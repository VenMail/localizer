import * as vscode from 'vscode';
import { I18nStatusBar } from '../core/statusBar';
import { ProjectConfigService } from '../services/projectConfigService';

/**
 * Command to show i18n status and settings
 */
export class StatusCommand {
    constructor(private statusBar: I18nStatusBar, private projectConfigService: ProjectConfigService) {}

    async execute(): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const autoMonitor = config.get<boolean>('i18n.autoMonitor', true);
        const autoExtract = config.get<boolean>('i18n.autoExtract', true);
        const autoRewrite = config.get<boolean>('i18n.autoRewrite', true);

        const items: Array<{ label: string; description?: string; action: string }> = [
            {
                label: autoMonitor
                    ? '$(check) Auto-monitoring enabled'
                    : '$(x) Auto-monitoring disabled',
                description: 'Toggle automatic monitoring of new translatable content',
                action: 'toggleMonitor',
            },
            {
                label: autoExtract
                    ? '$(check) Auto-extract enabled'
                    : '$(x) Auto-extract disabled',
                description: 'Toggle automatic extraction when files are committed',
                action: 'toggleExtract',
            },
            {
                label: autoRewrite
                    ? '$(check) Auto-rewrite enabled'
                    : '$(x) Auto-rewrite disabled',
                description: 'Toggle automatic rewrite after extraction',
                action: 'toggleRewrite',
            },
            {
                label: '$(gear) Configure Project i18n',
                description: 'Set up i18n scripts and configuration',
                action: 'configure',
            },
            {
                label: '$(refresh) Rescan Translations',
                description: 'Rebuild translation index',
                action: 'rescan',
            },
            {
                label: '$(pulse) Show Workspace i18n Health Report',
                description: 'View a summary of i18n diagnostics across the workspace',
                action: 'showHealthReport',
            },
        ];

        // Context-aware actions for current file
        const editor = vscode.window.activeTextEditor;
        const lang = editor?.document.languageId;
        const selectionHasText = !!(editor && !editor.selection.isEmpty);
        const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) ?? undefined : undefined;

        if (folder) {
            const hasScripts = await this.projectConfigService.hasI18nScripts(folder);
            if (!hasScripts) {
                items.unshift({
                    label: '$(rocket) Initialize Project i18n',
                    description: 'Copy scripts and set up package.json',
                    action: 'configure',
                });
            }
        }

        const isCode = lang === 'javascript' || lang === 'typescript' || lang === 'javascriptreact' || lang === 'typescriptreact' || lang === 'vue';
        const isBlade = lang === 'blade' || lang === 'php';

        const isJson = lang === 'json' || lang === 'jsonc';

        if (isJson && editor) {
            items.unshift({
                label: 'Bulk-translate untranslated keys in all locale files (project)',
                description:
                    'Use AI to translate all missing/untranslated keys across all locale JSON files in this workspace',
                action: 'bulkTranslateProject',
            });
            items.unshift({
                label: 'Apply all style suggestions in this file',
                description: 'Apply all AI i18n style suggestions in the current locale JSON file',
                action: 'applyAllStyleSuggestionsInFile',
            });
            items.unshift({
                label: 'Remove invalid/non-translatable keys in this locale file',
                description: 'Remove invalid or non-translatable keys from this locale JSON file (from report)',
                action: 'removeInvalidLocaleFile',
            });
            items.unshift({
                label: 'Cleanup unused keys in this locale file',
                description: 'Remove unused keys in this locale JSON file (from unused keys report)',
                action: 'cleanupUnusedLocaleFile',
            });
            items.unshift({
                label: 'Bulk-translate untranslated keys in this locale file',
                description: 'Use AI to translate all missing/untranslated keys in this locale JSON file',
                action: 'bulkTranslateLocaleFile',
            });
            items.unshift({
                label: 'Fix all i18n issues in this locale file',
                description:
                    'Run bulk-translate, cleanup unused keys, remove invalid keys, and apply all style suggestions (each step will confirm).',
                action: 'fixAllIssuesLocaleFile',
            });
        }

        if (isCode) {
            items.unshift({ label: '$(edit) Run Rewrite (JS/TS/Vue)', action: 'runRewrite' });
            items.unshift({ label: '$(search) Run Extract (JS/TS/Vue)', action: 'runExtract' });
        }
        if (isBlade) {
            items.unshift({ label: '$(symbol-keyword) Run Blade Rewrite', action: 'runRewriteBlade' });
        }
        if (selectionHasText && (isCode || isBlade)) {
            items.unshift({
                label: 'Review i18n issues for selection (AI-translate missing)',
                description:
                    'Analyze i18n keys in the current selection and AI-translate missing/untranslated locales.',
                action: 'reviewSelection',
            });
            items.unshift({ label: '$(quote) Convert Selection to Translation Key', action: 'convertSelection' });
        }

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: 'AI i18n Status & Settings',
        });

        if (!selection) {
            return;
        }

        switch (selection.action) {
            case 'toggleMonitor':
                await config.update(
                    'i18n.autoMonitor',
                    !autoMonitor,
                    vscode.ConfigurationTarget.Workspace,
                );
                this.statusBar.setMonitoring(!autoMonitor);
                vscode.window.showInformationMessage(
                    `AI Localizer: Auto-monitoring ${!autoMonitor ? 'enabled' : 'disabled'}.`,
                );
                break;
            case 'toggleExtract':
                await config.update(
                    'i18n.autoExtract',
                    !autoExtract,
                    vscode.ConfigurationTarget.Workspace,
                );
                vscode.window.showInformationMessage(
                    `AI Localizer: Auto-extract ${!autoExtract ? 'enabled' : 'disabled'}.`,
                );
                break;
            case 'toggleRewrite':
                await config.update(
                    'i18n.autoRewrite',
                    !autoRewrite,
                    vscode.ConfigurationTarget.Workspace,
                );
                vscode.window.showInformationMessage(
                    `AI Localizer: Auto-rewrite ${!autoRewrite ? 'enabled' : 'disabled'}.`,
                );
                break;
            case 'configure':
                await vscode.commands.executeCommand('ai-localizer.i18n.configureProject');
                break;
            case 'rescan':
                await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
                break;
            case 'showHealthReport':
                await vscode.commands.executeCommand('ai-localizer.i18n.showHealthReport');
                break;
            case 'runExtract':
                await vscode.commands.executeCommand('ai-localizer.i18n.runExtractScript');
                break;
            case 'runRewrite':
                await vscode.commands.executeCommand('ai-localizer.i18n.runRewriteScript');
                break;
            case 'runRewriteBlade':
                await vscode.commands.executeCommand('ai-localizer.i18n.runRewriteBladeScript');
                break;
            case 'convertSelection':
                await vscode.commands.executeCommand('ai-localizer.i18n.convertSelectionToKey');
                break;
            case 'reviewSelection':
                if (editor) {
                    await vscode.commands.executeCommand('ai-localizer.i18n.reviewSelection');
                }
                break;
            case 'fixAllIssuesLocaleFile':
                if (editor) {
                    await vscode.commands.executeCommand(
                        'ai-localizer.i18n.fixAllIssuesInFile',
                        editor.document.uri,
                    );
                }
                break;
            case 'bulkTranslateProject':
                await vscode.commands.executeCommand(
                    'ai-localizer.i18n.translateAllUntranslatedInProject',
                );
                break;
            case 'bulkTranslateLocaleFile':
                if (editor) {
                    await vscode.commands.executeCommand(
                        'ai-localizer.i18n.translateAllUntranslatedInFile',
                        editor.document.uri,
                    );
                }
                break;
            case 'cleanupUnusedLocaleFile':
                if (editor) {
                    await vscode.commands.executeCommand(
                        'ai-localizer.i18n.cleanupUnusedKeysInFile',
                        editor.document.uri,
                    );
                }
                break;
            case 'removeInvalidLocaleFile':
                if (editor) {
                    await vscode.commands.executeCommand(
                        'ai-localizer.i18n.restoreInvalidKeysInFile',
                        editor.document.uri,
                    );
                }
                break;
            case 'applyAllStyleSuggestionsInFile':
                if (editor) {
                    await vscode.commands.executeCommand(
                        'ai-localizer.i18n.applyAllStyleSuggestionsInFile',
                        editor.document.uri,
                    );
                }
                break;
        }
    }
}
