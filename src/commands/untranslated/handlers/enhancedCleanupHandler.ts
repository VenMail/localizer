import * as vscode from 'vscode';
import { I18nIndex } from '../../../core/i18nIndex';
import { pickWorkspaceFolder } from '../../../core/workspace';
import { getGranularSyncService } from '../../../services/granularSyncService';
import {
    sharedDecoder,
    writeJsonFile,
    deleteKeyPathInObject,
} from '../utils/jsonUtils';
import { operationLock, OperationType } from '../utils/operationLock';

interface CleanupResult {
    deletedKeys: Set<string>;
    deletedFromOtherFiles: number;
    keysStillInUse: string[];
    orphanedKeys: string[];
}

interface KeyUsageInfo {
    keyPath: string;
    isUsed: boolean;
    referencedIn: string[];
    locales: string[];
}

/**
 * Enhanced cleanup handler optimized for JSON locale files with improved performance and reliability
 */
export class EnhancedCleanupHandler {
    private fileContentCache = new Map<string, string>();
    private usageCache = new Map<string, boolean>();
    private readonly maxCacheSize = 1000;

    constructor(
        private i18nIndex: I18nIndex,
        private deleteKeyFromLocaleFiles: (keyPath: string, uris: vscode.Uri[], defaultValue?: string) => Promise<number>,
        private deleteKeyFromAllLocaleFiles: (keyPath: string, uris: vscode.Uri[], defaultValue?: string) => Promise<number>,
    ) {}

    /**
     * Enhanced cleanup for unused keys in JSON locale files with batch processing
     */
    async cleanupUnusedKeysInJsonFile(documentUri?: vscode.Uri): Promise<void> {
        const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            vscode.window.showInformationMessage(
                'AI Localizer: No active document to cleanup unused keys.',
            );
            return;
        }

        if (!(await this.canProceed('cleanup-unused', 'Cleanup Unused Keys'))) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(targetUri);
        if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
            vscode.window.showInformationMessage(
                'AI Localizer: Enhanced cleanup only applies to JSON locale files.',
            );
            return;
        }

        const folder = vscode.workspace.getWorkspaceFolder(targetUri) ?? await pickWorkspaceFolder();
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        // Get default locale from settings
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const defaultLocale = config.get<string>('i18n.defaultLocale') || 'en';

        // Show progress indicator
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'AI Localizer: Analyzing unused keys...',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ increment: 10, message: 'Reading locale file...' });
                
                // Parse the current file
                let root: any = {};
                try {
                    const text = doc.getText();
                    const parsed = JSON.parse(text);
                    if (parsed && typeof parsed === 'object') root = parsed;
                } catch {
                    vscode.window.showErrorMessage('AI Localizer: Invalid JSON file.');
                    return;
                }

                progress.report({ increment: 20, message: 'Extracting all keys...' });
                
                // Extract all keys from the current file
                const allKeysInFile = this.extractAllKeysFromObject(root);
                
                if (allKeysInFile.length === 0) {
                    vscode.window.showInformationMessage('AI Localizer: No keys found in this locale file.');
                    return;
                }

                progress.report({ increment: 30, message: `Checking usage of ${allKeysInFile.length} keys...` });

                // Batch check key usage with optimized caching
                const usageInfo = await this.batchCheckKeyUsage(folder, allKeysInFile, progress);
                
                const unusedKeys = usageInfo.filter(info => !info.isUsed);
                
                if (unusedKeys.length === 0) {
                    vscode.window.showInformationMessage('AI Localizer: No unused keys found in this file.');
                    return;
                }

                progress.report({ increment: 80, message: `Found ${unusedKeys.length} unused keys...` });

                // Show cleanup options
                const choice = await vscode.window.showQuickPick(
                    [
                        {
                            label: `$(trash) Remove ${unusedKeys.length} unused keys from this file only`,
                            description: 'Remove unused keys only from the current locale file',
                        },
                        {
                            label: `$(trash) Remove ${unusedKeys.length} unused keys from ALL locale files`,
                            description: 'Remove unused keys from all locale files in the project',
                        },
                        {
                            label: '$(eye) Show unused keys preview',
                            description: 'Preview what will be deleted without making changes',
                        },
                        {
                            label: '$(close) Cancel',
                            description: 'Do not remove any keys',
                        },
                    ],
                    {
                        placeHolder: `AI Localizer: Found ${unusedKeys.length} unused keys. Choose action:`,
                    }
                );

                if (!choice || choice.label === '$(close) Cancel') {
                    return;
                }

                if (choice.label.includes('preview')) {
                    this.showUnusedKeysPreview(unusedKeys);
                    return;
                }

                const applyToAllLocales = choice.label.includes('ALL locale files');
                
                progress.report({ increment: 90, message: 'Removing unused keys...' });

                // Execute cleanup with enhanced batch processing
                const result = await this.executeBatchCleanup(
                    folder,
                    targetUri,
                    unusedKeys,
                    root,
                    applyToAllLocales,
                    progress,
                    defaultLocale
                );

                this.showCleanupResult(result, applyToAllLocales);
            }
        );
    }

    /**
     * Extract all keys from a nested object using dot notation
     */
    private extractAllKeysFromObject(obj: any, prefix: string = ''): string[] {
        const keys: string[] = [];
        
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return keys;
        }

        for (const [key, value] of Object.entries(obj)) {
            const fullKey = prefix ? `${prefix}.${key}` : key;
            
            if (typeof value === 'string') {
                keys.push(fullKey);
            } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                keys.push(...this.extractAllKeysFromObject(value, fullKey));
            }
        }

        return keys;
    }

    /**
     * Batch check key usage with optimized caching and parallel processing
     */
    private async batchCheckKeyUsage(
        folder: vscode.WorkspaceFolder,
        keys: string[],
        progress: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<KeyUsageInfo[]> {
        const batchSize = 50; // Process keys in batches for better performance
        const results: KeyUsageInfo[] = [];
        
        for (let i = 0; i < keys.length; i += batchSize) {
            const batch = keys.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async (keyPath) => {
                    progress.report({
                        increment: 0,
                        message: `Checking key usage... ${Math.floor((i / keys.length) * 100)}%`
                    });

                    const isUsed = await this.checkKeyUsageWithCache(folder, keyPath);
                    
                    // Get locales where this key exists (for preview purposes)
                    const record = this.i18nIndex.getRecord(keyPath);
                    const _locales = record ? Array.from(record.locales.keys()) : [];

                    return {
                        keyPath,
                        isUsed,
                        referencedIn: isUsed ? ['source code'] : [],
                        locales: _locales,
                    };
                })
            );
            
            results.push(...batchResults);
        }

        return results;
    }

    /**
     * Check key usage with intelligent caching
     */
    private async checkKeyUsageWithCache(folder: vscode.WorkspaceFolder, keyPath: string): Promise<boolean> {
        // Check cache first
        if (this.usageCache.has(keyPath)) {
            return this.usageCache.get(keyPath)!;
        }

        const isUsed = await this.performKeyUsageCheck(folder, keyPath);
        
        // Update cache with size limit
        if (this.usageCache.size >= this.maxCacheSize) {
            // Clear oldest entries (simple LRU)
            const firstKey = this.usageCache.keys().next().value;
            if (firstKey) {
                this.usageCache.delete(firstKey);
            }
        }
        this.usageCache.set(keyPath, isUsed);

        return isUsed;
    }

    /**
     * Perform actual key usage check with optimized patterns for JSON locale files
     */
    private async performKeyUsageCheck(folder: vscode.WorkspaceFolder, keyPath: string): Promise<boolean> {
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const maxSourceFilesToScan = cfg.get<number>('i18n.maxSourceFilesToScan') ?? 5000;
        
        // Optimized source globs for better performance
        const sourceGlobs = cfg.get<string[]>('i18n.sourceGlobs') || [
            '**/*.{ts,tsx,js,jsx,vue}',
            '**/*.php',
            '**/*.blade.php',
        ];
        
        const excludeGlobs = cfg.get<string[]>('i18n.sourceExcludeGlobs') || [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/build/**',
            '**/coverage/**',
            '**/*.min.js',
            '**/*.chunk.js',
        ];

        // Enhanced search patterns for better detection
        const escapedKey = keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const searchPatterns: RegExp[] = [
            // JS/TS/Vue: t('key'), t("key"), t(`key`), $t('key')
            new RegExp(`\\b\\$?t\\s*\\(\\s*(['"\`])${escapedKey}\\1\\s*(?:,|\\))`),
            // Laravel: __('key'), trans('key'), @lang('key')
            new RegExp(`\\b__\\s*\\(\\s*(['"])${escapedKey}\\1\\s*(?:,|\\))`),
            new RegExp(`\\btrans\\s*\\(\\s*(['"])${escapedKey}\\1\\s*(?:,|\\))`),
            new RegExp(`@lang\\s*\\(\\s*(['"])${escapedKey}\\1\\s*(?:,|\\))`),
            new RegExp(`\\bLang::get\\s*\\(\\s*(['"])${escapedKey}\\1\\s*(?:,|\\))`),
            // Dynamic property access: obj.key, obj['key']
            new RegExp(`\\b(?:pages|messages|translations|locale|i18n)\\.${escapedKey}\\b`),
            new RegExp(`\\['${escapedKey}'\\]`),
            new RegExp(`\\["${escapedKey}"\\]`),
        ];

        const exclude = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;
        const seen = new Set<string>();
        const uris: vscode.Uri[] = [];

        // Collect files efficiently
        for (const include of sourceGlobs) {
            try {
                const pattern = new vscode.RelativePattern(folder, include);
                const found = await vscode.workspace.findFiles(pattern, exclude, maxSourceFilesToScan);
                for (const uri of found) {
                    const key = uri.toString();
                    if (!seen.has(key) && vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString()) {
                        seen.add(key);
                        uris.push(uri);
                    }
                }
            } catch {
                // Skip invalid glob patterns
            }
        }

        // Batch file reading for better performance
        const fileContents = await Promise.all(
            uris.map(async (uri) => {
                try {
                    const cacheKey = uri.toString();
                    let content = this.fileContentCache.get(cacheKey);
                    
                    if (!content) {
                        const data = await vscode.workspace.fs.readFile(uri);
                        content = sharedDecoder.decode(data);
                        
                        // Update cache with size limit
                        if (this.fileContentCache.size >= this.maxCacheSize) {
                            const firstKey = this.fileContentCache.keys().next().value;
                            if (firstKey) {
                                this.fileContentCache.delete(firstKey);
                            }
                        }
                        this.fileContentCache.set(cacheKey, content);
                    }
                    
                    return { uri, content };
                } catch {
                    return null;
                }
            })
        );

        // Search for patterns in all files
        for (const fileData of fileContents) {
            if (!fileData || !fileData.content) continue;
            
            for (const searchPattern of searchPatterns) {
                if (searchPattern.test(fileData.content)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Execute batch cleanup with enhanced error handling
     */
    private async executeBatchCleanup(
        folder: vscode.WorkspaceFolder,
        targetUri: vscode.Uri,
        unusedKeys: KeyUsageInfo[],
        root: any,
        applyToAllLocales: boolean,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        defaultLocale: string
    ): Promise<CleanupResult> {
        const result: CleanupResult | null = await operationLock.withGlobalLock(
            'cleanup-unused',
            'Cleanup Unused Keys',
            async () => {
                const deletedKeys = new Set<string>();
                const keysStillInUse: string[] = [];
                const orphanedKeys: string[] = [];
                let deletedFromOtherFiles = 0;

                // Re-read file to ensure we have the latest content
                let freshRoot: any = {};
                try {
                    const freshDoc = await vscode.workspace.openTextDocument(targetUri);
                    const text = freshDoc.getText();
                    const parsed = JSON.parse(text);
                    if (parsed && typeof parsed === 'object') freshRoot = parsed;
                } catch {
                    // If we can't read the file, use the cached version
                    freshRoot = root;
                }

                // Process keys in batches for better performance
                const batchSize = 20;
                for (let i = 0; i < unusedKeys.length; i += batchSize) {
                    const batch = unusedKeys.slice(i, i + batchSize);
                    
                    for (const { keyPath, isUsed } of batch) {
                        if (isUsed) {
                            keysStillInUse.push(keyPath);
                            continue;
                        }

                        // Check if key is orphaned (exists in locale files but not in default locale)
                        const record = this.i18nIndex.getRecord(keyPath);
                        if (!record || !record.locales.has(defaultLocale)) {
                            orphanedKeys.push(keyPath);
                        }

                        // Delete from current file
                        if (deleteKeyPathInObject(freshRoot, keyPath)) {
                            deletedKeys.add(keyPath);
                        }
                    }

                    // Update progress
                    progress.report({
                        increment: 0,
                        message: `Processing cleanup... ${Math.floor((i / unusedKeys.length) * 100)}%`
                    });
                }

                // Write changes to current file
                if (deletedKeys.size > 0) {
                    await operationLock.withFileLock(targetUri, 'cleanup-unused', async () => {
                        await writeJsonFile(targetUri, freshRoot);
                    });

                    await this.i18nIndex.updateFile(targetUri);
                    await vscode.commands.executeCommand(
                        'ai-localizer.i18n.refreshFileDiagnostics',
                        targetUri,
                        Array.from(deletedKeys),
                    );
                }

                // Handle cleanup across all locales if requested
                if (applyToAllLocales && deletedKeys.size > 0) {
                    await this.i18nIndex.ensureInitialized();
                    
                    const keysToDeleteFromAllLocales = new Map<string, vscode.Uri[]>();
                    
                    for (const keyPath of deletedKeys) {
                        const record = this.i18nIndex.getRecord(keyPath);
                        if (!record) continue;
                        
                        const allLocaleUris = record.locations.map((l) => l.uri);
                        keysToDeleteFromAllLocales.set(keyPath, allLocaleUris);
                    }
                    
                    for (const [keyPath, allUris] of keysToDeleteFromAllLocales) {
                        deletedFromOtherFiles += await this.deleteKeyFromAllLocaleFiles(keyPath, allUris);
                    }
                    
                    // Record deleted keys to prevent sync reintroduction
                    const syncService = getGranularSyncService();
                    await syncService.recordRecentlyDeletedKeys(folder, Array.from(deletedKeys));
                }

                return { deletedKeys, deletedFromOtherFiles, keysStillInUse, orphanedKeys };
            }
        );

        return result || { deletedKeys: new Set(), deletedFromOtherFiles: 0, keysStillInUse: [], orphanedKeys: [] };
    }

    /**
     * Show preview of unused keys
     */
    private showUnusedKeysPreview(unusedKeys: KeyUsageInfo[]): void {
        const preview = unusedKeys
            .slice(0, 50) // Limit preview to first 50 keys
            .map(info => `• ${info.keyPath} (${info.locales.join(', ')})`)
            .join('\n');

        const message = unusedKeys.length > 50 
            ? `Found ${unusedKeys.length} unused keys. Showing first 50:\n\n${preview}\n\n... and ${unusedKeys.length - 50} more`
            : `Found ${unusedKeys.length} unused keys:\n\n${preview}`;

        vscode.window.showInformationMessage(message, { modal: true });
    }

    /**
     * Show cleanup results
     */
    private showCleanupResult(result: CleanupResult, applyToAllLocales: boolean): void {
        const { deletedKeys, deletedFromOtherFiles, keysStillInUse, orphanedKeys } = result;
        
        let message = `AI Localizer: Removed ${deletedKeys.size} unused key(s)`;
        
        if (applyToAllLocales && deletedFromOtherFiles > 0) {
            message += ` from this file and ${deletedFromOtherFiles} other locale file(s)`;
        } else {
            message += ' from this file';
        }

        if (keysStillInUse.length > 0) {
            message += `. ${keysStillInUse.length} key(s) skipped because they are still referenced`;
        }

        if (orphanedKeys.length > 0) {
            message += `. ${orphanedKeys.length} orphaned key(s) removed`;
        }

        vscode.window.showInformationMessage(message);
    }

    /**
     * Check if operation can proceed
     */
    private async canProceed(operationType: OperationType, description: string): Promise<boolean> {
        if (!operationLock.isOperationRunning()) {
            return true;
        }
        const current = operationLock.getCurrentOperation();
        if (current?.type === operationType) {
            return true;
        }
        const blockingMsg = operationLock.getBlockingOperationMessage();
        vscode.window.showWarningMessage(
            `AI Localizer: Cannot start "${description}" - ${blockingMsg}. Please wait for it to complete.`
        );
        return false;
    }

    /**
     * Clear caches to free memory
     */
    clearCaches(): void {
        this.fileContentCache.clear();
        this.usageCache.clear();
    }
}
