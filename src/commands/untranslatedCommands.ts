import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { setTranslationValue } from '../core/i18nFs';
import { pickWorkspaceFolder } from '../core/workspace';
import { TextDecoder } from 'util';

/**
 * Commands for handling untranslated strings
 */
export class UntranslatedCommands {
    constructor(
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
    ) {}

    async openReport(): Promise<void> {
        const active = vscode.window.activeTextEditor;
        let folder = active
            ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
            : undefined;
        
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }

        if (!folder) {
            vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
            return;
        }

        const reportUri = vscode.Uri.file(
            path.join(folder.uri.fsPath, 'scripts', '.i18n-untranslated-report.json'),
        );

        try {
            const doc = await vscode.workspace.openTextDocument(reportUri);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch {
            vscode.window.showInformationMessage(
                'AI i18n: Untranslated report not found. Run the fix-untranslated script first.',
            );
        }
    }

    async applyAiFixes(): Promise<void> {
        const active = vscode.window.activeTextEditor;
        let folder = active
            ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
            : undefined;
        
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }

        if (!folder) {
            vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
            return;
        }

        const reportUri = vscode.Uri.file(
            path.join(folder.uri.fsPath, 'scripts', '.i18n-untranslated-report.json'),
        );

        const decoder = new TextDecoder('utf-8');
        let raw: string;

        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            raw = decoder.decode(data);
        } catch {
            vscode.window.showInformationMessage(
                'AI i18n: Untranslated report not found. Run the fix-untranslated script before applying AI fixes.',
            );
            return;
        }

        let report: any;
        try {
            report = JSON.parse(raw);
        } catch {
            vscode.window.showErrorMessage('AI i18n: Untranslated report is not valid JSON.');
            return;
        }

        const issues = Array.isArray(report.issues) ? report.issues : [];
        if (!issues.length) {
            vscode.window.showInformationMessage('AI i18n: No issues found in untranslated report.');
            return;
        }

        try {
            const updates = await this.translationService.getUntranslatedFixes(
                issues,
                report.aiInstructions,
            );

            if (!updates.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No valid translation updates returned by AI.',
                );
                return;
            }

            // Preview updates
            try {
                const previewDoc = await vscode.workspace.openTextDocument({
                    language: 'json',
                    content: JSON.stringify({ updates }, null, 2),
                } as any);
                await vscode.window.showTextDocument(previewDoc, { preview: false });
            } catch {
                // Preview failed, continue
            }

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Apply',
                        description: `Write ${updates.length} translation updates to locale files`,
                    },
                    { label: 'Cancel', description: 'Discard AI suggestions' },
                ],
                { placeHolder: 'Apply AI translation suggestions from untranslated report?' },
            );

            if (!choice || choice.label !== 'Apply') {
                return;
            }

            for (const u of updates) {
                await setTranslationValue(folder, u.locale, u.keyPath, u.newValue);
            }

            await this.i18nIndex.ensureInitialized(true);
            vscode.window.showInformationMessage(
                `AI i18n: Applied ${updates.length} AI translation updates.`,
            );
        } catch (err) {
            console.error('Failed to apply AI fixes:', err);
            vscode.window.showErrorMessage(`AI i18n: Failed to apply AI fixes. ${err}`);
        }
    }
}
