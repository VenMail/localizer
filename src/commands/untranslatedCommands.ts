import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex, extractKeyAtPosition } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { getGranularSyncService } from '../services/granularSyncService';
import { setTranslationValue, setTranslationValueInFile, setTranslationValuesBatch, deriveRootFromFile } from '../core/i18nFs';
import { pickWorkspaceFolder, runI18nScript } from '../core/workspace';
import { findKeyInHistory, getFileContentAtCommit, getFileDiff } from '../core/gitHistory';
import { CommitTracker } from '../core/commitTracker';
// Use shared encoder/decoder instances to avoid repeated allocations
import { TextDecoder, TextEncoder } from 'util';

const sharedDecoder = new TextDecoder('utf-8');
const sharedEncoder = new TextEncoder();

/**
 * Commands for handling untranslated strings
 */
export class UntranslatedCommands {
    private deletionGuardPending: Map<string, { key: string; value: string; timeout: NodeJS.Timeout }> = new Map();

    constructor(
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private projectConfigService: ProjectConfigService,
        private context?: vscode.ExtensionContext,
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

        let deleted = false;

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
                deleted = true;
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
        return deleted;
    }

    private computeEditDistance(a: string, b: string): number {
        const m = a.length;
        const n = b.length;
        if (!m) return n;
        if (!n) return m;
        const dp: number[] = [];
        for (let j = 0; j <= n; j += 1) dp[j] = j;
        for (let i = 1; i <= m; i += 1) {
            let prev = dp[0];
            dp[0] = i;
            for (let j = 1; j <= n; j += 1) {
                const temp = dp[j];
                if (a[i - 1] === b[j - 1]) {
                    dp[j] = prev;
                } else {
                    const add = dp[j - 1] + 1;
                    const del = dp[j] + 1;
                    const sub = prev + 1;
                    dp[j] = add < del ? (add < sub ? add : sub) : del < sub ? del : sub;
                }
                prev = temp;
            }
        }
        return dp[n];
    }

    private getRootNameForRecord(record: any): string {
        if (!record || !Array.isArray(record.locations) || !record.locations.length) {
            return 'common';
        }
        const defaultLocale = record.defaultLocale;
        let location = record.locations.find((loc: any) => loc && loc.locale === defaultLocale);
        if (!location) {
            location = record.locations[0];
        }
        if (!location || !location.uri) {
            return 'common';
        }
        const base = path.basename(location.uri.fsPath, '.json');
        if (!base) {
            return 'common';
        }
        return base.toLowerCase();
    }

    private buildLabelFromKeySegment(segment: string): string {
        if (!segment) return '';
        const replaced = segment.replace(/[_\-]+/g, ' ');
        const parts = replaced.split(/\s+/).filter(Boolean);
        if (!parts.length) return '';
        return parts
            .map((p, index) => {
                const lower = p.toLowerCase();
                if (index === 0) {
                    return lower.charAt(0).toUpperCase() + lower.slice(1);
                }
                return lower;
            })
            .join(' ');
    }

    private async setMultipleInFile(fileUri: vscode.Uri, updates: Map<string, string>): Promise<void> {
        let root: any = {};
        try {
            const data = await vscode.workspace.fs.readFile(fileUri);
            const raw = sharedDecoder.decode(data);
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
        await vscode.workspace.fs.writeFile(fileUri, sharedEncoder.encode(payload));
    }

    private async pruneUntranslatedReports(
        folder: vscode.WorkspaceFolder,
        fixed: Array<{ locale: string; keyPath: string }>,
    ): Promise<void> {
        if (!fixed.length) {
            return;
        }

        const keySet = new Set<string>();
        for (const item of fixed) {
            if (!item || !item.locale || !item.keyPath) continue;
            keySet.add(`${item.locale}::${item.keyPath}`);
        }
        if (!keySet.size) {
            return;
        }

        const remainingCompactKeys = new Set<string>();
        let remainingCompactKnown = false;

        let prunedUntranslatedIssues = 0;
        let prunedCompactEntries = 0;

        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');

        // Combined untranslated/style report: scripts/.i18n-untranslated-report.json
        try {
            const combinedUri = vscode.Uri.joinPath(
                scriptsDir,
                '.i18n-untranslated-report.json',
            );
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
                    const payload = `${JSON.stringify(report, null, 2)}\n`;
                    await vscode.workspace.fs.writeFile(
                        combinedUri,
                        sharedEncoder.encode(payload),
                    );
                }

                const remainingIssues: any[] = Array.isArray(report.issues)
                    ? report.issues
                    : [];
                for (const issue of remainingIssues) {
                    if (
                        !issue ||
                        issue.issueType !== 'untranslated' ||
                        typeof issue.locale !== 'string'
                    ) {
                        continue;
                    }
                    const locale = issue.locale as string;
                    const localeFile =
                        typeof issue.localeFile === 'string' ? issue.localeFile : '';
                    if (!locale) {
                        continue;
                    }
                    remainingCompactKeys.add(`${locale}::${localeFile}`);
                }
                remainingCompactKnown = true;
            }
        } catch {
            // Ignore if report file is missing or invalid
        }

        // Untranslated-only grouped report: scripts/.i18n-untranslated-untranslated.json
        try {
            const untranslatedUri = vscode.Uri.joinPath(
                scriptsDir,
                '.i18n-untranslated-untranslated.json',
            );
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
                    const issues = entry.issues.filter((issue: any) => {
                        const keyPath =
                            issue && typeof issue.keyPath === 'string'
                                ? issue.keyPath
                                : null;
                        if (!keyPath) {
                            return true;
                        }
                        const key = `${locale}::${keyPath}`;
                        return !keySet.has(key);
                    });
                    if (issues.length !== beforeCount) {
                        changed = true;
                        prunedUntranslatedIssues += beforeCount - issues.length;
                    }
                    const result = issues.length ? { ...entry, issues } : null;
                    if (result && remainingCompactKnown) {
                        const localeFile =
                            typeof result.localeFile === 'string' ? result.localeFile : '';
                        remainingCompactKeys.add(`${locale}::${localeFile}`);
                    }
                    return result;
                })
                .filter((entry: any) => !!entry);

            if (changed) {
                report.files = newFiles;
                const payload = `${JSON.stringify(report, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(
                    untranslatedUri,
                    sharedEncoder.encode(payload),
                );
            }
        } catch {
            // Ignore if report file is missing or invalid
        }

        // Compact untranslated report: scripts/.i18n-untranslated-compact.json
        if (remainingCompactKnown) {
            try {
                const compactUri = vscode.Uri.joinPath(
                    scriptsDir,
                    '.i18n-untranslated-compact.json',
                );
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
                        const localeFile =
                            typeof entry.localeFile === 'string' ? entry.localeFile : '';
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
                    const payload = `${JSON.stringify(report, null, 2)}\n`;
                    await vscode.workspace.fs.writeFile(
                        compactUri,
                        sharedEncoder.encode(payload),
                    );
                }
            } catch {
                // Ignore if compact report file is missing or invalid
            }
        }

        if (prunedUntranslatedIssues > 0 || prunedCompactEntries > 0) {
            const parts: string[] = [];
            if (prunedUntranslatedIssues > 0) {
                parts.push(
                    `${prunedUntranslatedIssues} untranslated issue${
                        prunedUntranslatedIssues === 1 ? '' : 's'
                    }`,
                );
            }
            if (prunedCompactEntries > 0) {
                parts.push(
                    `${prunedCompactEntries} compact entr${
                        prunedCompactEntries === 1 ? 'y' : 'ies'
                    }`,
                );
            }
            const summary = parts.join(', ');
            vscode.window.showInformationMessage(
                `AI Localizer: Pruned ${summary} from untranslated reports.`,
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

        // Read AI instructions from the separate .txt file (fix-untranslated.js now writes them there)
        let aiInstructions: string | undefined;
        try {
            const instructionsUri = vscode.Uri.file(
                path.join(folder.uri.fsPath, 'scripts', '.i18n-untranslated-ai-instructions.txt'),
            );
            const instructionsData = await vscode.workspace.fs.readFile(instructionsUri);
            aiInstructions = sharedDecoder.decode(instructionsData).trim() || undefined;
        } catch {
            // Instructions file is optional; AI will use default prompt if not found
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
            } catch {
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

            await this.i18nIndex.ensureInitialized();

            // Group updates by locale for batched writes
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

            // Write batched updates per locale
            let totalWritten = 0;
            for (const [locale, batchUpdates] of updatesByLocale.entries()) {
                const result = await setTranslationValuesBatch(folder, locale, batchUpdates);
                totalWritten += result.written;
            }

            await this.pruneUntranslatedReports(
                folder,
                updates.map((u) => ({ locale: u.locale, keyPath: u.keyPath })),
            );

            vscode.window.showInformationMessage(
                `AI Localizer: Applied ${totalWritten} AI translation updates.`,
            );
        } catch (err) {
            console.error('Failed to apply AI fixes:', err);
            vscode.window.showErrorMessage(`AI Localizer: Failed to apply AI fixes. ${err}`);
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
                vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
                return;
            }

            // Use granular key-level sync for quick fixes (avoids touching unrelated files)
            const syncService = getGranularSyncService(this.context);
            await syncService.syncKeys(folder, [key]);

            await this.i18nIndex.ensureInitialized();
            const record = this.i18nIndex.getRecord(key);
            if (!record) {
                vscode.window.showInformationMessage(
                    `AI Localizer: No translation record found for key ${key}.`,
                );
                return;
            }

            const defaultLocale = record.defaultLocale;
            const defaultValue = record.locales.get(defaultLocale);
            if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
                vscode.window.showInformationMessage(
                    `AI Localizer: Default locale value not found for key ${key}.`,
                );
                return;
            }

            const targetLocales = locales.filter((l) => l && l !== defaultLocale);
            if (!targetLocales.length) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No target locales to translate for this key.',
                );
                return;
            }

            const rootName = this.getRootNameForRecord(record);

            // First: sync missing keys with default placeholder values using batched writes
            const placeholderUpdates = new Map<string, Map<string, { value: string; rootName?: string }>>();
            for (const locale of targetLocales) {
                const current = record.locales.get(locale);
                if (typeof current !== 'string' || !current.trim()) {
                    let localeUpdates = placeholderUpdates.get(locale);
                    if (!localeUpdates) {
                        localeUpdates = new Map();
                        placeholderUpdates.set(locale, localeUpdates);
                    }
                    localeUpdates.set(key, { value: defaultValue, rootName });
                }
            }
            
            // Write placeholder values in batch
            for (const [locale, updates] of placeholderUpdates.entries()) {
                await setTranslationValuesBatch(folder, locale, updates);
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
                    'AI Localizer: No translations were generated for this quick fix (check API key and settings).',
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

            // Write AI translations in batch
            const translationUpdates = new Map<string, Map<string, { value: string; rootName?: string }>>();
            for (const [locale, newValue] of translations.entries()) {
                let localeUpdates = translationUpdates.get(locale);
                if (!localeUpdates) {
                    localeUpdates = new Map();
                    translationUpdates.set(locale, localeUpdates);
                }
                localeUpdates.set(key, { value: newValue, rootName });
            }
            
            for (const [locale, updates] of translationUpdates.entries()) {
                await setTranslationValuesBatch(folder, locale, updates);
            }

            // Locale file writes trigger watchers which update index + diagnostics incrementally
            vscode.window.showInformationMessage(
                `AI Localizer: Applied AI translations for ${key} in ${translations.size} locale(s).`,
            );
        } catch (err) {
            console.error('AI Localizer: Failed to apply quick fix for untranslated key:', err);
            vscode.window.showErrorMessage(
                'AI Localizer: Failed to apply AI quick fix for untranslated key.',
            );
        }
    }

    async reviewSelection(documentUri?: vscode.Uri): Promise<void> {
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
                    'AI Localizer: No known i18n keys found in the current selection.',
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
     * Translate all untranslated keys in a locale file using AI.
     */
    async translateAllUntranslatedInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No active document to translate.',
                );
                return;
            }

            const doc = await vscode.workspace.openTextDocument(targetUri);
            if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                vscode.window.showInformationMessage(
                    'AI Localizer: Bulk translate only applies to locale JSON files.',
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

            // Use granular file-level sync (only syncs keys from this specific file)
            const syncService = getGranularSyncService(this.context);
            await syncService.syncFile(folder, targetUri);

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
                    'AI Localizer: Could not determine locale for this file.',
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
                    `AI Localizer: No untranslated keys found for locale ${targetLocale}.`,
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
                    placeHolder: `AI Localizer: Translate ${keysToTranslate.length} untranslated key(s) in this file?`,
                },
            );
            if (!choice || choice.label === 'Cancel') {
                return;
            }

            // Translate in a single batched call per locale (with internal limits)
            let translatedCount = 0;
            const fixed: { locale: string; keyPath: string }[] = [];

            const relPath = vscode.workspace.asRelativePath(targetUri);
            const progressTitle = `AI Localizer: Translating ${targetLocale} (${relPath})...`;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: progressTitle,
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

                    // Build batch updates map for efficient file I/O
                    const batchUpdates = new Map<string, { value: string; rootName?: string }>();
                    for (const item of keysToTranslate) {
                        if (token.isCancellationRequested) {
                            break;
                        }
                        const newValue = translations.get(item.key);
                        if (!newValue) {
                            continue;
                        }
                        const record = this.i18nIndex.getRecord(item.key);
                        const rootName = record ? this.getRootNameForRecord(record) : 'common';
                        batchUpdates.set(item.key, { value: newValue, rootName });
                    }

                    if (batchUpdates.size > 0 && !token.isCancellationRequested) {
                        progress.report({
                            message: `Writing ${batchUpdates.size} translation(s) to ${targetLocale}...`,
                        });

                        const writeResult = await setTranslationValuesBatch(folder!, targetLocale, batchUpdates);
                        translatedCount = writeResult.written;

                        for (const [key] of batchUpdates.entries()) {
                            fixed.push({ locale: targetLocale, keyPath: key });
                        }

                        if (writeResult.errors.length > 0) {
                            console.error('AI Localizer: Some translations failed to write:', writeResult.errors);
                        }
                    }
                },
            );

            if (fixed.length > 0) {
                await this.pruneUntranslatedReports(folder, fixed);
            }

            // Locale file writes trigger watchers which update index + diagnostics incrementally

            if (translatedCount > 0) {
                vscode.window.showInformationMessage(
                    `AI Localizer: Translated ${translatedCount} key(s) in ${targetLocale}.`,
                );
            } else {
                const apiChoice = await vscode.window.showInformationMessage(
                    'AI Localizer: No translations were generated (check API key and settings).',
                    'Open OpenAI API Key Settings',
                    'Dismiss',
                );
                if (apiChoice === 'Open OpenAI API Key Settings') {
                    await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
                }
            }
        } catch (err) {
            console.error('AI Localizer: Failed to translate all untranslated keys:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to translate all untranslated keys.');
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
                'AI Localizer: No translation keys found in this file.',
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
                'AI Localizer: No untranslated keys found for non-default locales in this file.',
            );
            return;
        }

        const localeEntries = Array.from(missingPerLocale.entries());
        let selectedLocales: string[];
        let translateAll = false;

        if (localeEntries.length === 1) {
            selectedLocales = [localeEntries[0][0]];
        } else {
            const totalKeys = localeEntries.reduce((sum, [, list]) => sum + list.length, 0);
            const items: Array<vscode.QuickPickItem & { locale?: string; isAll?: boolean }> = [
                {
                    label: `$(globe) All locales (${localeEntries.length} locales, ${totalKeys} keys)`,
                    description: `Translate all missing keys for all ${localeEntries.length} locales at once`,
                    isAll: true,
                },
                { label: '---', kind: vscode.QuickPickItemKind.Separator },
                ...localeEntries.map(([locale, list]) => {
                    const count = list.length;
                    return {
                        label: `${locale} (${count} key${count === 1 ? '' : 's'})`,
                        description: undefined,
                        locale,
                    };
                }),
            ];

            const choice = await vscode.window.showQuickPick(items, {
                placeHolder:
                    'AI Localizer: Select target locale(s) to translate missing keys for this file',
            });
            if (!choice) {
                return;
            }

            if ((choice as any).isAll) {
                translateAll = true;
                selectedLocales = localeEntries.map(([locale]) => locale);
            } else {
                const selectedLocale = (choice as any).locale;
                if (!selectedLocale) {
                    return;
                }
                selectedLocales = [selectedLocale];
            }
        }

        // Confirm with user
        const totalKeysToTranslate = translateAll
            ? localeEntries.reduce((sum, [, list]) => sum + list.length, 0)
            : missingPerLocale.get(selectedLocales[0])?.length || 0;

        const confirmLabel = translateAll
            ? `Translate all ${totalKeysToTranslate} key(s) to ${selectedLocales.length} locale(s)`
            : `Translate ${totalKeysToTranslate} key(s) to ${selectedLocales[0]}`;

        const confirm = await vscode.window.showQuickPick(
            [
                {
                    label: confirmLabel,
                    description: translateAll
                        ? `Use AI to translate missing keys for all ${selectedLocales.length} locales`
                        : `Use AI to translate ${totalKeysToTranslate} untranslated key(s) to ${selectedLocales[0]}`,
                },
                { label: 'Cancel', description: 'Do not translate' },
            ],
            {
                placeHolder: `AI Localizer: ${confirmLabel}?`,
            },
        );
        if (!confirm || confirm.label === 'Cancel') {
            return;
        }

        const relPath = vscode.workspace.asRelativePath(documentUri);
        let totalTranslatedCount = 0;
        const fixed: { locale: string; keyPath: string }[] = [];

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: translateAll
                    ? `AI Localizer: Translating ${selectedLocales.length} locale(s) (${relPath})...`
                    : `AI Localizer: Translating ${selectedLocales[0]} (${relPath})...`,
                cancellable: true,
            },
            async (progress, token) => {
                for (let i = 0; i < selectedLocales.length; i++) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const selectedLocale = selectedLocales[i];
                    const keysToTranslate = missingPerLocale.get(selectedLocale) || [];

                    if (!keysToTranslate.length) {
                        continue;
                    }

                    progress.report({
                        message: `Translating ${selectedLocale} (${i + 1}/${selectedLocales.length}): ${keysToTranslate.length} key(s)...`,
                        increment: (100 / selectedLocales.length) * (i === 0 ? 0 : 1),
                    });

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
                        continue;
                    }

                    // Build batch updates map for efficient file I/O
                    const batchUpdates = new Map<string, { value: string; rootName?: string }>();
                    for (const item of keysToTranslate) {
                        if (token.isCancellationRequested) {
                            break;
                        }
                        const newValue = translations.get(item.key);
                        if (!newValue) {
                            continue;
                        }
                        const record = this.i18nIndex.getRecord(item.key);
                        const rootName = record ? this.getRootNameForRecord(record) : 'common';
                        batchUpdates.set(item.key, { value: newValue, rootName });
                    }

                    if (batchUpdates.size > 0 && !token.isCancellationRequested) {
                        progress.report({
                            message: `Writing ${batchUpdates.size} translation(s) to ${selectedLocale}...`,
                            increment: (100 / selectedLocales.length) * 0.5,
                        });

                        const writeResult = await setTranslationValuesBatch(folder, selectedLocale, batchUpdates);
                        totalTranslatedCount += writeResult.written;

                        for (const [key] of batchUpdates.entries()) {
                            fixed.push({ locale: selectedLocale, keyPath: key });
                        }

                        if (writeResult.errors.length > 0) {
                            console.error(
                                `AI Localizer: Some translations failed to write for ${selectedLocale}:`,
                                writeResult.errors,
                            );
                        }
                    }

                    progress.report({
                        increment: (100 / selectedLocales.length) * 0.5,
                    });
                }
            },
        );

        if (fixed.length > 0) {
            await this.pruneUntranslatedReports(folder, fixed);
        }

        // Locale file writes trigger watchers which update index + diagnostics incrementally

        if (totalTranslatedCount > 0) {
            const localeSummary = translateAll
                ? `${totalTranslatedCount} key(s) across ${selectedLocales.length} locale(s)`
                : `${totalTranslatedCount} key(s) in ${selectedLocales[0]}`;
            vscode.window.showInformationMessage(`AI Localizer: Translated ${localeSummary}.`);
        } else {
            const apiChoice = await vscode.window.showInformationMessage(
                'AI Localizer: No translations were generated (check API key and settings).',
                'Open OpenAI API Key Settings',
                'Dismiss',
            );
            if (apiChoice === 'Open OpenAI API Key Settings') {
                await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
            }
        }
    }

    async translateAllUntranslatedInProject(): Promise<void> {
        try {
            const folders = vscode.workspace.workspaceFolders || [];
            if (!folders.length) {
                vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
                return;
            }

            let folder: vscode.WorkspaceFolder | undefined;
            if (folders.length === 1) {
                folder = folders[0];
            } else {
                folder = await pickWorkspaceFolder();
            }

            if (!folder) {
                vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
                return;
            }

            await vscode.commands.executeCommand('ai-localizer.i18n.runSyncScript');

            await this.i18nIndex.ensureInitialized();

            const cfg = vscode.workspace.getConfiguration('ai-localizer');
            const globalDefaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

            const allKeys = this.i18nIndex.getAllKeys();
            if (!allKeys.length) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No translation keys found to translate.',
                );
                return;
            }

            const allLocales = this.i18nIndex.getAllLocales();
            if (!allLocales.length) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No locales detected in this workspace.',
                );
                return;
            }

            const missingPerLocale = new Map<
                string,
                { key: string; defaultValue: string; defaultLocale: string }[]
            >();
            const sampleFileByLocale = new Map<string, vscode.Uri>();

            for (const key of allKeys) {
                const record = this.i18nIndex.getRecord(key);
                if (!record) {
                    continue;
                }

                const defaultLocale = record.defaultLocale || globalDefaultLocale;
                const defaultValue = record.locales.get(defaultLocale);
                if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
                    continue;
                }
                const base = defaultValue.trim();

                for (const locale of allLocales) {
                    if (!locale || locale === defaultLocale) {
                        continue;
                    }
                    const currentValue = record.locales.get(locale);
                    const current = typeof currentValue === 'string' ? currentValue.trim() : '';
                    const needsTranslation = !current || current === base;
                    if (!needsTranslation) {
                        continue;
                    }

                    if (!sampleFileByLocale.has(locale) && record.locations && record.locations.length) {
                        const locEntry =
                            record.locations.find((l) => l.locale === locale) || record.locations[0];
                        if (locEntry) {
                            sampleFileByLocale.set(locale, locEntry.uri);
                        }
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
                    'AI Localizer: No untranslated keys found for non-default locales in this workspace.',
                );
                return;
            }

            let totalKeys = 0;
            for (const list of missingPerLocale.values()) {
                totalKeys += list.length;
            }

            const confirm = await vscode.window.showQuickPick(
                [
                    {
                        label: `Translate ${totalKeys} key(s)` ,
                        description: `Use AI to translate ${totalKeys} untranslated key(s) across ${missingPerLocale.size} locale(s)`,
                    },
                    { label: 'Cancel', description: 'Do not translate' },
                ],
                {
                    placeHolder: `AI Localizer: Translate ${totalKeys} untranslated key(s) across all locales in this workspace?`,
                },
            );

            if (!confirm || confirm.label === 'Cancel') {
                return;
            }

            const localeEntries = Array.from(missingPerLocale.entries());
            const maxConcurrent = 4;
            let completedLocales = 0;
            let translatedTotal = 0;
            const fixed: { locale: string; keyPath: string }[] = [];

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'AI Localizer: Translating all locales...',
                    cancellable: true,
                },
                async (progress, token) => {
                    if (token.isCancellationRequested) {
                        return;
                    }

                    let index = 0;
                    let lastReported = 0;

                    const worker = async () => {
                        while (true) {
                            const current = index;
                            index += 1;
                            if (current >= localeEntries.length || token.isCancellationRequested) {
                                break;
                            }

                            const [locale, items] = localeEntries[current];

                            try {
                                const batchItems = items.map((item) => ({
                                    id: item.key,
                                    text: item.defaultValue,
                                    defaultLocale: item.defaultLocale,
                                }));

                                const translations = await this.translationService.translateBatchToLocale(
                                    batchItems,
                                    locale,
                                    'text',
                                    true,
                                );

                                if (!translations || translations.size === 0 || token.isCancellationRequested) {
                                    continue;
                                }

                                // Build batch updates map for efficient file I/O
                                const batchUpdates = new Map<string, { value: string; rootName?: string }>();
                                for (const item of items) {
                                    if (token.isCancellationRequested) {
                                        break;
                                    }
                                    const newValue = translations.get(item.key);
                                    if (!newValue) {
                                        continue;
                                    }
                                    const record = this.i18nIndex.getRecord(item.key);
                                    const rootName = record ? this.getRootNameForRecord(record) : 'common';
                                    batchUpdates.set(item.key, { value: newValue, rootName });
                                }

                                if (batchUpdates.size > 0 && !token.isCancellationRequested) {
                                    const writeResult = await setTranslationValuesBatch(folder!, locale, batchUpdates);
                                    translatedTotal += writeResult.written;

                                    for (const [key] of batchUpdates.entries()) {
                                        fixed.push({ locale, keyPath: key });
                                    }

                                    if (writeResult.errors.length > 0) {
                                        console.error(`AI Localizer: Some translations failed to write for ${locale}:`, writeResult.errors);
                                    }
                                }
                            } catch (err) {
                                console.error(
                                    `AI Localizer: Failed to translate keys for locale ${locale}:`,
                                    err,
                                );
                            } finally {
                                completedLocales += 1;
                                const percent = (completedLocales / localeEntries.length) * 100;
                                const sampleUri = sampleFileByLocale.get(locale);
                                const fileLabel = sampleUri
                                    ? vscode.workspace.asRelativePath(sampleUri, false)
                                    : undefined;
                                const baseMsg = `${completedLocales} of ${localeEntries.length} locale(s)`;
                                const message = fileLabel
                                    ? `${baseMsg} — ${locale} (${fileLabel})`
                                    : `${baseMsg} — ${locale}`;
                                progress.report({
                                    message,
                                    increment: percent - lastReported,
                                });
                                lastReported = percent;
                            }
                        }
                    };

                    const workers: Promise<void>[] = [];
                    const workerCount = Math.min(maxConcurrent, localeEntries.length);
                    for (let i = 0; i < workerCount; i += 1) {
                        workers.push(worker());
                    }
                    await Promise.all(workers);
                },
            );

            if (fixed.length > 0) {
                await this.pruneUntranslatedReports(folder, fixed);
            }

            if (translatedTotal > 0) {
                vscode.window.showInformationMessage(
                    `AI Localizer: Translated ${translatedTotal} key(s) across ${missingPerLocale.size} locale(s).`,
                );
                await this.generateAutoIgnore(folder);
            } else {
                const apiChoice = await vscode.window.showInformationMessage(
                    'AI Localizer: No translations were generated (check API key and settings).',
                    'Open OpenAI API Key Settings',
                    'Dismiss',
                );
                if (apiChoice === 'Open OpenAI API Key Settings') {
                    await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
                }
            }
        } catch (err) {
            console.error('AI Localizer: Failed to translate all untranslated keys in the project:', err);
            vscode.window.showErrorMessage(
                'AI Localizer: Failed to translate all untranslated keys in the project.',
            );
        }
    }

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

                const requiredSame = 1;
                if (sameCount < requiredSame) {
                    continue;
                }

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
                existing.exactInsensitive = Array.isArray(existing.exactInsensitive)
                    ? existing.exactInsensitive
                    : [];
            }
            if (!Array.isArray(existing.contains)) {
                existing.contains = Array.isArray(existing.contains) ? existing.contains : [];
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
                `AI Localizer: Applied style suggestion for ${key} in ${locale}.`,
            );
        } catch (err) {
            console.error('AI Localizer: Failed to apply style suggestion quick fix:', err);
            vscode.window.showErrorMessage(
                'AI Localizer: Failed to apply style suggestion quick fix.',
            );
        }
    }

    async applyAllStyleSuggestionsInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage('AI Localizer: No active document to apply style suggestions.');
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
                const parsed = this.parseStyleDiagnostic(String(d.message || ''));
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

            // Fast path: single read/write for this file
            const updatesMap = new Map<string, string>();
            for (const s of unique) updatesMap.set(s.key, s.suggested);
            await this.setMultipleInFile(targetUri, updatesMap);
            // Incremental reindex and diagnostics refresh for this file only
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

    async fixAllIssuesInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No active document to fix i18n issues.',
                );
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
            console.error('AI Localizer: Failed to run all per-file fixes for file:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to run all per-file fixes for file.');
        }
    }

    async cleanupUnusedInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No active document to cleanup unused keys.',
                );
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
                return this.hasKeyPathInObject(root, item.keyPath);
            });

            if (!unused.length) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No unused keys from report were found in this file.',
                );
                return;
            }

            // Confirm with user before proceeding
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

            const applyToAllLocales =
                choice.label === 'Remove unused keys in all locale files';

            const deletedKeys = new Set<string>();
            for (const item of unused) {
                if (!item || typeof item.keyPath !== 'string') continue;
                if (this.deleteKeyPathInObject(root, item.keyPath)) {
                    deletedKeys.add(item.keyPath);
                }
            }

            if (!deletedKeys.size) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No unused keys were removed from this file.',
                );
                return;
            }

            const payload = `${JSON.stringify(root, null, 2)}\n`;
            await vscode.workspace.fs.writeFile(targetUri, sharedEncoder.encode(payload));

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
                    if (!record) {
                        continue;
                    }
                    const otherUris = record.locations
                        .map((l) => l.uri)
                        .filter((u) => u.toString() !== targetUri.toString());
                    if (!otherUris.length) {
                        continue;
                    }
                    deletedFromOtherFiles += await this.deleteKeyFromLocaleFiles(
                        keyPath,
                        otherUris,
                    );
                }
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
        } catch (err) {
            console.error('AI Localizer: Failed to cleanup unused keys for file:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to cleanup unused keys for file.');
        }
    }

    async restoreInvalidInFile(documentUri?: vscode.Uri): Promise<void> {
        try {
            const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
            if (!targetUri) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No active document to cleanup invalid keys.',
                );
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
                    'AI Localizer: No invalid/non-translatable keys from report were found in this file.',
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
                    placeHolder: `AI Localizer: Restore ${invalid.length} invalid key(s) found in this file to inline strings?`,
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
                        console.error(`AI Localizer: Failed to restore code reference for ${item.keyPath} in ${usage.file}:`, err);
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
                if (this.deleteKeyPathInObject(root, item.keyPath)) {
                    deletedKeys.add(item.keyPath);
                }
            }

            if (deletedKeys.size > 0) {
                const payload = `${JSON.stringify(root, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(targetUri, sharedEncoder.encode(payload));

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
                ? `AI Localizer: Restored ${codeRestoreCount} code reference(s) and removed ${deletedKeys.size} invalid key(s) from this file.`
                : `AI Localizer: Removed ${deletedKeys.size} invalid/non-translatable key(s) from this file.`;
            vscode.window.showInformationMessage(message);
        } catch (err) {
            console.error('AI Localizer: Failed to cleanup invalid keys for file:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to cleanup invalid keys for file.');
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
            console.error(`AI Localizer: Failed to restore inline string in ${fileUri.fsPath}:`, err);
            return false;
        }
    }

    async removeUnusedKeyInFile(documentUri: vscode.Uri, keyPath: string): Promise<void> {
        try {
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

            let root: any = {};
            try {
                const text = doc.getText();
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') root = parsed;
            } catch {}
            if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

            if (!this.deleteKeyPathInObject(root, keyPath)) {
                vscode.window.showInformationMessage(
                    `AI Localizer: Key ${keyPath} was not found in this file.`,
                );
                return;
            }

            const payload = `${JSON.stringify(root, null, 2)}\n`;
            await vscode.workspace.fs.writeFile(documentUri, sharedEncoder.encode(payload));

            await this.i18nIndex.updateFile(documentUri);
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.refreshFileDiagnostics',
                documentUri,
                [keyPath],
            );

            vscode.window.showInformationMessage(
                `AI Localizer: Removed unused key ${keyPath} from this file.`,
            );
        } catch (err) {
            console.error('AI Localizer: Failed to remove unused key from file:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to remove unused key from file.');
        }
    }

    async removeInvalidKeyInFile(documentUri: vscode.Uri, keyPath: string): Promise<void> {
        try {
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
                    placeHolder: `AI Localizer: Restore invalid key ${keyPath} to inline string and remove from locale files?`,
                },
            );
            if (!choice || choice.label === 'Cancel') {
                return;
            }

            // First, restore code references for this key
            // CRITICAL: With the fixed logic, keys in the invalid report should be unused.
            // However, if this is an old report generated with buggy logic, the key might have usages.
            // In that case, we should NOT restore code as it would break the application.
            let codeRestoreCount = 0;
            const usages = Array.isArray(entry.usages) ? entry.usages : [];
            const baseValue = typeof entry.baseValue === 'string' ? entry.baseValue : '';

            // Safety check: If the key is being used in code, this is likely from an old buggy report.
            // Warn the user - the key should not be removed if it's actively being used.
            if (usages.length > 0) {
                const choice = await vscode.window.showWarningMessage(
                    `AI Localizer: Key "${keyPath}" is marked as invalid but is being used in ${usages.length} location(s) in code. ` +
                    `This may be from an outdated report. Removing it would break the application. ` +
                    `Please regenerate the invalid keys report. Do you want to cancel this operation?`,
                    { modal: true },
                    'Cancel',
                    'Remove from locale files only (risky)',
                );
                if (!choice || choice === 'Cancel') {
                    return;
                }
                // User chose to proceed anyway - skip code restoration but remove from locale files
                // This is risky but user explicitly chose it
            } else {
                // Key is unused (as expected for invalid keys with the fixed logic)
                // No code to restore since the key isn't used anywhere
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

            if (this.deleteKeyPathInObject(root, keyPath)) {
                const payload = `${JSON.stringify(root, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(documentUri, sharedEncoder.encode(payload));

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
                ? `AI Localizer: Restored ${codeRestoreCount} code reference(s) and removed invalid key ${keyPath} from locale files.`
                : `AI Localizer: Removed invalid/non-translatable key ${keyPath} from locale files.`;
            vscode.window.showInformationMessage(message);
        } catch (err) {
            console.error('AI Localizer: Failed to remove invalid key from file:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to remove invalid key from file.');
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
                    `AI Localizer: No matching t('${key}') call found at this location to restore.`,
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
                    'AI Localizer: Failed to apply restore quick fix edit to source file.',
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
                    `AI Localizer: Restored inline string for invalid/non-translatable key ${key} at this location and removed it from ${deletedFromLocales} locale file(s).`,
                );
            } else {
                vscode.window.showInformationMessage(
                    `AI Localizer: Restored inline string for invalid/non-translatable key ${key} at this location.`,
                );
            }
        } catch (err) {
            console.error('AI Localizer: Failed to restore invalid key in code:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to restore invalid key in code.');
        }
    }

    async fixMissingKeyReference(
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
                vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
                return;
            }

            const cfg = vscode.workspace.getConfiguration('ai-localizer');
            const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';
            const rootName = deriveRootFromFile(folder, documentUri);
            const keyParts = String(key).split('.').filter(Boolean);
            const keyLeaf = keyParts[keyParts.length - 1] || '';
            const keyPrefix = keyParts.slice(0, -1).join('.');

            // Use granular key-level sync (only syncs the specific key being fixed)
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
                const score = this.computeEditDistance(keyLeaf, leaf);
                if (score < bestScore) {
                    bestScore = score;
                    bestKey = candidate;
                }
            }

            // Check if the best key is a good enough match (low edit distance)
            if (bestKey) {
                const bestParts = bestKey.split('.').filter(Boolean);
                const bestLeaf = bestParts[bestParts.length - 1] || '';
                const maxLen = Math.max(bestLeaf.length, keyLeaf.length);
                // Stricter threshold: score must be <= 2 or <= 25% of max length
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
            const localeUris = await this.getLocaleFileUris(folder, defaultLocale);
            let recoveredValue: string | null = null;
            let recoveredSource: string | null = null;

            // Try recent git history (within last 30 days)
            for (const localeUri of localeUris) {
                const historyResult = await findKeyInHistory(folder, localeUri.fsPath, key, 30);
                if (historyResult && historyResult.value) {
                    recoveredValue = historyResult.value;
                    recoveredSource = 'git history';
                    break;
                }
            }

            // Try commit ref tracking (extract/replace commits)
            if (!recoveredValue && this.context) {
                const extractRef = CommitTracker.getExtractCommitRef(this.context, folder);
                if (extractRef) {
                    for (const localeUri of localeUris) {
                        const content = await getFileContentAtCommit(
                            folder,
                            localeUri.fsPath,
                            extractRef.commitHash,
                        );
                        if (content) {
                            try {
                                const json = JSON.parse(content);
                                const value = this.getNestedValue(json, key);
                                if (value && typeof value === 'string') {
                                    recoveredValue = value;
                                    recoveredSource = 'pre-extract commit';
                                    break;
                                }
                            } catch {
                                // Invalid JSON
                            }
                        }
                    }
                }
            }

            // If recovered from git, auto-restore
            if (recoveredValue) {
                await setTranslationValue(folder, defaultLocale, key, recoveredValue, { rootName });
                vscode.window.showInformationMessage(
                    `AI Localizer: Restored "${key}" from ${recoveredSource}.`,
                );
                return;
            }

            // STEP 3: Show options (only as fallback)
            const items: vscode.QuickPickItem[] = [];
            
            // Offer similar key replacement if we found one (but not an exact auto-fix)
            if (bestKey && bestKey !== key) {
                const bestParts = bestKey.split('.').filter(Boolean);
                const bestLeaf = bestParts[bestParts.length - 1] || '';
                const maxLen = Math.max(bestLeaf.length, keyLeaf.length);
                // More lenient threshold for showing the option
                if (maxLen > 0 && bestScore <= Math.max(3, Math.floor(maxLen / 2))) {
                    items.push({
                        label: `$(replace) Replace with: ${bestKey}`,
                        description: `Similar key found (edit distance: ${bestScore})`,
                        detail: 'Use closest matching translation key in the same namespace',
                    });
                }
            }

            // Generate a suggested label from the key segment
            const suggestedLabel = this.buildLabelFromKeySegment(keyLeaf) || key;
            
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
            if (!choice) {
                return;
            }

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
                if (!customValue) {
                    return;
                }
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
        } catch (err) {
            console.error('AI Localizer: Failed to fix missing key reference:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to fix missing key reference.');
        }
    }

    private async deleteKeyFromLocaleFiles(
        keyPath: string,
        uris: vscode.Uri[],
        defaultValue?: string,
    ): Promise<number> {
        return this.deleteKeyFromLocaleFilesWithGuard(keyPath, uris, defaultValue);
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

            // Rescan to apply the new ignore pattern
            await vscode.commands.executeCommand('ai-localizer.i18n.rescan');

            vscode.window.showInformationMessage(
                `AI Localizer: Added "${normalizedValue}" to ignore list. Diagnostics will be refreshed.`,
            );
        } catch (err) {
            console.error('AI Localizer: Failed to add key to ignore list:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to add key to ignore list.');
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
                vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
                return;
            }

            await this.i18nIndex.ensureInitialized();
            const record = this.i18nIndex.getRecord(key);
            if (!record) {
                vscode.window.showInformationMessage(
                    `AI Localizer: No translation record found for key ${key}.`,
                );
                return;
            }

            const defaultLocale = record.defaultLocale;
            const defaultValue = record.locales.get(defaultLocale);
            if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
                vscode.window.showInformationMessage(
                    `AI Localizer: Default locale value not found for key ${key}.`,
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
                    'AI Localizer: No translation generated (check API key and settings).',
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
                const record = this.i18nIndex.getRecord(key);
                const rootName = record ? this.getRootNameForRecord(record) : 'common';
                await setTranslationValue(folder, locale, key, newValue, { rootName });
                // Locale file writes trigger watchers which update index + diagnostics incrementally

                vscode.window.showInformationMessage(
                    `AI Localizer: Fixed placeholder mismatch for ${key} in ${locale}.`,
                );
            }
        } catch (err) {
            console.error('AI Localizer: Failed to fix placeholder mismatch:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to fix placeholder mismatch.');
        }
    }

    /**
     * Bulk fix missing translation key references in a ts/tsx file
     * Scans the file for all t('key') calls and fixes missing keys
     */
    async bulkFixMissingKeyReferences(documentUri: vscode.Uri): Promise<void> {
        try {
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

            let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
            if (!folder) {
                folder = await pickWorkspaceFolder();
            }
            if (!folder) {
                vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
                return;
            }

            // Extract all translation keys from the file
            const text = doc.getText();
            const keyMatches: Array<{ key: string; range: vscode.Range }> = [];
            
            // Match t('key') or t('key', { ... }) patterns
            // Handles: t('key'), t("key"), t('key', { vars }), $t('key'), etc.
            // Pattern: t( followed by quoted key, then either ) or , (for additional args)
            const tCallRegex = /\$?t\(\s*(['"])([A-Za-z0-9_.]+)\1\s*[,)]/g;
            let match;
            while ((match = tCallRegex.exec(text)) !== null) {
                const key = match[2];
                // Calculate position: match.index + '$?t(' length + whitespace + opening quote
                const keyStartInMatch = match[0].indexOf(match[1]) + 1; // After opening quote
                const startPos = doc.positionAt(match.index + keyStartInMatch);
                const endPos = doc.positionAt(match.index + keyStartInMatch + key.length);
                const range = new vscode.Range(startPos, endPos);
                keyMatches.push({ key, range });
            }

            if (keyMatches.length === 0) {
                vscode.window.showInformationMessage(
                    'AI Localizer: No translation key references found in this file.',
                );
                return;
            }

            await this.i18nIndex.ensureInitialized();
            const allKeys = this.i18nIndex.getAllKeys();
            // Use Set for O(1) lookup instead of O(n) includes()
            const allKeysSet = new Set(allKeys);
            const missingKeys: Array<{ key: string; range: vscode.Range }> = [];

            // Check which keys are missing
            for (const { key, range } of keyMatches) {
                if (!allKeysSet.has(key)) {
                    missingKeys.push({ key, range });
                }
            }

            if (missingKeys.length === 0) {
                vscode.window.showInformationMessage(
                    'AI Localizer: All translation keys in this file are valid.',
                );
                return;
            }

            // Show progress and fix missing keys
            const progressMessage = `Found ${missingKeys.length} missing translation key(s). Fixing...`;
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'AI Localizer: Bulk Fix Missing References',
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: progressMessage });

                    const edit = new vscode.WorkspaceEdit();
                    const cfg = vscode.workspace.getConfiguration('ai-localizer');
                    const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';
                    const rootName = deriveRootFromFile(folder!, documentUri);
                    const batchUpdates = new Map<string, { value: string; rootName: string }>();

                    let fixedCount = 0;
                    let createdCount = 0;

                    // Pre-fetch locale URIs once (not inside the loop)
                    const localeUris = await this.getLocaleFileUris(folder!, defaultLocale);
                    
                    // Pre-fetch commit ref once
                    const extractRef = this.context 
                        ? CommitTracker.getExtractCommitRef(this.context, folder!)
                        : null;
                    
                    // Cache commit content to avoid repeated git calls
                    const commitContentCache = new Map<string, any>();
                    if (extractRef) {
                        for (const localeUri of localeUris) {
                            const content = await getFileContentAtCommit(
                                folder!,
                                localeUri.fsPath,
                                extractRef.commitHash,
                            );
                            if (content) {
                                try {
                                    commitContentCache.set(localeUri.fsPath, JSON.parse(content));
                                } catch {
                                    // Invalid JSON
                                }
                            }
                        }
                    }

                    // Build prefix index for faster candidate lookup
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

                    for (const { key, range } of missingKeys) {
                        // Try to find a similar key
                        const keyParts = key.split('.').filter(Boolean);
                        const keyPrefix = keyParts.slice(0, -1).join('.');
                        const keyLeaf = keyParts[keyParts.length - 1] || '';

                        let bestKey: string | null = null;
                        let bestScore = Number.POSITIVE_INFINITY;

                        // Only check candidates with matching prefix (O(1) lookup + small set iteration)
                        const candidates = keysByPrefix.get(keyPrefix) || [];
                        for (const { key: candidateKey, leaf } of candidates) {
                            const score = this.computeEditDistance(keyLeaf, leaf);
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
                                // Replace with best matching key
                                edit.replace(documentUri, range, bestKey);
                                fixedCount++;
                                continue;
                            }
                        }

                        // Try to recover from git history
                        let recoveredValue: string | null = null;

                        for (const localeUri of localeUris) {
                            const historyResult = await findKeyInHistory(folder!, localeUri.fsPath, key, 30);
                            if (historyResult && historyResult.value) {
                                recoveredValue = historyResult.value;
                                break;
                            }
                        }

                        // Try to recover from cached commit refs
                        if (!recoveredValue && extractRef) {
                            for (const localeUri of localeUris) {
                                const cachedJson = commitContentCache.get(localeUri.fsPath);
                                if (cachedJson) {
                                    const value = this.getNestedValue(cachedJson, key);
                                    if (value && typeof value === 'string') {
                                        recoveredValue = value;
                                        break;
                                    }
                                }
                            }
                        }

                        if (recoveredValue) {
                            // Restore the value
                            batchUpdates.set(key, { value: recoveredValue, rootName });
                            createdCount++;
                        } else {
                            // Create new key with label from key segment
                            const lastSegment = keyParts[keyParts.length - 1] || '';
                            const label = this.buildLabelFromKeySegment(lastSegment) || key;
                            batchUpdates.set(key, { value: label, rootName });
                            createdCount++;
                        }
                    }

                    // Apply edits
                    if (edit.size > 0) {
                        const applied = await vscode.workspace.applyEdit(edit);
                        if (applied) {
                            await doc.save();
                        }
                    }

                    // Batch create missing keys
                    if (batchUpdates.size > 0) {
                        await setTranslationValuesBatch(folder!, defaultLocale, batchUpdates);
                    }

                    const message = `Fixed ${fixedCount} reference(s) and created ${createdCount} new key(s).`;
                    vscode.window.showInformationMessage(`AI Localizer: ${message}`);
                },
            );
        } catch (err) {
            console.error('AI Localizer: Failed to bulk fix missing key references:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to bulk fix missing key references.');
        }
    }

    /**
     * Get locale file URIs for a locale
     */
    private async getLocaleFileUris(
        folder: vscode.WorkspaceFolder,
        locale: string,
    ): Promise<vscode.Uri[]> {
        const uris: vscode.Uri[] = [];
        const localeDir = vscode.Uri.joinPath(
            folder.uri,
            'resources',
            'js',
            'i18n',
            'auto',
            locale,
        );

        try {
            const entries = await vscode.workspace.fs.readDirectory(localeDir);
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.json')) {
                    uris.push(vscode.Uri.joinPath(localeDir, name));
                }
            }
        } catch {
            // Try single file format
            const singleFile = vscode.Uri.joinPath(
                folder.uri,
                'resources',
                'js',
                'i18n',
                'auto',
                `${locale}.json`,
            );
            try {
                await vscode.workspace.fs.stat(singleFile);
                uris.push(singleFile);
            } catch {
                // File doesn't exist
            }
        }

        return uris;
    }

    /**
     * Get nested value from object using dot notation path
     */
    private getNestedValue(obj: any, path: string): any {
        const segments = path.split('.').filter(Boolean);
        let current = obj;
        for (const segment of segments) {
            if (!current || typeof current !== 'object' || Array.isArray(current)) {
                return undefined;
            }
            if (!Object.prototype.hasOwnProperty.call(current, segment)) {
                return undefined;
            }
            current = current[segment];
        }
        return current;
    }

    /**
     * Guard: Prevent deletion of default locale keys that are used in components
     * Shows confirmation dialog with restore capability
     */
    async guardDeleteDefaultLocaleKey(
        localeUri: vscode.Uri,
        keyPath: string,
        defaultValue: string,
    ): Promise<boolean> {
        const folder = vscode.workspace.getWorkspaceFolder(localeUri);
        if (!folder) {
            return true; // Allow deletion if no folder
        }

        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

        // Check if this is a default locale file
        const localePath = localeUri.fsPath.toLowerCase();
        const isDefaultLocale = localePath.includes(`/${defaultLocale}/`) || 
                               localePath.includes(`/${defaultLocale}.json`);

        if (!isDefaultLocale) {
            return true; // Not default locale, allow deletion
        }

        // Check if key is used in any component files
        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(keyPath);
        const isUsed = record && record.locations.length > 0;

        if (!isUsed) {
            return true; // Not used, allow deletion
        }

        // Key is used and in default locale - require confirmation immediately
        const message = `Key "${keyPath}" is used in ${record.locations.length} component(s). Deleting it will cause missing translations.`;
        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            'Delete Anyway',
            'Cancel',
        );

        if (choice !== 'Delete Anyway') {
            return false; // Deletion cancelled
        }

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

        return true; // Deletion allowed
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

            // If value is empty, try to recover from git history
            if (!restoreValue || !restoreValue.trim()) {
                const historyResult = await findKeyInHistory(folder, localeUri.fsPath, keyPath, 30);
                if (historyResult && historyResult.value) {
                    restoreValue = historyResult.value;
                } else if (this.context) {
                    // Try commit refs
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
                                const recovered = this.getNestedValue(json, keyPath);
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

            const doc = await vscode.workspace.openTextDocument(localeUri);
            let root: any = {};
            
            try {
                const data = await vscode.workspace.fs.readFile(localeUri);
                const raw = sharedDecoder.decode(data);
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    root = parsed;
                }
            } catch {
                root = {};
            }

            // Set the key back
            const segments = keyPath.split('.').filter(Boolean);
            let current = root;
            for (let i = 0; i < segments.length - 1; i++) {
                const segment = segments[i];
                if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
                    current[segment] = {};
                }
                current = current[segment];
            }
            current[segments[segments.length - 1]] = restoreValue;

            const payload = `${JSON.stringify(root, null, 2)}\n`;
            await vscode.workspace.fs.writeFile(localeUri, sharedEncoder.encode(payload));
            
            await this.i18nIndex.updateFile(localeUri);
            vscode.window.showInformationMessage(`AI Localizer: Restored key "${keyPath}".`);
        } catch (err) {
            console.error('AI Localizer: Failed to restore deleted key:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to restore deleted key.');
        }
    }

    /**
     * Enhanced deleteKeyFromLocaleFiles with guard
     */
    private async deleteKeyFromLocaleFilesWithGuard(
        keyPath: string,
        uris: vscode.Uri[],
        defaultValue?: string,
    ): Promise<number> {
        if (!uris.length) {
            return 0;
        }

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
                    const raw = sharedDecoder.decode(data);
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') root = parsed;
                } catch {
                    continue;
                }
                if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

                // Get current value before deletion
                const currentValue = this.getNestedValue(root, keyPath);
                const valueToRestore = defaultValue || (typeof currentValue === 'string' ? currentValue : '');

                // Check guard
                if (valueToRestore) {
                    const allowed = await this.guardDeleteDefaultLocaleKey(uri, keyPath, valueToRestore);
                    if (!allowed) {
                        continue; // Deletion was cancelled or restored
                    }
                }

                if (!this.deleteKeyPathInObject(root, keyPath)) {
                    continue;
                }

                const payload = `${JSON.stringify(root, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(uri, sharedEncoder.encode(payload));
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
