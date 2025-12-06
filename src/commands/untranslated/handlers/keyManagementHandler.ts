import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex, extractKeyAtPosition } from '../../../core/i18nIndex';
import { setTranslationValue, setTranslationValuesBatch, deriveRootFromFile } from '../../../core/i18nFs';
import { getGranularSyncService } from '../../../services/granularSyncService';
import { pickWorkspaceFolder } from '../../../core/workspace';
import { findKeyInHistory, getFileContentAtCommit } from '../../../core/gitHistory';
import { CommitTracker } from '../../../core/commitTracker';
import {
    sharedDecoder,
    sharedEncoder,
    readJsonFile,
    writeJsonFile,
    deleteKeyPathInObject,
    getNestedValue,
    setNestedValue,
} from '../utils/jsonUtils';
import {
    computeEditDistance,
    buildLabelFromKeySegment,
} from '../utils/textAnalysis';
import { findCommentRanges, isPositionInComment } from '../utils/commentParser';
import { GitRecoveryHandler } from './gitRecoveryHandler';
import { getBatchRecoveryHandler } from './batchRecoveryHandler';
import { clearLocaleCaches } from '../utils/localeCache';
import { operationLock, OperationType } from '../utils/operationLock';

export class KeyManagementHandler {
    private deletionGuardPending: Map<string, { key: string; value: string; timeout: NodeJS.Timeout }> = new Map();

    constructor(
        private i18nIndex: I18nIndex,
        private gitRecoveryHandler: GitRecoveryHandler,
        private context?: vscode.ExtensionContext,
        private log?: vscode.OutputChannel,
    ) {}

    /**
     * Cleanup all pending guard timeouts. Call on extension deactivation.
     */
    dispose(): void {
        for (const [, pending] of this.deletionGuardPending) {
            clearTimeout(pending.timeout);
        }
        this.deletionGuardPending.clear();
    }

    /**
     * Check if operation can proceed, showing warning if blocked
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
     * Fix missing key reference
     */
    async fixMissingKeyReference(
        documentUri: vscode.Uri,
        position: { line: number; character: number },
        key: string,
    ): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(documentUri);

        let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';
        const rootName = deriveRootFromFile(folder, documentUri);
        const keyParts = String(key).split('.').filter(Boolean);
        const keyLeaf = keyParts[keyParts.length - 1] || '';
        const keyPrefix = keyParts.slice(0, -1).join('.');

        const syncService = getGranularSyncService(this.context);
        await syncService.syncKeys(folder, [key]);

        await this.i18nIndex.ensureInitialized();
        const allKeys = this.i18nIndex.getAllKeys();

        // STEP 1: Try to find the best matching existing key (typo fix)
        let bestKey: string | null = null;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const candidate of allKeys) {
            if (!candidate) continue;
            const parts = candidate.split('.').filter(Boolean);
            if (!parts.length) continue;
            const prefix = parts.slice(0, -1).join('.');
            if (prefix !== keyPrefix) continue;
            const leaf = parts[parts.length - 1] || '';
            const score = computeEditDistance(keyLeaf, leaf);
            if (score < bestScore) {
                bestScore = score;
                bestKey = candidate;
            }
        }

        // Check if the best key is a good enough match
        if (bestKey) {
            const bestParts = bestKey.split('.').filter(Boolean);
            const bestLeaf = bestParts[bestParts.length - 1] || '';
            const maxLen = Math.max(bestLeaf.length, keyLeaf.length);
            if (maxLen > 0 && bestScore <= Math.max(2, Math.floor(maxLen / 4))) {
                // Auto-fix: Replace with similar key
                const vsPosition = new vscode.Position(position.line, position.character);
                const keyInfo = extractKeyAtPosition(doc, vsPosition);
                if (keyInfo && keyInfo.key === key) {
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(documentUri, keyInfo.range, bestKey);
                    const applied = await vscode.workspace.applyEdit(edit);
                    if (applied) {
                        await doc.save();
                        vscode.window.showInformationMessage(
                            `AI Localizer: Auto-fixed "${key}" → "${bestKey}"`,
                        );
                        return;
                    }
                }
            }
        }

        // STEP 2: Try to recover value from git history
        const localeUris = await this.gitRecoveryHandler.getLocaleFileUris(folder, defaultLocale, this.i18nIndex);
        const recovery = await this.gitRecoveryHandler.recoverKeyFromGit(folder, localeUris, key, defaultLocale, {
            daysBack: 60,
            maxCommits: 40,
            perDayCommitLimit: 3,
            logPrefix: '[MissingRefFix]',
        });

        if (recovery) {
            await setTranslationValue(folder, defaultLocale, key, recovery.value, { rootName });
            vscode.window.showInformationMessage(
                `AI Localizer: Restored "${key}" from ${recovery.source}.`,
            );
            return;
        }
        this.log?.appendLine(`[MissingRefFix] Git recovery failed for "${key}".`);

        // STEP 3: Show options (only as fallback)
        const items: vscode.QuickPickItem[] = [];

        if (bestKey && bestKey !== key) {
            const bestParts = bestKey.split('.').filter(Boolean);
            const bestLeaf = bestParts[bestParts.length - 1] || '';
            const maxLen = Math.max(bestLeaf.length, keyLeaf.length);
            if (maxLen > 0 && bestScore <= Math.max(3, Math.floor(maxLen / 2))) {
                items.push({
                    label: `$(replace) Replace with: ${bestKey}`,
                    description: `Similar key found (edit distance: ${bestScore})`,
                    detail: 'Use closest matching translation key in the same namespace',
                });
            }
        }

        const suggestedLabel = buildLabelFromKeySegment(keyLeaf) || key;

        items.push({
            label: `$(add) Create new key with value: "${suggestedLabel}"`,
            description: 'Create a new locale entry using this key',
            detail: `Key: ${key}`,
        });

        items.push({
            label: '$(edit) Create new key with custom value...',
            description: 'Enter a custom translation value',
        });

        const choice = await vscode.window.showQuickPick(items, {
            placeHolder: `AI Localizer: Fix missing "${key}" (no git history found)`,
        });
        if (!choice) return;

        if (choice.label.startsWith('$(replace)') && bestKey) {
            const vsPosition = new vscode.Position(position.line, position.character);
            const keyInfo = extractKeyAtPosition(doc, vsPosition);
            if (!keyInfo || keyInfo.key !== key) {
                vscode.window.showInformationMessage(
                    `AI Localizer: Could not locate "${key}" at this position.`,
                );
                return;
            }

            const edit = new vscode.WorkspaceEdit();
            edit.replace(documentUri, keyInfo.range, bestKey);
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                vscode.window.showErrorMessage(
                    'AI Localizer: Failed to apply reference fix to source file.',
                );
                return;
            }
            await doc.save();
            vscode.window.showInformationMessage(
                `AI Localizer: Replaced "${key}" with "${bestKey}".`,
            );
            return;
        }

        if (choice.label.includes('custom value')) {
            const customValue = await vscode.window.showInputBox({
                prompt: `Enter translation value for "${key}"`,
                value: suggestedLabel,
                placeHolder: 'Translation value...',
            });
            if (!customValue) return;
            await setTranslationValue(folder, defaultLocale, key, customValue, { rootName });
            vscode.window.showInformationMessage(
                `AI Localizer: Created "${key}" = "${customValue}" in locale ${defaultLocale}.`,
            );
            return;
        }

        // Default: create with suggested label
        await setTranslationValue(folder, defaultLocale, key, suggestedLabel, { rootName });
        vscode.window.showInformationMessage(
            `AI Localizer: Created "${key}" = "${suggestedLabel}" in locale ${defaultLocale}.`,
        );
    }

    /**
     * Add a key's default value to the auto-ignore list
     */
    async addKeyToIgnoreList(folderUri: vscode.Uri, key: string): Promise<void> {
        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(key);
        if (!record) {
            vscode.window.showInformationMessage(
                `AI Localizer: No translation record found for key ${key}.`,
            );
            return;
        }

        const defaultValue = record.locales.get(record.defaultLocale);
        if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
            vscode.window.showInformationMessage(
                `AI Localizer: No default value found for key ${key}.`,
            );
            return;
        }

        const scriptsDir = vscode.Uri.joinPath(folderUri, 'scripts');
        const ignoreUri = vscode.Uri.joinPath(scriptsDir, '.i18n-auto-ignore.json');
        let ignoreData: { exact?: string[]; exactInsensitive?: string[]; contains?: string[] } = {
            exact: [],
            exactInsensitive: [],
            contains: [],
        };

        try {
            const data = await vscode.workspace.fs.readFile(ignoreUri);
            const raw = sharedDecoder.decode(data);
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                ignoreData = {
                    exact: Array.isArray(parsed.exact) ? parsed.exact : [],
                    exactInsensitive: Array.isArray(parsed.exactInsensitive) ? parsed.exactInsensitive : [],
                    contains: Array.isArray(parsed.contains) ? parsed.contains : [],
                };
            }
        } catch {
            // File doesn't exist, use defaults
        }

        const normalizedValue = defaultValue.replace(/\s+/g, ' ').trim();
        if (!ignoreData.exact!.includes(normalizedValue)) {
            ignoreData.exact!.push(normalizedValue);
        }

        const payload = JSON.stringify(ignoreData, null, 2) + '\n';
        await vscode.workspace.fs.writeFile(ignoreUri, sharedEncoder.encode(payload));

        await vscode.commands.executeCommand('ai-localizer.i18n.rescan');

        vscode.window.showInformationMessage(
            `AI Localizer: Added "${normalizedValue}" to ignore list. Diagnostics will be refreshed.`,
        );
    }

    /**
     * Bulk fix missing translation key references in a ts/tsx file
     * Optimized version using batch recovery with parallel processing
     */
    async bulkFixMissingKeyReferences(documentUri: vscode.Uri): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(documentUri);
        const languageId = doc.languageId;

        const supportedLanguages = [
            'typescript', 'typescriptreact',
            'javascript', 'javascriptreact',
            'vue',
        ];

        if (!supportedLanguages.includes(languageId)) {
            vscode.window.showWarningMessage(
                'AI Localizer: Bulk fix is available for JS/TS/JSX/TSX/Vue files.',
            );
            return;
        }

        // Check if another operation is blocking
        if (!(await this.canProceed('key-management', 'Bulk Fix Missing References'))) {
            return;
        }

        let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        this.log?.appendLine(
            `[BulkFixMissingRefs] Starting for ${documentUri.fsPath} (lang=${languageId})`,
        );

        // Extract all translation keys from the file
        const text = doc.getText();
        const commentRanges = findCommentRanges(text);
        const keyMatches: Array<{ key: string; range: vscode.Range; hasVariables: boolean }> = [];

        const tCallRegex = /\b(\$?)t\(\s*(['"])([A-Za-z0-9_.]+)\2\s*([,)])/g;
        let match;
        while ((match = tCallRegex.exec(text)) !== null) {
            const dollarSignLength = match[1] ? 1 : 0;
            const tCallStart = match.index + dollarSignLength;

            if (isPositionInComment(tCallStart, commentRanges)) {
                continue;
            }

            const key = match[3];
            const afterKey = match[4];
            const hasVariables = afterKey === ',';

            const quoteChar = match[2];
            const searchStart = dollarSignLength + 2;
            const quotePosInMatch = match[0].indexOf(quoteChar, searchStart);
            const keyStartPosition = match.index + quotePosInMatch + 1;

            const startPos = doc.positionAt(keyStartPosition);
            const endPos = doc.positionAt(keyStartPosition + key.length);
            const range = new vscode.Range(startPos, endPos);
            keyMatches.push({ key, range, hasVariables });
        }

        if (keyMatches.length === 0) {
            vscode.window.showInformationMessage(
                'AI Localizer: No translation key references found in this file.',
            );
            return;
        }

        await this.i18nIndex.ensureInitialized();
        const allKeys = this.i18nIndex.getAllKeys();
        const allKeysSet = new Set(allKeys);
        const missingKeys: Array<{ key: string; range: vscode.Range; hasVariables: boolean }> = [];

        for (const { key, range, hasVariables } of keyMatches) {
            if (!allKeysSet.has(key)) {
                missingKeys.push({ key, range, hasVariables });
            }
        }

        if (missingKeys.length === 0) {
            vscode.window.showInformationMessage(
                'AI Localizer: All translation keys in this file are valid.',
            );
            return;
        }

        const progressMessage = `Found ${missingKeys.length} missing translation key(s). Fixing...`;
        
        let finalFixedKeys: string[] = [];

        // Acquire lock for bulk key management
        await operationLock.withGlobalLock(
            'key-management',
            'Bulk Fix Missing References',
            async () => {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'AI Localizer: Bulk Fix Missing References',
                        cancellable: false,
                    },
                    async (progress) => {
                        progress.report({ message: progressMessage });

                        const startTime = Date.now();
                        const edit = new vscode.WorkspaceEdit();
                        const cfg = vscode.workspace.getConfiguration('ai-localizer');
                        const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';
                        const rootName = deriveRootFromFile(folder!, documentUri);
                        const batchUpdates = new Map<string, { value: string; rootName: string }>();

                        let fixedCount = 0;
                        let createdCount = 0;

                        // Clear old caches for fresh batch operation
                        clearLocaleCaches();

                        // Build prefix index for faster typo-fix candidate lookup
                        const keysByPrefix = new Map<string, Array<{ key: string; leaf: string }>>();
                        for (const candidate of allKeys) {
                            if (!candidate) continue;
                            const parts = candidate.split('.').filter(Boolean);
                            if (!parts.length) continue;
                            const prefix = parts.slice(0, -1).join('.');
                            const leaf = parts[parts.length - 1] || '';
                            if (!keysByPrefix.has(prefix)) {
                                keysByPrefix.set(prefix, []);
                            }
                            keysByPrefix.get(prefix)!.push({ key: candidate, leaf });
                        }

                        // PHASE 1: Try to fix typos first (fast, no git needed)
                        const keysNeedingRecovery: Array<{ key: string; range: vscode.Range; hasVariables: boolean }> = [];
                        
                        for (const { key, range, hasVariables } of missingKeys) {
                            const keyParts = key.split('.').filter(Boolean);
                            const keyPrefix = keyParts.slice(0, -1).join('.');
                            const keyLeaf = keyParts[keyParts.length - 1] || '';

                            let bestKey: string | null = null;
                            let bestScore = Number.POSITIVE_INFINITY;

                            const candidates = keysByPrefix.get(keyPrefix) || [];
                            for (const { key: candidateKey, leaf } of candidates) {
                                const score = computeEditDistance(keyLeaf, leaf);
                                if (score < bestScore) {
                                    bestScore = score;
                                    bestKey = candidateKey;
                                }
                            }

                            if (bestKey) {
                                const bestParts = bestKey.split('.').filter(Boolean);
                                const bestLeaf = bestParts[bestParts.length - 1] || '';
                                const maxLen = Math.max(bestLeaf.length, keyLeaf.length);
                                if (maxLen > 0 && bestScore <= Math.max(2, Math.floor(maxLen / 2))) {
                                    edit.replace(documentUri, range, bestKey);
                                    fixedCount++;
                                    continue;
                                }
                            }
                            
                            // Key needs recovery from git
                            keysNeedingRecovery.push({ key, range, hasVariables });
                        }

                        // PHASE 2: Batch recover keys from git (parallel processing)
                        const keysNeedingReview: Array<{ key: string; generatedValue: string }> = [];
                        let recoveredCount = 0;

                        if (keysNeedingRecovery.length > 0) {
                            progress.report({ 
                                message: `Recovering ${keysNeedingRecovery.length} key(s) from git history...` 
                            });

                            const batchRecovery = getBatchRecoveryHandler(this.context, this.log);
                            const extractRef = batchRecovery.getExtractCommitRef(folder!);
                            
                            const keysToRecover = keysNeedingRecovery.map(k => k.key);
                            const recoveryResults = await batchRecovery.recoverKeysBatch(
                                folder!,
                                keysToRecover,
                                defaultLocale,
                                {
                                    daysBack: 120,
                                    maxCommitsPerFile: 20,
                                    extractRef,
                                },
                            );

                            // Process recovery results
                            for (const { key } of keysNeedingRecovery) {
                                const result = recoveryResults.get(key);
                                
                                if (result && result.value) {
                                    batchUpdates.set(key, { value: result.value, rootName });
                                    createdCount++;
                                    recoveredCount++;
                                } else {
                                    // Fallback: generate label from key
                                    const keyParts = key.split('.').filter(Boolean);
                                    const lastSegment = keyParts[keyParts.length - 1] || '';
                                    const label = buildLabelFromKeySegment(lastSegment) || key;
                                    batchUpdates.set(key, { value: label, rootName });
                                    keysNeedingReview.push({ key, generatedValue: label });
                                    createdCount++;
                                }
                            }
                        }

                        // PHASE 3: Apply edits and write batch updates
                        if (edit.size > 0) {
                            const applied = await vscode.workspace.applyEdit(edit);
                            if (applied) {
                                await doc.save();
                            }
                        }

                        if (batchUpdates.size > 0) {
                            try {
                                await setTranslationValuesBatch(folder!, defaultLocale, batchUpdates);
                            } catch (applyErr) {
                                this.log?.appendLine(
                                    `[BulkFixMissingRefs] Failed to write ${batchUpdates.size} batch update(s): ${String(applyErr)}`,
                                );
                                throw applyErr;
                            }
                        }

                        // PHASE 4: Sync keys to other locales
                        if (batchUpdates.size > 0) {
                            progress.report({ message: 'Syncing to other locales...' });
                            try {
                                const syncService = getGranularSyncService(this.context);
                                const keysToSync = Array.from(batchUpdates.keys());
                                await syncService.syncKeys(folder!, keysToSync, { verbose: false });
                                this.log?.appendLine(`[BulkFixMissingRefs] Synced ${keysToSync.length} keys to other locales`);
                            } catch (syncErr) {
                                this.log?.appendLine(`[BulkFixMissingRefs] Locale sync warning: ${String(syncErr)}`);
                            }
                        }

                        // PHASE 5: Generate review report if there are keys that couldn't be recovered
                        if (keysNeedingReview.length > 0) {
                            await this.generateReviewReport(folder!, documentUri, keysNeedingReview);
                        }

                        finalFixedKeys = Array.from(batchUpdates.keys());

                        const elapsed = Date.now() - startTime;
                        const recoveryRate = keysNeedingRecovery.length > 0 
                            ? Math.round((recoveredCount / keysNeedingRecovery.length) * 100) 
                            : 100;
                        
                        let message = `Fixed ${fixedCount} typo(s), created ${createdCount} key(s) (${recoveryRate}% recovered from git) in ${elapsed}ms.`;
                        if (keysNeedingReview.length > 0) {
                            message += ` ${keysNeedingReview.length} key(s) need review.`;
                        }
                        
                        this.log?.appendLine(`[BulkFixMissingRefs] ${message}`);
                        vscode.window.showInformationMessage(`AI Localizer: ${message}`);
                    },
                );
            }
        );

        // Refresh diagnostics outside the key-management lock to avoid thrashing
        if (finalFixedKeys.length > 0) {
            try {
                // Invalidate stale report entries
                await vscode.commands.executeCommand(
                    'ai-localizer.i18n.invalidateReportKeys',
                    finalFixedKeys,
                );

                // Trigger rescan to refresh diagnostics
                await vscode.commands.executeCommand('ai-localizer.i18n.rescan');

                // Also refresh diagnostics for the current file
                await vscode.commands.executeCommand(
                    'ai-localizer.i18n.refreshFileDiagnostics',
                    documentUri,
                    finalFixedKeys,
                );
            } catch (refreshErr) {
                this.log?.appendLine(
                    `[BulkFixMissingRefs] Diagnostics refresh warning: ${String(refreshErr)}`,
                );
            }
        }
    }

    /**
     * Generate a JSON report for keys that couldn't be recovered from git
     */
    private async generateReviewReport(
        folder: vscode.WorkspaceFolder,
        sourceUri: vscode.Uri,
        keysNeedingReview: Array<{ key: string; generatedValue: string }>,
    ): Promise<void> {
        if (keysNeedingReview.length === 0) return;

        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-review-generated.json');

        try {
            // Ensure scripts directory exists
            try {
                await vscode.workspace.fs.createDirectory(scriptsDir);
            } catch {
                // Directory might already exist
            }

            // Load existing report if any
            let existingReport: any = { files: [] };
            try {
                const data = await vscode.workspace.fs.readFile(reportUri);
                existingReport = JSON.parse(sharedDecoder.decode(data));
            } catch {
                // No existing report
            }

            const relativePath = path.relative(folder.uri.fsPath, sourceUri.fsPath).replace(/\\/g, '/');
            const timestamp = new Date().toISOString();

            // Find or create file entry
            let fileEntry = existingReport.files?.find((f: any) => f.file === relativePath);
            if (!fileEntry) {
                fileEntry = { file: relativePath, issues: [] };
                if (!existingReport.files) {
                    existingReport.files = [];
                }
                existingReport.files.push(fileEntry);
            }

            // Add new issues (avoid duplicates)
            const existingKeys = new Set(fileEntry.issues?.map((i: any) => i.key) || []);
            for (const { key, generatedValue } of keysNeedingReview) {
                if (!existingKeys.has(key)) {
                    fileEntry.issues.push({
                        key,
                        generatedValue,
                        needsReview: true,
                        timestamp,
                    });
                }
            }

            // Write report
            existingReport.lastUpdated = timestamp;
            const payload = JSON.stringify(existingReport, null, 2) + '\n';
            await vscode.workspace.fs.writeFile(reportUri, sharedEncoder.encode(payload));

            this.log?.appendLine(
                `[BulkFixMissingRefs] Generated review report: ${keysNeedingReview.length} keys added to ${reportUri.fsPath}`,
            );
        } catch (err) {
            this.log?.appendLine(`[BulkFixMissingRefs] Failed to generate review report: ${String(err)}`);
        }
    }

    /**
     * Delete a key from multiple locale files with guard
     */
    async deleteKeyFromLocaleFiles(
        keyPath: string,
        uris: vscode.Uri[],
        defaultValue?: string,
    ): Promise<number> {
        if (!uris.length) return 0;

        const changedUris: vscode.Uri[] = [];

        for (const uri of uris) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                    continue;
                }

                let root: any = await readJsonFile(uri) || {};
                if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

                const currentValue = getNestedValue(root, keyPath);
                const valueToRestore = defaultValue || (typeof currentValue === 'string' ? currentValue : '');

                if (valueToRestore) {
                    const allowed = await this.guardDeleteDefaultLocaleKey(uri, keyPath, valueToRestore);
                    if (!allowed) continue;
                }

                if (!deleteKeyPathInObject(root, keyPath)) {
                    continue;
                }

                await writeJsonFile(uri, root);
                changedUris.push(uri);
            } catch {
                // Ignore failures for individual locale files
            }
        }

        for (const uri of changedUris) {
            try {
                await this.i18nIndex.updateFile(uri);
                await vscode.commands.executeCommand(
                    'ai-localizer.i18n.refreshFileDiagnostics',
                    uri,
                    [keyPath],
                );
            } catch {
                // Ignore failures during diagnostics refresh
            }
        }

        return changedUris.length;
    }

    /**
     * Guard: Prevent deletion of default locale keys that are used in components
     */
    async guardDeleteDefaultLocaleKey(
        localeUri: vscode.Uri,
        keyPath: string,
        defaultValue: string,
    ): Promise<boolean> {
        const folder = vscode.workspace.getWorkspaceFolder(localeUri);
        if (!folder) return true;

        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

        const localePath = localeUri.fsPath.toLowerCase();
        const isDefaultLocale = localePath.includes(`/${defaultLocale}/`) ||
            localePath.includes(`/${defaultLocale}.json`);

        if (!isDefaultLocale) return true;

        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(keyPath);
        const isUsed = record && record.locations.length > 0;

        if (!isUsed) return true;

        const message = `Key "${keyPath}" is used in ${record.locations.length} component(s). Deleting it will cause missing translations.`;
        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            'Delete Anyway',
            'Cancel',
        );

        if (choice !== 'Delete Anyway') return false;

        // Show restore option after 5 seconds
        const guardKey = `${localeUri.toString()}:${keyPath}`;
        const timeout = setTimeout(async () => {
            this.deletionGuardPending.delete(guardKey);
            const restoreChoice = await vscode.window.showInformationMessage(
                `Key "${keyPath}" was deleted. You can restore it from git history.`,
                'Restore from Git History',
                'Dismiss',
            );
            if (restoreChoice === 'Restore from Git History') {
                await this.restoreDeletedKey(localeUri, keyPath, defaultValue, folder);
            }
        }, 5000);

        this.deletionGuardPending.set(guardKey, {
            key: keyPath,
            value: defaultValue,
            timeout,
        });

        return true;
    }

    /**
     * Restore a deleted key, trying git history first if value is not provided
     */
    private async restoreDeletedKey(
        localeUri: vscode.Uri,
        keyPath: string,
        value: string,
        folder: vscode.WorkspaceFolder,
    ): Promise<void> {
        try {
            let restoreValue = value;

            if (!restoreValue || !restoreValue.trim()) {
                const historyResult = await findKeyInHistory(folder, localeUri.fsPath, keyPath, 30);
                if (historyResult && historyResult.value) {
                    restoreValue = historyResult.value;
                } else if (this.context) {
                    const extractRef = CommitTracker.getExtractCommitRef(this.context, folder);
                    if (extractRef) {
                        const content = await getFileContentAtCommit(
                            folder,
                            localeUri.fsPath,
                            extractRef.commitHash,
                        );
                        if (content) {
                            try {
                                const json = JSON.parse(content);
                                const recovered = getNestedValue(json, keyPath);
                                if (recovered && typeof recovered === 'string') {
                                    restoreValue = recovered;
                                }
                            } catch {
                                // Invalid JSON
                            }
                        }
                    }
                }
            }

            if (!restoreValue || !restoreValue.trim()) {
                vscode.window.showWarningMessage(
                    `AI Localizer: Could not recover value for key "${keyPath}" from git history.`,
                );
                return;
            }

            let root: any = await readJsonFile(localeUri) || {};

            setNestedValue(root, keyPath, restoreValue);
            await writeJsonFile(localeUri, root);

            await this.i18nIndex.updateFile(localeUri);
            vscode.window.showInformationMessage(`AI Localizer: Restored key "${keyPath}".`);
        } catch (err) {
            console.error('AI Localizer: Failed to restore deleted key:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to restore deleted key.');
        }
    }
}



