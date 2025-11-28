import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { setTranslationValue, setTranslationValueInFile } from '../core/i18nFs';
import { pickWorkspaceFolder, runI18nScript } from '../core/workspace';
import { TextDecoder, TextEncoder } from 'util';

let parseSync: any;
let MagicString: any;

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

    private deleteKeyPathInObject(obj: any, keyPath: string): boolean {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
        const segments = String(keyPath).split('.').filter(Boolean);
        if (!segments.length) return false;

        const helper = (target: any, index: number): boolean => {
            if (!target || typeof target !== 'object' || Array.isArray(target)) {
                return false;
            }
            const key = segments[index];
            if (index === segments.length - 1) {
                if (!Object.prototype.hasOwnProperty.call(target, key)) {
                    return false;
                }
                delete target[key];
                return Object.keys(target).length === 0;
            }
            if (!Object.prototype.hasOwnProperty.call(target, key)) {
                return false;
            }
            const child = target[key];
            const shouldDeleteChild = helper(child, index + 1);
            if (shouldDeleteChild) {
                delete target[key];
            }
            return Object.keys(target).length === 0;
        };

        helper(obj, 0);
        return true;
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
                    await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
                }
                // No AI translations, but placeholders were applied already; reindex and rescan
                await this.i18nIndex.ensureInitialized(true);
                await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
                return;
            }

            for (const [locale, newValue] of translations.entries()) {
                await setTranslationValue(folder, locale, key, newValue);
            }

            await this.i18nIndex.ensureInitialized(true);
            await vscode.commands.executeCommand('ai-localizer.i18n.rescan');

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

    async generateAutoIgnore(): Promise<void> {
        try {
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

            await this.i18nIndex.ensureInitialized();

            const allKeys = this.i18nIndex.getAllKeys();
            if (!allKeys.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No translation keys found to analyze for auto-ignore.',
                );
                return;
            }

            const candidates = new Set<string>();
            const cfg = vscode.workspace.getConfiguration('ai-localizer');
            const globalDefaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

            for (const key of allKeys) {
                const record = this.i18nIndex.getRecord(key);
                if (!record) {
                    continue;
                }
                const defaultLocale = record.defaultLocale || globalDefaultLocale;
                const baseValue = record.locales.get(defaultLocale);
                if (typeof baseValue !== 'string') {
                    continue;
                }
                const base = baseValue.trim();
                if (!base) {
                    continue;
                }

                const normalized = base.replace(/\s+/g, ' ');
                const words = normalized.split(/\s+/).filter(Boolean);
                const wordCount = words.length;
                const isTokenLike =
                    wordCount <= 3 &&
                    normalized.length <= 24 &&
                    !/[.!?]/.test(normalized);

                if (!isTokenLike) {
                    continue;
                }

                const nonDefaultLocales = Array.from(record.locales.keys()).filter(
                    (l) => l !== defaultLocale,
                );
                if (!nonDefaultLocales.length) {
                    continue;
                }

                let sameCount = 0;
                for (const locale of nonDefaultLocales) {
                    const v = record.locales.get(locale);
                    if (typeof v === 'string' && v.trim() === base) {
                        sameCount += 1;
                    }
                }

                const requiredSame = nonDefaultLocales.length <= 1 ? 1 : 2;
                if (sameCount < requiredSame) {
                    continue;
                }

                candidates.add(normalized);
            }

            if (!candidates.size) {
                vscode.window.showInformationMessage(
                    'AI i18n: No constant-like values found to add to auto-ignore.',
                );
                return;
            }

            const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
            const autoUri = vscode.Uri.joinPath(scriptsDir, '.i18n-auto-ignore.json');
            const decoder = new TextDecoder('utf-8');
            const encoder = new TextEncoder();

            let existing: any = {};
            try {
                const data = await vscode.workspace.fs.readFile(autoUri);
                const raw = decoder.decode(data);
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    existing = parsed;
                }
            } catch {
            }

            const existingExact = new Set<string>(
                Array.isArray(existing.exact) ? existing.exact.map((v: any) => String(v)) : [],
            );
            const newValues: string[] = [];
            for (const value of candidates) {
                if (!existingExact.has(value)) {
                    existingExact.add(value);
                    newValues.push(value);
                }
            }

            if (!newValues.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No new auto-ignore patterns to add (all are already present).',
                );
                return;
            }

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Apply',
                        description: `Add ${newValues.length} auto-ignore pattern(s) to scripts/.i18n-auto-ignore.json`,
                    },
                    { label: 'Cancel', description: 'Do not change auto-ignore patterns' },
                ],
                { placeHolder: 'Generate AI i18n auto-ignore patterns from constant-like values?' },
            );

            if (!choice || choice.label !== 'Apply') {
                return;
            }

            existing.exact = Array.from(existingExact).sort();
            if (!Array.isArray(existing.exactInsensitive)) {
                existing.exactInsensitive = Array.isArray(existing.exactInsensitive)
                    ? existing.exactInsensitive
                    : [];
            }
            if (!Array.isArray(existing.contains)) {
                existing.contains = Array.isArray(existing.contains) ? existing.contains : [];
            }

            const payload = `${JSON.stringify(existing, null, 2)}\n`;
            await vscode.workspace.fs.createDirectory(scriptsDir);
            await vscode.workspace.fs.writeFile(autoUri, encoder.encode(payload));

            vscode.window.showInformationMessage(
                `AI i18n: Updated scripts/.i18n-auto-ignore.json with ${newValues.length} pattern(s).`,
            );

            await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
        } catch (err) {
            console.error('AI i18n: Failed to generate auto-ignore patterns:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to generate auto-ignore patterns.');
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
            await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', documentUri, [key]);

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
            await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', targetUri, Array.from(updatesMap.keys()));

            vscode.window.showInformationMessage(
                `AI i18n: Applied ${unique.length} style suggestion(s) for this file.`,
            );
        } catch (err) {
            console.error('AI i18n: Failed to apply all style suggestions:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to apply all style suggestions for file.');
        }
    }

    async cleanupUnusedInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage(
                    'AI i18n: No active document to cleanup unused keys.',
                );
                return;
            }

            const doc = await vscode.workspace.openTextDocument(targetUri);
            if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                vscode.window.showInformationMessage(
                    'AI i18n: Cleanup unused keys only applies to locale JSON files.',
                );
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

            const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
            const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-unused-report.json');
            const decoder = new TextDecoder('utf-8');

            let rawReport: string;
            try {
                const data = await vscode.workspace.fs.readFile(reportUri);
                rawReport = decoder.decode(data);
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
                            'AI i18n: Unused keys report not found. Generate it by running the cleanup script?',
                    },
                );
                if (!choice || choice.label !== 'Generate report') {
                    return;
                }
                await runI18nScript('i18n:cleanup-unused');
                vscode.window.showInformationMessage(
                    'AI i18n: Running i18n:cleanup-unused script in a terminal. Re-run this quick fix after it completes.',
                );
                return;
            }

            let report: any;
            try {
                report = JSON.parse(rawReport);
            } catch {
                vscode.window.showErrorMessage(
                    'AI i18n: Unused keys report is not valid JSON.',
                );
                return;
            }

            const unused = Array.isArray(report.unused) ? report.unused : [];
            if (!unused.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No unused keys found in unused keys report.',
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

            const deletedKeys = new Set<string>();
            for (const item of unused) {
                if (!item || typeof item.keyPath !== 'string') continue;
                const before = JSON.stringify(root);
                this.deleteKeyPathInObject(root, item.keyPath);
                const after = JSON.stringify(root);
                if (before !== after) {
                    deletedKeys.add(item.keyPath);
                }
            }

            if (!deletedKeys.size) {
                vscode.window.showInformationMessage(
                    'AI i18n: No unused keys from report were found in this file.',
                );
                return;
            }

            const encoder = new TextEncoder();
            const payload = `${JSON.stringify(root, null, 2)}\n`;
            await vscode.workspace.fs.writeFile(targetUri, encoder.encode(payload));

            await this.i18nIndex.updateFile(targetUri);
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.refreshFileDiagnostics',
                targetUri,
                Array.from(deletedKeys),
            );

            vscode.window.showInformationMessage(
                `AI i18n: Removed ${deletedKeys.size} unused key(s) from this file.`,
            );
        } catch (err) {
            console.error('AI i18n: Failed to cleanup unused keys for file:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to cleanup unused keys for file.');
        }
    }

    async restoreInvalidInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage(
                    'AI i18n: No active document to cleanup invalid keys.',
                );
                return;
            }

            const doc = await vscode.workspace.openTextDocument(targetUri);
            if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                vscode.window.showInformationMessage(
                    'AI i18n: Restore invalid keys only applies to locale JSON files.',
                );
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

            const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
            const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-invalid-report.json');
            const decoder = new TextDecoder('utf-8');

            let rawReport: string;
            try {
                const data = await vscode.workspace.fs.readFile(reportUri);
                rawReport = decoder.decode(data);
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
                            'AI i18n: Invalid keys report not found. Generate it by running the restore-invalid script?',
                    },
                );
                if (!choice || choice.label !== 'Generate report') {
                    return;
                }
                await runI18nScript('i18n:restore-invalid');
                vscode.window.showInformationMessage(
                    'AI i18n: Running i18n:restore-invalid script in a terminal. Re-run this quick fix after it completes.',
                );
                return;
            }

            let report: any;
            try {
                report = JSON.parse(rawReport);
            } catch {
                vscode.window.showErrorMessage(
                    'AI i18n: Invalid keys report is not valid JSON.',
                );
                return;
            }

            const invalid = Array.isArray(report.invalid) ? report.invalid : [];
            if (!invalid.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No invalid/non-translatable keys found in invalid keys report.',
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

            const deletedKeys = new Set<string>();
            for (const item of invalid) {
                if (!item || typeof item.keyPath !== 'string') continue;
                const before = JSON.stringify(root);
                this.deleteKeyPathInObject(root, item.keyPath);
                const after = JSON.stringify(root);
                if (before !== after) {
                    deletedKeys.add(item.keyPath);
                }
            }

            if (!deletedKeys.size) {
                vscode.window.showInformationMessage(
                    'AI i18n: No invalid/non-translatable keys from report were found in this file.',
                );
                return;
            }

            const encoder = new TextEncoder();
            const payload = `${JSON.stringify(root, null, 2)}\n`;
            await vscode.workspace.fs.writeFile(targetUri, encoder.encode(payload));

            await this.i18nIndex.updateFile(targetUri);
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.refreshFileDiagnostics',
                targetUri,
                Array.from(deletedKeys),
            );

            vscode.window.showInformationMessage(
                `AI i18n: Removed ${deletedKeys.size} invalid/non-translatable key(s) from this file.`,
            );
        } catch (err) {
            console.error('AI i18n: Failed to cleanup invalid keys for file:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to cleanup invalid keys for file.');
        }
    }

    async removeUnusedKeyInFile(documentUri: vscode.Uri, keyPath: string): Promise<void> {
        try {
            if (!documentUri) {
                vscode.window.showInformationMessage(
                    'AI i18n: No document provided to remove unused key.',
                );
                return;
            }

            const doc = await vscode.workspace.openTextDocument(documentUri);
            if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                vscode.window.showInformationMessage(
                    'AI i18n: Remove unused key only applies to locale JSON files.',
                );
                return;
            }

            let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
            if (!folder) {
                folder = await pickWorkspaceFolder();
            }
            if (!folder) {
                vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
                return;
            }

            const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
            const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-unused-report.json');
            const decoder = new TextDecoder('utf-8');

            let rawReport: string;
            try {
                const data = await vscode.workspace.fs.readFile(reportUri);
                rawReport = decoder.decode(data);
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
                            'AI i18n: Unused keys report not found. Generate it by running the cleanup script?',
                    },
                );
                if (!choice || choice.label !== 'Generate report') {
                    return;
                }
                await runI18nScript('i18n:cleanup-unused');
                vscode.window.showInformationMessage(
                    'AI i18n: Running i18n:cleanup-unused script in a terminal. Re-run this quick fix after it completes.',
                );
                return;
            }

            let report: any;
            try {
                report = JSON.parse(rawReport);
            } catch {
                vscode.window.showErrorMessage(
                    'AI i18n: Unused keys report is not valid JSON.',
                );
                return;
            }

            const unused = Array.isArray(report.unused) ? report.unused : [];
            const hasEntry = unused.some(
                (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === keyPath,
            );
            if (!hasEntry) {
                vscode.window.showInformationMessage(
                    `AI i18n: Key ${keyPath} is not marked as unused in unused keys report.`,
                );
            }

            let root: any = {};
            try {
                const text = doc.getText();
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') root = parsed;
            } catch {}
            if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

            const before = JSON.stringify(root);
            this.deleteKeyPathInObject(root, keyPath);
            const after = JSON.stringify(root);
            if (before === after) {
                vscode.window.showInformationMessage(
                    `AI i18n: Key ${keyPath} was not found in this file.`,
                );
                return;
            }

            const encoder = new TextEncoder();
            const payload = `${JSON.stringify(root, null, 2)}\n`;
            await vscode.workspace.fs.writeFile(documentUri, encoder.encode(payload));

            await this.i18nIndex.updateFile(documentUri);
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.refreshFileDiagnostics',
                documentUri,
                [keyPath],
            );

            vscode.window.showInformationMessage(
                `AI i18n: Removed unused key ${keyPath} from this file.`,
            );
        } catch (err) {
            console.error('AI i18n: Failed to remove unused key from file:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to remove unused key from file.');
        }
    }

    async removeInvalidKeyInFile(documentUri: vscode.Uri, keyPath: string): Promise<void> {
        try {
            if (!documentUri) {
                vscode.window.showInformationMessage(
                    'AI i18n: No document provided to remove invalid key.',
                );
                return;
            }

            const doc = await vscode.workspace.openTextDocument(documentUri);
            if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                vscode.window.showInformationMessage(
                    'AI i18n: Remove invalid key only applies to locale JSON files.',
                );
                return;
            }

            let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
            if (!folder) {
                folder = await pickWorkspaceFolder();
            }
            if (!folder) {
                vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
                return;
            }

            const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
            const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-invalid-report.json');
            const decoder = new TextDecoder('utf-8');

            let rawReport: string;
            try {
                const data = await vscode.workspace.fs.readFile(reportUri);
                rawReport = decoder.decode(data);
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
                            'AI i18n: Invalid keys report not found. Generate it by running the restore-invalid script?',
                    },
                );
                if (!choice || choice.label !== 'Generate report') {
                    return;
                }
                await runI18nScript('i18n:restore-invalid');
                vscode.window.showInformationMessage(
                    'AI i18n: Running i18n:restore-invalid script in a terminal. Re-run this quick fix after it completes.',
                );
                return;
            }

            let report: any;
            try {
                report = JSON.parse(rawReport);
            } catch {
                vscode.window.showErrorMessage(
                    'AI i18n: Invalid keys report is not valid JSON.',
                );
                return;
            }

            const invalid = Array.isArray(report.invalid) ? report.invalid : [];
            const hasEntry = invalid.some(
                (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === keyPath,
            );
            if (!hasEntry) {
                vscode.window.showInformationMessage(
                    `AI i18n: Key ${keyPath} is not marked as invalid/non-translatable in invalid keys report.`,
                );
            }

            let root: any = {};
            try {
                const text = doc.getText();
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') root = parsed;
            } catch {}
            if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

            const before = JSON.stringify(root);
            this.deleteKeyPathInObject(root, keyPath);
            const after = JSON.stringify(root);
            if (before === after) {
                vscode.window.showInformationMessage(
                    `AI i18n: Key ${keyPath} was not found in this file.`,
                );
                return;
            }

            const encoder = new TextEncoder();
            const payload = `${JSON.stringify(root, null, 2)}\n`;
            await vscode.workspace.fs.writeFile(documentUri, encoder.encode(payload));

            await this.i18nIndex.updateFile(documentUri);
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.refreshFileDiagnostics',
                documentUri,
                [keyPath],
            );

            vscode.window.showInformationMessage(
                `AI i18n: Removed invalid/non-translatable key ${keyPath} from this file.`,
            );
        } catch (err) {
            console.error('AI i18n: Failed to remove invalid key from file:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to remove invalid key from file.');
        }
    }

    async restoreInvalidKeyInCode(
        documentUri: vscode.Uri,
        position: { line: number; character: number },
        key: string,
    ): Promise<void> {
        try {
            if (!parseSync || !MagicString) {
                try {
                    // @ts-ignore - runtime dependency without TypeScript types
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    parseSync = require('oxc-parser').parseSync;
                    // @ts-ignore - runtime dependency without TypeScript types
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    MagicString = require('magic-string');
                } catch (err) {
                    console.error('AI i18n: Failed to load oxc-parser or magic-string for restore quick fix:', err);
                    vscode.window.showErrorMessage(
                        'AI i18n: Failed to load parser dependencies (oxc-parser, magic-string) for restore quick fix. Install these dependencies in your extension environment to enable this quick fix.',
                    );
                    return;
                }
            }

            const doc = await vscode.workspace.openTextDocument(documentUri);

            let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
            if (!folder) {
                folder = await pickWorkspaceFolder();
            }
            if (!folder) {
                vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
                return;
            }

            const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
            const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-invalid-report.json');
            const decoder = new TextDecoder('utf-8');

            let rawReport: string;
            try {
                const data = await vscode.workspace.fs.readFile(reportUri);
                rawReport = decoder.decode(data);
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
                            'AI i18n: Invalid keys report not found. Generate it by running the restore-invalid script?',
                    },
                );
                if (!choice || choice.label !== 'Generate report') {
                    return;
                }
                await runI18nScript('i18n:restore-invalid');
                vscode.window.showInformationMessage(
                    'AI i18n: Running i18n:restore-invalid script in a terminal. Re-run this quick fix after it completes.',
                );
                return;
            }

            let report: any;
            try {
                report = JSON.parse(rawReport);
            } catch {
                vscode.window.showErrorMessage(
                    'AI i18n: Invalid keys report is not valid JSON.',
                );
                return;
            }

            const invalid = Array.isArray(report.invalid) ? report.invalid : [];
            const entry = invalid.find(
                (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === key,
            );
            if (!entry || typeof entry.baseValue !== 'string') {
                vscode.window.showInformationMessage(
                    `AI i18n: No invalid/non-translatable entry found in invalid keys report for key ${key}.`,
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
                        placeHolder: `AI i18n: Restore invalid key ${key} and delete it from locale files?`,
                    },
                );
                if (!choice || choice.label === 'Cancel') {
                    return;
                }
                shouldDeleteFromLocales = true;
            }

            const code = doc.getText();
            const fileName = path.basename(documentUri.fsPath);
            const ext = path.extname(documentUri.fsPath).toLowerCase();

            let parsed: any;
            try {
                parsed = parseSync(fileName, code, {
                    sourceType: 'module',
                    lang:
                        ext === '.tsx'
                            ? 'tsx'
                            : ext === '.ts'
                            ? 'ts'
                            : ext === '.jsx'
                            ? 'jsx'
                            : 'js',
                });
            } catch (err) {
                console.error('AI i18n: Failed to parse source file for restore quick fix:', err);
                vscode.window.showErrorMessage(
                    'AI i18n: Failed to analyze source file for restore quick fix.',
                );
                return;
            }

            if (!parsed || !parsed.program) {
                vscode.window.showInformationMessage(
                    'AI i18n: Could not analyze source file for restore quick fix.',
                );
                return;
            }

            const ast = parsed.program;
            const s = new MagicString(code);
            const docPosition = new vscode.Position(position.line, position.character);
            const posOffset = doc.offsetAt(docPosition);

            const isStringLiteralNode = (node: any): boolean => {
                if (!node) return false;
                if (node.type === 'StringLiteral') return true;
                if (node.type === 'Literal' && typeof node.value === 'string') return true;
                return false;
            };

            const getStringLiteralValue = (node: any): string | null => {
                if (!node) return null;
                if (node.type === 'StringLiteral') return node.value;
                if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
                return null;
            };

            const buildInlineFromCall = (callNode: any): string | null => {
                const args = callNode.arguments || [];
                if (!args.length || !isStringLiteralNode(args[0])) return null;
                const keyPath = getStringLiteralValue(args[0]);
                if (!keyPath || keyPath !== key) return null;

                const placeholderRegex = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)\}/g;
                const parts: { type: 'text' | 'placeholder'; value?: string; name?: string }[] = [];
                let lastIndex = 0;
                let match: RegExpExecArray | null;

                while ((match = placeholderRegex.exec(baseValue)) !== null) {
                    if (match.index > lastIndex) {
                        parts.push({ type: 'text', value: baseValue.slice(lastIndex, match.index) });
                    }
                    parts.push({ type: 'placeholder', name: match[1] });
                    lastIndex = match.index + match[0].length;
                }
                if (lastIndex < baseValue.length) {
                    parts.push({ type: 'text', value: baseValue.slice(lastIndex) });
                }

                const hasPlaceholder = parts.some((p) => p.type === 'placeholder');
                if (!hasPlaceholder) {
                    const escaped = baseValue
                        .replace(/\\/g, '\\\\')
                        .replace(/'/g, "\\'")
                        .replace(/\r?\n/g, '\\n');
                    return `'${escaped}'`;
                }

                const placeholdersArg = args[1];
                if (!placeholdersArg || placeholdersArg.type !== 'ObjectExpression') {
                    return null;
                }

                const exprByName = new Map<string, string>();
                for (const prop of placeholdersArg.properties || []) {
                    if (!prop || prop.type !== 'Property') continue;
                    if (prop.computed) continue;
                    const keyNode = prop.key;
                    let name: string | null = null;
                    if (keyNode.type === 'Identifier') name = keyNode.name;
                    else if (isStringLiteralNode(keyNode)) name = getStringLiteralValue(keyNode);
                    if (!name) continue;
                    const valueNode = prop.value;
                    if (!valueNode) continue;
                    const exprCode = code.slice(valueNode.start, valueNode.end);
                    exprByName.set(name, exprCode);
                }

                let out = '`';
                for (const part of parts) {
                    if (part.type === 'text') {
                        const safe = String(part.value || '')
                            .replace(/`/g, '\\`')
                            .replace(/\$/g, '\\$');
                        out += safe;
                    } else if (part.type === 'placeholder') {
                        if (!part.name) {
                            return null;
                        }
                        const expr = exprByName.get(part.name);
                        if (!expr) {
                            return null;
                        }
                        out += '${' + expr + '}';
                    }
                }
                out += '`';
                return out;
            };

            let replaced = false;

            const walkAst = (node: any): void => {
                if (!node || typeof node !== 'object') return;
                const visit = (node as any).type === 'CallExpression';
                if (visit) {
                    const callNode: any = node;
                    const callee = callNode.callee;
                    const args = callNode.arguments || [];
                    if (
                        callee &&
                        callee.type === 'Identifier' &&
                        callee.name === 't' &&
                        args.length &&
                        isStringLiteralNode(args[0]) &&
                        typeof callNode.start === 'number' &&
                        typeof callNode.end === 'number'
                    ) {
                        if (posOffset >= callNode.start && posOffset <= callNode.end) {
                            const inline = buildInlineFromCall(callNode);
                            if (inline) {
                                s.overwrite(callNode.start, callNode.end, inline);
                                replaced = true;
                                return;
                            }
                        }
                    }
                }

                for (const key of Object.keys(node)) {
                    if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') {
                        continue;
                    }
                    const child = (node as any)[key];
                    if (Array.isArray(child)) {
                        for (const c of child) {
                            if (c && typeof c === 'object') {
                                walkAst(c);
                                if (replaced) return;
                            }
                        }
                    } else if (child && typeof child === 'object') {
                        walkAst(child);
                        if (replaced) return;
                    }
                }
            };

            walkAst(ast);

            if (!replaced) {
                vscode.window.showInformationMessage(
                    `AI i18n: No matching t('${key}') call found at this location to restore.`,
                );
                return;
            }

            const newCode = s.toString();
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(code.length),
            );
            edit.replace(documentUri, fullRange, newCode);
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                vscode.window.showErrorMessage(
                    'AI i18n: Failed to apply restore quick fix edit to source file.',
                );
                return;
            }

            await doc.save();

            let deletedFromLocales = 0;
            if (shouldDeleteFromLocales && localeUris.length) {
                deletedFromLocales = await this.deleteKeyFromLocaleFiles(key, localeUris);
            }

            await this.i18nIndex.ensureInitialized(true);

            if (deletedFromLocales > 0) {
                vscode.window.showInformationMessage(
                    `AI i18n: Restored inline string for invalid/non-translatable key ${key} at this location and removed it from ${deletedFromLocales} locale file(s).`,
                );
            } else {
                vscode.window.showInformationMessage(
                    `AI i18n: Restored inline string for invalid/non-translatable key ${key} at this location.`,
                );
            }
        } catch (err) {
            console.error('AI i18n: Failed to restore invalid key in code:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to restore invalid key in code.');
        }
    }

    private async deleteKeyFromLocaleFiles(
        keyPath: string,
        uris: vscode.Uri[],
    ): Promise<number> {
        if (!uris.length) {
            return 0;
        }

        const decoder = new TextDecoder('utf-8');
        const encoder = new TextEncoder();
        const changedUris: vscode.Uri[] = [];

        for (const uri of uris) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                    continue;
                }

                let root: any = {};
                try {
                    const data = await vscode.workspace.fs.readFile(uri);
                    const raw = decoder.decode(data);
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') root = parsed;
                } catch {
                    continue;
                }
                if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

                const before = JSON.stringify(root);
                this.deleteKeyPathInObject(root, keyPath);
                const after = JSON.stringify(root);
                if (before === after) {
                    continue;
                }

                const payload = `${JSON.stringify(root, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(uri, encoder.encode(payload));
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
}
