import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex } from '../../../core/i18nIndex';
import { TranslationService } from '../../../services/translationService';
import { setTranslationValuesBatch } from '../../../core/i18nFs';
import { pickWorkspaceFolder } from '../../../core/workspace';
import { sharedDecoder, sharedEncoder, readJsonFile, writeJsonFile } from '../utils/jsonUtils';

export class ReportHandler {
    constructor(
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private getRootNameForRecord: (record: any) => string,
    ) {}

    /**
     * Open the untranslated report file
     */
    async openReport(): Promise<void> {
        const active = vscode.window.activeTextEditor;
        let folder = active
            ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
            : undefined;

        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
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
                'AI Localizer: Untranslated report not found. Run the fix-untranslated script first.',
            );
        }
    }

    /**
     * Apply AI fixes from the untranslated report
     */
    async applyAiFixes(
        pruneReportsCallback: (folder: vscode.WorkspaceFolder, fixed: Array<{ locale: string; keyPath: string }>) => Promise<void>,
    ): Promise<void> {
        const active = vscode.window.activeTextEditor;
        let folder = active
            ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
            : undefined;

        if (!folder) {
            folder = await pickWorkspaceFolder();
        }

        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        const reportUri = vscode.Uri.file(
            path.join(folder.uri.fsPath, 'scripts', '.i18n-untranslated-report.json'),
        );

        let raw: string;

        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            raw = sharedDecoder.decode(data);
        } catch {
            vscode.window.showInformationMessage(
                'AI Localizer: Untranslated report not found. Run the fix-untranslated script before applying AI fixes.',
            );
            return;
        }

        let report: any;
        try {
            report = JSON.parse(raw);
        } catch {
            vscode.window.showErrorMessage('AI Localizer: Untranslated report is not valid JSON.');
            return;
        }

        const issues = Array.isArray(report.issues) ? report.issues : [];
        if (!issues.length) {
            vscode.window.showInformationMessage('AI Localizer: No issues found in untranslated report.');
            return;
        }

        let aiInstructions: string | undefined;
        try {
            const instructionsUri = vscode.Uri.file(
                path.join(folder.uri.fsPath, 'scripts', '.i18n-untranslated-ai-instructions.txt'),
            );
            const instructionsData = await vscode.workspace.fs.readFile(instructionsUri);
            aiInstructions = sharedDecoder.decode(instructionsData).trim() || undefined;
        } catch {
            // Instructions file is optional
        }

        try {
            const updates = await this.translationService.getUntranslatedFixes(
                issues,
                aiInstructions,
            );

            if (!updates.length) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No valid translation updates returned by AI.',
                );
                return;
            }

            try {
                const previewDoc = await vscode.workspace.openTextDocument({
                    language: 'json',
                    content: JSON.stringify({ updates }, null, 2),
                } as any);
                await vscode.window.showTextDocument(previewDoc, { preview: false });
            } catch {}

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

            await this.i18nIndex.ensureInitialized();

            const updatesByLocale = new Map<string, Map<string, { value: string; rootName?: string }>>();
            for (const u of updates) {
                const record = this.i18nIndex.getRecord(u.keyPath);
                const rootName = record ? this.getRootNameForRecord(record) : 'common';

                let localeUpdates = updatesByLocale.get(u.locale);
                if (!localeUpdates) {
                    localeUpdates = new Map();
                    updatesByLocale.set(u.locale, localeUpdates);
                }
                localeUpdates.set(u.keyPath, { value: u.newValue, rootName });
            }

            let totalWritten = 0;
            for (const [locale, batchUpdates] of updatesByLocale.entries()) {
                const result = await setTranslationValuesBatch(folder, locale, batchUpdates);
                totalWritten += result.written;
            }

            await pruneReportsCallback(
                folder,
                updates.map((u) => ({ locale: u.locale, keyPath: u.keyPath })),
            );

            vscode.window.showInformationMessage(
                `AI Localizer: Applied ${totalWritten} AI translation updates.`,
            );

            // Rescan to refresh index and diagnostics after applying AI fixes
            try {
                await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
            } catch {
                // Ignore rescan failures; updates are already written
            }
        } catch (err) {
            console.error('Failed to apply AI fixes:', err);
            vscode.window.showErrorMessage(`AI Localizer: Failed to apply AI fixes. ${err}`);
        }
    }

    /**
     * Prune fixed items from untranslated reports
     */
    async pruneUntranslatedReports(
        folder: vscode.WorkspaceFolder,
        fixed: Array<{ locale: string; keyPath: string }>,
    ): Promise<void> {
        if (!fixed.length) return;

        const keySet = new Set<string>();
        for (const item of fixed) {
            if (!item || !item.locale || !item.keyPath) continue;
            keySet.add(`${item.locale}::${item.keyPath}`);
        }
        if (!keySet.size) return;

        const remainingCompactKeys = new Set<string>();
        let remainingCompactKnown = false;

        let prunedUntranslatedIssues = 0;
        let prunedCompactEntries = 0;

        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');

        // Combined untranslated/style report
        try {
            const combinedUri = vscode.Uri.joinPath(scriptsDir, '.i18n-untranslated-report.json');
            const data = await vscode.workspace.fs.readFile(combinedUri);
            const raw = sharedDecoder.decode(data);
            const report: any = JSON.parse(raw);
            const issues: any[] = Array.isArray(report.issues) ? report.issues : [];
            if (issues.length) {
                const filtered = issues.filter((issue: any) => {
                    if (!issue || typeof issue.locale !== 'string' || typeof issue.keyPath !== 'string') {
                        return true;
                    }
                    const key = `${issue.locale}::${issue.keyPath}`;
                    return !keySet.has(key);
                });
                if (filtered.length !== issues.length) {
                    report.issues = filtered;
                    await writeJsonFile(combinedUri, report);
                }

                const remainingIssues: any[] = Array.isArray(report.issues) ? report.issues : [];
                for (const issue of remainingIssues) {
                    if (!issue || issue.issueType !== 'untranslated' || typeof issue.locale !== 'string') {
                        continue;
                    }
                    const locale = issue.locale as string;
                    const localeFile = typeof issue.localeFile === 'string' ? issue.localeFile : '';
                    if (!locale) continue;
                    remainingCompactKeys.add(`${locale}::${localeFile}`);
                }
                remainingCompactKnown = true;
            }
        } catch {}

        // Untranslated-only grouped report
        try {
            const untranslatedUri = vscode.Uri.joinPath(scriptsDir, '.i18n-untranslated-untranslated.json');
            const data = await vscode.workspace.fs.readFile(untranslatedUri);
            const raw = sharedDecoder.decode(data);
            const report: any = JSON.parse(raw);
            const files: any[] = Array.isArray(report.files) ? report.files : [];
            let changed = false;

            const newFiles = files
                .map((entry: any) => {
                    if (!entry || typeof entry.locale !== 'string' || !Array.isArray(entry.issues)) {
                        return entry;
                    }
                    const locale = entry.locale;
                    const beforeCount = entry.issues.length;
                    const filteredIssues = entry.issues.filter((issue: any) => {
                        const keyPath = issue && typeof issue.keyPath === 'string' ? issue.keyPath : null;
                        if (!keyPath) return true;
                        const key = `${locale}::${keyPath}`;
                        return !keySet.has(key);
                    });
                    if (filteredIssues.length !== beforeCount) {
                        changed = true;
                        prunedUntranslatedIssues += beforeCount - filteredIssues.length;
                    }
                    const result = filteredIssues.length ? { ...entry, issues: filteredIssues } : null;
                    if (result && remainingCompactKnown) {
                        const localeFile = typeof result.localeFile === 'string' ? result.localeFile : '';
                        remainingCompactKeys.add(`${locale}::${localeFile}`);
                    }
                    return result;
                })
                .filter((entry: any) => !!entry);

            if (changed) {
                report.files = newFiles;
                await writeJsonFile(untranslatedUri, report);
            }
        } catch {}

        // Compact untranslated report
        if (remainingCompactKnown) {
            try {
                const compactUri = vscode.Uri.joinPath(scriptsDir, '.i18n-untranslated-compact.json');
                const data = await vscode.workspace.fs.readFile(compactUri);
                const raw = sharedDecoder.decode(data);
                const report: any = JSON.parse(raw);
                const files: any[] = Array.isArray(report.files) ? report.files : [];

                const newFiles = files
                    .map((entry: any) => {
                        if (!entry || typeof entry.locale !== 'string') {
                            return entry;
                        }
                        const locale = entry.locale as string;
                        const localeFile = typeof entry.localeFile === 'string' ? entry.localeFile : '';
                        const key = `${locale}::${localeFile}`;
                        if (!remainingCompactKeys.has(key)) {
                            return null;
                        }
                        return entry;
                    })
                    .filter((entry: any) => !!entry);

                if (newFiles.length !== files.length) {
                    prunedCompactEntries += files.length - newFiles.length;
                    report.files = newFiles;
                    await writeJsonFile(compactUri, report);
                }
            } catch {}
        }

        if (prunedUntranslatedIssues > 0 || prunedCompactEntries > 0) {
            const parts: string[] = [];
            if (prunedUntranslatedIssues > 0) {
                parts.push(
                    `${prunedUntranslatedIssues} untranslated issue${prunedUntranslatedIssues === 1 ? '' : 's'}`,
                );
            }
            if (prunedCompactEntries > 0) {
                parts.push(
                    `${prunedCompactEntries} compact entr${prunedCompactEntries === 1 ? 'y' : 'ies'}`,
                );
            }
            const summary = parts.join(', ');
            vscode.window.showInformationMessage(
                `AI Localizer: Pruned ${summary} from untranslated reports.`,
            );
        }
    }

    /**
     * Review selection for untranslated keys
     */
    async reviewSelection(
        applyQuickFix: (documentUri: vscode.Uri, key: string, locales: string[]) => Promise<void>,
    ): Promise<void> {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('AI Localizer: No active editor.');
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
                    'AI Localizer: Selection review only applies to JS/TS, Vue, and Blade/PHP files.',
                );
                return;
            }

            const selection = editor.selection;
            if (selection.isEmpty) {
                vscode.window.showInformationMessage(
                    'AI Localizer: Please select the code containing i18n keys to review.',
                );
                return;
            }

            await this.i18nIndex.ensureInitialized();

            const selectionText = document.getText(selection);
            const keyRegex = /['"`]([A-Za-z0-9_\.\-]+)['"`]/g;
            const keysInSelection = new Set<string>();

            let match: RegExpExecArray | null;
            // eslint-disable-next-line no-cond-assign
            while ((match = keyRegex.exec(selectionText)) !== null) {
                const key = match[1];
                if (key) {
                    keysInSelection.add(key);
                }
            }

            if (!keysInSelection.size) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No known i18n keys found in the current selection.',
                );
                return;
            }

            const unresolvedByKey = new Map<string, Set<string>>();
            const allDiagnostics = vscode.languages.getDiagnostics();

            for (const entry of allDiagnostics) {
                const diags = entry[1];
                if (!diags || !diags.length) continue;

                for (const d of diags) {
                    if (String(d.code) !== 'ai-i18n.untranslated') continue;
                    const { parseUntranslatedDiagnostic } = await import('../utils/diagnosticParser');
                    const parsed = parseUntranslatedDiagnostic(String(d.message || ''));
                    if (!parsed || !parsed.key || !parsed.locales || !parsed.locales.length) continue;
                    if (!keysInSelection.has(parsed.key)) continue;
                    let set = unresolvedByKey.get(parsed.key);
                    if (!set) {
                        set = new Set<string>();
                        unresolvedByKey.set(parsed.key, set);
                    }
                    for (const locale of parsed.locales) {
                        if (locale) set.add(locale);
                    }
                }
            }

            if (!unresolvedByKey.size) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No untranslated diagnostics found for keys in the current selection.',
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
                        'AI Localizer: Apply AI translations for i18n issues in this selection?',
                },
            );

            if (!choice || choice.label === 'Cancel') return;

            let translatedRequests = 0;
            for (const [key, localeSet] of unresolvedByKey.entries()) {
                const locales = Array.from(localeSet);
                if (!locales.length) continue;
                await applyQuickFix(document.uri, key, locales);
                translatedRequests += locales.length;
            }

            if (translatedRequests > 0) {
                vscode.window.showInformationMessage(
                    `AI Localizer: Requested AI translations for ${translatedRequests} value(s) across ${unresolvedByKey.size} key(s) in this selection.`,
                );
            }
        } catch (err) {
            console.error('AI Localizer: Failed to review selection for i18n issues:', err);
            vscode.window.showErrorMessage(
                'AI Localizer: Failed to review selection for i18n issues.',
            );
        }
    }

    /**
     * Show workspace health report
     */
    async showHealthReport(): Promise<void> {
        try {
            const allDiagnostics = vscode.languages.getDiagnostics();
            const codeTotals = new Map<string, number>();
            const fileTotals = new Map<string, { uri: vscode.Uri; count: number; byCode: Map<string, number> }>();

            for (const [uri, diags] of allDiagnostics) {
                if (!diags || !diags.length) continue;
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
                    if (!code || !code.startsWith('ai-i18n.')) continue;

                    const prevGlobal = codeTotals.get(code) || 0;
                    codeTotals.set(code, prevGlobal + 1);

                    fileEntry.count += 1;
                    const prevFile = fileEntry.byCode.get(code) || 0;
                    fileEntry.byCode.set(code, prevFile + 1);
                }
            }

            if (!codeTotals.size || !fileTotals.size) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No i18n diagnostics found for this workspace.',
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
            console.error('AI Localizer: Failed to generate workspace health report:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to generate workspace health report.');
        }
    }

    /**
     * Generate auto-ignore patterns from constant-like values
     */
    async generateAutoIgnore(folderArg?: vscode.WorkspaceFolder): Promise<void> {
        try {
            let folder = folderArg;
            if (!folder) {
                const active = vscode.window.activeTextEditor;
                folder = active
                    ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
                    : undefined;

                if (!folder) {
                    folder = await pickWorkspaceFolder();
                }
            }

            if (!folder) {
                vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
                return;
            }

            await this.i18nIndex.ensureInitialized();

            const allKeys = this.i18nIndex.getAllKeys();
            if (!allKeys.length) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No translation keys found to analyze for auto-ignore.',
                );
                return;
            }

            const candidates = new Set<string>();
            const cfg = vscode.workspace.getConfiguration('ai-localizer');
            const globalDefaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

            for (const key of allKeys) {
                const record = this.i18nIndex.getRecord(key);
                if (!record) continue;
                const defaultLocale = record.defaultLocale || globalDefaultLocale;
                const baseValue = record.locales.get(defaultLocale);
                if (typeof baseValue !== 'string') continue;
                const base = baseValue.trim();
                if (!base) continue;

                const normalized = base.replace(/\s+/g, ' ');
                const words = normalized.split(/\s+/).filter(Boolean);
                const wordCount = words.length;
                const isTokenLike =
                    wordCount <= 3 &&
                    normalized.length <= 24 &&
                    !/[.!?]/.test(normalized);

                if (!isTokenLike) continue;

                const nonDefaultLocales = Array.from(record.locales.keys()).filter(
                    (l) => l !== defaultLocale,
                );
                if (!nonDefaultLocales.length) continue;

                let sameCount = 0;
                for (const locale of nonDefaultLocales) {
                    const v = record.locales.get(locale);
                    if (typeof v === 'string' && v.trim() === base) {
                        sameCount += 1;
                    }
                }

                const requiredSame = 1;
                if (sameCount < requiredSame) continue;

                candidates.add(normalized);
            }

            if (!candidates.size) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No constant-like values found to add to auto-ignore.',
                );
                return;
            }

            const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
            const autoUri = vscode.Uri.joinPath(scriptsDir, '.i18n-auto-ignore.json');
            let existing: any = {};
            try {
                const data = await vscode.workspace.fs.readFile(autoUri);
                const raw = sharedDecoder.decode(data);
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    existing = parsed;
                }
            } catch {}

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
                    'AI Localizer: No new auto-ignore patterns to add (all are already present).',
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
                existing.exactInsensitive = [];
            }
            if (!Array.isArray(existing.contains)) {
                existing.contains = [];
            }

            const payload = `${JSON.stringify(existing, null, 2)}\n`;
            await vscode.workspace.fs.createDirectory(scriptsDir);
            await vscode.workspace.fs.writeFile(autoUri, sharedEncoder.encode(payload));

            vscode.window.showInformationMessage(
                `AI Localizer: Updated scripts/.i18n-auto-ignore.json with ${newValues.length} pattern(s).`,
            );

            await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
        } catch (err) {
            console.error('AI Localizer: Failed to generate auto-ignore patterns:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to generate auto-ignore patterns.');
        }
    }
}

