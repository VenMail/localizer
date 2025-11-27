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

    async applyQuickFix(
        documentUri: vscode.Uri,
        key: string,
        locales: string[],
    ): Promise<void> {
        try {
            let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
            if (!folder) {
                folder = await pickWorkspaceFolder();
            }

            if (!folder) {
                vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
                return;
            }

            await this.i18nIndex.ensureInitialized();
            const record = this.i18nIndex.getRecord(key);
            if (!record) {
                vscode.window.showInformationMessage(
                    `AI i18n: No translation record found for key ${key}.`,
                );
                return;
            }

            const defaultLocale = record.defaultLocale;
            const defaultValue = record.locales.get(defaultLocale);
            if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
                vscode.window.showInformationMessage(
                    `AI i18n: Default locale value not found for key ${key}.`,
                );
                return;
            }

            const targetLocales = locales.filter((l) => l && l !== defaultLocale);
            if (!targetLocales.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No target locales to translate for this key.',
                );
                return;
            }

            const translations = await this.translationService.translateToLocales(
                defaultValue,
                defaultLocale,
                targetLocales,
                'text',
                true,
            );

            if (!translations || translations.size === 0) {
                vscode.window.showInformationMessage(
                    'AI i18n: No translations were generated for this quick fix (check API key and settings).',
                );
                return;
            }

            for (const [locale, newValue] of translations.entries()) {
                await setTranslationValue(folder, locale, key, newValue);
            }

            await this.i18nIndex.ensureInitialized(true);
            await vscode.commands.executeCommand('ai-assistant.i18n.rescan');

            vscode.window.showInformationMessage(
                `AI i18n: Applied AI translations for ${key} in ${translations.size} locale(s).`,
            );
        } catch (err) {
            console.error('AI i18n: Failed to apply quick fix for untranslated key:', err);
            vscode.window.showErrorMessage(
                'AI i18n: Failed to apply AI quick fix for untranslated key.',
            );
        }
    }
}
