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
        // Single-candidate flow: preserve existing behavior with key confirmation
        if (!hasMultipleCandidates) {
            const single = candidates[0];
            const slug = slugifyForKey(single.text);
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
            const translations = await this.translationService.translateToLocales(
                single.text,
                defaultLocale,
                targetLocales,
                kind,
            );

            for (const locale of locales) {
                const value =
                    locale === defaultLocale ? single.text : translations.get(locale) ?? single.text;
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
                return;
            }

            if (isVueLike) {
                edit.replace(document.uri, single.range, `{{$t('${finalKey}')}}`);
                await vscode.workspace.applyEdit(edit);
                vscode.window.showInformationMessage(
                    `AI i18n: Created key ${finalKey} for selection.`,
                );
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

            editSingle.replace(document.uri, single.range, `t('${finalKey}')`);
            await vscode.workspace.applyEdit(editSingle);
            vscode.window.showInformationMessage(
                `AI i18n: Created key ${finalKey} for selection.`,
            );
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
            const slug = slugifyForKey(segment.text);
            const key = `${namespace}.${kind}.${slug}`;

            const targetLocales = locales.filter((l) => l !== defaultLocale);
            const translations = await this.translationService.translateToLocales(
                segment.text,
                defaultLocale,
                targetLocales,
                kind,
            );

            for (const locale of locales) {
                const value =
                    locale === defaultLocale ? segment.text : translations.get(locale) ?? segment.text;
                await upsertTranslationKey(folder, locale, key, value);
            }

            if (isBladeLike) {
                edit.replace(document.uri, segment.range, `{{ __('${key}') }}`);
            } else if (isVueLike) {
                edit.replace(document.uri, segment.range, `{{$t('${key}')}}`);
            } else {
                edit.replace(document.uri, segment.range, `t('${key}')`);
            }
        }

        await this.i18nIndex.ensureInitialized(true);
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage(
            `AI i18n: Applied translations to ${segments.length} selected text segment(s).`,
        );
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

        if (isJsLike) {
            // Match string literals within the selection
            const stringRegex = /(['"])([^'"\n]+?)\1/g;
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
        }

        // Fallback: if nothing matched, treat the full selection as a single candidate
        // but only if it passes the translatability check
        if (!candidates.length) {
            const trimmed = selectionText.trim();
            if (trimmed && this.isTranslatableText(trimmed)) {
                candidates.push({ range: selection, text: trimmed });
            }
        }

        return candidates;
    }

    /**
     * Determine if a string is likely translatable UI text vs technical content.
     * Uses shared validation logic with English phonetic pattern detection.
     */
    private isTranslatableText(text: string): boolean {
        return isTranslatableTextShared(text);
    }
}
