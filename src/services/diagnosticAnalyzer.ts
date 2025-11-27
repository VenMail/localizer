import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import { I18nIndex } from '../core/i18nIndex';
import { ProjectConfigService } from './projectConfigService';

/**
 * Performant incremental diagnostic analyzer for i18n translation issues.
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
    private styleIssuesByLocaleKey = new Map<
        string,
        { english?: string; current?: string; suggested?: string }
    >();
    private decoder = new TextDecoder('utf-8');

    constructor(
        private i18nIndex: I18nIndex,
        private projectConfigService: ProjectConfigService,
        private log: vscode.OutputChannel,
    ) {}

    /**
     * Analyze a single locale file and return diagnostics for it.
     * This is the core incremental analysis method.
     */
    async analyzeFile(
        uri: vscode.Uri,
        config: DiagnosticConfig,
    ): Promise<vscode.Diagnostic[]> {
        const fileKey = uri.toString();
        this.log.appendLine(`[DiagnosticAnalyzer] Analyzing file: ${uri.fsPath}`);

        // Get keys contributed by this file
        const fileInfo = this.i18nIndex.getKeysForFile(uri);
        if (!fileInfo) {
            this.log.appendLine(`[DiagnosticAnalyzer] No keys found for file: ${uri.fsPath}`);
            return [];
        }

        const { locale: fileLocale, keys: fileKeys } = fileInfo;
        const diagnostics: vscode.Diagnostic[] = [];

        // Get workspace folder config
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            return [];
        }

        const projectConfig = await this.projectConfigService.readConfig(folder);
        const defaultLocale = config.defaultLocale || 'en';
        let locales = projectConfig?.locales || [defaultLocale];
        if (!locales.includes(defaultLocale)) {
            locales = [defaultLocale, ...locales];
        }

        // For each key in this file, check all locales
        for (const key of fileKeys) {
            const record = this.i18nIndex.getRecord(key);
            if (!record) {
                continue;
            }

            const defaultValue = record.locales.get(defaultLocale);
            if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
                continue;
            }

            const defaultPlaceholders = this.extractPlaceholders(defaultValue);

            // Check all locales for this key
            for (const locale of locales) {
                if (locale === defaultLocale) {
                    continue;
                }

                const val = record.locales.get(locale);
                const locEntry = record.locations.find((l) => l.locale === locale);

                // Only create diagnostics for this file if it owns this locale
                if (locEntry && locEntry.uri.toString() !== fileKey) {
                    continue;
                }

                // If this file is the locale file for this locale, analyze it
                if (fileLocale === locale || !locEntry) {
                    const issues = this.analyzeKeyForLocale(
                        key,
                        locale,
                        val,
                        defaultValue,
                        defaultPlaceholders,
                        config,
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
        }

        this.diagnosticsByFile.set(fileKey, diagnostics);
        this.log.appendLine(
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
        this.log.appendLine(`[DiagnosticAnalyzer] Analyzing ${uris.length} file(s)...`);

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
        this.log.appendLine('[DiagnosticAnalyzer] Performing full analysis...');

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
     * Load style issues from .i18n-untranslated-style.json report.
     */
    async loadStyleReport(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<void> {
        this.styleIssuesByLocaleKey.clear();

        for (const folder of workspaceFolders) {
            try {
                const styleUri = vscode.Uri.joinPath(
                    folder.uri,
                    'scripts',
                    '.i18n-untranslated-style.json',
                );
                const data = await vscode.workspace.fs.readFile(styleUri);
                const raw = this.decoder.decode(data);
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
    }

    /**
     * Clear cached diagnostics for a file.
     */
    clearFile(uri: vscode.Uri): void {
        const fileKey = uri.toString();
        this.diagnosticsByFile.delete(fileKey);
        this.fileTextCache.delete(fileKey);
    }

    /**
     * Clear all cached diagnostics.
     */
    clearAll(): void {
        this.diagnosticsByFile.clear();
        this.fileTextCache.clear();
    }

    /**
     * Analyze a single key for a specific locale and return issues.
     */
    private analyzeKeyForLocale(
        key: string,
        locale: string,
        value: string | undefined,
        defaultValue: string,
        defaultPlaceholders: Set<string>,
        config: DiagnosticConfig,
    ): Array<{ message: string; severity: vscode.DiagnosticSeverity; code: string }> {
        const issues: Array<{ message: string; severity: vscode.DiagnosticSeverity; code: string }> = [];

        // Check for missing translation
        if (!value || !value.trim()) {
            issues.push({
                message: `AI i18n: Missing translation for key ${key} in locale ${locale}`,
                severity: config.missingSeverity,
                code: 'ai-i18n.untranslated',
            });
            return issues; // No point checking placeholders if value is missing
        }

        // Check for untranslated (same as default)
        if (config.untranslatedEnabled && value === defaultValue) {
            issues.push({
                message: `AI i18n: Untranslated (same as default) value for key ${key} in locale ${locale}`,
                severity: config.untranslatedSeverity,
                code: 'ai-i18n.untranslated',
            });
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
                        ? `AI i18n: Placeholder mismatch for key ${key} in locale ${locale} (expected: ${expected})`
                        : `AI i18n: Placeholder mismatch for key ${key} in locale ${locale}`;
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
            const parts: string[] = [];
            if (typeof styleInfo.current === 'string') {
                parts.push(`current: ${styleInfo.current}`);
            }
            if (typeof styleInfo.suggested === 'string') {
                parts.push(`suggested: ${styleInfo.suggested}`);
            }
            const details = parts.length ? ` (${parts.join(' | ')})` : '';
            issues.push({
                message: `AI i18n: Style suggestion for key ${key} in locale ${locale}${details}`,
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
                const text = this.decoder.decode(data);
                const lineStarts: number[] = [0];
                for (let i = 0; i < text.length; i += 1) {
                    if (text.charCodeAt(i) === 10) {
                        lineStarts.push(i + 1);
                    }
                }
                cached = { text, lineStarts, keyRanges: new Map<string, vscode.Range>() };
                this.fileTextCache.set(cacheKey, cached);
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

        const needle = `"${lastSegment}"`;
        let index = text.indexOf(needle);
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
}

export interface DiagnosticConfig {
    enabled: boolean;
    defaultLocale: string;
    missingSeverity: vscode.DiagnosticSeverity;
    untranslatedEnabled: boolean;
    untranslatedSeverity: vscode.DiagnosticSeverity;
}

export function getDiagnosticConfig(): DiagnosticConfig {
    const cfg = vscode.workspace.getConfiguration('ai-assistant');
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

    return {
        enabled,
        defaultLocale,
        missingSeverity: mapSeverity(missingSeveritySetting),
        untranslatedEnabled,
        untranslatedSeverity: mapSeverity(untranslatedSeveritySetting),
    };
}
