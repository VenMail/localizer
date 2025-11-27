import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex, extractKeyAtPosition, escapeMarkdown } from '../core/i18nIndex';
import { detectFrameworkProfile } from '../frameworks/detection';

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
            const config = vscode.workspace.getConfiguration('ai-assistant');
            const delayMs = config.get<number>('i18n.hoverDelayMs') ?? 1900;

            if (delayMs > 0) {
                await new Promise<void>((resolve) => {
                    const handle = setTimeout(() => {
                        clearTimeout(handle);
                        resolve();
                    }, delayMs);
                });

                if (token.isCancellationRequested) {
                    return undefined;
                }
            }

            await this.i18nIndex.ensureInitialized();
            
            const keyInfo = extractKeyAtPosition(document, position);
            if (!keyInfo) {
                return undefined;
            }

            // Don't show hover if cursor is anywhere inside the key text range
            // This prevents hover from appearing when clicking or typing inside the key
            const range = keyInfo.range;
            if (range.contains(position)) {
                return undefined;
            }

            const record = this.i18nIndex.getRecord(keyInfo.key);
            if (!record) {
                return undefined;
            }

            // Sort locales with default first
            const locales = Array.from(record.locales.keys()).sort((a, b) => {
                if (a === record.defaultLocale) return -1;
                if (b === record.defaultLocale) return 1;
                return a.localeCompare(b);
            });

            // Build hover content
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**i18n key** \`${record.key}\`\n\n`);
            
            for (const locale of locales) {
                const value = record.locales.get(locale);
                if (value === undefined) continue;
                
                const isDefault = locale === record.defaultLocale;
                const localeLabel = isDefault ? `${locale} (default)` : locale;
                md.appendMarkdown(`- **${localeLabel}**: ${escapeMarkdown(value)}\n`);
            }

            const args = {
                uri: document.uri.toString(),
                position: { line: range.start.line, character: range.start.character },
            };
            const encoded = encodeURIComponent(JSON.stringify(args));
            md.appendMarkdown(
                `\n[Go to translation file](command:ai-assistant.i18n.gotoTranslationFromHover?${encoded})\n`,
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
    constructor(private i18nIndex: I18nIndex) {}

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
            
            // Split key into parts (e.g., "Namespace.button.save" -> ["Namespace", "button", "save"])
            const keyParts = key.split('.');
            const lastPart = keyParts[keyParts.length - 1];
            
            // Search for the key in the JSON structure
            // Look for patterns like: "lastPart": "value" or "lastPart":"value"
            const escapedKey = lastPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const searchPattern = new RegExp(`"${escapedKey}"\s*:\s*`, 'g');
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
            await this.i18nIndex.ensureInitialized();
            
            // If nothing is indexed yet, offer to initialize i18n for the project
            const allKeys = this.i18nIndex.getAllKeys();
            if (!allKeys.length) {
                const choice = await vscode.window.showInformationMessage(
                    'AI i18n: No translations indexed for this workspace yet.',
                    'Rescan Translations',
                    'Configure i18n',
                );
                if (choice === 'Rescan Translations') {
                    await vscode.commands.executeCommand('ai-assistant.i18n.rescan');
                } else if (choice === 'Configure i18n') {
                    await vscode.commands.executeCommand('ai-assistant.i18n.configureProject');
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
            await this.i18nIndex.ensureInitialized();
            const langId = document.languageId;

            if (langId === 'json' || langId === 'jsonc') {
                // Provide IntelliSense for known translations inside locale JSON files
                return this.provideJsonTranslationCompletions(document, position);
            }

            const keyInfo = extractKeyAtPosition(document, position);
            const existingPrefix = keyInfo ? keyInfo.key : '';

            const items: vscode.CompletionItem[] = [];
            const allKeys = this.i18nIndex.getAllKeys();

            for (const key of allKeys) {
                // Filter by prefix if one exists
                if (existingPrefix && !key.startsWith(existingPrefix)) {
                    continue;
                }

                const record = this.i18nIndex.getRecord(key);
                if (!record) continue;

                // Calculate the suffix to insert (avoid duplicating the prefix)
                const insertText = existingPrefix ? key.substring(existingPrefix.length) : key;
                const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Value);
                item.insertText = insertText;
                
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

        // Infer locale from path (similar to I18nIndex.inferLocaleFromPath)
        const parts = normalized.split('/').filter(Boolean);
        let locale: string | null = null;
        const autoIndex = parts.lastIndexOf('auto');
        if (autoIndex >= 0 && autoIndex + 1 < parts.length) {
            const raw = parts[autoIndex + 1];
            locale = raw.replace(/\.json$/i, '');
        } else {
            const fileName = parts[parts.length - 1];
            const match = fileName.match(/^([A-Za-z0-9_-]+)\.json$/);
            if (match) {
                locale = match[1];
            }
        }

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

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
    ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
        const diagnostics = context.diagnostics.filter((d) => d.code === 'ai-i18n.untranslated');
        if (!diagnostics.length) {
            return [];
        }

        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of diagnostics) {
            if (!diagnostic.range.intersection(range)) {
                continue;
            }

            const parsed = this.parseDiagnosticMessage(String(diagnostic.message || ''));
            if (!parsed) {
                continue;
            }

            const { key, locales } = parsed;
            if (!key || !locales.length) {
                continue;
            }

            const uniqueLocales = Array.from(new Set(locales));
            const localeLabel = uniqueLocales.join(', ');
            const title = `AI i18n: AI-translate ${localeLabel} for ${key}`;

            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            action.diagnostics = [diagnostic];
            action.command = {
                title,
                command: 'ai-assistant.i18n.applyUntranslatedQuickFix',
                arguments: [document.uri, key, uniqueLocales],
            };
            actions.push(action);
        }

        return actions;
    }

    private parseDiagnosticMessage(message: string): { key: string; locales: string[] } | null {
        if (!message) {
            return null;
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

        const selectionMatch = clean.match(/^Missing translations for\s+(.+?)\s+in locales:\s+(.+)$/);
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
    const codeActionProvider = new I18nUntranslatedCodeActionProvider();

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
