import * as vscode from 'vscode';
import { I18nIndex, slugifyForKey } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { deriveNamespaceFromFile, upsertTranslationKey } from '../core/i18nFs';
import { pickWorkspaceFolder } from '../core/workspace';
import { isTranslatableText as isTranslatableTextShared } from '../core/textValidation';

/**
 * Command to convert selected text to translation key
 */
export class ConvertSelectionCommand {
    constructor(
        private context: vscode.ExtensionContext,
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private projectConfigService: ProjectConfigService,
    ) {}

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('AI i18n: No active editor.');
            return;
        }

        const document = editor.document;
        const langId = document.languageId;

        // Check if language is supported
        const isJsLike = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].includes(langId);
        const isVueLike = langId === 'vue';
        const isBladeLike = langId === 'blade' || langId === 'php';
        const isJsSource = isJsLike && !isVueLike && !isBladeLike;

        if (!isJsLike && !isVueLike && !isBladeLike) {
            vscode.window.showInformationMessage(
                'AI i18n: Selection to key is only supported in JavaScript/TypeScript, Vue, and Blade/PHP files.',
            );
            return;
        }

        // Get selection
        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showInformationMessage(
                'AI i18n: Please select the text you want to convert to a translation key.',
            );
            return;
        }

        const selectedText = document.getText(selection).trim();
        if (!selectedText) {
            vscode.window.showInformationMessage('AI i18n: Selected text is empty.');
            return;
        }

        // Detect one or more candidate string segments inside the selection
        const candidates = this.findCandidateStrings(document, selection, langId);
        if (!candidates.length) {
            vscode.window.showInformationMessage(
                'AI i18n: No translatable strings detected in the current selection.',
            );
            return;
        }
        const hasMultipleCandidates = candidates.length > 1;

        // Get workspace folder
        const folder =
            vscode.workspace.getWorkspaceFolder(document.uri) || (await pickWorkspaceFolder());
        if (!folder) {
            vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
            return;
        }

        // Get locales
        const config = vscode.workspace.getConfiguration('ai-assistant');
        const defaultLocale = config.get<string>('i18n.defaultLocale') || 'en';
        
        const projectConfig = await this.projectConfigService.readConfig(folder);
        let locales = projectConfig?.locales || [defaultLocale];
        
        if (!locales.includes(defaultLocale)) {
            locales.unshift(defaultLocale);
        }

        // Prompt for kind (applies to all selected segments)
        const namespace = deriveNamespaceFromFile(folder, document.uri);
        const kindPick = await vscode.window.showQuickPick(
            [
                { label: 'text', description: 'Generic UI text (default)' },
                { label: 'heading', description: 'Headings and titles' },
                { label: 'button', description: 'Buttons and primary actions' },
                { label: 'label', description: 'Field labels and chips' },
                { label: 'placeholder', description: 'Input placeholders' },
                { label: 'toast', description: 'Toast and notification messages' },
            ],
            { placeHolder: 'Select the kind of text you are converting to an i18n key' },
        );

        if (!kindPick) {
            return;
        }

        const kind = kindPick.label;

        // Ensure index is warmed so we can reuse known translations
        await this.i18nIndex.ensureInitialized();
        // Single-candidate flow: preserve existing behavior with key confirmation
        if (!hasMultipleCandidates) {
            const single = candidates[0];

            // For JS source files, support advanced template literal handling by
            // turning template interpolations into {placeholders} and passing
            // an object argument with the original expressions.
            let sourceText = single.text;
            let templateInfo:
                | { baseText: string; placeholders: Array<{ name: string; expression: string }> }
                | null = null;

            if (isJsSource) {
                const rawLiteral = document.getText(single.range);
                if (
                    rawLiteral &&
                    rawLiteral.startsWith('`') &&
                    rawLiteral.endsWith('`') &&
                    rawLiteral.includes('${')
                ) {
                    templateInfo = this.analyzeTemplateLiteral(rawLiteral);
                    if (templateInfo && templateInfo.baseText.trim().length > 0) {
                        sourceText = templateInfo.baseText;
                    }
                }
            }

            const slug = slugifyForKey(sourceText);
            const defaultKey = `${namespace}.${kind}.${slug}`;

            const finalKey = await vscode.window.showInputBox({
                value: defaultKey,
                prompt: 'Confirm or edit the i18n key',
            });

            if (!finalKey) {
                return;
            }

            // Get AI translations
            const targetLocales = locales.filter((l) => l !== defaultLocale);

            // Reuse known translations for the same base text where possible
            const reuseTranslations = this.i18nIndex.findTranslationsForBaseText(
                sourceText,
                defaultLocale,
            );
            const localesNeedingAi = targetLocales.filter((l) => !reuseTranslations.has(l));

            const translations = localesNeedingAi.length
                ? await this.translationService.translateToLocales(
                      sourceText,
                      defaultLocale,
                      localesNeedingAi,
                      kind,
                  )
                : new Map<string, string>();

            for (const locale of locales) {
                let value: string;
                if (locale === defaultLocale) {
                    value = sourceText;
                } else if (reuseTranslations.has(locale)) {
                    value = reuseTranslations.get(locale)!;
                } else if (translations.has(locale)) {
                    value = translations.get(locale)!;
                } else {
                    value = sourceText;
                }
                await upsertTranslationKey(folder, locale, finalKey, value);
            }

            await this.i18nIndex.ensureInitialized(true);

            const edit = new vscode.WorkspaceEdit();

            if (isBladeLike) {
                edit.replace(document.uri, single.range, `{{ __('${finalKey}') }}`);
                await vscode.workspace.applyEdit(edit);
                vscode.window.showInformationMessage(
                    `AI i18n: Created key ${finalKey} for selection.`,
                );
                await this.runSyncIfConfigured(folder);
                return;
            }

            if (isVueLike) {
                edit.replace(document.uri, single.range, `{{$t('${finalKey}')}}`);
                await vscode.workspace.applyEdit(edit);
                vscode.window.showInformationMessage(
                    `AI i18n: Created key ${finalKey} for selection.`,
                );
                await this.runSyncIfConfigured(folder);
                return;
            }

            // JavaScript/TypeScript - add import if needed
            const tImportPath = config.get<string>('i18n.tImportPath') || '@/i18n';
            const fullText = document.getText();
            const hasTImport =
                fullText.includes(`import { t } from '${tImportPath}'`) ||
                fullText.includes(`import { t } from "${tImportPath}"`);

            const editSingle = new vscode.WorkspaceEdit();

            if (!hasTImport) {
                const importLine = `import { t } from '${tImportPath}';\n`;
                const insertPos = this.findImportInsertPosition(document);
                editSingle.insert(document.uri, insertPos, importLine);
            }

            let replacement = `t('${finalKey}')`;
            if (isJsSource && templateInfo && templateInfo.placeholders.length > 0) {
                const argsObject = templateInfo.placeholders
                    .map((p) => `${p.name}: ${p.expression}`)
                    .join(', ');
                if (argsObject.length > 0) {
                    replacement = `t('${finalKey}', { ${argsObject} })`;
                }
            }

            editSingle.replace(document.uri, single.range, replacement);
            await vscode.workspace.applyEdit(editSingle);
            vscode.window.showInformationMessage(
                `AI i18n: Created key ${finalKey} for selection.`,
            );
            await this.runSyncIfConfigured(folder);
            return;
        }

        // Multi-candidate flow: offer preconfigured suggestions and apply translations in one action
        const multiItems = candidates.map((c, index) => {
            const preview = c.text.length > 80 ? `${c.text.slice(0, 77)}…` : c.text;
            return {
                label: preview || `(text ${index + 1})`,
                description: `Line ${c.range.start.line + 1}`,
                segment: c,
            } as vscode.QuickPickItem & {
                segment: { range: vscode.Range; text: string };
            };
        });

        const picked = await vscode.window.showQuickPick(multiItems, {
            canPickMany: true,
            placeHolder: 'Select text segments to apply translations to',
        });

        if (!picked || picked.length === 0) {
            return;
        }

        const segments = picked.map((p) => (p as any).segment as { range: vscode.Range; text: string });

        const edit = new vscode.WorkspaceEdit();

        // JavaScript/TypeScript - ensure import once for all segments
        let hasTImport = false;
        let tImportPath = '';
        if (isJsLike && !isVueLike && !isBladeLike) {
            tImportPath = config.get<string>('i18n.tImportPath') || '@/i18n';
            const fullText = document.getText();
            hasTImport =
                fullText.includes(`import { t } from '${tImportPath}'`) ||
                fullText.includes(`import { t } from "${tImportPath}"`);

            if (!hasTImport) {
                const importLine = `import { t } from '${tImportPath}';\n`;
                const insertPos = this.findImportInsertPosition(document);
                edit.insert(document.uri, insertPos, importLine);
            }
        }

        for (const segment of segments) {
            let sourceText = segment.text;
            let templateInfo:
                | { baseText: string; placeholders: Array<{ name: string; expression: string }> }
                | null = null;

            if (isJsSource) {
                const rawLiteral = document.getText(segment.range);
                if (
                    rawLiteral &&
                    rawLiteral.startsWith('`') &&
                    rawLiteral.endsWith('`') &&
                    rawLiteral.includes('${')
                ) {
                    templateInfo = this.analyzeTemplateLiteral(rawLiteral);
                    if (templateInfo && templateInfo.baseText.trim().length > 0) {
                        sourceText = templateInfo.baseText;
                    }
                }
            }

            const slug = slugifyForKey(sourceText);
            const key = `${namespace}.${kind}.${slug}`;

            const targetLocales = locales.filter((l) => l !== defaultLocale);

            // Reuse known translations for this segment text where possible
            const reuseTranslations = this.i18nIndex.findTranslationsForBaseText(
                sourceText,
                defaultLocale,
            );
            const localesNeedingAi = targetLocales.filter((l) => !reuseTranslations.has(l));

            const translations = localesNeedingAi.length
                ? await this.translationService.translateToLocales(
                      sourceText,
                      defaultLocale,
                      localesNeedingAi,
                      kind,
                  )
                : new Map<string, string>();

            for (const locale of locales) {
                let value: string;
                if (locale === defaultLocale) {
                    value = sourceText;
                } else if (reuseTranslations.has(locale)) {
                    value = reuseTranslations.get(locale)!;
                } else if (translations.has(locale)) {
                    value = translations.get(locale)!;
                } else {
                    value = sourceText;
                }
                await upsertTranslationKey(folder, locale, key, value);
            }

            if (isBladeLike) {
                edit.replace(document.uri, segment.range, `{{ __('${key}') }}`);
            } else if (isVueLike) {
                edit.replace(document.uri, segment.range, `{{$t('${key}')}}`);
            } else {
                let replacement = `t('${key}')`;
                if (isJsSource && templateInfo && templateInfo.placeholders.length > 0) {
                    const argsObject = templateInfo.placeholders
                        .map((p) => `${p.name}: ${p.expression}`)
                        .join(', ');
                    if (argsObject.length > 0) {
                        replacement = `t('${key}', { ${argsObject} })`;
                    }
                }
                edit.replace(document.uri, segment.range, replacement);
            }
        }

        await this.i18nIndex.ensureInitialized(true);
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage(
            `AI i18n: Applied translations to ${segments.length} selected text segment(s).`,
        );
        await this.runSyncIfConfigured(folder);
    }

    /**
     * Find the best position to insert import statement
     */
    private findImportInsertPosition(document: vscode.TextDocument): vscode.Position {
        let lastImportLine = -1;
        let firstCodeLine = -1;

        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            const trimmed = lineText.trim();

            // Skip empty lines and comments
            if (
                !trimmed ||
                trimmed.startsWith('//') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('*')
            ) {
                continue;
            }

            if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
                lastImportLine = i;
            } else if (firstCodeLine === -1) {
                firstCodeLine = i;
            }
        }

        // Insert after last import, or before first code line, or at the beginning
        if (lastImportLine >= 0) {
            return new vscode.Position(lastImportLine + 1, 0);
        } else if (firstCodeLine >= 0) {
            return new vscode.Position(firstCodeLine, 0);
        }

        return new vscode.Position(0, 0);
    }

    /**
     * Detect candidate string segments within the current selection that are
     * likely to be translated. Uses smart filtering to exclude CSS classes,
     * technical strings, and other non-translatable content.
     */
    private findCandidateStrings(
        document: vscode.TextDocument,
        selection: vscode.Range,
        langId: string,
    ): Array<{ range: vscode.Range; text: string }> {
        const selectionText = document.getText(selection);
        const baseOffset = document.offsetAt(selection.start);
        const candidates: Array<{ range: vscode.Range; text: string }> = [];

        const jsLikeLangs = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'vue'];
        const isJsLike = jsLikeLangs.includes(langId);
        const isBladeLike = langId === 'blade' || langId === 'php';

        if (isJsLike) {
            // First, try to extract string from object property value pattern
            // e.g., "description: `some text`" or "title: 'some text'"
            const propertyValueMatch = selectionText.match(/^\s*(?:[\w$]+|['"][^'"]+['"])\s*:\s*(['"`])([\s\S]+?)\1\s*,?\s*$/s);
            if (propertyValueMatch) {
                const quote = propertyValueMatch[1];
                const value = propertyValueMatch[2];
                
                // Find the position of the string value (not the whole property)
                const quoteIndex = selectionText.indexOf(quote, selectionText.indexOf(':'));
                if (quoteIndex !== -1) {
                    const valueStartOffset = baseOffset + quoteIndex;
                    const valueEndOffset = valueStartOffset + quote.length + value.length + quote.length;
                    const startPos = document.positionAt(valueStartOffset);
                    const endPos = document.positionAt(valueEndOffset);
                    const range = new vscode.Range(startPos, endPos);

                    if (quote === '`') {
                        const staticParts = this.extractStaticPartsFromTemplate(value);
                        const combined = staticParts.map((p) => p.text).join(' ');
                        if (this.isTranslatableText(combined)) {
                            candidates.push({ range, text: combined.trim() });
                        }
                    } else if (this.isTranslatableText(value)) {
                        candidates.push({ range, text: value.trim() });
                    }
                }
                
                if (candidates.length > 0) {
                    return candidates;
                }
            }

            // Match regular string literals (single and double quotes)
            // Supports escaped characters and inner quotes of the other type
            const stringRegex = /(['"])((?:\\.|(?!\1)[\s\S])+?)\1/g;
            let match: RegExpExecArray | null;
            // eslint-disable-next-line no-cond-assign
            while ((match = stringRegex.exec(selectionText)) !== null) {
                const full = match[0];
                const inner = match[2];
                
                // Apply smart filtering
                if (!this.isTranslatableText(inner)) {
                    continue;
                }

                const startOffset = baseOffset + match.index;
                const endOffset = startOffset + full.length;
                const startPos = document.positionAt(startOffset);
                const endPos = document.positionAt(endOffset);
                const range = new vscode.Range(startPos, endPos);
                candidates.push({ range, text: inner.trim() });
            }

            // Template literals (backticks) outside of simple object properties
            const templateRegex = /`([^`]+)`/g;
            // eslint-disable-next-line no-cond-assign
            while ((match = templateRegex.exec(selectionText)) !== null) {
                const full = match[0];
                const inner = match[1];

                const staticParts = this.extractStaticPartsFromTemplate(inner);
                const combined = staticParts.map((p) => p.text).join(' ');
                if (!this.isTranslatableText(combined)) {
                    continue;
                }

                const startOffset = baseOffset + match.index;
                const endOffset = startOffset + full.length;
                const startPos = document.positionAt(startOffset);
                const endPos = document.positionAt(endOffset);
                const range = new vscode.Range(startPos, endPos);
                candidates.push({ range, text: combined.trim() });
            }
        }

        if (isBladeLike) {
            const arrayItemMatch = selectionText.match(/^\s*(['"])([^'"]+)\1\s*=>\s*(['"])([\s\S]+?)\3\s*,?\s*$/s);
            if (arrayItemMatch) {
                const valueQuote = arrayItemMatch[3];
                const value = arrayItemMatch[4];

                const arrowIndex = selectionText.indexOf('=>');
                const valueQuoteIndex = arrowIndex >= 0 ? selectionText.indexOf(valueQuote, arrowIndex) : -1;
                if (valueQuoteIndex !== -1) {
                    const valueStartOffset = baseOffset + valueQuoteIndex;
                    const valueEndOffset = valueStartOffset + valueQuote.length + value.length + valueQuote.length;
                    const startPos = document.positionAt(valueStartOffset);
                    const endPos = document.positionAt(valueEndOffset);
                    const range = new vscode.Range(startPos, endPos);

                    if (this.isTranslatableText(value)) {
                        candidates.push({ range, text: value.trim() });
                    }
                }

                if (candidates.length > 0) {
                    return candidates;
                }
            }

            const bladeStringRegex = /(['"])((?:\\.|(?!\1)[\s\S])+?)\1/g;
            let match: RegExpExecArray | null;
            // eslint-disable-next-line no-cond-assign
            while ((match = bladeStringRegex.exec(selectionText)) !== null) {
                const full = match[0];
                const inner = match[2];

                if (!this.isTranslatableText(inner)) {
                    continue;
                }

                const startOffset = baseOffset + match.index;
                const endOffset = startOffset + full.length;
                const startPos = document.positionAt(startOffset);
                const endPos = document.positionAt(endOffset);
                const range = new vscode.Range(startPos, endPos);
                candidates.push({ range, text: inner.trim() });
            }
        }

        // Fallback: if nothing matched, treat the full selection as a single candidate
        // but only if it passes the translatability check
        if (!candidates.length) {
            const trimmed = selectionText.trim();

            // For JS-like languages, avoid using the entire selection when it clearly
            // looks like code (object literals, JSX, functions, etc.). In those cases
            // we would rather ask the user to tighten the selection than replace a
            // large code fragment.
            const looksLikeJsCode =
                isJsLike && /[:;{}<>]|=>|\bfunction\b|\breturn\b/.test(trimmed);

            if (!looksLikeJsCode && trimmed && this.isTranslatableText(trimmed)) {
                candidates.push({ range: selection, text: trimmed });
            }
        }

        return candidates;
    }

    private analyzeTemplateLiteral(rawLiteral: string):
        | { baseText: string; placeholders: Array<{ name: string; expression: string }> }
        | null {
        if (!rawLiteral || rawLiteral.length < 2 || rawLiteral[0] !== '`' || rawLiteral[rawLiteral.length - 1] !== '`') {
            return null;
        }

        const inner = rawLiteral.slice(1, -1);
        const placeholders: Array<{ name: string; expression: string }> = [];
        let baseText = '';
        let lastIndex = 0;
        const usedNames = new Set<string>();

        const interpolationRegex = /\$\{([^}]*)\}/g;
        let match: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign
        while ((match = interpolationRegex.exec(inner)) !== null) {
            const expr = match[1].trim();

            baseText += inner.slice(lastIndex, match.index);

            if (expr.length > 0) {
                let name: string | null = null;

                const lengthMatch = expr.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\.length\s*$/);
                if (lengthMatch && lengthMatch[1]) {
                    const base = lengthMatch[1];
                    name = /count$/i.test(base) ? base : `${base}Count`;
                }

                if (!name) {
                    const idMatch = expr.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
                    if (idMatch && idMatch[1]) {
                        name = idMatch[1];
                    }
                }

                if (!name) {
                    name = `value${placeholders.length + 1}`;
                }

                let uniqueName = name;
                let counter = 2;
                while (usedNames.has(uniqueName)) {
                    uniqueName = `${name}${counter}`;
                    counter += 1;
                }
                usedNames.add(uniqueName);

                placeholders.push({ name: uniqueName, expression: expr });
                baseText += `{${uniqueName}}`;
            }

            lastIndex = interpolationRegex.lastIndex;
        }

        baseText += inner.slice(lastIndex);

        return { baseText, placeholders };
    }

    /**
     * Extract static text parts from a template literal, excluding interpolations.
     * Returns array of {text, offset} where offset is relative to the template content.
     */
    private extractStaticPartsFromTemplate(template: string): Array<{ text: string; offset: number }> {
        const parts: Array<{ text: string; offset: number }> = [];
        
        // Split by ${...} interpolations
        const segments = template.split(/\$\{[^}]*\}/);
        let currentOffset = 0;
        
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (segment.trim().length > 0) {
                parts.push({ text: segment, offset: currentOffset });
            }
            
            // Move offset forward by segment length + interpolation length
            currentOffset += segment.length;
            if (i < segments.length - 1) {
                // Find the interpolation that was removed
                const remainingTemplate = template.substring(currentOffset);
                const interpolationMatch = remainingTemplate.match(/^\$\{[^}]*\}/);
                if (interpolationMatch) {
                    currentOffset += interpolationMatch[0].length;
                }
            }
        }
        
        return parts;
    }

    /**
     * Determine if a string is likely translatable UI text vs technical content.
     * Uses shared validation logic with English phonetic pattern detection.
     */
    private isTranslatableText(text: string): boolean {
        return isTranslatableTextShared(text);
    }

    /**
     * Optionally run the i18n sync script after applying translations so
     * non-default locales are kept in sync and can reuse known translations.
     */
    private async runSyncIfConfigured(folder: vscode.WorkspaceFolder): Promise<void> {
        try {
            const cfg = vscode.workspace.getConfiguration('ai-assistant');
            const autoSync = cfg.get<boolean>('i18n.autoSync');
            if (autoSync === false) {
                return;
            }

            const projectConfig = await this.projectConfigService.readConfig(folder);
            const hasSyncScript = !!projectConfig?.scripts?.['i18n:sync'];
            if (!hasSyncScript) {
                return;
            }

            await vscode.commands.executeCommand('ai-assistant.i18n.runSyncScript');
        } catch (err) {
            console.error('AI i18n: Failed to run i18n:sync after applying translations:', err);
        }
    }
}
