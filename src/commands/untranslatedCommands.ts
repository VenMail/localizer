import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { setTranslationValue, setTranslationValueInFile } from '../core/i18nFs';
import { pickWorkspaceFolder } from '../core/workspace';
import { TextDecoder, TextEncoder } from 'util';

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

    private async setMultipleInFile(fileUri: vscode.Uri, updates: Map<string, string>): Promise<void> {
        const decoder = new TextDecoder('utf-8');
        const encoder = new TextEncoder();
        let root: any = {};
        try {
            const data = await vscode.workspace.fs.readFile(fileUri);
            const raw = decoder.decode(data);
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') root = parsed;
        } catch {}
        if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

        const ensureDeepContainer = (obj: any, segments: string[]) => {
            let node: any = obj;
            for (const seg of segments) {
                if (!node || typeof node !== 'object') break;
                if (
                    !Object.prototype.hasOwnProperty.call(node, seg) ||
                    typeof node[seg] !== 'object' ||
                    Array.isArray(node[seg])
                ) {
                    node[seg] = {};
                }
                node = node[seg];
            }
            return node;
        };

        for (const [fullKey, value] of updates.entries()) {
            const segments = fullKey.split('.').filter(Boolean);
            const container = ensureDeepContainer(root, segments.slice(0, -1));
            const last = segments[segments.length - 1];
            container[last] = value;
        }

        const payload = `${JSON.stringify(root, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(payload));
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

            // First: sync missing keys with default placeholder values
            for (const locale of targetLocales) {
                const current = record.locales.get(locale);
                if (typeof current !== 'string' || !current.trim()) {
                    await setTranslationValue(folder, locale, key, defaultValue);
                }
            }

            // Reindex after placeholder sync so Problems panel updates immediately
            await this.i18nIndex.ensureInitialized(true);

            const translations = await this.translationService.translateToLocales(
                defaultValue,
                defaultLocale,
                targetLocales,
                'text',
                true,
            );

            if (!translations || translations.size === 0) {
                const choice = await vscode.window.showInformationMessage(
                    'AI i18n: No translations were generated for this quick fix (check API key and settings).',
                    'Open OpenAI API Key Settings',
                    'Dismiss',
                );
                if (choice === 'Open OpenAI API Key Settings') {
                    await vscode.commands.executeCommand('ai-assistant.setOpenAiApiKeySecret');
                }
                // No AI translations, but placeholders were applied already; reindex and rescan
                await this.i18nIndex.ensureInitialized(true);
                await vscode.commands.executeCommand('ai-assistant.i18n.rescan');
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

    private parseStyleDiagnostic(message: string): { key: string; locale: string; suggested: string } | null {
        if (!message) return null;
        const clean = String(message).replace(/^AI i18n:\s*/, '');
        const m = clean.match(/^Style suggestion for key\s+(.+?)\s+in locale\s+([A-Za-z0-9_-]+)\s*\(([^)]*)\)/);
        if (!m) return null;
        const key = m[1].trim();
        const locale = m[2].trim();
        const details = m[3] || '';
        const sugMatch = details.match(/suggested:\s*([^|)]+)/i);
        const suggested = sugMatch ? sugMatch[1].trim() : '';
        if (!key || !locale || !suggested) return null;
        return { key, locale, suggested };
    }

    async applyStyleSuggestionQuickFix(
        documentUri: vscode.Uri,
        key: string,
        locale: string,
        suggested: string,
    ): Promise<void> {
        try {
            // Write directly into the file where the diagnostic originated
            await setTranslationValueInFile(documentUri, key, suggested);
            // Incrementally update index for just this file
            await this.i18nIndex.updateFile(documentUri);
            // Refresh diagnostics only for this file, focusing on the changed key
            await vscode.commands.executeCommand('ai-assistant.i18n.refreshFileDiagnostics', documentUri, [key]);

            vscode.window.showInformationMessage(
                `AI i18n: Applied style suggestion for ${key} in ${locale}.`,
            );
        } catch (err) {
            console.error('AI i18n: Failed to apply style suggestion quick fix:', err);
            vscode.window.showErrorMessage(
                'AI i18n: Failed to apply style suggestion quick fix.',
            );
        }
    }

    async applyAllStyleSuggestionsInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage('AI i18n: No active document to apply style suggestions.');
                return;
            }

            let folder = vscode.workspace.getWorkspaceFolder(targetUri) ?? undefined;
            if (!folder) {
                folder = await pickWorkspaceFolder();
            }
            if (!folder) {
                vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
                return;
            }

            const diags = vscode.languages
                .getDiagnostics(targetUri)
                .filter((d) => String(d.code) === 'ai-i18n.style');

            if (!diags.length) {
                vscode.window.showInformationMessage('AI i18n: No style suggestions found for this file.');
                return;
            }

            const suggestions: { key: string; locale: string; suggested: string }[] = [];
            for (const d of diags) {
                const parsed = this.parseStyleDiagnostic(String(d.message || ''));
                if (parsed) suggestions.push(parsed);
            }

            if (!suggestions.length) {
                vscode.window.showInformationMessage('AI i18n: No parsable style suggestions in diagnostics.');
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

            // Fast path: single read/write for this file
            const updatesMap = new Map<string, string>();
            for (const s of unique) updatesMap.set(s.key, s.suggested);
            await this.setMultipleInFile(targetUri, updatesMap);
            // Incremental reindex and diagnostics refresh for this file only
            await this.i18nIndex.updateFile(targetUri);
            await vscode.commands.executeCommand('ai-assistant.i18n.refreshFileDiagnostics', targetUri, Array.from(updatesMap.keys()));

            vscode.window.showInformationMessage(
                `AI i18n: Applied ${unique.length} style suggestion(s) for this file.`,
            );
        } catch (err) {
            console.error('AI i18n: Failed to apply all style suggestions:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to apply all style suggestions for file.');
        }
    }
}
