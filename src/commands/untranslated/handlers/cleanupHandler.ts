import * as vscode from 'vscode';
import { I18nIndex } from '../../../core/i18nIndex';
import { pickWorkspaceFolder, runI18nScript } from '../../../core/workspace';
import {
    sharedDecoder,
    sharedEncoder,
    readJsonFile,
    writeJsonFile,
    hasKeyPathInObject,
    deleteKeyPathInObject,
} from '../utils/jsonUtils';
import { operationLock, OperationType } from '../utils/operationLock';

export class CleanupHandler {
    constructor(
        private i18nIndex: I18nIndex,
        private deleteKeyFromLocaleFiles: (keyPath: string, uris: vscode.Uri[], defaultValue?: string) => Promise<number>,
    ) {}

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
     * Cleanup unused keys in a locale file
     */
    async cleanupUnusedInFile(documentUri?: vscode.Uri): Promise<void> {
        const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            vscode.window.showInformationMessage(
                'AI Localizer: No active document to cleanup unused keys.',
            );
            return;
        }

        // Check if another operation is blocking
        if (!(await this.canProceed('cleanup-unused', 'Cleanup Unused Keys'))) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(targetUri);
        if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
            vscode.window.showInformationMessage(
                'AI Localizer: Cleanup unused keys only applies to locale JSON files.',
            );
            return;
        }

        let folder = vscode.workspace.getWorkspaceFolder(targetUri) ?? undefined;
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-unused-report.json');

        let rawReport: string;
        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            rawReport = sharedDecoder.decode(data);
        } catch {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Generate report',
                        description:
                            'Run i18n:cleanup-unused script now to analyze and generate the unused keys report.',
                    },
                    { label: 'Cancel', description: 'Skip cleaning up unused keys for now.' },
                ],
                {
                    placeHolder:
                        'AI Localizer: Unused keys report not found. Generate it by running the cleanup script?',
                },
            );
            if (!choice || choice.label !== 'Generate report') {
                return;
            }
            await runI18nScript('i18n:cleanup-unused');
            vscode.window.showInformationMessage(
                'AI Localizer: Running i18n:cleanup-unused script in a terminal. Re-run this quick fix after it completes.',
            );
            return;
        }

        let report: any;
        try {
            report = JSON.parse(rawReport);
        } catch {
            vscode.window.showErrorMessage(
                'AI Localizer: Unused keys report is not valid JSON.',
            );
            return;
        }

        const allUnused = Array.isArray(report.unused) ? report.unused : [];
        if (!allUnused.length) {
            vscode.window.showInformationMessage(
                'AI Localizer: No unused keys found in unused keys report.',
            );
            return;
        }

        // Parse the current file to find which keys exist in it
        let root: any = {};
        try {
            const text = doc.getText();
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') root = parsed;
        } catch {}
        if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

        // Filter to only keys that exist in this file
        const unused = allUnused.filter((item: any) => {
            if (!item || typeof item.keyPath !== 'string') return false;
            return hasKeyPathInObject(root, item.keyPath);
        });

        if (!unused.length) {
            vscode.window.showInformationMessage(
                'AI Localizer: No unused keys from report were found in this file.',
            );
            return;
        }

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: 'Remove unused keys in this file',
                    description: `Remove ${unused.length} unused key(s) from this locale file only.`,
                },
                {
                    label: 'Remove unused keys in all locale files',
                    description: `Remove ${unused.length} unused key(s) from this and all other locale files.`,
                },
                {
                    label: 'Cancel',
                    description: 'Do not remove keys.',
                },
            ],
            {
                placeHolder: `AI Localizer: Remove ${unused.length} unused key(s) found in this file?`,
            },
        );
        if (!choice || choice.label === 'Cancel') {
            return;
        }

        const applyToAllLocales = choice.label === 'Remove unused keys in all locale files';

        // Acquire lock before modifying files
        const result = await operationLock.withGlobalLock(
            'cleanup-unused',
            'Cleanup Unused Keys',
            async () => {
                // Re-read the file to get fresh content (avoid stale data)
                let freshRoot: any = {};
                try {
                    const freshDoc = await vscode.workspace.openTextDocument(targetUri);
                    const text = freshDoc.getText();
                    const parsed = JSON.parse(text);
                    if (parsed && typeof parsed === 'object') freshRoot = parsed;
                } catch {}
                if (!freshRoot || typeof freshRoot !== 'object' || Array.isArray(freshRoot)) {
                    freshRoot = {};
                }

                const deletedKeys = new Set<string>();
                for (const item of unused) {
                    if (!item || typeof item.keyPath !== 'string') continue;
                    if (deleteKeyPathInObject(freshRoot, item.keyPath)) {
                        deletedKeys.add(item.keyPath);
                    }
                }

                if (!deletedKeys.size) {
                    return { deletedKeys, deletedFromOtherFiles: 0 };
                }

                await operationLock.withFileLock(targetUri, 'cleanup-unused', async () => {
                    await writeJsonFile(targetUri, freshRoot);
                });

                await this.i18nIndex.updateFile(targetUri);
                await vscode.commands.executeCommand(
                    'ai-localizer.i18n.refreshFileDiagnostics',
                    targetUri,
                    Array.from(deletedKeys),
                );

                let deletedFromOtherFiles = 0;

                if (applyToAllLocales && deletedKeys.size > 0) {
                    await this.i18nIndex.ensureInitialized();
                    for (const keyPath of deletedKeys) {
                        const record = this.i18nIndex.getRecord(keyPath);
                        if (!record) continue;
                        const otherUris = record.locations
                            .map((l) => l.uri)
                            .filter((u) => u.toString() !== targetUri.toString());
                        if (!otherUris.length) continue;
                        deletedFromOtherFiles += await this.deleteKeyFromLocaleFiles(keyPath, otherUris);
                    }
                }

                return { deletedKeys, deletedFromOtherFiles };
            }
        );

        if (!result) {
            return;
        }

        const { deletedKeys, deletedFromOtherFiles } = result;

        if (!deletedKeys.size) {
            vscode.window.showInformationMessage(
                'AI Localizer: No unused keys were removed from this file.',
            );
            return;
        }

        if (deletedFromOtherFiles > 0) {
            vscode.window.showInformationMessage(
                `AI Localizer: Removed ${deletedKeys.size} unused key(s) from this file and cleaned up unused keys in ${deletedFromOtherFiles} other locale file(s).`,
            );
        } else {
            vscode.window.showInformationMessage(
                `AI Localizer: Removed ${deletedKeys.size} unused key(s) from this file.`,
            );
        }
    }

    /**
     * Remove a single unused key from a locale file
     */
    async removeUnusedKeyInFile(documentUri: vscode.Uri, keyPath: string): Promise<void> {
        if (!documentUri) {
            vscode.window.showInformationMessage(
                'AI Localizer: No document provided to remove unused key.',
            );
            return;
        }

        const doc = await vscode.workspace.openTextDocument(documentUri);
        if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
            vscode.window.showInformationMessage(
                'AI Localizer: Remove unused key only applies to locale JSON files.',
            );
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

        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-unused-report.json');

        let rawReport: string;
        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            rawReport = sharedDecoder.decode(data);
        } catch {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Generate report',
                        description:
                            'Run i18n:cleanup-unused script now to analyze and generate the unused keys report.',
                    },
                    { label: 'Cancel', description: 'Skip removing this unused key for now.' },
                ],
                {
                    placeHolder:
                        'AI Localizer: Unused keys report not found. Generate it by running the cleanup script?',
                },
            );
            if (!choice || choice.label !== 'Generate report') {
                return;
            }
            await runI18nScript('i18n:cleanup-unused');
            vscode.window.showInformationMessage(
                'AI Localizer: Running i18n:cleanup-unused script in a terminal. Re-run this quick fix after it completes.',
            );
            return;
        }

        let report: any;
        try {
            report = JSON.parse(rawReport);
        } catch {
            vscode.window.showErrorMessage(
                'AI Localizer: Unused keys report is not valid JSON.',
            );
            return;
        }

        const unused = Array.isArray(report.unused) ? report.unused : [];
        const hasEntry = unused.some(
            (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === keyPath,
        );
        if (!hasEntry) {
            vscode.window.showInformationMessage(
                `AI Localizer: Key ${keyPath} is not marked as unused in unused keys report.`,
            );
        }

        let root: any = await readJsonFile(documentUri) || {};
        if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

        if (!deleteKeyPathInObject(root, keyPath)) {
            vscode.window.showInformationMessage(
                `AI Localizer: Key ${keyPath} was not found in this file.`,
            );
            return;
        }

        await writeJsonFile(documentUri, root);

        await this.i18nIndex.updateFile(documentUri);
        await vscode.commands.executeCommand(
            'ai-localizer.i18n.refreshFileDiagnostics',
            documentUri,
            [keyPath],
        );

        vscode.window.showInformationMessage(
            `AI Localizer: Removed unused key ${keyPath} from this file.`,
        );
    }

    /**
     * Restore invalid keys in a locale file
     */
    async restoreInvalidInFile(documentUri?: vscode.Uri): Promise<void> {
        const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            vscode.window.showInformationMessage(
                'AI Localizer: No active document to cleanup invalid keys.',
            );
            return;
        }

        // Check if another operation is blocking
        if (!(await this.canProceed('cleanup-invalid', 'Restore Invalid Keys'))) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(targetUri);
        if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
            vscode.window.showInformationMessage(
                'AI Localizer: Restore invalid keys only applies to locale JSON files.',
            );
            return;
        }

        let folder = vscode.workspace.getWorkspaceFolder(targetUri) ?? undefined;
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-invalid-report.json');

        let rawReport: string;
        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            rawReport = sharedDecoder.decode(data);
        } catch {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Generate report',
                        description:
                            'Run i18n:restore-invalid script now to analyze and generate the invalid keys report.',
                    },
                    { label: 'Cancel', description: 'Skip cleaning up invalid keys for now.' },
                ],
                {
                    placeHolder:
                        'AI Localizer: Invalid keys report not found. Generate it by running the restore-invalid script?',
                },
            );
            if (!choice || choice.label !== 'Generate report') {
                return;
            }
            await runI18nScript('i18n:restore-invalid');
            vscode.window.showInformationMessage(
                'AI Localizer: Running i18n:restore-invalid script in a terminal. Re-run this quick fix after it completes.',
            );
            return;
        }

        let report: any;
        try {
            report = JSON.parse(rawReport);
        } catch {
            vscode.window.showErrorMessage(
                'AI Localizer: Invalid keys report is not valid JSON.',
            );
            return;
        }

        const allInvalid = Array.isArray(report.invalid) ? report.invalid : [];
        if (!allInvalid.length) {
            vscode.window.showInformationMessage(
                'AI Localizer: No invalid/non-translatable keys found in invalid keys report.',
            );
            return;
        }

        let root: any = {};
        try {
            const text = doc.getText();
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') root = parsed;
        } catch {}
        if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

        const invalid = allInvalid.filter((item: any) => {
            if (!item || typeof item.keyPath !== 'string') return false;
            return hasKeyPathInObject(root, item.keyPath);
        });

        if (!invalid.length) {
            vscode.window.showInformationMessage(
                'AI Localizer: No invalid/non-translatable keys from report were found in this file.',
            );
            return;
        }

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: 'Restore code references and remove from this file',
                    description: `Restore inline strings in code and remove ${invalid.length} invalid key(s) from this locale file only.`,
                },
                {
                    label: 'Cancel',
                    description: 'Do not change code or locale files.',
                },
            ],
            {
                placeHolder: `AI Localizer: Restore ${invalid.length} invalid key(s) found in this file to inline strings?`,
            },
        );
        if (!choice || choice.label === 'Cancel') {
            return;
        }

        // Acquire lock for the modification operations
        const result = await operationLock.withGlobalLock(
            'cleanup-invalid',
            'Restore Invalid Keys',
            async () => {
                let codeRestoreCount = 0;
                for (const item of invalid) {
                    if (!item || typeof item.keyPath !== 'string') continue;
                    const usages = Array.isArray(item.usages) ? item.usages : [];
                    const baseValue = typeof item.baseValue === 'string' ? item.baseValue : '';

                    for (const usage of usages) {
                        if (!usage || typeof usage.file !== 'string' || typeof usage.line !== 'number') continue;
                        const codeFileUri = vscode.Uri.joinPath(folder!.uri, usage.file);
                        try {
                            const restored = await this.restoreInlineStringInFile(
                                codeFileUri,
                                item.keyPath,
                                baseValue,
                                usage.line - 1,
                            );
                            if (restored) {
                                codeRestoreCount++;
                            }
                        } catch (err) {
                            console.error(`AI Localizer: Failed to restore code reference for ${item.keyPath} in ${usage.file}:`, err);
                        }
                    }
                }

                // Re-read the file to get fresh content
                let freshRoot: any = {};
                try {
                    const freshDoc = await vscode.workspace.openTextDocument(targetUri);
                    const text = freshDoc.getText();
                    const parsed = JSON.parse(text);
                    if (parsed && typeof parsed === 'object') freshRoot = parsed;
                } catch {}
                if (!freshRoot || typeof freshRoot !== 'object' || Array.isArray(freshRoot)) {
                    freshRoot = {};
                }

                // Verify that keys are safe to delete by checking for current usages
                const deletedKeys = new Set<string>();
                const keysStillInUse: string[] = [];
                
                for (const item of invalid) {
                    if (!item || typeof item.keyPath !== 'string') continue;
                    
                    // Check if the key still has any references in the codebase
                    await this.i18nIndex.ensureInitialized();
                    const record = this.i18nIndex.getRecord(item.keyPath);
                    
                    // If the key has a record and it's used in code, don't delete it
                    if (record && record.locations && record.locations.length > 0) {
                        // The key is still referenced in locale files, check if it's actually used in code
                        // We need to scan the codebase to check for actual usages
                        const hasCurrentUsages = await this.checkKeyUsageInCode(folder!, item.keyPath);
                        
                        if (hasCurrentUsages) {
                            keysStillInUse.push(item.keyPath);
                            continue; // Skip deletion for this key
                        }
                    }
                    
                    if (deleteKeyPathInObject(freshRoot, item.keyPath)) {
                        deletedKeys.add(item.keyPath);
                    }
                }

                if (deletedKeys.size > 0) {
                    await operationLock.withFileLock(targetUri, 'cleanup-invalid', async () => {
                        await writeJsonFile(targetUri, freshRoot);
                    });

                    await this.i18nIndex.updateFile(targetUri);
                    await vscode.commands.executeCommand(
                        'ai-localizer.i18n.refreshFileDiagnostics',
                        targetUri,
                        Array.from(deletedKeys),
                    );
                }

                return { codeRestoreCount, deletedKeys, keysStillInUse };
            }
        );

        if (!result) {
            return;
        }

        const { codeRestoreCount, deletedKeys, keysStillInUse } = result;
        
        let message = codeRestoreCount > 0
            ? `AI Localizer: Restored ${codeRestoreCount} code reference(s) and removed ${deletedKeys.size} invalid key(s) from this file.`
            : `AI Localizer: Removed ${deletedKeys.size} invalid/non-translatable key(s) from this file.`;
        
        if (keysStillInUse && keysStillInUse.length > 0) {
            message += ` Note: ${keysStillInUse.length} key(s) skipped because they are still in use.`;
        }
        
        vscode.window.showInformationMessage(message);
    }

    /**
     * Check if a key is currently used in source code
     */
    private async checkKeyUsageInCode(
        folder: vscode.WorkspaceFolder,
        keyPath: string,
    ): Promise<boolean> {
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const sourceGlobs = cfg.get<string[]>('i18n.sourceGlobs') || ['**/*.{ts,tsx,js,jsx,vue}'];
        const excludeGlobs = cfg.get<string[]>('i18n.sourceExcludeGlobs') || [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/build/**',
        ];

        // Search patterns for the key
        const searchPatterns = [
            `t('${keyPath}'`,
            `t("${keyPath}"`,
            `$t('${keyPath}'`,
            `$t("${keyPath}"`,
        ];

        const exclude = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;

        const seen = new Set<string>();
        const uris: vscode.Uri[] = [];
        const includes = sourceGlobs.length > 0 ? sourceGlobs : [];

        for (const include of includes) {
            try {
                const pattern = new vscode.RelativePattern(folder, include);
                const found = await vscode.workspace.findFiles(pattern, exclude, 100);
                for (const uri of found) {
                    const key = uri.toString();
                    if (!seen.has(key)) {
                        seen.add(key);
                        uris.push(uri);
                    }
                }
            } catch {
                // Skip invalid glob patterns
            }
        }

        for (const uri of uris) {
            try {
                const data = await vscode.workspace.fs.readFile(uri);
                const content = new TextDecoder().decode(data);

                for (const searchPattern of searchPatterns) {
                    if (content.includes(searchPattern)) {
                        return true; // Key is still in use
                    }
                }
            } catch {
                // Skip files that can't be read
            }
        }

        return false; // Key not found in any source files
    }

    /**
     * Restore a single t('key') call to an inline string in a specific file
     */
    private async restoreInlineStringInFile(
        fileUri: vscode.Uri,
        keyPath: string,
        baseValue: string,
        lineNumber: number,
    ): Promise<boolean> {
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const lineText = doc.lineAt(lineNumber).text;

            const escapedKey = keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const patterns = [
                new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*\\)`, 'g'),
                new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*,\\s*\\{[^}]*\\}\\s*\\)`, 'g'),
            ];

            let newLineText = lineText;
            let replaced = false;

            const placeholderRegex = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)\}/g;
            const hasPlaceholders = placeholderRegex.test(baseValue);

            let replacement: string;
            if (hasPlaceholders) {
                const escaped = baseValue
                    .replace(/`/g, '\\`')
                    .replace(/\$/g, '\\$');
                replacement = `\`${escaped}\``;
            } else {
                const escaped = baseValue
                    .replace(/\\/g, '\\\\')
                    .replace(/'/g, "\\'")
                    .replace(/\r?\n/g, '\\n');
                replacement = `'${escaped}'`;
            }

            for (const pattern of patterns) {
                if (pattern.test(newLineText)) {
                    newLineText = newLineText.replace(pattern, replacement);
                    replaced = true;
                    break;
                }
            }

            if (!replaced) return false;

            const edit = new vscode.WorkspaceEdit();
            const lineRange = doc.lineAt(lineNumber).range;
            edit.replace(fileUri, lineRange, newLineText);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
            }
            return applied;
        } catch (err) {
            console.error(`AI Localizer: Failed to restore inline string in ${fileUri.fsPath}:`, err);
            return false;
        }
    }

    /**
     * Remove an invalid key from a locale file
     */
    async removeInvalidKeyInFile(documentUri: vscode.Uri, keyPath: string): Promise<void> {
        if (!documentUri) {
            vscode.window.showInformationMessage(
                'AI Localizer: No document provided to remove invalid key.',
            );
            return;
        }

        const doc = await vscode.workspace.openTextDocument(documentUri);
        if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
            vscode.window.showInformationMessage(
                'AI Localizer: Remove invalid key only applies to locale JSON files.',
            );
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

        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-invalid-report.json');

        let rawReport: string;
        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            rawReport = sharedDecoder.decode(data);
        } catch {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Generate report',
                        description:
                            'Run i18n:restore-invalid script now to analyze and generate the invalid keys report.',
                    },
                    { label: 'Cancel', description: 'Skip removing this invalid key for now.' },
                ],
                {
                    placeHolder:
                        'AI Localizer: Invalid keys report not found. Generate it by running the restore-invalid script?',
                },
            );
            if (!choice || choice.label !== 'Generate report') {
                return;
            }
            await runI18nScript('i18n:restore-invalid');
            vscode.window.showInformationMessage(
                'AI Localizer: Running i18n:restore-invalid script in a terminal. Re-run this quick fix after it completes.',
            );
            return;
        }

        let report: any;
        try {
            report = JSON.parse(rawReport);
        } catch {
            vscode.window.showErrorMessage(
                'AI Localizer: Invalid keys report is not valid JSON.',
            );
            return;
        }

        const invalid = Array.isArray(report.invalid) ? report.invalid : [];
        const entry = invalid.find(
            (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === keyPath,
        );
        if (!entry) {
            vscode.window.showInformationMessage(
                `AI Localizer: Key ${keyPath} is not marked as invalid/non-translatable in invalid keys report.`,
            );
            return;
        }

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: 'Restore code references and remove from locale files',
                    description: `Restore inline string in code and remove ${keyPath} from all locale files.`,
                },
                {
                    label: 'Cancel',
                    description: 'Do not change code or locale files.',
                },
            ],
            {
                placeHolder: `AI Localizer: Restore invalid key ${keyPath} to inline string and remove from locale files?`,
            },
        );
        if (!choice || choice.label === 'Cancel') {
            return;
        }

        // Safety check for keys in use
        const usages = Array.isArray(entry.usages) ? entry.usages : [];
        if (usages.length > 0) {
            const safetyChoice = await vscode.window.showWarningMessage(
                `AI Localizer: Key "${keyPath}" is marked as invalid but is being used in ${usages.length} location(s) in code. ` +
                `This may be from an outdated report. Removing it would break the application. ` +
                `Please regenerate the invalid keys report. Do you want to cancel this operation?`,
                { modal: true },
                'Cancel',
                'Remove from locale files only (risky)',
            );
            if (!safetyChoice || safetyChoice === 'Cancel') {
                return;
            }
        }

        // Remove from this locale file
        let root: any = await readJsonFile(documentUri) || {};
        if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

        if (deleteKeyPathInObject(root, keyPath)) {
            await writeJsonFile(documentUri, root);

            await this.i18nIndex.updateFile(documentUri);
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.refreshFileDiagnostics',
                documentUri,
                [keyPath],
            );
        }

        // Also remove from other locale files
        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(keyPath);
        if (record) {
            const otherUris = record.locations
                .map((l) => l.uri)
                .filter((u) => u.toString() !== documentUri.toString());
            if (otherUris.length) {
                await this.deleteKeyFromLocaleFiles(keyPath, otherUris);
            }
        }

        vscode.window.showInformationMessage(
            `AI Localizer: Removed invalid/non-translatable key ${keyPath} from locale files.`,
        );
    }

    /**
     * Restore invalid key in code
     */
    async restoreInvalidKeyInCode(
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

        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-invalid-report.json');

        let rawReport: string;
        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            rawReport = sharedDecoder.decode(data);
        } catch {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Generate report',
                        description:
                            'Run i18n:restore-invalid script now to analyze and generate the invalid keys report.',
                    },
                    { label: 'Cancel', description: 'Skip restoring this key for now.' },
                ],
                {
                    placeHolder:
                        'AI Localizer: Invalid keys report not found. Generate it by running the restore-invalid script?',
                },
            );
            if (!choice || choice.label !== 'Generate report') {
                return;
            }
            await runI18nScript('i18n:restore-invalid');
            vscode.window.showInformationMessage(
                'AI Localizer: Running i18n:restore-invalid script in a terminal. Re-run this quick fix after it completes.',
            );
            return;
        }

        let report: any;
        try {
            report = JSON.parse(rawReport);
        } catch {
            vscode.window.showErrorMessage(
                'AI Localizer: Invalid keys report is not valid JSON.',
            );
            return;
        }

        const invalid = Array.isArray(report.invalid) ? report.invalid : [];
        const entry = invalid.find(
            (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === key,
        );
        if (!entry || typeof entry.baseValue !== 'string') {
            vscode.window.showInformationMessage(
                `AI Localizer: No invalid/non-translatable entry found in invalid keys report for key ${key}.`,
            );
            return;
        }

        const baseValue = String(entry.baseValue || '');

        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(key);
        const localeUris = record ? record.locations.map((l) => l.uri) : [];

        let shouldDeleteFromLocales = false;
        if (localeUris.length) {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Restore and delete from locale files',
                        description: `Remove ${key} from ${localeUris.length} locale file(s) after restoring inline string.`,
                    },
                    {
                        label: 'Cancel',
                        description: 'Do not change code or locale files.',
                    },
                ],
                {
                    placeHolder: `AI Localizer: Restore invalid key ${key} and delete it from locale files?`,
                },
            );
            if (!choice || choice.label === 'Cancel') {
                return;
            }
            shouldDeleteFromLocales = true;
        }

        // Use regex-based replacement
        const lineText = doc.lineAt(position.line).text;
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const patterns = [
            new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*\\)`, 'g'),
            new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*,\\s*\\{[^}]*\\}\\s*\\)`, 'g'),
        ];

        let newLineText = lineText;
        let replaced = false;

        const placeholderRegex = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)\}/g;
        const hasPlaceholders = placeholderRegex.test(baseValue);

        let replacement: string;
        if (hasPlaceholders) {
            const escaped = baseValue
                .replace(/`/g, '\\`')
                .replace(/\$/g, '\\$');
            replacement = `\`${escaped}\``;
        } else {
            const escaped = baseValue
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "\\'")
                .replace(/\r?\n/g, '\\n');
            replacement = `'${escaped}'`;
        }

        for (const pattern of patterns) {
            if (pattern.test(newLineText)) {
                newLineText = newLineText.replace(pattern, replacement);
                replaced = true;
                break;
            }
        }

        if (!replaced) {
            vscode.window.showInformationMessage(
                `AI Localizer: No matching t('${key}') call found at this location to restore.`,
            );
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        const lineRange = doc.lineAt(position.line).range;
        edit.replace(documentUri, lineRange, newLineText);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showErrorMessage(
                'AI Localizer: Failed to apply restore quick fix edit to source file.',
            );
            return;
        }

        await doc.save();

        let deletedFromLocales = 0;
        if (shouldDeleteFromLocales && localeUris.length) {
            deletedFromLocales = await this.deleteKeyFromLocaleFiles(key, localeUris);
        }

        if (deletedFromLocales > 0) {
            vscode.window.showInformationMessage(
                `AI Localizer: Restored inline string for invalid/non-translatable key ${key} at this location and removed it from ${deletedFromLocales} locale file(s).`,
            );
        } else {
            vscode.window.showInformationMessage(
                `AI Localizer: Restored inline string for invalid/non-translatable key ${key} at this location.`,
            );
        }
    }
}

