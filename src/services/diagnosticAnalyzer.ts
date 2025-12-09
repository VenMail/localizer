import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import { I18nIndex, TranslationRecord } from '../core/i18nIndex';
import { ProjectConfigService } from './projectConfigService';
import { operationLock } from '../commands/untranslated/utils/operationLock';

// Shared decoder instance to avoid repeated allocations
const sharedDecoder = new TextDecoder('utf-8');

// Maximum number of files to keep in text cache (prevents unbounded memory growth)
const MAX_FILE_TEXT_CACHE_SIZE = 50;

/**
 * Incremental diagnostic analyzer for i18n translation issues.
 * 
 * Architecture:
 * - Maintains per-file diagnostic cache
 * - Tracks which keys are affected by each file
 * - Only recomputes diagnostics for keys in changed files
 * - Supports single-file and multi-file analysis
 */
export class DiagnosticAnalyzer {
    private diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();
    private fileTextCache = new Map<
        string,
        { text: string; lineStarts: number[]; keyRanges: Map<string, vscode.Range> }
    >();
    private fileTextCacheOrder: string[] = []; // Track insertion order for LRU eviction
    private styleIssuesByLocaleKey = new Map<
        string,
        { english?: string; current?: string; suggested?: string }
    >();
    private styleReportLoaded = false;
    private ignorePatterns: { exact?: string[]; exactInsensitive?: string[]; contains?: string[] } | null = null;
    private ignorePatternsLoaded = false;
    private untranslatedIssuesByLocaleKey = new Map<string, boolean>();
    private untranslatedReportActive = false;

    constructor(
        private i18nIndex: I18nIndex,
        private projectConfigService: ProjectConfigService,
        private log: vscode.OutputChannel,
    ) {}

    // Per-run logging flag (set from config)
    private logVerboseEnabled = false;

    /**
     * Suppress verbose logging while bulk operations (key management, translations, cleanup) are running.
     */
    private isQuietMode(): boolean {
        const current = operationLock.getCurrentOperation();
        if (!current) return false;
        return [
            'key-management',
            'translation-project',
            'translation-file',
            'cleanup-unused',
            'cleanup-invalid',
            'style-fix',
        ].includes(current.type);
    }

    private safeLog(message: string): void {
        if (!this.logVerboseEnabled) return;
        if (this.isQuietMode()) return;
        this.log.appendLine(message);
    }

    private verboseLog(message: string, enabled: boolean): void {
        if (!enabled) return;
        this.safeLog(message);
    }

    /**
     * Analyze a single locale file and return diagnostics for it.
     * This is the core incremental analysis method.
     */
    async analyzeFile(
        uri: vscode.Uri,
        config: DiagnosticConfig,
        extraKeys?: string[],
        forcedLocales?: string[],
    ): Promise<vscode.Diagnostic[]> {
        this.logVerboseEnabled = config.verboseLogging === true;
        const fileKey = uri.toString();
        // Invalidate cached text/range data so we always analyze the latest version
        this.fileTextCache.delete(fileKey);
        this.safeLog(`[DiagnosticAnalyzer] Analyzing file: ${uri.fsPath}`);
        const verbose = config.verboseLogging === true;

        // Get keys contributed by this file
        const fileInfo = this.i18nIndex.getKeysForFile(uri);
        
        // If no keys in this file, we still need to check if this is a locale file
        // that should have keys from the default locale
        const fileLocale = fileInfo?.locale;
        const fileKeys = fileInfo?.keys || [];
        const keysToAnalyze = extraKeys && extraKeys.length
            ? Array.from(new Set<string>([...fileKeys, ...extraKeys]))
            : fileKeys;
        const changedKeysSet = new Set<string>(extraKeys || []);
        
        if (!fileLocale) {
            this.safeLog(`[DiagnosticAnalyzer] Cannot determine locale for file: ${uri.fsPath}`);
            return [];
        }
        
        this.verboseLog(
            `[DiagnosticAnalyzer] File has ${fileKeys.length} key(s) for locale '${fileLocale}' (analyzing ${keysToAnalyze.length})`,
            verbose,
        );
        const diagnostics: vscode.Diagnostic[] = [];

        // Get workspace folder config
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            return [];
        }

        const projectConfig = await this.projectConfigService.readConfig(folder);
        const defaultLocaleGlobal = config.defaultLocale || 'en';
        const discoveredLocales = this.i18nIndex.getAllLocales();
        const configuredLocales = projectConfig?.locales || [];
        const union = new Set<string>([...configuredLocales, ...discoveredLocales, defaultLocaleGlobal]);
        const localesBase = [
            defaultLocaleGlobal,
            ...Array.from(union).filter((l) => l !== defaultLocaleGlobal),
        ];
        const localesSet = new Set<string>(localesBase);
        for (const fl of forcedLocales || []) {
            if (fl) localesSet.add(fl);
        }
        const locales = Array.from(localesSet);

        // For each key in this file (plus any extra changed keys), check all locales
        for (const key of keysToAnalyze) {
            const record = this.i18nIndex.getRecord(key);
            if (!record) {
                continue;
            }

            const defaultLocaleForKey = record.defaultLocale || defaultLocaleGlobal;
            const defaultValueRaw =
                record.locales.get(defaultLocaleForKey) ??
                record.locales.get(defaultLocaleGlobal);
            const hasDefaultValue = typeof defaultValueRaw === 'string' && !!defaultValueRaw.trim();
            const defaultValue = hasDefaultValue ? (defaultValueRaw as string) : '';
            const defaultPlaceholders = hasDefaultValue
                ? this.extractPlaceholders(defaultValue)
                : new Set<string>();

            const isConstantLikeAcrossLocales = this.isProbablyConstantAcrossLocales(
                record,
                defaultLocaleForKey,
                defaultValue,
            );

            // Base value flags:
            // - baseLooksNonTranslatable: clearly technical / CSS / code, should not be translated
            // - baseIsIgnored: user-configured ignore pattern (suppress untranslated/missing diagnostics)
            const baseLooksNonTranslatable =
                hasDefaultValue && this.isProbablyNonTranslatable(defaultValue);
            const baseIsIgnored = hasDefaultValue && this.isIgnoredText(defaultValue);

            this.verboseLog(
                `[DiagnosticAnalyzer] Checking key '${key}' (default='${defaultLocaleForKey}') in file '${uri.fsPath}' (fileLocale='${fileLocale}')`,
                verbose,
            );

            // Emit a dedicated diagnostic when the default-locale value itself looks invalid/non-translatable.
            // This runs only when analyzing the default-locale file for this key so Problems entries are stable.
            // NOTE: we only use heuristic detection here; user ignore patterns (baseIsIgnored) do NOT trigger
            // an invalid diagnostic, they simply suppress untranslated/missing diagnostics.
            if (fileLocale === defaultLocaleForKey && baseLooksNonTranslatable) {
                const range = await this.getKeyRangeInFile(uri, key);
                const invalidDiag = new vscode.Diagnostic(
                    range,
                    `Invalid/non-translatable value "${key}" [${defaultLocaleForKey}]`,
                    config.invalidSeverity,
                );
                invalidDiag.code = 'ai-i18n.invalid';
                diagnostics.push(invalidDiag);
            }

            // Check all locales for this key
            for (const locale of locales) {
                if (locale === defaultLocaleForKey) {
                    continue;
                }

                const val = record.locales.get(locale);
                const locEntry = record.locations.find((l) => l.locale === locale);

                // Determine if we should report diagnostics for this locale in this file:
                // 1. If this file IS the locale file (fileLocale === locale), always report
                // 2. If this file is the DEFAULT locale and the key is missing in target locale, report
                // 3. If locEntry exists but points to a different file, skip (that file will handle it)
                
                const shouldReport = 
                    fileLocale === locale || // This file owns this locale
                    (fileLocale === defaultLocaleForKey && !locEntry); // Default-locale file reporting missing translations
                
                if (!shouldReport) {
                    // Skip if another file owns this locale
                    if (locEntry && locEntry.uri.toString() !== fileKey) {
                        continue;
                    }
                }

                // Avoid duplicate missing diagnostics: only the default-locale file should emit
                if ((!val || !val.trim()) && fileLocale !== defaultLocaleForKey) {
                    continue;
                }

                this.verboseLog(
                    `[DiagnosticAnalyzer] Considering locale '${locale}' for key '${key}': ` +
                    `val=${val ? 'present' : 'missing'}, locEntry=${!!locEntry}, shouldReport=${shouldReport}`,
                    verbose,
                );

                if (!val || !val.trim()) {
                    this.verboseLog(
                        `[DiagnosticAnalyzer] Missing translation detected for key '${key}' in locale '${locale}' while analyzing file '${uri.fsPath}' (fileLocale='${fileLocale}', defaultLocale='${defaultLocaleForKey}')`,
                        verbose,
                    );
                }

                const issues = this.analyzeKeyForLocale(
                    key,
                    locale,
                    val,
                    defaultValue,
                    defaultPlaceholders,
                    config,
                    isConstantLikeAcrossLocales,
                    baseIsIgnored || baseLooksNonTranslatable,
                );

                for (const issue of issues) {
                    const range = await this.getKeyRangeInFile(uri, key);
                    const diagnostic = new vscode.Diagnostic(
                        range,
                        issue.message,
                        issue.severity,
                    );
                    diagnostic.code = issue.code;
                    diagnostics.push(diagnostic);
                }
            }

        }

        this.diagnosticsByFile.set(fileKey, diagnostics);
        this.safeLog(
            `[DiagnosticAnalyzer] Found ${diagnostics.length} diagnostic(s) for file: ${uri.fsPath}`,
        );
        return diagnostics;
    }

    /**
     * Analyze multiple files in parallel.
     */
    async analyzeFiles(
        uris: vscode.Uri[],
        config: DiagnosticConfig,
    ): Promise<Map<string, vscode.Diagnostic[]>> {
        this.logVerboseEnabled = config.verboseLogging === true;
        this.safeLog(`[DiagnosticAnalyzer] Analyzing ${uris.length} file(s)...`);

        const results = await Promise.all(
            uris.map(async (uri) => {
                const diagnostics = await this.analyzeFile(uri, config);
                return { uri: uri.toString(), diagnostics };
            }),
        );

        const map = new Map<string, vscode.Diagnostic[]>();
        for (const { uri, diagnostics } of results) {
            map.set(uri, diagnostics);
        }

        return map;
    }

    /**
     * Analyze all locale files in the index.
     */
    async analyzeAll(config: DiagnosticConfig): Promise<Map<string, vscode.Diagnostic[]>> {
        this.logVerboseEnabled = config.verboseLogging === true;
        this.safeLog('[DiagnosticAnalyzer] Performing full analysis...');

        // Collect all unique locale file URIs from the index
        const allKeys = this.i18nIndex.getAllKeys();
        const fileUris = new Set<string>();

        for (const key of allKeys) {
            const record = this.i18nIndex.getRecord(key);
            if (!record) {
                continue;
            }
            for (const loc of record.locations) {
                fileUris.add(loc.uri.toString());
            }
        }

        const uris = Array.from(fileUris).map((uriStr) => vscode.Uri.parse(uriStr));
        return this.analyzeFiles(uris, config);
    }

    /**
     * Reset all caches. Call before a full re-analysis.
     */
    resetCaches(): void {
        this.diagnosticsByFile.clear();
        this.fileTextCache.clear();
        this.fileTextCacheOrder = [];
        this.styleIssuesByLocaleKey.clear();
        this.styleReportLoaded = false;
        this.untranslatedIssuesByLocaleKey.clear();
        this.untranslatedReportActive = false;
        this.ignorePatterns = null;
        this.ignorePatternsLoaded = false;
    }

    /**
     * Invalidate untranslated report entries for specific keys.
     * This should be called when translation files are edited to ensure
     * stale report data doesn't cause incorrect diagnostics.
     */
    invalidateUntranslatedReportKeys(keys: string[]): void {
        if (!this.untranslatedReportActive || !keys.length) {
            return;
        }

        // Get all locales from the index to invalidate all locale variants of each key
        const allLocales = this.i18nIndex.getAllLocales();
        
        for (const key of keys) {
            for (const locale of allLocales) {
                const reportKey = `${key}::${locale}`;
                this.untranslatedIssuesByLocaleKey.delete(reportKey);
            }
        }

        // If all entries are cleared, deactivate the report
        if (this.untranslatedIssuesByLocaleKey.size === 0) {
            this.untranslatedReportActive = false;
        }
    }

    /**
     * Load style issues from .i18n-untranslated-style.json report.
     */
    async loadStyleReport(
        workspaceFolders: readonly vscode.WorkspaceFolder[],
        force = false,
    ): Promise<void> {
        if (this.styleReportLoaded && !force) {
            return;
        }

        this.styleIssuesByLocaleKey.clear();

        for (const folder of workspaceFolders) {
            try {
                const styleUri = vscode.Uri.joinPath(
                    folder.uri,
                    'scripts',
                    '.i18n-untranslated-style.json',
                );
                const data = await vscode.workspace.fs.readFile(styleUri);
                const raw = sharedDecoder.decode(data);
                const report: any = JSON.parse(raw);
                const files = Array.isArray(report?.files) ? report.files : [];

                for (const file of files) {
                    const locale = typeof file?.locale === 'string' ? file.locale : null;
                    const issues = Array.isArray(file?.issues) ? file.issues : [];
                    if (!locale || !issues.length) {
                        continue;
                    }

                    for (const issue of issues) {
                        const keyPath = typeof issue?.keyPath === 'string' ? issue.keyPath : null;
                        if (!keyPath) {
                            continue;
                        }
                        const mapKey = `${keyPath}::${locale}`;
                        if (!this.styleIssuesByLocaleKey.has(mapKey)) {
                            this.styleIssuesByLocaleKey.set(mapKey, {
                                english: typeof issue.english === 'string' ? issue.english : undefined,
                                current: typeof issue.current === 'string' ? issue.current : undefined,
                                suggested: typeof issue.suggested === 'string' ? issue.suggested : undefined,
                            });
                        }
                    }
                }
            } catch {
                // Style report is optional
            }
        }
        this.styleReportLoaded = true;
    }

    async loadUntranslatedReport(
        workspaceFolders: readonly vscode.WorkspaceFolder[],
        force = false,
    ): Promise<void> {
        if (this.untranslatedReportActive && !force) {
            return;
        }

        this.untranslatedIssuesByLocaleKey.clear();
        this.untranslatedReportActive = false;

        for (const folder of workspaceFolders) {
            try {
                const reportUri = vscode.Uri.joinPath(
                    folder.uri,
                    'scripts',
                    '.i18n-untranslated-untranslated.json',
                );
                const data = await vscode.workspace.fs.readFile(reportUri);
                const raw = sharedDecoder.decode(data);
                const report: any = JSON.parse(raw);
                const files = Array.isArray(report?.files) ? report.files : [];

                for (const file of files) {
                    const locale = typeof file?.locale === 'string' ? file.locale : null;
                    const issues = Array.isArray(file?.issues) ? file.issues : [];
                    if (!locale || !issues.length) {
                        continue;
                    }

                    for (const issue of issues) {
                        const keyPath = typeof issue?.keyPath === 'string' ? issue.keyPath : null;
                        if (!keyPath) {
                            continue;
                        }
                        const mapKey = `${keyPath}::${locale}`;
                        if (!this.untranslatedIssuesByLocaleKey.has(mapKey)) {
                            this.untranslatedIssuesByLocaleKey.set(mapKey, true);
                        }
                    }
                }
            } catch {
                // Optional report; ignore missing/invalid files and move on to the next folder
            }
        }

        if (this.untranslatedIssuesByLocaleKey.size > 0) {
            this.untranslatedReportActive = true;
        }
    }

    /**
     * Load ignore patterns from scripts/i18n-ignore-patterns.json if present.
     */
    async loadIgnorePatterns(
        workspaceFolders: readonly vscode.WorkspaceFolder[],
        force = false,
    ): Promise<void> {
        if (this.ignorePatternsLoaded && !force) {
            return;
        }

        const merged: { exact?: string[]; exactInsensitive?: string[]; contains?: string[] } = {
            exact: [],
            exactInsensitive: [],
            contains: [],
        };
        for (const folder of workspaceFolders) {
            try {
                const ignoreUri = vscode.Uri.joinPath(
                    folder.uri,
                    'scripts',
                    'i18n-ignore-patterns.json',
                );
                const data = await vscode.workspace.fs.readFile(ignoreUri);
                const raw = sharedDecoder.decode(data);
                const json = JSON.parse(raw);
                if (Array.isArray(json?.exact)) merged.exact!.push(...json.exact);
                if (Array.isArray(json?.exactInsensitive)) merged.exactInsensitive!.push(...json.exactInsensitive);
                if (Array.isArray(json?.contains)) merged.contains!.push(...json.contains);
            } catch {
                // ignore missing/invalid files
            }
            try {
                const autoUri = vscode.Uri.joinPath(
                    folder.uri,
                    'scripts',
                    '.i18n-auto-ignore.json',
                );
                const data = await vscode.workspace.fs.readFile(autoUri);
                const raw = sharedDecoder.decode(data);
                const json = JSON.parse(raw);
                if (Array.isArray(json?.exact)) merged.exact!.push(...json.exact);
                if (Array.isArray(json?.exactInsensitive)) merged.exactInsensitive!.push(...json.exactInsensitive);
                if (Array.isArray(json?.contains)) merged.contains!.push(...json.contains);
            } catch {
                // ignore missing/invalid auto-ignore files
            }
        }
        this.ignorePatterns = merged;
        this.ignorePatternsLoaded = true;
    }

    private isIgnoredText(text: string): boolean {
        const pat = this.ignorePatterns;
        if (!pat) return false;
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return false;
        if (Array.isArray(pat.exact) && pat.exact.includes(normalized)) return true;
        if (Array.isArray(pat.exactInsensitive)) {
            const lower = normalized.toLowerCase();
            for (const v of pat.exactInsensitive) {
                if (String(v || '').toLowerCase() === lower) return true;
            }
        }
        if (Array.isArray(pat.contains)) {
            for (const sub of pat.contains) {
                if (sub && normalized.includes(String(sub))) return true;
            }
        }
        return false;
    }

    private isPlaceholderOnlyText(text: string): boolean {
        const trimmed = String(text || '').trim();
        if (!trimmed) {
            return false;
        }
        let stripped = trimmed
            .replace(/\{\{\s*[^}]+\s*\}\}/g, ' ')
            .replace(/\{[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}/g, ' ');
        stripped = stripped.replace(/[()\[\]{},.:;'"!?\-_]/g, ' ');
        stripped = stripped.replace(/\s+/g, ' ').trim();
        if (!stripped) {
            return true;
        }
        if (!/[A-Za-z]/.test(stripped)) {
            return true;
        }
        const letters = stripped.replace(/[^A-Za-z]/g, '');
        if (letters.length <= 1 && stripped.length <= 3) {
            return true;
        }
        return false;
    }

    /**
     * Detect values that are clearly extraction errors and should be removed/restored.
     * These are technical fragments that should never have been translation keys.
     * Examples:
     *   - "?duration=" (query fragment)
     *   - "/schedule/" (path fragment)
     *   - "{value1} {value2} {value3} {value4}" (placeholder-only)
     *   - "font-medium {color}" (CSS + placeholder)
     */
    private isProbablyNonTranslatable(text: string): boolean {
        const normalized = String(text || '').trim().replace(/\s+/g, ' ');
        if (!normalized) return false;

        // Placeholder-only text (no real words, just placeholders and punctuation)
        if (this.isPlaceholderOnlyText(normalized)) {
            return true;
        }

        // CSS/utility class patterns with placeholders like "font-medium {color}"
        if (this.isCssWithPlaceholders(normalized)) {
            return true;
        }

        if (this.isCssUtilityString(normalized)) {
            return true;
        }

        if (/\{[^}]*:[^;]+;[^}]*\}/.test(normalized)) {
            return true;
        }

        if (
            normalized.includes('class="') ||
            normalized.includes("class='") ||
            normalized.includes('style="') ||
            normalized.includes("style='") ||
            /@\w+\s*=/.test(normalized)
        ) {
            return true;
        }

        if (/^\s*(height|width|margin|padding|font(?:-family)?|color|background|border)[^;{]*;?\s*$/.test(normalized)) {
            return true;
        }

        if (/^\s*(sans|serif|mono|monospace|system)\s*\([^)]+\)\s*$/i.test(normalized)) {
            return true;
        }

        if (
            /\{\{\s*[^}]+\s*\}\}/.test(normalized) &&
            (/[?:]/.test(normalized) || /\|\|/.test(normalized) || /&&/.test(normalized) || /\.length\b/.test(normalized))
        ) {
            return true;
        }

        // UUID-like strings
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
            return true;
        }

        // Complex CSS/utility token (single token with :, [], etc.)
        if (!/\s/.test(normalized) && /[:\[\]]/.test(normalized) && /^[A-Za-z0-9:._\-\[\]]+$/.test(normalized)) {
            return true;
        }

        // Obvious JS-ish code with common keywords
        if (/[{};]/.test(normalized) && /\b(const|let|var|function|return|if|else|for|while|class|async|await)\b/.test(normalized)) {
            return true;
        }

        // Analytics / object-literal style code snippets (e.g. gtag(... { 'send_to': ... }); )
        if (
            normalized.includes('gtag(') ||
            (/[{}]/.test(normalized) && /['"][^'"]+['"]\s*:/.test(normalized))
        ) {
            return true;
        }

        // Obvious URLs
        if (/^https?:\/\//i.test(normalized) || /^www\./i.test(normalized)) return true;

        // Filesystem-like paths (e.g. "/schedule/", "/api/v1", "C:\\path")
        if (/^\/[A-Za-z0-9_/-]+\/?$/.test(normalized)) return true;
        if (/^\\\\[^\s]+/.test(normalized) || /^[A-Za-z]:[\\/][^\s]*$/.test(normalized)) return true;

        // Query-string fragments (e.g. "?duration=", "?lang=en", "foo=bar&baz=qux")
        if (!/\s/.test(normalized)) {
            // Starts with ? or # and has key=value pattern
            if (/^[?#][A-Za-z0-9_.-]+=/.test(normalized)) return true;
            // Pure query string without leading ?
            if (/^[A-Za-z0-9_.-]+=[^&\s]*(&[A-Za-z0-9_.-]+=[^&\s]*)+$/.test(normalized)) return true;
        }

        // Single character
        if (normalized.length === 1) return true;

        return false;
    }

    /**
     * Detect CSS/utility class patterns mixed with placeholders.
     * Examples: "font-medium {color}", "w-full {value1}", "text-{size} font-bold"
     */
    private isCssWithPlaceholders(text: string): boolean {
        const hasPlaceholder = /\{[A-Za-z0-9_]+\}/.test(text);
        if (!hasPlaceholder) return false;

        // Remove placeholders and check if remaining looks like CSS classes
        const withoutPlaceholders = text.replace(/\{[A-Za-z0-9_]+\}/g, '').trim();
        if (!withoutPlaceholders) return true; // Only placeholders

        // Check if remaining parts look like CSS utility classes (kebab-case tokens)
        const tokens = withoutPlaceholders.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return true;

        // If all remaining tokens are kebab-case or utility-like, it's CSS
        const cssLikeTokens = tokens.filter(t => /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/i.test(t));
        return cssLikeTokens.length === tokens.length;
    }

    private isCssUtilityString(text: string): boolean {
        const withoutPlaceholders = text
            .replace(/\{\{\s*[^}]+\s*\}\}/g, ' ')
            .replace(/\{[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}/g, ' ');
        const tokens = withoutPlaceholders.split(/\s+/).filter(Boolean);
        if (tokens.length < 3) {
            return false;
        }

        const cssKeywords = new Set([
            'absolute',
            'relative',
            'fixed',
            'sticky',
            'static',
            'transform',
            'inline',
            'block',
            'flex',
            'grid',
        ]);

        let cssLikeCount = 0;
        for (const token of tokens) {
            const lower = token.toLowerCase();
            if (cssKeywords.has(lower)) {
                cssLikeCount += 1;
                continue;
            }
            if (/^-?[a-z][a-z0-9]*(?:-[a-z0-9/:%]+)+$/.test(lower)) {
                cssLikeCount += 1;
                continue;
            }
            if (/^[a-z]+[0-9]+$/.test(lower)) {
                cssLikeCount += 1;
            }
        }

        return cssLikeCount >= 3 && cssLikeCount / tokens.length >= 0.6;
    }

    private isProbablyConstantAcrossLocales(
        record: TranslationRecord,
        defaultLocale: string,
        defaultValue: string,
    ): boolean {
        const base = String(defaultValue || '').trim();
        if (!base) {
            return false;
        }

        const normalized = base.replace(/\s+/g, ' ');
        const words = normalized.split(/\s+/).filter(Boolean);
        const wordCount = words.length;

        // Only consider relatively short, token-like strings as candidates
        const isTokenLike =
            wordCount <= 3 &&
            normalized.length <= 24 &&
            !/[.!?]/.test(normalized);

        if (!isTokenLike) {
            return false;
        }

        let sameCount = 0;
        const nonDefaultLocales = Array.from(record.locales.keys()).filter(
            (l) => l !== defaultLocale,
        );
        for (const locale of nonDefaultLocales) {
            const value = record.locales.get(locale);
            if (typeof value !== 'string') {
                continue;
            }
            if (value.trim() === base) {
                sameCount += 1;
            }
        }

        const requiredSame = 1;
        return sameCount >= requiredSame;
    }

    private analyzeKeyForLocale(
        key: string,
        locale: string,
        value: string | undefined,
        defaultValue: string,
        defaultPlaceholders: Set<string>,
        config: DiagnosticConfig,
        isConstantLikeAcrossLocales: boolean,
        isBaseNonTranslatable: boolean,
    ): Array<{ message: string; severity: vscode.DiagnosticSeverity; code: string }> {
        const issues: Array<{ message: string; severity: vscode.DiagnosticSeverity; code: string }> = [];

        // Check for missing translation
        if (!value || !value.trim()) {
            if (!isBaseNonTranslatable) {
                issues.push({
                    message: `Missing translation for "${key}" [${locale}]`,
                    severity: config.missingSeverity,
                    code: 'ai-i18n.untranslated',
                });
            }
            return issues; // No point checking placeholders if value is missing
        }

        // Check for untranslated (same as default) and apply ignore patterns/heuristics
        if (config.untranslatedEnabled && value === defaultValue) {
            const ignore =
                isConstantLikeAcrossLocales ||
                isBaseNonTranslatable;

            let allowedByReport = true;
            if (this.untranslatedReportActive) {
                const reportKey = `${key}::${locale}`;
                allowedByReport = this.untranslatedIssuesByLocaleKey.has(reportKey);
            }

            if (!ignore && allowedByReport) {
                issues.push({
                    message: `Untranslated (same as default) "${key}" [${locale}]`,
                    severity: config.untranslatedSeverity,
                    code: 'ai-i18n.untranslated',
                });
            }
        }

        // Check for placeholder mismatch
        if (defaultPlaceholders.size > 0) {
            const localePlaceholders = this.extractPlaceholders(value);
            let mismatch = false;

            if (localePlaceholders.size !== defaultPlaceholders.size) {
                mismatch = true;
            } else {
                for (const token of defaultPlaceholders) {
                    if (!localePlaceholders.has(token)) {
                        mismatch = true;
                        break;
                    }
                }
            }

            if (mismatch) {
                const expected = Array.from(defaultPlaceholders).join(', ');
                const message =
                    expected.length > 0
                        ? `Placeholder mismatch "${key}" [${locale}] (expected: ${expected})`
                        : `Placeholder mismatch "${key}" [${locale}]`;
                issues.push({
                    message,
                    severity: vscode.DiagnosticSeverity.Warning,
                    code: 'ai-i18n.placeholders',
                });
            }
        }

        // Check for style issues
        const styleKey = `${key}::${locale}`;
        const styleInfo = this.styleIssuesByLocaleKey.get(styleKey);
        if (styleInfo) {
            const normalizedValue = String(value || '').replace(/\s+/g, ' ').trim();
            const normalizedCurrent =
                typeof styleInfo.current === 'string'
                    ? styleInfo.current.replace(/\s+/g, ' ').trim()
                    : '';
            const normalizedSuggested =
                typeof styleInfo.suggested === 'string'
                    ? styleInfo.suggested.replace(/\s+/g, ' ').trim()
                    : '';

            if (
                (normalizedCurrent && normalizedValue !== normalizedCurrent) ||
                (!normalizedCurrent && normalizedSuggested && normalizedValue === normalizedSuggested)
            ) {
                return issues;
            }

            const parts: string[] = [];
            if (typeof styleInfo.current === 'string') {
                parts.push(`current: ${styleInfo.current}`);
            }
            if (typeof styleInfo.suggested === 'string') {
                parts.push(`suggested: ${styleInfo.suggested}`);
            }
            const details = parts.length ? ` (${parts.join(' | ')})` : '';
            issues.push({
                message: `Style suggestion "${key}" [${locale}]${details}`,
                severity: vscode.DiagnosticSeverity.Information,
                code: 'ai-i18n.style',
            });
        }

        return issues;
    }

    /**
     * Extract placeholders from a translation string.
     */
    private extractPlaceholders(text: string): Set<string> {
        const result = new Set<string>();
        if (!text) {
            return result;
        }
        const single = /\{[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}/g;
        const double = /\{\{\s*[^}]+\s*\}\}/g;
        let match: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign
        while ((match = single.exec(text)) !== null) {
            result.add(match[0]);
        }
        // eslint-disable-next-line no-cond-assign
        while ((match = double.exec(text)) !== null) {
            result.add(match[0]);
        }
        return result;
    }

    /**
     * Get the range of a key in a locale file, with caching.
     */
    private async getKeyRangeInFile(uri: vscode.Uri, fullKey: string): Promise<vscode.Range> {
        const cacheKey = uri.toString();
        let cached = this.fileTextCache.get(cacheKey);

        if (!cached) {
            try {
                const data = await vscode.workspace.fs.readFile(uri);
                const text = sharedDecoder.decode(data);
                const lineStarts: number[] = [0];
                for (let i = 0; i < text.length; i += 1) {
                    if (text.charCodeAt(i) === 10) {
                        lineStarts.push(i + 1);
                    }
                }
                cached = { text, lineStarts, keyRanges: new Map<string, vscode.Range>() };
                
                // LRU eviction: remove oldest entries if at capacity
                while (this.fileTextCacheOrder.length >= MAX_FILE_TEXT_CACHE_SIZE) {
                    const oldest = this.fileTextCacheOrder.shift();
                    if (oldest) {
                        this.fileTextCache.delete(oldest);
                    }
                }
                
                this.fileTextCache.set(cacheKey, cached);
                this.fileTextCacheOrder.push(cacheKey);
            } catch {
                return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
            }
        }

        const { text, lineStarts, keyRanges } = cached;

        const existingRange = keyRanges.get(fullKey);
        if (existingRange) {
            return existingRange;
        }

        const parts = fullKey.split('.');
        const lastSegment = parts[parts.length - 1];
        if (!lastSegment) {
            return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
        }

        // Try to narrow the search using the full dotted key path so we place
        // diagnostics on the correct occurrence when the same slug appears
        // under multiple groups in a large locale file.
        let searchStart = 0;
        if (parts.length > 1) {
            for (let i = 0; i < parts.length - 1; i += 1) {
                const seg = parts[i];
                if (!seg) {
                    continue;
                }
                const segNeedle = `"${seg}"`;
                const idx = text.indexOf(segNeedle, searchStart);
                if (idx === -1) {
                    searchStart = 0;
                    break;
                }
                searchStart = idx + segNeedle.length;
            }
        }

        const needle = `"${lastSegment}"`;
        let index = text.indexOf(needle, searchStart);
        let foundIndex = -1;

        while (index !== -1) {
            let i = index + needle.length;
            while (
                i < text.length &&
                (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')
            ) {
                i += 1;
            }
            if (i < text.length && text[i] === ':') {
                foundIndex = index + 1;
                break;
            }
            index = text.indexOf(needle, index + needle.length);
        }

        if (foundIndex === -1) {
            return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
        }

        let line = 0;
        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= foundIndex) {
            line += 1;
        }
        const character = foundIndex - lineStarts[line];
        const start = new vscode.Position(line, character);
        const end = new vscode.Position(line, character + lastSegment.length);
        const range = new vscode.Range(start, end);
        keyRanges.set(fullKey, range);
        return range;
    }

    /**
     * Analyze a source file (ts/tsx/js/jsx/vue) for missing translation key references.
     * Returns diagnostics for any t('key') calls where the key doesn't exist.
     */
    async analyzeSourceFile(
        uri: vscode.Uri,
        config: DiagnosticConfig,
    ): Promise<vscode.Diagnostic[]> {
        this.logVerboseEnabled = config.verboseLogging === true;
        const fileKey = uri.toString();
        const languageId = this.getLanguageIdForUri(uri);
        
        // Only analyze supported source file types
        const supportedLanguages = [
            'typescript',
            'typescriptreact',
            'javascript',
            'javascriptreact',
            'vue',
            'php',
        ];
        if (!supportedLanguages.includes(languageId)) {
            return [];
        }

        this.safeLog(`[DiagnosticAnalyzer] Analyzing source file for missing refs: ${uri.fsPath}`);

        let text: string;
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            text = sharedDecoder.decode(data);
        } catch {
            return [];
        }

        await this.i18nIndex.ensureInitialized();
        const allKeys = this.i18nIndex.getAllKeys();
        const allKeysSet = new Set(allKeys);

        const diagnostics: vscode.Diagnostic[] = [];
        
        // Build comment ranges to skip false positives in comments
        const commentRanges = this.findCommentRanges(text);
        // Build string literal ranges to avoid flagging t('key') patterns that only
        // appear inside plain strings (e.g. documentation prompts, AI instructions).
        const stringRanges = this.findStringLiteralRanges(text);

        // Match translation calls that reference i18n keys.
        // JS/TS/Vue: t('key'), t("key"), $t('key'), $t("key") with a word boundary before t
        // Laravel PHP/Blade: __('key'), trans('key'), @lang('key')
        const tCallPatterns: Array<{ regex: RegExp; keyGroupIndex: number }> = [];

        tCallPatterns.push({
            regex: /\b\$?t\(\s*(['"`])([A-Za-z0-9_.]+)\1\s*(?:,|\))/g,
            keyGroupIndex: 2,
        });

        if (languageId === 'php') {
            tCallPatterns.push(
                {
                    regex: /\b__\(\s*(['"])([A-Za-z0-9_.]+)\1\s*(?:,|\))/g,
                    keyGroupIndex: 2,
                },
                {
                    regex: /\btrans\(\s*(['"])([A-Za-z0-9_.]+)\1\s*(?:,|\))/g,
                    keyGroupIndex: 2,
                },
                {
                    regex: /@lang\(\s*(['"])([A-Za-z0-9_.]+)\1\s*(?:,|\))/g,
                    keyGroupIndex: 2,
                },
            );
        }

        for (const { regex, keyGroupIndex } of tCallPatterns) {
            regex.lastIndex = 0;
            let match;

            while ((match = regex.exec(text)) !== null) {
                const key = match[keyGroupIndex];
                const matchIndex = match.index;
                
                // Skip if match is inside a comment or string literal
                if (
                    this.isIndexInRanges(matchIndex, commentRanges) ||
                    this.isIndexInRanges(matchIndex, stringRanges)
                ) {
                    continue;
                }
                
                if (!allKeysSet.has(key)) {
                    // Calculate position
                    const startIndex = match.index + match[0].indexOf(key);
                    const endIndex = startIndex + key.length;
                    
                    const startPos = this.indexToPosition(text, startIndex);
                    const endPos = this.indexToPosition(text, endIndex);
                    const range = new vscode.Range(startPos, endPos);

                    const diagnostic = new vscode.Diagnostic(
                        range,
                        `Missing translation key "${key}" - key not found in locale files`,
                        config.missingReferenceSeverity ?? config.missingSeverity,
                    );
                    diagnostic.code = 'ai-i18n.missing-reference';
                    diagnostic.source = 'AI Localizer';
                    diagnostics.push(diagnostic);
                }
            }
        }

        this.diagnosticsByFile.set(fileKey, diagnostics);
        this.log.appendLine(
            `[DiagnosticAnalyzer] Found ${diagnostics.length} missing reference(s) in source file: ${uri.fsPath}`,
        );
        return diagnostics;
    }
    
    /**
     * Find all comment ranges in source text (single-line // and multi-line /* *\/)
     * Also handles HTML comments <!-- --> for Vue templates
     */
    private findCommentRanges(text: string): Array<{ start: number; end: number }> {
        const ranges: Array<{ start: number; end: number }> = [];
        
        // Match single-line comments: // ... until end of line
        const singleLineRegex = /\/\/[^\n]*/g;
        let match;
        while ((match = singleLineRegex.exec(text)) !== null) {
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
        
        // Match multi-line comments: /* ... */
        const multiLineRegex = /\/\*[\s\S]*?\*\//g;
        while ((match = multiLineRegex.exec(text)) !== null) {
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
        
        // Match HTML comments: <!-- ... --> (for Vue templates)
        const htmlCommentRegex = /<!--[\s\S]*?-->/g;
        while ((match = htmlCommentRegex.exec(text)) !== null) {
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
        
        return ranges;
    }

    /**
     * Find ranges of JavaScript/TypeScript string literals (", ' and `) in raw text.
     * This is a lightweight heuristic used only to suppress false positives where
     * t('key') appears inside documentation strings or prompt text.
     */
    private findStringLiteralRanges(text: string): Array<{ start: number; end: number }> {
        const ranges: Array<{ start: number; end: number }> = [];
        const len = text.length;
        let i = 0;

        while (i < len) {
            const ch = text[i];
            if (ch === '"' || ch === '\'' || ch === '`') {
                const quote = ch;
                const start = i;
                i += 1;
                let escaped = false;
                while (i < len) {
                    const c = text[i];
                    if (escaped) {
                        escaped = false;
                    } else if (c === '\\') {
                        escaped = true;
                    } else if (c === quote) {
                        i += 1;
                        ranges.push({ start, end: i });
                        break;
                    }
                    i += 1;
                }
                continue;
            }
            i += 1;
        }

        return ranges;
    }
    
    /**
     * Check if an index falls within any of the given ranges
     */
    private isIndexInRanges(index: number, ranges: Array<{ start: number; end: number }>): boolean {
        for (const range of ranges) {
            if (index >= range.start && index < range.end) {
                return true;
            }
        }
        return false;
    }

    /**
     * Convert a character index to a Position in the document.
     */
    private indexToPosition(text: string, index: number): vscode.Position {
        let line = 0;
        let character = 0;
        
        for (let i = 0; i < index && i < text.length; i++) {
            if (text[i] === '\n') {
                line++;
                character = 0;
            } else {
                character++;
            }
        }
        
        return new vscode.Position(line, character);
    }

    /**
     * Get language ID for a URI based on file extension.
     */
    private getLanguageIdForUri(uri: vscode.Uri): string {
        const ext = uri.fsPath.split('.').pop()?.toLowerCase() || '';
        switch (ext) {
            case 'ts':
                return 'typescript';
            case 'tsx':
                return 'typescriptreact';
            case 'js':
            case 'mjs':
                return 'javascript';
            case 'jsx':
                return 'javascriptreact';
            case 'vue':
                return 'vue';
            default:
                return ext;
        }
    }
}

export interface DiagnosticConfig {
    enabled: boolean;
    defaultLocale: string;
    missingSeverity: vscode.DiagnosticSeverity;
    untranslatedEnabled: boolean;
    untranslatedSeverity: vscode.DiagnosticSeverity;
    invalidSeverity: vscode.DiagnosticSeverity;
    missingReferenceEnabled: boolean;
    missingReferenceSeverity: vscode.DiagnosticSeverity;
    verboseLogging?: boolean;
}

export function getDiagnosticConfig(): DiagnosticConfig {
    const cfg = vscode.workspace.getConfiguration('ai-localizer');
    const enabled = cfg.get<boolean>('i18n.diagnostics.enabled') ?? true;
    const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

    const mapSeverity = (value: string | undefined): vscode.DiagnosticSeverity => {
        switch ((value || '').toLowerCase()) {
            case 'error':
                return vscode.DiagnosticSeverity.Error;
            case 'info':
                return vscode.DiagnosticSeverity.Information;
            case 'hint':
                return vscode.DiagnosticSeverity.Hint;
            case 'warning':
            default:
                return vscode.DiagnosticSeverity.Warning;
        }
    };

    const missingSeveritySetting = cfg.get<string>('i18n.diagnostics.missingLocaleSeverity') || 'warning';
    const untranslatedEnabled = cfg.get<boolean>('i18n.diagnostics.untranslatedSameAsDefaultEnabled') ?? true;
    const untranslatedSeveritySetting =
        cfg.get<string>('i18n.diagnostics.untranslatedSameAsDefaultSeverity') || 'warning';
    const invalidSeveritySetting =
        cfg.get<string>('i18n.diagnostics.invalidBaseValueSeverity') || 'warning';
    const missingReferenceEnabled = cfg.get<boolean>('i18n.diagnostics.missingReferenceEnabled') ?? true;
    const missingReferenceSeveritySetting =
        cfg.get<string>('i18n.diagnostics.missingReferenceSeverity') || 'error';
    const verboseLogging = cfg.get<boolean>('i18n.diagnostics.verboseLogging') ?? false;

    return {
        enabled,
        defaultLocale,
        missingSeverity: mapSeverity(missingSeveritySetting),
        untranslatedEnabled,
        untranslatedSeverity: mapSeverity(untranslatedSeveritySetting),
        invalidSeverity: mapSeverity(invalidSeveritySetting),
        missingReferenceEnabled,
        missingReferenceSeverity: mapSeverity(missingReferenceSeveritySetting),
        verboseLogging,
    };
}
