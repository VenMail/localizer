import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex, extractKeyAtPosition, escapeMarkdown } from '../core/i18nIndex';
import { readLaravelKeyValueFromFile, sharedDecoder } from '../core/i18nFs';
import { inferJsonLocaleFromUri } from '../core/i18nPath';
import { detectFrameworkProfile } from '../frameworks/detection';
import { ProjectConfigService } from '../services/projectConfigService';
import { isProjectDisabled } from '../utils/projectIgnore';
import {
    parseInvalidDiagnostic,
    parseMissingReferenceDiagnostic,
    parsePlaceholderDiagnostic,
    parseStyleDiagnostic,
    parseUntranslatedDiagnostic,
    parseMissingDefaultDiagnostic,
} from '../commands/untranslated/utils/diagnosticParser';

/**
 * Language selector for source files using i18n keys
 */
export const I18N_CODE_SELECTOR: vscode.DocumentSelector = [
    { language: 'javascript', scheme: 'file' },
    { language: 'typescript', scheme: 'file' },
    { language: 'javascriptreact', scheme: 'file' },
    { language: 'typescriptreact', scheme: 'file' },
    { language: 'vue', scheme: 'file' },
    { language: 'blade', scheme: 'file' },
    { language: 'php', scheme: 'file' },
];

/**
 * Language selector for locale JSON files
 */
export const I18N_JSON_SELECTOR: vscode.DocumentSelector = [
    { language: 'json', scheme: 'file' },
    { language: 'jsonc', scheme: 'file' },
];

/**
 * Hover provider for i18n translation keys
 * Shows all translations for a key across all locales
 */
export class I18nHoverProvider implements vscode.HoverProvider {
    constructor(private i18nIndex: I18nIndex) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.Hover | undefined> {
        try {
            // Check if project is disabled
            const folder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (folder && isProjectDisabled(folder)) {
                return undefined; // Project is disabled
            }

            const config = vscode.workspace.getConfiguration('ai-localizer');
            const delayMs = config.get<number>('i18n.hoverDelayMs') ?? 1900;

            if (delayMs > 0) {
                // Use a cancellation-aware delay to avoid keeping promises pending
                const cancelled = await new Promise<boolean>((resolve) => {
                    const handle = setTimeout(() => resolve(false), delayMs);
                    // Listen for cancellation to resolve early and clear timer
                    const disposable = token.onCancellationRequested(() => {
                        clearTimeout(handle);
                        disposable.dispose();
                        resolve(true);
                    });
                });

                if (cancelled || token.isCancellationRequested) {
                    return undefined;
                }
            }

            await this.i18nIndex.ensureInitialized();
            
            const keyInfo = extractKeyAtPosition(document, position);
            if (!keyInfo) {
                return undefined;
            }

            const range = keyInfo.range;

            const record = this.i18nIndex.getRecord(keyInfo.key);
            if (!record) {
                return undefined;
            }

            const languageId = document.languageId;
            const isLaravelSource = languageId === 'php' || languageId === 'blade';

            const valueMap = new Map<string, string>();
            let locales: string[] = [];

            if (isLaravelSource) {
                const laravelByLocale = new Map<string, vscode.Uri>();
                for (const loc of record.locations) {
                    const fsPath = loc.uri.fsPath.replace(/\\/g, '/').toLowerCase();
                    if (fsPath.includes('/lang/') || fsPath.includes('/resources/lang/')) {
                        const existing = laravelByLocale.get(loc.locale);
                        if (!existing || loc.uri.fsPath.length < existing.fsPath.length) {
                            laravelByLocale.set(loc.locale, loc.uri);
                        }
                    }
                }

                if (laravelByLocale.size === 0) {
                    return undefined;
                }

                const entries = Array.from(laravelByLocale.entries());
                const results = await Promise.all(
                    entries.map(async ([locale, uri]) => {
                        const v = await readLaravelKeyValueFromFile(uri, record.key);
                        return { locale, value: v };
                    }),
                );

                for (const { locale, value } of results) {
                    if (typeof value === 'string' && value !== '') {
                        valueMap.set(locale, value);
                    }
                }

                if (valueMap.size === 0) {
                    return undefined;
                }

                locales = Array.from(valueMap.keys());
            } else {
                for (const [locale, value] of record.locales.entries()) {
                    if (typeof value === 'string') {
                        valueMap.set(locale, value);
                    }
                }
                locales = Array.from(valueMap.keys());
            }

            locales.sort((a, b) => {
                if (a === record.defaultLocale) return -1;
                if (b === record.defaultLocale) return 1;
                return a.localeCompare(b);
            });

            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**i18n key** \`${record.key}\`\n\n`);
            
            const missingLocales = locales.filter((l) => {
                const v = valueMap.get(l);
                return v === undefined || v === '';
            });
            if (missingLocales.length > 0) {
                md.appendMarkdown(`⚠️ Missing in: ${missingLocales.join(', ')}\n\n`);
            }
            
            for (const locale of locales) {
                const value = valueMap.get(locale);
                if (value === undefined || value === '') {
                    const isDefault = locale === record.defaultLocale;
                    const localeLabel = isDefault ? `${locale} (default)` : locale;
                    md.appendMarkdown(`- **${localeLabel}**: *(missing)*\n`);
                    continue;
                }
                
                const isDefault = locale === record.defaultLocale;
                const localeLabel = isDefault ? `${locale} (default)` : locale;
                const displayValue = value.length > 80 ? value.substring(0, 77) + '...' : value;
                md.appendMarkdown(`- **${localeLabel}**: ${escapeMarkdown(displayValue)}\n`);
            }

            const args = {
                uri: document.uri.toString(),
                position: { line: range.start.line, character: range.start.character },
            };
            const encoded = encodeURIComponent(JSON.stringify(args));
            md.appendMarkdown(
                `\n[Go to translation file](command:ai-localizer.i18n.gotoTranslationFromHover?${encoded})\n`,
            );

            md.isTrusted = true;
            return new vscode.Hover(md, keyInfo.range);
        } catch (err) {
            console.error('Hover provider error:', err);
            return undefined;
        }
    }
}

/**
 * Definition provider for i18n translation keys
 * Allows jumping to translation files with locale selection
 */
export class I18nDefinitionProvider implements vscode.DefinitionProvider {
    private projectConfigService = new ProjectConfigService();

    constructor(private i18nIndex: I18nIndex) {}

    private skipJsonWhitespaceAndComments(text: string, index: number): number {
        let i = index;
        while (i < text.length) {
            const ch = text[i];
            if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
                i += 1;
                continue;
            }

            // JSONC: line comment
            if (ch === '/' && text[i + 1] === '/') {
                i += 2;
                while (i < text.length && text[i] !== '\n') i += 1;
                continue;
            }

            // JSONC: block comment
            if (ch === '/' && text[i + 1] === '*') {
                i += 2;
                while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
                i = i + 2;
                continue;
            }

            return i;
        }
        return i;
    }

    private parseJsonString(
        text: string,
        index: number,
    ): { value: string; start: number; end: number } | null {
        const quote = text[index];
        if (quote !== '"') return null;

        const start = index;
        let i = index + 1;
        let value = '';
        while (i < text.length) {
            const ch = text[i];
            if (ch === '\\') {
                const next = text[i + 1];
                if (next === undefined) return null;
                // We don't need perfect unescaping for key comparisons; preserve common escapes.
                value += next;
                i += 2;
                continue;
            }
            if (ch === quote) {
                return { value, start, end: i + 1 };
            }
            value += ch;
            i += 1;
        }
        return null;
    }

    private skipJsonValue(text: string, index: number): number {
        let i = this.skipJsonWhitespaceAndComments(text, index);
        if (i >= text.length) return i;

        const ch = text[i];
        if (ch === '"') {
            const str = this.parseJsonString(text, i);
            return str ? str.end : i + 1;
        }

        if (ch === '{' || ch === '[') {
            const open = ch;
            const close = ch === '{' ? '}' : ']';
            let depth = 0;
            while (i < text.length) {
                i = this.skipJsonWhitespaceAndComments(text, i);
                if (i >= text.length) return i;

                const c = text[i];
                if (c === '"') {
                    const s = this.parseJsonString(text, i);
                    i = s ? s.end : i + 1;
                    continue;
                }
                if (c === open) {
                    depth += 1;
                    i += 1;
                    continue;
                }
                if (c === close) {
                    depth -= 1;
                    i += 1;
                    if (depth <= 0) return i;
                    continue;
                }
                i += 1;
            }
            return i;
        }

        // Primitive value: read until delimiter
        while (i < text.length) {
            const c = text[i];
            if (c === ',' || c === '}' || c === ']') {
                return i;
            }
            i += 1;
        }
        return i;
    }

    private findJsonKeyRangeInObject(
        text: string,
        startIndex: number,
        targetParts: string[],
        partIndex: number,
    ): { start: number; end: number } | null {
        let i = this.skipJsonWhitespaceAndComments(text, startIndex);
        if (text[i] !== '{') return null;
        i += 1;

        while (i < text.length) {
            i = this.skipJsonWhitespaceAndComments(text, i);
            if (i >= text.length) return null;
            if (text[i] === '}') return null;

            const keyNode = this.parseJsonString(text, i);
            if (!keyNode) return null;
            i = this.skipJsonWhitespaceAndComments(text, keyNode.end);
            if (text[i] !== ':') return null;
            i = this.skipJsonWhitespaceAndComments(text, i + 1);

            const currentPart = targetParts[partIndex];
            const isMatch = keyNode.value === currentPart;
            if (isMatch) {
                if (partIndex === targetParts.length - 1) {
                    return { start: keyNode.start, end: keyNode.end };
                }
                const next = this.skipJsonWhitespaceAndComments(text, i);
                if (text[next] === '{') {
                    const nested = this.findJsonKeyRangeInObject(
                        text,
                        next,
                        targetParts,
                        partIndex + 1,
                    );
                    if (nested) return nested;
                }
            }

            i = this.skipJsonValue(text, i);
            i = this.skipJsonWhitespaceAndComments(text, i);
            if (text[i] === ',') {
                i += 1;
                continue;
            }
            if (text[i] === '}') {
                return null;
            }
        }

        return null;
    }

    private findJsonKeyRange(text: string, key: string): { start: number; end: number } | null {
        const rootIndex = this.skipJsonWhitespaceAndComments(text, 0);
        if (rootIndex >= text.length || text[rootIndex] !== '{') return null;

        // Prefer nested key paths (Auth.Authorize.heading.key)
        const dottedParts = key.split('.').filter(Boolean);
        if (dottedParts.length > 1) {
            const nested = this.findJsonKeyRangeInObject(text, rootIndex, dottedParts, 0);
            if (nested) return nested;
        }

        // Fallback: flat JSON where the entire dotted key is a single property
        return this.findJsonKeyRangeInObject(text, rootIndex, [key], 0);
    }

    /**
     * Find the exact position of a key in a JSON file
     * Returns a range that can be used to navigate to the key
     */
    private async findKeyPositionInFile(
        uri: vscode.Uri,
        key: string,
    ): Promise<vscode.Range> {
        try {
            // Open the document (loads into memory, doesn't show in editor yet)
            const document = await vscode.workspace.openTextDocument(uri);
            const text = document.getText();

            const ext = uri.fsPath.split('.').pop()?.toLowerCase() || '';
            if (ext === 'json' || ext === 'jsonc') {
                const rangeOffsets = this.findJsonKeyRange(text, key);
                if (rangeOffsets) {
                    const startPos = document.positionAt(rangeOffsets.start);
                    const endPos = document.positionAt(rangeOffsets.end);
                    return new vscode.Range(startPos, endPos);
                }
            }
            
            // Split key into parts (e.g., "Namespace.button.save" -> ["Namespace", "button", "save"])
            const keyParts = key.split('.');
            const lastPart = keyParts[keyParts.length - 1];
            
            // Search for the key in the JSON structure
            // Look for patterns like: "lastPart": "value" or "lastPart":"value"
            const escapedKey = lastPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const searchPattern = new RegExp(`"${escapedKey}"\\s*:\\s*`, 'g');
            const matches = [...text.matchAll(searchPattern)];
            
            if (matches.length > 0) {
                // Use the first match
                const match = matches[0];
                const matchIndex = match.index!;
                const startPos = document.positionAt(matchIndex);
                // Create a range that highlights the key name
                const endPos = document.positionAt(matchIndex + lastPart.length + 2); // +2 for quotes
                return new vscode.Range(startPos, endPos);
            }
        } catch (err) {
            console.error('Failed to find key position in file:', err);
            console.error('URI:', uri.toString());
            console.error('Key:', key);
        }
        
        // Fallback to top of file
        return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Definition | undefined> {
        try {
            // Check if project is disabled
            const folder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (folder && isProjectDisabled(folder)) {
                return undefined; // Project is disabled
            }

            await this.i18nIndex.ensureInitialized();
            
            // If nothing is indexed yet, offer to initialize i18n for the project
            const allKeys = this.i18nIndex.getAllKeys();
            if (!allKeys.length) {
                const configFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                const isConfigured = configFolder
                    ? await this.projectConfigService.hasI18nScripts(configFolder)
                    : false;

                const buttons = isConfigured
                    ? ['Rescan Translations']
                    : ['Disable for this Project', 'Configure i18n'];

                const choice = await vscode.window.showInformationMessage(
                    'AI Localizer: No translations indexed for this workspace yet.',
                    ...buttons,
                );

                if (choice === 'Rescan Translations') {
                    await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
                } else if (choice === 'Configure i18n') {
                    await vscode.commands.executeCommand('ai-localizer.i18n.configureProject');
                } else if (choice === 'Disable for this Project') {
                    await vscode.commands.executeCommand('ai-localizer.project.disable');
                }
                return undefined;
            }

            const keyInfo = extractKeyAtPosition(document, position);
            if (!keyInfo) {
                return undefined;
            }

            const record = this.i18nIndex.getRecord(keyInfo.key);
            if (!record || record.locations.length === 0) {
                return undefined;
            }

            const isLaravelSource = document.languageId === 'php' || document.languageId === 'blade';

            // Collapse to a single primary location per locale using the indexed information
            const primaryByLocale = new Map<string, { locale: string; uri: vscode.Uri }>();
            for (const loc of record.locations) {
                const existing = primaryByLocale.get(loc.locale);
                if (!existing) {
                    primaryByLocale.set(loc.locale, loc);
                    continue;
                }
                // Prefer the shorter (shallower) path as the primary location for that locale
                const existingLen = existing.uri.fsPath.length;
                const newLen = loc.uri.fsPath.length;
                if (newLen < existingLen) {
                    primaryByLocale.set(loc.locale, loc);
                }
            }

            // Start from one canonical location per locale
            const currentFolder = vscode.workspace.getWorkspaceFolder(document.uri) || undefined;
            let locations = Array.from(primaryByLocale.values());

            if (isLaravelSource) {
                const laravelLocations = locations.filter((loc) => {
                    const fsPath = loc.uri.fsPath.replace(/\\/g, '/').toLowerCase();
                    return fsPath.includes('/lang/') || fsPath.includes('/resources/lang/');
                });
                if (laravelLocations.length > 0) {
                    locations = laravelLocations;
                }
            }

            if (currentFolder) {
                try {
                    const profile = await detectFrameworkProfile(currentFolder);
                    if (profile) {
                        const preferredByRoot = locations.filter((loc) => {
                            const rel = path
                                .relative(currentFolder.uri.fsPath, loc.uri.fsPath)
                                .replace(/\\/g, '/');
                            return rel.startsWith(profile.rootDir + '/');
                        });
                        if (preferredByRoot.length > 0) {
                            locations = preferredByRoot;
                        }
                    }
                } catch (err) {
                    console.error('Failed to detect framework profile for definition provider:', err);
                }

                // Fallback: prefer locations in the same workspace folder
                if (locations.length > 1) {
                    const sameWorkspace = locations.filter((loc) => {
                        const locFolder = vscode.workspace.getWorkspaceFolder(loc.uri);
                        return locFolder && locFolder.uri.fsPath === currentFolder.uri.fsPath;
                    });
                    if (sameWorkspace.length > 0) {
                        locations = sameWorkspace;
                    }
                }
            }

            // If only one location, jump directly with precise position
            if (locations.length === 1) {
                const targetUri = locations[0].uri;
                console.log('[i18n] Jumping to single location:', targetUri.toString());
                const range = await this.findKeyPositionInFile(targetUri, keyInfo.key);
                console.log('[i18n] Found range:', range.start.line, range.start.character);
                return new vscode.Location(targetUri, range);
            }

            // Multiple locales available - let user choose
            const localeChoices = locations.map((loc) => {
                const translation = record.locales.get(loc.locale) || '';
                const isDefault = loc.locale === record.defaultLocale;
                
                return {
                    label: isDefault ? `$(star-full) ${loc.locale}` : `$(globe) ${loc.locale}`,
                    description: translation.length > 50 
                        ? translation.substring(0, 50) + '...' 
                        : translation,
                    detail: isDefault ? 'Default locale' : undefined,
                    location: loc,
                };
            });

            // Sort with default locale first
            localeChoices.sort((a, b) => {
                if (a.location.locale === record.defaultLocale) return -1;
                if (b.location.locale === record.defaultLocale) return 1;
                return a.location.locale.localeCompare(b.location.locale);
            });

            const choice = await vscode.window.showQuickPick(localeChoices, {
                placeHolder: `Select locale for translation key: ${record.key}`,
                title: 'Go to Translation File',
                matchOnDescription: true,
            });

            if (!choice) {
                // User cancelled - jump to default locale as fallback
                const primary =
                    record.locations.find((l) => l.locale === record.defaultLocale) ||
                    record.locations[0];
                console.log('[i18n] User cancelled, jumping to default:', primary.uri.toString());
                const range = await this.findKeyPositionInFile(primary.uri, keyInfo.key);
                return new vscode.Location(primary.uri, range);
            }

            // Jump to the selected locale file with precise position
            const targetUri = choice.location.uri;
            console.log('[i18n] User selected locale:', choice.location.locale, targetUri.toString());
            const range = await this.findKeyPositionInFile(targetUri, keyInfo.key);
            console.log('[i18n] Found range:', range.start.line, range.start.character);
            return new vscode.Location(targetUri, range);
        } catch (err) {
            console.error('Definition provider error:', err);
            return undefined;
        }
    }
}

/**
 * Completion provider for i18n translation keys
 * Provides autocomplete suggestions for translation keys
 */
export class I18nCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private i18nIndex: I18nIndex) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.CompletionItem[]> {
        try {
            // Check if project is disabled
            const folder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (folder && isProjectDisabled(folder)) {
                return []; // Project is disabled
            }

            await this.i18nIndex.ensureInitialized();
            const langId = document.languageId;
            const isLaravelSource = langId === 'php' || langId === 'blade';

            if (langId === 'json' || langId === 'jsonc') {
                // Provide IntelliSense for known translations inside locale JSON files
                return this.provideJsonTranslationCompletions(document, position);
            }

            const keyInfo = extractKeyAtPosition(document, position);
            if (!keyInfo) {
                // Only offer completions when cursor is inside a translation key string
                return [];
            }
            const existingPrefix = keyInfo.key;

            const items: vscode.CompletionItem[] = [];
            const allKeys = this.i18nIndex.getAllKeys();

            for (const key of allKeys) {
                // Filter by prefix if one exists
                if (existingPrefix && !key.startsWith(existingPrefix)) {
                    continue;
                }

                const record = this.i18nIndex.getRecord(key);
                if (!record) continue;

                if (isLaravelSource) {
                    const hasLaravel = record.locations.some((loc) => {
                        const fsPath = loc.uri.fsPath.replace(/\\/g, '/').toLowerCase();
                        return fsPath.includes('/lang/') || fsPath.includes('/resources/lang/');
                    });
                    if (!hasLaravel) {
                        continue;
                    }
                }

                // Calculate the suffix to insert (avoid duplicating the prefix)
                const insertText = existingPrefix ? key.substring(existingPrefix.length) : key;
                const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Value);
                item.insertText = insertText;
                item.command = {
                    title: 'Go to Translation File',
                    command: 'ai-localizer.i18n.gotoTranslationFromHover',
                    arguments: [
                        {
                            uri: document.uri.toString(),
                            position: {
                                line: keyInfo.range.start.line,
                                character: keyInfo.range.start.character,
                            },
                        },
                    ],
                };
                
                // Set detail to default locale translation
                const defaultTranslation = record.locales.get(record.defaultLocale) ?? '';
                item.detail = defaultTranslation;

                // Build documentation with all translations
                const md = new vscode.MarkdownString();
                md.appendMarkdown(`**i18n key** \`${record.key}\`\n\n`);
                
                // Sort locales with default first
                const sortedLocales = Array.from(record.locales.entries()).sort(([a], [b]) => {
                    if (a === record.defaultLocale) return -1;
                    if (b === record.defaultLocale) return 1;
                    return a.localeCompare(b);
                });

                for (const [locale, value] of sortedLocales) {
                    const isDefault = locale === record.defaultLocale;
                    const localeLabel = isDefault ? `${locale} (default)` : locale;
                    md.appendMarkdown(`- **${localeLabel}**: ${escapeMarkdown(value)}\n`);
                }
                
                md.isTrusted = false;
                item.documentation = md;

                // Add sort text to prioritize matches
                if (key.startsWith(existingPrefix)) {
                    item.sortText = `0_${key}`;
                } else {
                    item.sortText = `1_${key}`;
                }

                items.push(item);

                // Limit results to prevent performance issues
                if (items.length >= 200) {
                    break;
                }
            }

            return items;
        } catch (err) {
            console.error('Completion provider error:', err);
            return [];
        }
    }

    /**
     * Provide completion items for locale JSON files based on known
     * translations for the current locale.
     */
    private async provideJsonTranslationCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.CompletionItem[]> {
        const fsPath = document.uri.fsPath;
        const normalized = fsPath.replace(/\\/g, '/');

        // Heuristic: only run on likely locale JSON paths
        if (
            !normalized.includes('/i18n/') &&
            !normalized.includes('/locales/') &&
            !normalized.includes('/resources/js/i18n/')
        ) {
            return [];
        }

        const locale = inferJsonLocaleFromUri(document.uri);

        if (!locale) {
            return [];
        }

        const line = document.lineAt(position.line).text;
        if (!line) {
            return [];
        }

        const before = line.slice(0, position.character);
        const lastQuote = before.lastIndexOf('"');
        const lastColon = before.lastIndexOf(':');

        // Only provide value completions when cursor is inside a JSON string
        // after the colon (i.e. the value side of a key/value pair).
        if (lastQuote === -1 || lastColon === -1 || lastQuote < lastColon) {
            return [];
        }

        const existingPrefix = before.slice(lastQuote + 1);
        const prefixLower = existingPrefix.toLowerCase();

        const items: vscode.CompletionItem[] = [];
        const seen = new Set<string>();
        const allKeys = this.i18nIndex.getAllKeys();

        for (const key of allKeys) {
            const record = this.i18nIndex.getRecord(key);
            if (!record) continue;

            const rawValue = record.locales.get(locale);
            if (typeof rawValue !== 'string') continue;
            const value = rawValue.trim();
            if (!value) continue;

            if (existingPrefix) {
                const valueLower = value.toLowerCase();
                if (!valueLower.startsWith(prefixLower)) {
                    continue;
                }
            }

            if (seen.has(value)) {
                continue;
            }
            seen.add(value);

            const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Text);
            const insertText = existingPrefix ? value.slice(existingPrefix.length) : value;
            item.insertText = insertText;
            item.detail = `Known ${locale} translation from key ${key}`;

            items.push(item);

            if (items.length >= 100) {
                break;
            }
        }

        return items;
    }
}

class I18nUntranslatedCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    private isLaravelLocaleFile(document: vscode.TextDocument): boolean {
        const fsPath = document.uri.fsPath.replace(/\\/g, '/').toLowerCase();
        if (!fsPath.endsWith('.php')) {
            return false;
        }
        return fsPath.includes('/lang/') || fsPath.includes('/resources/lang/');
    }

    constructor(private i18nIndex: I18nIndex) {}

    async provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
    ): Promise<(vscode.CodeAction | vscode.Command)[]> {
        // Check if project is disabled
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (folder && isProjectDisabled(folder)) {
            return []; // Project is disabled
        }

        const actions: vscode.CodeAction[] = [];

        const relevant = context.diagnostics.filter(
            (d) =>
                d.code === 'ai-i18n.untranslated' ||
                d.code === 'ai-i18n.style' ||
                d.code === 'ai-i18n.invalid' ||
                d.code === 'ai-i18n.placeholders' ||
                d.code === 'ai-i18n.missing-reference' ||
                d.code === 'ai-i18n.missing-default',
        );

        let addedBulkActions = false;
        const actionWorkspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        const isJsonLocale = document.languageId === 'json' || document.languageId === 'jsonc';
        const isLaravelLocale = this.isLaravelLocaleFile(document);

        for (const diagnostic of relevant) {
            if (!diagnostic.range.intersection(range)) {
                continue;
            }

            if (diagnostic.code === 'ai-i18n.untranslated') {
                const parsed = parseUntranslatedDiagnostic(String(diagnostic.message || ''));
                if (!parsed) continue;
                const { key, locales } = parsed;
                if (!key || !locales || !locales.length) {
                    continue;
                }
                const uniqueLocales = Array.from(new Set(locales));
                const localeLabel = uniqueLocales.join(', ');
                const title = `AI Localizer: AI-translate ${localeLabel} for ${key}`;
                const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                action.command = {
                    title,
                    command: 'ai-localizer.i18n.applyUntranslatedQuickFix',
                    arguments: [document.uri, key, uniqueLocales],
                };
                actions.push(action);

                // Add "ignore this key" option for keys that shouldn't be translated
                if (actionWorkspaceFolder) {
                    const ignoreTitle = `AI Localizer: Add "${key}" to ignore list`;
                    const ignoreAction = new vscode.CodeAction(ignoreTitle, vscode.CodeActionKind.QuickFix);
                    ignoreAction.diagnostics = [diagnostic];
                    ignoreAction.command = {
                        title: ignoreTitle,
                        command: 'ai-localizer.i18n.addKeyToIgnoreList',
                        arguments: [actionWorkspaceFolder.uri, key],
                    };
                    actions.push(ignoreAction);
                }
            } else if (diagnostic.code === 'ai-i18n.placeholders') {
                // Placeholder mismatch - offer to copy placeholders from default
                const placeholderParsed = parsePlaceholderDiagnostic(String(diagnostic.message || ''));
                if (placeholderParsed) {
                    const { key, locale } = placeholderParsed;
                    const title = `AI Localizer: Fix placeholder mismatch for ${key} in ${locale}`;
                    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                    action.diagnostics = [diagnostic];
                    action.isPreferred = true;
                    action.command = {
                        title,
                        command: 'ai-localizer.i18n.fixPlaceholderMismatch',
                        arguments: [document.uri, key, locale],
                    };
                    actions.push(action);
                }
            } else if (diagnostic.code === 'ai-i18n.style') {
                const styleParsed = parseStyleDiagnostic(String(diagnostic.message || ''));
                if (!styleParsed) continue;
                const { key, locale, suggested } = styleParsed;
                if (!key || !locale || !suggested) continue;
                const title = `AI Localizer: Apply suggested style (${locale}) for ${key}`;
                const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.command = {
                    title,
                    command: 'ai-localizer.i18n.applyStyleSuggestionQuickFix',
                    arguments: [document.uri, key, locale, suggested],
                };
                actions.push(action);
            } else if (diagnostic.code === 'ai-i18n.invalid') {
                // Parse the invalid diagnostic to extract the key
                const invalidParsed = parseInvalidDiagnostic(String(diagnostic.message || ''));
                if (!invalidParsed) continue;
                const { key } = invalidParsed;

                // Offer per-key removal from this file
                const title = `AI Localizer: Remove invalid key "${key}" from this file`;
                const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                action.command = {
                    title,
                    command: 'ai-localizer.i18n.removeInvalidKeyInFile',
                    arguments: [document.uri, key],
                };
                actions.push(action);

                // Also offer bulk restore if we have a folder
                if (actionWorkspaceFolder) {
                    const bulkTitle = `AI Localizer: Restore all invalid keys in code and remove from locales`;
                    const bulkAction = new vscode.CodeAction(bulkTitle, vscode.CodeActionKind.QuickFix);
                    bulkAction.diagnostics = [diagnostic];
                    bulkAction.command = {
                        title: bulkTitle,
                        command: 'ai-localizer.i18n.restoreInvalidKeysInFile',
                        arguments: [document.uri],
                    };
                    actions.push(bulkAction);
                }
            } else if (diagnostic.code === 'ai-i18n.missing-reference') {
                // Parse the missing reference diagnostic to extract the key
                const missingRefParsed = parseMissingReferenceDiagnostic(String(diagnostic.message || ''));
                if (!missingRefParsed) continue;
                const { key } = missingRefParsed;

                // Single fix action
                const title = `AI Localizer: Fix missing reference "${key}"`;
                const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                action.command = {
                    title,
                    command: 'ai-localizer.i18n.fixMissingKeyReference',
                    arguments: [
                        document.uri,
                        { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
                        key,
                    ],
                };
                actions.push(action);

                // Bulk fix action for all missing references in this file
                if (
                    !addedBulkActions &&
                    (document.languageId === 'typescript' ||
                        document.languageId === 'typescriptreact' ||
                        document.languageId === 'javascript' ||
                        document.languageId === 'javascriptreact' ||
                        document.languageId === 'vue' ||
                        document.languageId === 'php' ||
                        document.languageId === 'blade')
                ) {
                    addedBulkActions = true;
                    const bulkTitle = 'AI Localizer: Bulk fix all missing key references in this file';
                    const bulkAction = new vscode.CodeAction(bulkTitle, vscode.CodeActionKind.QuickFix);
                    bulkAction.diagnostics = [diagnostic];
                    bulkAction.command = {
                        title: bulkTitle,
                        command: 'ai-localizer.i18n.bulkFixMissingKeyReferences',
                        arguments: [document.uri],
                    };
                    actions.push(bulkAction);
                }
            } else if (diagnostic.code === 'ai-i18n.missing-default') {
                // Parse the missing default diagnostic to extract key and locales
                const missingDefaultParsed = parseMissingDefaultDiagnostic(String(diagnostic.message || ''));
                if (!missingDefaultParsed) continue;
                const { key, defaultLocale, existingLocales } = missingDefaultParsed;
                if (!key || !defaultLocale || !existingLocales.length) continue;

                // Offer to copy translation from one of the existing locales
                const firstExistingLocale = existingLocales[0];
                const title = `AI Localizer: Copy translation from ${firstExistingLocale} to ${defaultLocale} for ${key}`;
                const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                action.command = {
                    title,
                    command: 'ai-localizer.i18n.copyTranslationToDefaultLocale',
                    arguments: [document.uri, key, firstExistingLocale, defaultLocale],
                };
                actions.push(action);

                // Add bulk fix action for all missing default locale translations in this file
                if (
                    !addedBulkActions &&
                    (isJsonLocale || isLaravelLocale)
                ) {
                    addedBulkActions = true;
                    const bulkTitle = 'AI Localizer: Bulk fix all missing default locale translations in this file';
                    const bulkAction = new vscode.CodeAction(bulkTitle, vscode.CodeActionKind.QuickFix);
                    bulkAction.diagnostics = [diagnostic];
                    bulkAction.command = {
                        title: bulkTitle,
                        command: 'ai-localizer.i18n.bulkFixMissingDefaultTranslations',
                        arguments: [document.uri],
                    };
                    actions.push(bulkAction);
                }
            }

            if (!addedBulkActions && (isJsonLocale || isLaravelLocale)) {
                addedBulkActions = true;

                // Add bulk translate action for all untranslated keys in this file
                const bulkTranslateTitle = 'AI Localizer: AI-translate all untranslated keys in this file';
                const bulkTranslateAction = new vscode.CodeAction(
                    bulkTranslateTitle,
                    vscode.CodeActionKind.QuickFix,
                );
                bulkTranslateAction.command = {
                    title: bulkTranslateTitle,
                    command: 'ai-localizer.i18n.translateAllUntranslatedInFile',
                    arguments: [document.uri],
                };
                actions.push(bulkTranslateAction);

                if (isJsonLocale) {
                    const cleanupTitle = 'AI Localizer: Cleanup unused keys in this file (from report)';
                    const cleanupAction = new vscode.CodeAction(
                        cleanupTitle,
                        vscode.CodeActionKind.QuickFix,
                    );
                    cleanupAction.command = {
                        title: cleanupTitle,
                        command: 'ai-localizer.i18n.cleanupUnusedKeysInFile',
                        arguments: [document.uri],
                    };
                    actions.push(cleanupAction);

                    const invalidTitle =
                        'AI Localizer: Remove invalid/non-translatable keys in this file (from report)';
                    const invalidAction = new vscode.CodeAction(
                        invalidTitle,
                        vscode.CodeActionKind.QuickFix,
                    );
                    invalidAction.command = {
                        title: invalidTitle,
                        command: 'ai-localizer.i18n.restoreInvalidKeysInFile',
                        arguments: [document.uri],
                    };
                    actions.push(invalidAction);
                }
            }
        }

        const reportWorkspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri) || undefined;

        if (reportWorkspaceFolder && (document.languageId === 'json' || document.languageId === 'jsonc')) {
            const keyPath = await this.getKeyPathForJsonRange(document, range);
            if (keyPath) {
                const scriptsDir = vscode.Uri.joinPath(reportWorkspaceFolder.uri, 'scripts');
                const unusedReport = await this.loadReport(scriptsDir, '.i18n-unused-report.json');
                const invalidReport = await this.loadReport(scriptsDir, '.i18n-invalid-report.json');

                const unused = Array.isArray(unusedReport?.unused) ? unusedReport.unused : [];
                const invalid = Array.isArray(invalidReport?.invalid) ? invalidReport.invalid : [];

                const isUnused = unused.some(
                    (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === keyPath,
                );
                const isInvalid = invalid.some(
                    (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === keyPath,
                );

                if (isUnused) {
                    const title = `AI Localizer: Remove this unused key (${keyPath}) from this file (from report)`;
                    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                    action.command = {
                        title,
                        command: 'ai-localizer.i18n.removeUnusedKeyInFile',
                        arguments: [document.uri, keyPath],
                    };
                    actions.push(action);
                }

                if (isInvalid) {
                    const title = `AI Localizer: Remove this invalid/non-translatable key (${keyPath}) from this file (from report)`;
                    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                    action.isPreferred = true;
                    action.command = {
                        title,
                        command: 'ai-localizer.i18n.removeInvalidKeyInFile',
                        arguments: [document.uri, keyPath],
                    };
                    actions.push(action);
                }
            }
        }

        if (folder && document.languageId !== 'json' && document.languageId !== 'jsonc' && !isLaravelLocale) {
            const keyInfo = extractKeyAtPosition(document, range.start) || extractKeyAtPosition(document, range.end);
            if (keyInfo) {
                const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
                const invalidReport = await this.loadReport(scriptsDir, '.i18n-invalid-report.json');
                const invalid = Array.isArray(invalidReport?.invalid) ? invalidReport.invalid : [];
                const hasInvalid = invalid.some(
                    (item: any) => item && typeof item.keyPath === 'string' && item.keyPath === keyInfo.key,
                );

                if (hasInvalid) {
                    const title = `AI Localizer: Restore inline string and remove invalid key (${keyInfo.key}) (from report)`;
                    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                    action.isPreferred = true;
                    action.command = {
                        title,
                        command: 'ai-localizer.i18n.restoreInvalidKeyInCode',
                        arguments: [
                            document.uri,
                            { line: keyInfo.range.start.line, character: keyInfo.range.start.character },
                            keyInfo.key,
                        ],
                    };
                    actions.push(action);
                }

                await this.i18nIndex.ensureInitialized();
                const record = this.i18nIndex.getRecord(keyInfo.key);
                if (!record) {
                    const title = 'AI Localizer: Fix reference';
                    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                    if (!hasInvalid) {
                        action.isPreferred = true;
                    }
                    action.command = {
                        title,
                        command: 'ai-localizer.i18n.fixMissingKeyReference',
                        arguments: [
                            document.uri,
                            { line: keyInfo.range.start.line, character: keyInfo.range.start.character },
                            keyInfo.key,
                        ],
                    };
                    actions.push(action);

                    // Add bulk fix action for ts/tsx files
                    if (document.languageId === 'typescript' || document.languageId === 'typescriptreact') {
                        const bulkTitle = 'AI Localizer: Bulk fix all missing key references in this file';
                        const bulkAction = new vscode.CodeAction(bulkTitle, vscode.CodeActionKind.QuickFix);
                        bulkAction.command = {
                            title: bulkTitle,
                            command: 'ai-localizer.i18n.bulkFixMissingKeyReferences',
                            arguments: [document.uri],
                        };
                        actions.push(bulkAction);
                    }
                }
            }
        }

        const unique: vscode.CodeAction[] = [];
        const seen = new Set<string>();

        for (const action of actions) {
            const commandId = action.command?.command || '';
            const argsSig = action.command?.arguments ? JSON.stringify(action.command.arguments) : '';
            const key = `${commandId}:${action.title}:${argsSig}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            unique.push(action);
        }

        return unique;
    }

    private async loadReport(scriptsDir: vscode.Uri, fileName: string): Promise<any | null> {
        const reportUri = vscode.Uri.joinPath(scriptsDir, fileName);
        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            const raw = sharedDecoder.decode(data);
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    private async getKeyPathForJsonRange(
        document: vscode.TextDocument,
        range: vscode.Range,
    ): Promise<string | null> {
        await this.i18nIndex.ensureInitialized();
        const info = this.i18nIndex.getKeysForFile(document.uri);
        const keys = info?.keys || [];
        if (!keys.length) {
            return null;
        }
        const text = document.getText();
        for (const fullKey of keys) {
            const keyRange = this.findKeyRangeInJsonText(document, text, fullKey);
            if (keyRange && keyRange.intersection(range)) {
                return fullKey;
            }
        }
        return null;
    }

    private findKeyRangeInJsonText(
        document: vscode.TextDocument,
        text: string,
        fullKey: string,
    ): vscode.Range | null {
        const parts = fullKey.split('.');
        const lastSegment = parts[parts.length - 1];
        if (!lastSegment) {
            return null;
        }
        const needle = `"${lastSegment}"`;
        let index = text.indexOf(needle);
        while (index !== -1) {
            let i = index + needle.length;
            while (
                i < text.length &&
                (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')
            ) {
                i += 1;
            }
            if (i < text.length && text[i] === ':') {
                const startOffset = index + 1;
                const start = document.positionAt(startOffset);
                const end = new vscode.Position(start.line, start.character + lastSegment.length);
                return new vscode.Range(start, end);
            }
            index = text.indexOf(needle, index + needle.length);
        }
        return null;
    }
}

/**
 * Register all i18n IntelliSense providers
 */
export function registerI18nProviders(
    context: vscode.ExtensionContext,
    i18nIndex: I18nIndex,
): void {
    const hoverProvider = new I18nHoverProvider(i18nIndex);
    const definitionProvider = new I18nDefinitionProvider(i18nIndex);
    const completionProvider = new I18nCompletionProvider(i18nIndex);
    const codeActionProvider = new I18nUntranslatedCodeActionProvider(i18nIndex);

    context.subscriptions.push(
        vscode.languages.registerHoverProvider(I18N_CODE_SELECTOR, hoverProvider),
        vscode.languages.registerDefinitionProvider(I18N_CODE_SELECTOR, definitionProvider),
        // Completions for code files (keys)
        vscode.languages.registerCompletionItemProvider(
            I18N_CODE_SELECTOR,
            completionProvider,
            '.', // Trigger on dot
            '"', // Trigger on quote
            "'", // Trigger on single quote
        ),
        // Completions for locale JSON files (known translations)
        vscode.languages.registerCompletionItemProvider(
            I18N_JSON_SELECTOR,
            completionProvider,
            '"',
        ),
        vscode.languages.registerCodeActionsProvider(
            I18N_CODE_SELECTOR,
            codeActionProvider,
            {
                providedCodeActionKinds: I18nUntranslatedCodeActionProvider.providedCodeActionKinds,
            },
        ),
        vscode.languages.registerCodeActionsProvider(
            I18N_JSON_SELECTOR,
            codeActionProvider,
            {
                providedCodeActionKinds: I18nUntranslatedCodeActionProvider.providedCodeActionKinds,
            },
        ),
    );
}
