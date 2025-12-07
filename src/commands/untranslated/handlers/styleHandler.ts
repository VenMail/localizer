import * as vscode from 'vscode';
import { I18nIndex } from '../../../core/i18nIndex';
import { setTranslationValueInFile } from '../../../core/i18nFs';
import { pickWorkspaceFolder } from '../../../core/workspace';
import { setMultipleInFile } from '../utils/jsonUtils';
import { parseStyleDiagnostic } from '../utils/diagnosticParser';
import { operationLock, OperationType } from '../utils/operationLock';

export class StyleHandler {
    constructor(private i18nIndex: I18nIndex) {}

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
     * Apply a style suggestion quick fix
     */
    async applyStyleSuggestionQuickFix(
        documentUri: vscode.Uri,
        key: string,
        locale: string,
        suggested: string,
    ): Promise<void> {
        try {
            await setTranslationValueInFile(documentUri, key, suggested);
            await this.i18nIndex.updateFile(documentUri);
            await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', documentUri, [key]);

            vscode.window.showInformationMessage(
                `AI Localizer: Applied style suggestion for ${key} in ${locale}.`,
            );
        } catch (err) {
            console.error('AI Localizer: Failed to apply style suggestion quick fix:', err);
            vscode.window.showErrorMessage(
                'AI Localizer: Failed to apply style suggestion quick fix.',
            );
        }
    }

    /**
     * Apply all style suggestions in a locale file
     */
    async applyAllStyleSuggestionsInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage('AI Localizer: No active document to apply style suggestions.');
                return;
            }

            // Check if another operation is blocking
            if (!(await this.canProceed('style-fix', 'Apply All Style Suggestions'))) {
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

            const diags = vscode.languages
                .getDiagnostics(targetUri)
                .filter((d) => String(d.code) === 'ai-i18n.style');

            if (!diags.length) {
                vscode.window.showInformationMessage('AI Localizer: No style suggestions found for this file.');
                return;
            }

            const suggestions: { key: string; locale: string; suggested: string }[] = [];
            for (const d of diags) {
                const parsed = parseStyleDiagnostic(String(d.message || ''));
                if (parsed) suggestions.push(parsed);
            }

            if (!suggestions.length) {
                vscode.window.showInformationMessage('AI Localizer: No parsable style suggestions in diagnostics.');
                return;
            }

            // Deduplicate by locale+key
            const uniqueMap = new Map<string, { key: string; locale: string; suggested: string }>();
            for (const s of suggestions) {
                uniqueMap.set(`${s.locale}::${s.key}`, s);
            }
            const unique = Array.from(uniqueMap.values());

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Apply',
                        description: `Write ${unique.length} style suggestion(s) to locale files`,
                    },
                    { label: 'Cancel', description: 'Do not apply suggestions' },
                ],
                { placeHolder: 'Apply all AI i18n style suggestions for this file?' },
            );
            if (!choice || choice.label !== 'Apply') {
                return;
            }

            const updatesMap = new Map<string, string>();
            for (const s of unique) updatesMap.set(s.key, s.suggested);
            await setMultipleInFile(targetUri, updatesMap);

            await this.i18nIndex.updateFile(targetUri);
            await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', targetUri, Array.from(updatesMap.keys()));

            vscode.window.showInformationMessage(
                `AI Localizer: Applied ${unique.length} style suggestion(s) for this file.`,
            );
        } catch (err) {
            console.error('AI Localizer: Failed to apply all style suggestions:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to apply all style suggestions for file.');
        }
    }

    /**
     * Fix all issues in a locale file
     */
    async fixAllIssuesInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No active document to fix i18n issues.',
                );
                return;
            }

            // Check if another operation is blocking
            if (!(await this.canProceed('style-fix', 'Fix All i18n Issues'))) {
                return;
            }

            const doc = await vscode.workspace.openTextDocument(targetUri);
            if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                vscode.window.showInformationMessage(
                    'AI Localizer: Fix-all only applies to locale JSON files.',
                );
                return;
            }

            await vscode.commands.executeCommand('ai-localizer.i18n.runSyncScript');

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Run all per-file fixes',
                        description:
                            'Bulk-translate, cleanup unused keys, remove invalid keys, and apply style suggestions (each step will confirm).',
                    },
                    {
                        label: 'Cancel',
                        description: 'Do not change this file.',
                    },
                ],
                {
                    placeHolder:
                        'AI Localizer: Run all per-file i18n fixes for this locale file?',
                },
            );
            if (!choice || choice.label !== 'Run all per-file fixes') {
                return;
            }

            // Fix issues in the correct order to avoid recursion:
            // 1. Restore invalid keys first (removes them from code and locale files)
            // 2. Translate untranslated keys (for remaining valid keys)
            // 3. Cleanup unused keys (after translations are added)
            // 4. Apply style suggestions (final cleanup)
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.restoreInvalidKeysInFile',
                targetUri,
            );
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.translateAllUntranslatedInFile',
                targetUri,
            );
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.cleanupUnusedKeysInFile',
                targetUri,
            );
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.applyAllStyleSuggestionsInFile',
                targetUri,
            );
        } catch (err) {
            console.error('AI Localizer: Failed to run all per-file fixes for file:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to run all per-file fixes for file.');
        }
    }
}

