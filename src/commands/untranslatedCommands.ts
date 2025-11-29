import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { setTranslationValue, setTranslationValueInFile } from '../core/i18nFs';
import { pickWorkspaceFolder, runI18nScript } from '../core/workspace';
import { TextDecoder, TextEncoder } from 'util';

/**
 * Commands for handling untranslated strings
 */
export class UntranslatedCommands {
    constructor(
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private projectConfigService: ProjectConfigService,
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

    /**
     * Check if a key path exists in a JSON object
     */
    private hasKeyPathInObject(obj: any, keyPath: string): boolean {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
        const segments = String(keyPath).split('.').filter(Boolean);
        if (!segments.length) return false;

        let node = obj;
        for (const segment of segments) {
            if (!node || typeof node !== 'object' || Array.isArray(node)) {
                return false;
            }
            if (!Object.prototype.hasOwnProperty.call(node, segment)) {
                return false;
            }
            node = node[segment];
        }
        return true;
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

            // Locale file writes trigger watchers which update index + diagnostics incrementally
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

            // Locale file writes trigger watchers which update index + diagnostics incrementally

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
                // No AI translations, but placeholders were applied already
                // Locale file writes trigger watchers which update index + diagnostics incrementally
                return;
            }

            for (const [locale, newValue] of translations.entries()) {
                await setTranslationValue(folder, locale, key, newValue);
            }

            // Locale file writes trigger watchers which update index + diagnostics incrementally
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

    async reviewSelection(documentUri?: vscode.Uri): Promise<void> {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('AI i18n: No active editor.');
                return;
            }

            const document = editor.document;
            const langId = document.languageId;
            const isCode =
                langId === 'javascript' ||
                langId === 'typescript' ||
                langId === 'javascriptreact' ||
                langId === 'typescriptreact' ||
                langId === 'vue' ||
                langId === 'blade' ||
                langId === 'php';

            if (!isCode) {
                vscode.window.showInformationMessage(
                    'AI i18n: Selection review only applies to JS/TS, Vue, and Blade/PHP files.',
                );
                return;
            }

            const selection = editor.selection;
            if (selection.isEmpty) {
                vscode.window.showInformationMessage(
                    'AI i18n: Please select the code containing i18n keys to review.',
                );
                return;
            }

            await this.i18nIndex.ensureInitialized();

            const selectionText = document.getText(selection);
            const keyRegex = /['"`]([A-Za-z0-9_.]+)['"`]/g;
            const keysInSelection = new Set<string>();

            let match: RegExpExecArray | null;
            while ((match = keyRegex.exec(selectionText)) !== null) {
                const key = match[1];
                if (!key) {
                    continue;
                }
                const record = this.i18nIndex.getRecord(key);
                if (!record) {
                    continue;
                }
                keysInSelection.add(key);
            }

            if (!keysInSelection.size) {
                vscode.window.showInformationMessage(
                    'AI i18n: No known i18n keys found in the current selection.',
                );
                return;
            }

            const unresolvedByKey = new Map<string, Set<string>>();
            const allDiagnostics = vscode.languages.getDiagnostics();

            for (const entry of allDiagnostics) {
                const diags = entry[1];
                if (!diags || !diags.length) {
                    continue;
                }

                for (const d of diags) {
                    if (String(d.code) !== 'ai-i18n.untranslated') {
                        continue;
                    }
                    const parsed = this.parseUntranslatedDiagnostic(String(d.message || ''));
                    if (!parsed || !parsed.key || !parsed.locales || !parsed.locales.length) {
                        continue;
                    }
                    if (!keysInSelection.has(parsed.key)) {
                        continue;
                    }
                    let set = unresolvedByKey.get(parsed.key);
                    if (!set) {
                        set = new Set<string>();
                        unresolvedByKey.set(parsed.key, set);
                    }
                    for (const locale of parsed.locales) {
                        if (locale) {
                            set.add(locale);
                        }
                    }
                }
            }

            if (!unresolvedByKey.size) {
                vscode.window.showInformationMessage(
                    'AI i18n: No untranslated diagnostics found for keys in the current selection.',
                );
                return;
            }

            let totalIssues = 0;
            for (const set of unresolvedByKey.values()) {
                totalIssues += set.size;
            }

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: `Translate ${totalIssues} value(s) for ${unresolvedByKey.size} key(s)`,
                        description:
                            'Use AI to translate missing or untranslated locales for all keys in this selection.',
                    },
                    {
                        label: 'Cancel',
                        description: 'Do not change translations for this selection.',
                    },
                ],
                {
                    placeHolder:
                        'AI i18n: Apply AI translations for i18n issues in this selection?',
                },
            );

            if (!choice || choice.label === 'Cancel') {
                return;
            }

            let translatedRequests = 0;
            for (const [key, localeSet] of unresolvedByKey.entries()) {
                const locales = Array.from(localeSet);
                if (!locales.length) {
                    continue;
                }
                await this.applyQuickFix(document.uri, key, locales);
                translatedRequests += locales.length;
            }

            if (translatedRequests > 0) {
                vscode.window.showInformationMessage(
                    `AI i18n: Requested AI translations for ${translatedRequests} value(s) across ${unresolvedByKey.size} key(s) in this selection.`,
                );
            }
        } catch (err) {
            console.error('AI i18n: Failed to review selection for i18n issues:', err);
            vscode.window.showErrorMessage(
                'AI i18n: Failed to review selection for i18n issues.',
            );
        }
    }

    async showHealthReport(): Promise<void> {
        try {
            const allDiagnostics = vscode.languages.getDiagnostics();
            const codeTotals = new Map<string, number>();
            const fileTotals = new Map<
                string,
                { uri: vscode.Uri; count: number; byCode: Map<string, number> }
            >();

            for (const [uri, diags] of allDiagnostics) {
                if (!diags || !diags.length) {
                    continue;
                }
                const fileKey = uri.toString();
                let fileEntry = fileTotals.get(fileKey);
                if (!fileEntry) {
                    fileEntry = { uri, count: 0, byCode: new Map<string, number>() };
                    fileTotals.set(fileKey, fileEntry);
                }

                for (const d of diags) {
                    const rawCode = d.code;
                    const code = typeof rawCode === 'string' || typeof rawCode === 'number'
                        ? String(rawCode)
                        : '';
                    if (!code || !code.startsWith('ai-i18n.')) {
                        continue;
                    }

                    const prevGlobal = codeTotals.get(code) || 0;
                    codeTotals.set(code, prevGlobal + 1);

                    fileEntry.count += 1;
                    const prevFile = fileEntry.byCode.get(code) || 0;
                    fileEntry.byCode.set(code, prevFile + 1);
                }
            }

            if (!codeTotals.size || !fileTotals.size) {
                vscode.window.showInformationMessage(
                    'AI i18n: No i18n diagnostics found for this workspace.',
                );
                return;
            }

            const labelForCode = (code: string): string => {
                if (code === 'ai-i18n.untranslated') return 'Missing/untranslated';
                if (code === 'ai-i18n.invalid') return 'Invalid/non-translatable default value';
                if (code === 'ai-i18n.placeholders') return 'Placeholder mismatch';
                if (code === 'ai-i18n.style') return 'Style suggestion';
                return code;
            };

            const globalLines: string[] = [];
            globalLines.push('# AI i18n – Workspace Health Report');
            globalLines.push('');
            globalLines.push(`Generated at ${new Date().toISOString()}`);
            globalLines.push('');

            globalLines.push('## Overall issue counts');
            globalLines.push('');
            globalLines.push('| Issue type | Count |');
            globalLines.push('| --- | ---: |');
            const sortedCodes = Array.from(codeTotals.entries()).sort((a, b) => b[1] - a[1]);
            for (const [code, count] of sortedCodes) {
                const label = labelForCode(code);
                globalLines.push(`| ${label} | ${count} |`);
            }
            globalLines.push('');

            const sortedFiles = Array.from(fileTotals.values()).sort((a, b) => b.count - a.count);
            globalLines.push('## Files with i18n issues');
            globalLines.push('');
            globalLines.push('| File | Total | Missing/untranslated | Invalid | Placeholders | Style |');
            globalLines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
            const maxFiles = 100;
            for (let i = 0; i < sortedFiles.length && i < maxFiles; i += 1) {
                const entry = sortedFiles[i];
                const missing = entry.byCode.get('ai-i18n.untranslated') || 0;
                const invalid = entry.byCode.get('ai-i18n.invalid') || 0;
                const placeholders = entry.byCode.get('ai-i18n.placeholders') || 0;
                const style = entry.byCode.get('ai-i18n.style') || 0;
                const rel = vscode.workspace.asRelativePath(entry.uri);
                globalLines.push(
                    `| ${rel} | ${entry.count} | ${missing} | ${invalid} | ${placeholders} | ${style} |`,
                );
            }

            if (sortedFiles.length > maxFiles) {
                globalLines.push('');
                globalLines.push(
                    `Showing top ${maxFiles} file(s) by issue count out of ${sortedFiles.length} total.`,
                );
            }

            const content = globalLines.join('\n');
            const doc = await vscode.workspace.openTextDocument({
                language: 'markdown',
                content,
            } as any);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
            console.error('AI i18n: Failed to generate workspace health report:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to generate workspace health report.');
        }
    }

    /**
     * Translate all untranslated keys in a locale file using AI.
     */
    async translateAllUntranslatedInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage(
                    'AI i18n: No active document to translate.',
                );
                return;
            }

            const doc = await vscode.workspace.openTextDocument(targetUri);
            if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                vscode.window.showInformationMessage(
                    'AI i18n: Bulk translate only applies to locale JSON files.',
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

            await this.i18nIndex.ensureInitialized();

            // Get locale for this file
            const fileInfo = this.i18nIndex.getKeysForFile(targetUri);
            const cfg = vscode.workspace.getConfiguration('ai-localizer');
            const globalDefaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

            // Infer locale from file path if not in index
            let fileLocale: string | null = fileInfo?.locale || null;
            if (!fileLocale) {
                // Try to infer from path (e.g., /auto/fr.json or /locales/fr.json)
                const fsPath = targetUri.fsPath;
                const parts = fsPath.split(/[\\/]/).filter(Boolean);
                const fileName = parts[parts.length - 1];
                const match = fileName.match(/^([A-Za-z0-9_-]+)\.json$/);
                if (match) {
                    fileLocale = match[1];
                }
            }

            if (!fileLocale) {
                vscode.window.showInformationMessage(
                    'AI i18n: Could not determine locale for this file.',
                );
                return;
            }

            if (fileLocale === globalDefaultLocale) {
                await this.translateMissingLocalesFromDefaultFile(
                    folder,
                    targetUri,
                    fileInfo,
                    globalDefaultLocale,
                );
                return;
            }

            // Narrow the type for TypeScript
            const targetLocale: string = fileLocale;

            // Find ALL keys in this file that need translation for this locale
            // This includes keys that exist in default locale but are missing/untranslated in this locale
            const keysToTranslate: { key: string; defaultValue: string; defaultLocale: string }[] = [];
            const keysInFile = fileInfo?.keys || [];

            for (const key of keysInFile) {
                const record = this.i18nIndex.getRecord(key);
                if (!record) continue;

                const defaultLocale = record.defaultLocale || globalDefaultLocale;
                if (targetLocale === defaultLocale) continue; // Skip if this is the default locale

                const defaultValue = record.locales.get(defaultLocale);
                if (typeof defaultValue !== 'string' || !defaultValue.trim()) continue;

                const currentValue = record.locales.get(targetLocale);
                const needsTranslation =
                    !currentValue ||
                    !currentValue.trim() ||
                    currentValue.trim() === defaultValue.trim();

                if (needsTranslation) {
                    keysToTranslate.push({ key, defaultValue, defaultLocale });
                }
            }

            if (!keysToTranslate.length) {
                vscode.window.showInformationMessage(
                    `AI i18n: No untranslated keys found for locale ${targetLocale}.`,
                );
                return;
            }

            // Confirm with user
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: `Translate ${keysToTranslate.length} key(s)`,
                        description: `Use AI to translate ${keysToTranslate.length} untranslated key(s) to ${targetLocale}`,
                    },
                    { label: 'Cancel', description: 'Do not translate' },
                ],
                {
                    placeHolder: `AI i18n: Translate ${keysToTranslate.length} untranslated key(s) in this file?`,
                },
            );
            if (!choice || choice.label === 'Cancel') {
                return;
            }

            // Translate in a single batched call per locale (with internal limits)
            let translatedCount = 0;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'AI i18n: Translating...',
                    cancellable: true,
                },
                async (progress, token) => {
                    if (token.isCancellationRequested) {
                        return;
                    }

                    const batchItems = keysToTranslate.map((item) => ({
                        id: item.key,
                        text: item.defaultValue,
                        defaultLocale: item.defaultLocale,
                    }));

                    const translations = await this.translationService.translateBatchToLocale(
                        batchItems,
                        targetLocale,
                        'text',
                        true,
                    );

                    if (!translations || translations.size === 0 || token.isCancellationRequested) {
                        return;
                    }

                    let processed = 0;
                    let lastReported = 0;
                    for (const item of keysToTranslate) {
                        if (token.isCancellationRequested) {
                            break;
                        }
                        const newValue = translations.get(item.key);
                        if (!newValue) {
                            continue;
                        }
                        try {
                            await setTranslationValue(folder!, targetLocale, item.key, newValue);
                            translatedCount++;
                        } catch (err) {
                            console.error(`AI i18n: Failed to write translation for key ${item.key}:`, err);
                        }
                        processed += 1;
                        if (processed % 10 === 0 || processed === keysToTranslate.length) {
                            const percent = (processed / keysToTranslate.length) * 100;
                            progress.report({
                                message: `${processed} of ${keysToTranslate.length}`,
                                increment: percent - lastReported,
                            });
                            lastReported = percent;
                        }
                    }
                },
            );

            // Locale file writes trigger watchers which update index + diagnostics incrementally

            if (translatedCount > 0) {
                vscode.window.showInformationMessage(
                    `AI i18n: Translated ${translatedCount} key(s) in ${targetLocale}.`,
                );
            } else {
                const apiChoice = await vscode.window.showInformationMessage(
                    'AI i18n: No translations were generated (check API key and settings).',
                    'Open OpenAI API Key Settings',
                    'Dismiss',
                );
                if (apiChoice === 'Open OpenAI API Key Settings') {
                    await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
                }
            }
        } catch (err) {
            console.error('AI i18n: Failed to translate all untranslated keys:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to translate all untranslated keys.');
        }
    }

    private async translateMissingLocalesFromDefaultFile(
        folder: vscode.WorkspaceFolder,
        documentUri: vscode.Uri,
        fileInfo: { locale: string; keys: string[] } | null,
        globalDefaultLocale: string,
    ): Promise<void> {
        const keysInFile = fileInfo?.keys || [];
        if (!keysInFile.length) {
            vscode.window.showInformationMessage(
                'AI i18n: No translation keys found in this file.',
            );
            return;
        }
        const missingPerLocale = new Map<
            string,
            { key: string; defaultValue: string; defaultLocale: string }[]
        >();

        for (const key of keysInFile) {
            const record = this.i18nIndex.getRecord(key);
            if (!record) {
                continue;
            }

            const defaultLocale = record.defaultLocale || globalDefaultLocale;
            const defaultValue = record.locales.get(defaultLocale);
            if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
                continue;
            }

            for (const [locale, currentValue] of record.locales.entries()) {
                if (!locale || locale === defaultLocale) {
                    continue;
                }
                const current = typeof currentValue === 'string' ? currentValue.trim() : '';
                const needsTranslation = !current || current === defaultValue.trim();
                if (!needsTranslation) {
                    continue;
                }

                let list = missingPerLocale.get(locale);
                if (!list) {
                    list = [];
                    missingPerLocale.set(locale, list);
                }
                list.push({ key, defaultValue, defaultLocale });
            }
        }

        if (!missingPerLocale.size) {
            vscode.window.showInformationMessage(
                'AI i18n: No untranslated keys found for non-default locales in this file.',
            );
            return;
        }

        const localeEntries = Array.from(missingPerLocale.entries());
        let selectedLocale: string;
        let keysToTranslate: { key: string; defaultValue: string; defaultLocale: string }[];

        if (localeEntries.length === 1) {
            [selectedLocale, keysToTranslate] = localeEntries[0];
        } else {
            const items = localeEntries.map(([locale, list]) => {
                const count = list.length;
                return {
                    label: `${locale} (${count} key${count === 1 ? '' : 's'})`,
                    description: undefined,
                    locale,
                    count,
                } as vscode.QuickPickItem & { locale: string; count: number };
            });

            const choice = await vscode.window.showQuickPick(items, {
                placeHolder:
                    'AI i18n: Select target locale to translate missing keys for this file',
            });
            if (!choice) {
                return;
            }

            selectedLocale = (choice as any).locale;
            keysToTranslate = missingPerLocale.get(selectedLocale) || [];
        }

        if (!keysToTranslate || !keysToTranslate.length) {
            vscode.window.showInformationMessage(
                `AI i18n: No untranslated keys found for locale ${selectedLocale} in this file.`,
            );
            return;
        }

        const confirm = await vscode.window.showQuickPick(
            [
                {
                    label: `Translate ${keysToTranslate.length} key(s)`,
                    description: `Use AI to translate ${keysToTranslate.length} untranslated key(s) to ${selectedLocale}`,
                },
                { label: 'Cancel', description: 'Do not translate' },
            ],
            {
                placeHolder: `AI i18n: Translate ${keysToTranslate.length} untranslated key(s) in this file?`,
            },
        );
        if (!confirm || confirm.label === 'Cancel') {
            return;
        }

        let translatedCount = 0;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'AI i18n: Translating...',
                cancellable: true,
            },
            async (progress, token) => {
                if (token.isCancellationRequested) {
                    return;
                }

                const batchItems = keysToTranslate.map((item) => ({
                    id: item.key,
                    text: item.defaultValue,
                    defaultLocale: item.defaultLocale,
                }));

                const translations = await this.translationService.translateBatchToLocale(
                    batchItems,
                    selectedLocale,
                    'text',
                    true,
                );

                if (!translations || translations.size === 0 || token.isCancellationRequested) {
                    return;
                }

                let processed = 0;
                let lastReported = 0;
                for (const item of keysToTranslate) {
                    if (token.isCancellationRequested) {
                        break;
                    }
                    const newValue = translations.get(item.key);
                    if (!newValue) {
                        continue;
                    }
                    try {
                        await setTranslationValue(folder, selectedLocale, item.key, newValue);
                        translatedCount += 1;
                    } catch (err) {
                        console.error(`AI i18n: Failed to write translation for key ${item.key}:`, err);
                    }
                    processed += 1;
                    if (processed % 10 === 0 || processed === keysToTranslate.length) {
                        const percent = (processed / keysToTranslate.length) * 100;
                        progress.report({
                            message: `${processed} of ${keysToTranslate.length}`,
                            increment: percent - lastReported,
                        });
                        lastReported = percent;
                    }
                }
            },
        );

        // Locale file writes trigger watchers which update index + diagnostics incrementally

        if (translatedCount > 0) {
            vscode.window.showInformationMessage(
                `AI i18n: Translated ${translatedCount} key(s) in ${selectedLocale}.`,
            );
        } else {
            const apiChoice = await vscode.window.showInformationMessage(
                'AI i18n: No translations were generated (check API key and settings).',
                'Open OpenAI API Key Settings',
                'Dismiss',
            );
            if (apiChoice === 'Open OpenAI API Key Settings') {
                await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
            }
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

    private parseUntranslatedDiagnostic(message: string): { key: string; locales: string[] } | null {
        if (!message) {
            return null;
        }

        const missingNewMatch = message.match(/^Missing translation for "(.+?)"\s*\[([A-Za-z0-9_-]+)\]/);
        if (missingNewMatch) {
            const key = missingNewMatch[1].trim();
            const locale = missingNewMatch[2].trim();
            return { key, locales: [locale] };
        }

        const untranslatedNewMatch = message.match(
            /^Untranslated \(same as default\) "(.+?)"\s*\[([A-Za-z0-9_-]+)\]/,
        );
        if (untranslatedNewMatch) {
            const key = untranslatedNewMatch[1].trim();
            const locale = untranslatedNewMatch[2].trim();
            return { key, locales: [locale] };
        }

        const clean = message.replace(/^AI i18n:\s*/, '');

        const missingMatch = clean.match(
            /^Missing translation for key\s+(.+?)\s+in locale\s+([A-Za-z0-9_-]+)/,
        );
        if (missingMatch) {
            const key = missingMatch[1].trim();
            const locale = missingMatch[2].trim();
            return { key, locales: [locale] };
        }

        const untranslatedMatch = clean.match(
            /^Untranslated \(same as default\) value for key\s+(.+?)\s+in locale\s+([A-Za-z0-9_-]+)/,
        );
        if (untranslatedMatch) {
            const key = untranslatedMatch[1].trim();
            const locale = untranslatedMatch[2].trim();
            return { key, locales: [locale] };
        }

        const selectionMatch = clean.match(
            /^Missing translations for\s+(.+?)\s+in locales:\s+(.+)$/,
        );
        if (selectionMatch) {
            const key = selectionMatch[1].trim();
            const localesRaw = selectionMatch[2]
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean);
            if (!key || !localesRaw.length) {
                return null;
            }
            return { key, locales: localesRaw };
        }

        return null;
    }

    private parseStyleDiagnostic(message: string): { key: string; locale: string; suggested: string } | null {
        if (!message) return null;

        const newMatch = message.match(/^Style suggestion "(.+?)"\s*\[([A-Za-z0-9_-]+)\]\s*\(([^)]*)\)/);
        if (newMatch) {
            const key = newMatch[1].trim();
            const locale = newMatch[2].trim();
            const details = newMatch[3] || '';
            const sugMatch = details.match(/suggested:\s*([^|)]+)/i);
            const suggested = sugMatch ? sugMatch[1].trim() : '';
            if (!key || !locale || !suggested) return null;
            return { key, locale, suggested };
        }

        const clean = String(message).replace(/^AI i18n:\s*/, '');
        const legacyMatch = clean.match(
            /^Style suggestion for key\s+(.+?)\s+in locale\s+([A-Za-z0-9_-]+)\s*\(([^)]*)\)/,
        );
        if (!legacyMatch) return null;
        const key = legacyMatch[1].trim();
        const locale = legacyMatch[2].trim();
        const details = legacyMatch[3] || '';
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

    async fixAllIssuesInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage(
                    'AI i18n: No active document to fix i18n issues.',
                );
                return;
            }

            const doc = await vscode.workspace.openTextDocument(targetUri);
            if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                vscode.window.showInformationMessage(
                    'AI i18n: Fix-all only applies to locale JSON files.',
                );
                return;
            }

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
                        'AI i18n: Run all per-file i18n fixes for this locale file?',
                },
            );
            if (!choice || choice.label !== 'Run all per-file fixes') {
                return;
            }

            await vscode.commands.executeCommand(
                'ai-localizer.i18n.translateAllUntranslatedInFile',
                targetUri,
            );
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.cleanupUnusedKeysInFile',
                targetUri,
            );
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.restoreInvalidKeysInFile',
                targetUri,
            );
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.applyAllStyleSuggestionsInFile',
                targetUri,
            );
        } catch (err) {
            console.error('AI i18n: Failed to run all per-file fixes for file:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to run all per-file fixes for file.');
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

            const allUnused = Array.isArray(report.unused) ? report.unused : [];
            if (!allUnused.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No unused keys found in unused keys report.',
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
                return this.hasKeyPathInObject(root, item.keyPath);
            });

            if (!unused.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No unused keys from report were found in this file.',
                );
                return;
            }

            // Confirm with user before proceeding
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: `Remove ${unused.length} unused key(s)`,
                        description: `Remove ${unused.length} unused key(s) from this locale file only.`,
                    },
                    {
                        label: 'Cancel',
                        description: 'Do not remove keys.',
                    },
                ],
                {
                    placeHolder: `AI i18n: Remove ${unused.length} unused key(s) found in this file?`,
                },
            );
            if (!choice || choice.label === 'Cancel') {
                return;
            }

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
                    'AI i18n: No unused keys were removed from this file.',
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

            const allInvalid = Array.isArray(report.invalid) ? report.invalid : [];
            if (!allInvalid.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No invalid/non-translatable keys found in invalid keys report.',
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
            const invalid = allInvalid.filter((item: any) => {
                if (!item || typeof item.keyPath !== 'string') return false;
                return this.hasKeyPathInObject(root, item.keyPath);
            });

            if (!invalid.length) {
                vscode.window.showInformationMessage(
                    'AI i18n: No invalid/non-translatable keys from report were found in this file.',
                );
                return;
            }

            // Confirm with user before proceeding
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
                    placeHolder: `AI i18n: Restore ${invalid.length} invalid key(s) found in this file to inline strings?`,
                },
            );
            if (!choice || choice.label === 'Cancel') {
                return;
            }

            // First, restore code references for invalid keys in this file
            let codeRestoreCount = 0;
            for (const item of invalid) {
                if (!item || typeof item.keyPath !== 'string') continue;
                const usages = Array.isArray(item.usages) ? item.usages : [];
                const baseValue = typeof item.baseValue === 'string' ? item.baseValue : '';
                
                for (const usage of usages) {
                    if (!usage || typeof usage.file !== 'string' || typeof usage.line !== 'number') continue;
                    const codeFileUri = vscode.Uri.joinPath(folder.uri, usage.file);
                    try {
                        const restored = await this.restoreInlineStringInFile(
                            codeFileUri,
                            item.keyPath,
                            baseValue,
                            usage.line - 1, // Convert to 0-indexed
                        );
                        if (restored) {
                            codeRestoreCount++;
                        }
                    } catch (err) {
                        console.error(`AI i18n: Failed to restore code reference for ${item.keyPath} in ${usage.file}:`, err);
                    }
                }
            }

            // Then remove keys from this locale file only
            // Re-read the file in case it was modified by code restoration
            try {
                const freshDoc = await vscode.workspace.openTextDocument(targetUri);
                const text = freshDoc.getText();
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

            if (deletedKeys.size > 0) {
                const encoder = new TextEncoder();
                const payload = `${JSON.stringify(root, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(targetUri, encoder.encode(payload));

                await this.i18nIndex.updateFile(targetUri);
                await vscode.commands.executeCommand(
                    'ai-localizer.i18n.refreshFileDiagnostics',
                    targetUri,
                    Array.from(deletedKeys),
                );
            }

            // Note: We intentionally do NOT remove from other locale files here.
            // This is a single-file operation. Use the project-wide script for bulk cleanup.

            const message = codeRestoreCount > 0
                ? `AI i18n: Restored ${codeRestoreCount} code reference(s) and removed ${deletedKeys.size} invalid key(s) from this file.`
                : `AI i18n: Removed ${deletedKeys.size} invalid/non-translatable key(s) from this file.`;
            vscode.window.showInformationMessage(message);
        } catch (err) {
            console.error('AI i18n: Failed to cleanup invalid keys for file:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to cleanup invalid keys for file.');
        }
    }

    /**
     * Restore a single t('key') call to an inline string in a specific file at a specific line.
     * Uses regex-based replacement to avoid external dependencies.
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

            // Escape special regex characters in the key
            const escapedKey = keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Match t('key') or t("key") with optional second argument
            // Pattern: t('key') or t('key', {...})
            const patterns = [
                // t('key') - simple case without placeholders
                new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*\\)`, 'g'),
                // t('key', { ... }) - with placeholder object (greedy match for the object)
                new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*,\\s*\\{[^}]*\\}\\s*\\)`, 'g'),
            ];

            let newLineText = lineText;
            let replaced = false;

            // Check if baseValue has placeholders
            const placeholderRegex = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)\}/g;
            const hasPlaceholders = placeholderRegex.test(baseValue);

            // Build the replacement string
            let replacement: string;
            if (hasPlaceholders) {
                // For placeholders, we need to extract the expressions from the t() call
                // This is complex without AST, so for now just use the base value with placeholders as-is
                // wrapped in backticks as a template literal hint
                const escaped = baseValue
                    .replace(/`/g, '\\`')
                    .replace(/\$/g, '\\$');
                replacement = `\`${escaped}\``;
            } else {
                // Simple string without placeholders
                const escaped = baseValue
                    .replace(/\\/g, '\\\\')
                    .replace(/'/g, "\\'")
                    .replace(/\r?\n/g, '\\n');
                replacement = `'${escaped}'`;
            }

            // Try each pattern
            for (const pattern of patterns) {
                if (pattern.test(newLineText)) {
                    newLineText = newLineText.replace(pattern, replacement);
                    replaced = true;
                    break;
                }
            }

            if (!replaced) {
                return false;
            }

            // Apply the edit
            const edit = new vscode.WorkspaceEdit();
            const lineRange = doc.lineAt(lineNumber).range;
            edit.replace(fileUri, lineRange, newLineText);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
            }
            return applied;
        } catch (err) {
            console.error(`AI i18n: Failed to restore inline string in ${fileUri.fsPath}:`, err);
            return false;
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
            const entry = invalid.find(
                (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === keyPath,
            );
            if (!entry) {
                vscode.window.showInformationMessage(
                    `AI i18n: Key ${keyPath} is not marked as invalid/non-translatable in invalid keys report.`,
                );
                return;
            }

            // Confirm with user before proceeding
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
                    placeHolder: `AI i18n: Restore invalid key ${keyPath} to inline string and remove from locale files?`,
                },
            );
            if (!choice || choice.label === 'Cancel') {
                return;
            }

            // First, restore code references for this key
            let codeRestoreCount = 0;
            const usages = Array.isArray(entry.usages) ? entry.usages : [];
            const baseValue = typeof entry.baseValue === 'string' ? entry.baseValue : '';

            for (const usage of usages) {
                if (!usage || typeof usage.file !== 'string' || typeof usage.line !== 'number') continue;
                const codeFileUri = vscode.Uri.joinPath(folder.uri, usage.file);
                try {
                    const restored = await this.restoreInlineStringInFile(
                        codeFileUri,
                        keyPath,
                        baseValue,
                        usage.line - 1, // Convert to 0-indexed
                    );
                    if (restored) {
                        codeRestoreCount++;
                    }
                } catch (err) {
                    console.error(`AI i18n: Failed to restore code reference for ${keyPath} in ${usage.file}:`, err);
                }
            }

            // Then remove from this locale file
            let root: any = {};
            try {
                // Re-read the file in case it was modified
                const freshDoc = await vscode.workspace.openTextDocument(documentUri);
                const text = freshDoc.getText();
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') root = parsed;
            } catch {}
            if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

            const before = JSON.stringify(root);
            this.deleteKeyPathInObject(root, keyPath);
            const after = JSON.stringify(root);
            if (before !== after) {
                const encoder = new TextEncoder();
                const payload = `${JSON.stringify(root, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(documentUri, encoder.encode(payload));

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

            const message = codeRestoreCount > 0
                ? `AI i18n: Restored ${codeRestoreCount} code reference(s) and removed invalid key ${keyPath} from locale files.`
                : `AI i18n: Removed invalid/non-translatable key ${keyPath} from locale files.`;
            vscode.window.showInformationMessage(message);
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

            // Use regex-based replacement (no external dependencies needed)
            const lineText = doc.lineAt(position.line).text;
            const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Match t('key') or t("key") with optional second argument
            const patterns = [
                new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*\\)`, 'g'),
                new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*,\\s*\\{[^}]*\\}\\s*\\)`, 'g'),
            ];

            let newLineText = lineText;
            let replaced = false;

            // Check if baseValue has placeholders
            const placeholderRegex = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)\}/g;
            const hasPlaceholders = placeholderRegex.test(baseValue);

            // Build the replacement string
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

            // Try each pattern
            for (const pattern of patterns) {
                if (pattern.test(newLineText)) {
                    newLineText = newLineText.replace(pattern, replacement);
                    replaced = true;
                    break;
                }
            }

            if (!replaced) {
                vscode.window.showInformationMessage(
                    `AI i18n: No matching t('${key}') call found at this location to restore.`,
                );
                return;
            }

            // Apply the edit
            const edit = new vscode.WorkspaceEdit();
            const lineRange = doc.lineAt(position.line).range;
            edit.replace(documentUri, lineRange, newLineText);
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

            // deleteKeyFromLocaleFiles already calls updateFile + refreshFileDiagnostics for each changed file

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

    /**
     * Add a key's default value to the auto-ignore list so it won't be flagged as untranslated.
     */
    async addKeyToIgnoreList(folderUri: vscode.Uri, key: string): Promise<void> {
        try {
            await this.i18nIndex.ensureInitialized();
            const record = this.i18nIndex.getRecord(key);
            if (!record) {
                vscode.window.showInformationMessage(
                    `AI i18n: No translation record found for key ${key}.`,
                );
                return;
            }

            const defaultValue = record.locales.get(record.defaultLocale);
            if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
                vscode.window.showInformationMessage(
                    `AI i18n: No default value found for key ${key}.`,
                );
                return;
            }

            const scriptsDir = vscode.Uri.joinPath(folderUri, 'scripts');
            const ignoreUri = vscode.Uri.joinPath(scriptsDir, '.i18n-auto-ignore.json');
            const decoder = new TextDecoder('utf-8');
            const encoder = new TextEncoder();

            let ignoreData: { exact?: string[]; exactInsensitive?: string[]; contains?: string[] } = {
                exact: [],
                exactInsensitive: [],
                contains: [],
            };

            try {
                const data = await vscode.workspace.fs.readFile(ignoreUri);
                const raw = decoder.decode(data);
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
            await vscode.workspace.fs.writeFile(ignoreUri, encoder.encode(payload));

            // Rescan to apply the new ignore pattern
            await vscode.commands.executeCommand('ai-localizer.i18n.rescan');

            vscode.window.showInformationMessage(
                `AI i18n: Added "${normalizedValue}" to ignore list. Diagnostics will be refreshed.`,
            );
        } catch (err) {
            console.error('AI i18n: Failed to add key to ignore list:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to add key to ignore list.');
        }
    }

    /**
     * Fix placeholder mismatch by re-translating the value with correct placeholders.
     */
    async fixPlaceholderMismatch(documentUri: vscode.Uri, key: string, locale: string): Promise<void> {
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

            // Re-translate with AI to get correct placeholders
            const translations = await this.translationService.translateToLocales(
                defaultValue,
                defaultLocale,
                [locale],
                'text',
                true,
            );

            if (!translations || translations.size === 0) {
                const choice = await vscode.window.showInformationMessage(
                    'AI i18n: No translation generated (check API key and settings).',
                    'Open OpenAI API Key Settings',
                    'Dismiss',
                );
                if (choice === 'Open OpenAI API Key Settings') {
                    await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
                }
                return;
            }

            const newValue = translations.get(locale);
            if (newValue) {
                await setTranslationValue(folder, locale, key, newValue);
                // Locale file writes trigger watchers which update index + diagnostics incrementally

                vscode.window.showInformationMessage(
                    `AI i18n: Fixed placeholder mismatch for ${key} in ${locale}.`,
                );
            }
        } catch (err) {
            console.error('AI i18n: Failed to fix placeholder mismatch:', err);
            vscode.window.showErrorMessage('AI i18n: Failed to fix placeholder mismatch.');
        }
    }
}
