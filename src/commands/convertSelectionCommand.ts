import * as vscode from 'vscode';
import { exec } from 'child_process';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { deriveNamespaceFromFile, deriveRootFromFile, upsertTranslationKey } from '../core/i18nFs';
import { pickWorkspaceFolder } from '../core/workspace';
import { SelectionStringDetector } from './untranslated/utils/SelectionStringDetector';
import { TranslationKeyGenerator } from './untranslated/utils/TranslationKeyGenerator';
import { FrameworkCodeGenerator } from './untranslated/utils/FrameworkCodeGenerator';
import { TemplateLiteralProcessor, TemplateInfo } from './untranslated/utils/TemplateLiteralProcessor';

/**
 * Command to convert selected text to translation key
 */
export class ConvertSelectionCommand {
    constructor(
        private context: vscode.ExtensionContext,
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private projectConfigService: ProjectConfigService,
        private untranslatedDiagnostics: vscode.DiagnosticCollection,
    ) {}

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('AI Localizer: No active editor.');
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
                'AI Localizer: Selection to key is only supported in JavaScript/TypeScript, Vue, and Blade/PHP files.',
            );
            return;
        }

        // Get selection
        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showInformationMessage(
                'AI Localizer: Please select the text you want to convert to a translation key.',
            );
            return;
        }

        const selectedText = document.getText(selection).trim();
        if (!selectedText) {
            vscode.window.showInformationMessage('AI Localizer: Selected text is empty.');
            return;
        }

        // Detect one or more candidate string segments inside the selection
        const detector = new SelectionStringDetector(document, selection);
        const candidates = detector.findCandidates();
        if (!candidates.length) {
            vscode.window.showInformationMessage(
                'AI Localizer: No translatable strings detected in the current selection.',
            );
            return;
        }
        const hasMultipleCandidates = candidates.length > 1;

        // Get workspace folder
        const folder =
            vscode.workspace.getWorkspaceFolder(document.uri) || (await pickWorkspaceFolder());
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        const rootName = deriveRootFromFile(folder, document.uri);

        // Get locales
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const defaultLocale = config.get<string>('i18n.defaultLocale') || 'en';
        
        const projectConfig = await this.projectConfigService.readConfig(folder);
        let locales = projectConfig?.locales || [defaultLocale];
        
        if (!locales.includes(defaultLocale)) {
            locales.unshift(defaultLocale);
        }

        // Prompt for kind (applies to all selected segments)
        const namespace = deriveNamespaceFromFile(folder, document.uri);
        const kindPick = await vscode.window.showQuickPick(
            TranslationKeyGenerator.getTextKinds(),
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

            // For JS source files, support advanced template literal handling
            let sourceText = single.text;
            let templateInfo: TemplateInfo | null = null;

            if (isJsSource) {
                templateInfo = FrameworkCodeGenerator.analyzeTemplateLiteral(document, single.range);
                if (templateInfo && templateInfo.baseText.trim().length > 0) {
                    sourceText = templateInfo.baseText;
                }
            }

            const defaultKey = TranslationKeyGenerator.generateKey({
                kind,
                namespace,
                sourceText
            });

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

            const missingLocalesSingle: string[] = [];
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
                    missingLocalesSingle.push(locale);
                }
                await upsertTranslationKey(folder, locale, finalKey, value, { rootName });
            }

            if (missingLocalesSingle.length) {
                this.reportUntranslatedLocales(document, single.range, finalKey, missingLocalesSingle);
            }

            // Locale file writes trigger watchers which update index + diagnostics incrementally

            const edit = new vscode.WorkspaceEdit();

            if (isBladeLike) {
                const replacement = FrameworkCodeGenerator.generateReplacement({
                    document,
                    range: single.range,
                    key: finalKey
                });
                edit.replace(document.uri, single.range, replacement);
                await vscode.workspace.applyEdit(edit);
                vscode.window.showInformationMessage(
                    `AI Localizer: Created key ${finalKey} for selection.`,
                );
                await this.runSyncIfConfigured(folder);
                return;
            }

            if (isVueLike) {
                const replacement = FrameworkCodeGenerator.generateReplacement({
                    document,
                    range: single.range,
                    key: finalKey
                });
                edit.replace(document.uri, single.range, replacement);
                await vscode.workspace.applyEdit(edit);
                vscode.window.showInformationMessage(
                    `AI Localizer: Created key ${finalKey} for selection.`,
                );
                await this.runSyncIfConfigured(folder);
                return;
            }

            // JavaScript/TypeScript - add import if needed and replace
            const tImportPath = FrameworkCodeGenerator.getImportPath(document);
            FrameworkCodeGenerator.addImportIfNeeded(document, edit, tImportPath);

            const replacement = FrameworkCodeGenerator.generateReplacement({
                document,
                range: single.range,
                key: finalKey,
                templateInfo,
                isJsSource
            });

            edit.replace(document.uri, single.range, replacement);
            await vscode.workspace.applyEdit(edit);
            vscode.window.showInformationMessage(
                `AI Localizer: Created key ${finalKey} for selection.`,
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
        if (isJsLike && !isVueLike && !isBladeLike) {
            const tImportPath = FrameworkCodeGenerator.getImportPath(document);
            FrameworkCodeGenerator.addImportIfNeeded(document, edit, tImportPath);
        }

        for (const segment of segments) {
            let sourceText = segment.text;
            let templateInfo: TemplateInfo | null = null;

            if (isJsSource) {
                templateInfo = FrameworkCodeGenerator.analyzeTemplateLiteral(document, segment.range);
                if (templateInfo && templateInfo.baseText.trim().length > 0) {
                    sourceText = templateInfo.baseText;
                }
            }

            const key = TranslationKeyGenerator.generateKey({
                kind,
                namespace,
                sourceText
            });

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

            const missingLocalesMulti: string[] = [];
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
                    missingLocalesMulti.push(locale);
                }
                await upsertTranslationKey(folder, locale, key, value, { rootName });
            }

            if (missingLocalesMulti.length) {
                this.reportUntranslatedLocales(document, segment.range, key, missingLocalesMulti);
            }

            if (isBladeLike) {
                const replacement = FrameworkCodeGenerator.generateReplacement({
                    document,
                    range: segment.range,
                    key
                });
                edit.replace(document.uri, segment.range, replacement);
            } else if (isVueLike) {
                const replacement = FrameworkCodeGenerator.generateReplacement({
                    document,
                    range: segment.range,
                    key
                });
                edit.replace(document.uri, segment.range, replacement);
            } else {
                const replacement = FrameworkCodeGenerator.generateReplacement({
                    document,
                    range: segment.range,
                    key,
                    templateInfo,
                    isJsSource
                });
                edit.replace(document.uri, segment.range, replacement);
            }
        }

        // Locale file writes trigger watchers which update index + diagnostics incrementally
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage(
            `AI Localizer: Applied translations to ${segments.length} selected text segment(s).`,
        );
        await this.runSyncIfConfigured(folder);
    }

    private reportUntranslatedLocales(
        document: vscode.TextDocument,
        range: vscode.Range,
        key: string,
        missingLocales: string[],
    ): void {
        if (!missingLocales.length) {
            return;
        }

        const existing = this.untranslatedDiagnostics.get(document.uri) || [];
        const message = `AI Localizer: Missing translations for ${key} in locales: ${missingLocales.join(", ")}`;

        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const setting = cfg.get<string>('i18n.diagnostics.missingLocaleSeverity') || 'warning';
        const severity = this.mapSeverityFromSetting(setting);

        const diagnostic = new vscode.Diagnostic(
            range,
            message,
            severity,
        );
        diagnostic.code = 'ai-i18n.untranslated';
        this.untranslatedDiagnostics.set(document.uri, existing.concat(diagnostic));
    }

    private mapSeverityFromSetting(value: string | undefined): vscode.DiagnosticSeverity {
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
    }

    /**
     * Optionally run the i18n sync script after applying translations so
     * non-default locales are kept in sync and can reuse known translations.
     */
    private async runSyncIfConfigured(folder: vscode.WorkspaceFolder): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const syncScript = config.get<string>('i18n.syncScript');
        if (syncScript) {
            try {
                await new Promise<void>((resolve, reject) => {
                    exec(syncScript, { cwd: folder.uri.fsPath }, (error: any) => {
                        if (error) {
                            console.warn('Sync script failed:', error);
                            resolve(); // Don't reject, just log warning
                        } else {
                            resolve();
                        }
                    });
                });
            } catch (error) {
                console.warn('Failed to run sync script:', error);
            }
        }
    }
}
