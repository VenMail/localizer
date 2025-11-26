import * as vscode from 'vscode';
import { I18nStatusBar } from '../core/statusBar';
import { ProjectConfigService } from '../services/projectConfigService';

/**
 * Command to show i18n status and settings
 */
export class StatusCommand {
    constructor(private statusBar: I18nStatusBar, private projectConfigService: ProjectConfigService) {}

    async execute(): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-assistant');
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

        if (isCode) {
            items.unshift({ label: '$(edit) Run Rewrite (JS/TS/Vue)', action: 'runRewrite' });
            items.unshift({ label: '$(search) Run Extract (JS/TS/Vue)', action: 'runExtract' });
        }
        if (isBlade) {
            items.unshift({ label: '$(symbol-keyword) Run Blade Rewrite', action: 'runRewriteBlade' });
        }
        if (selectionHasText && (isCode || isBlade)) {
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
                    `AI i18n: Auto-monitoring ${!autoMonitor ? 'enabled' : 'disabled'}.`,
                );
                break;
            case 'toggleExtract':
                await config.update(
                    'i18n.autoExtract',
                    !autoExtract,
                    vscode.ConfigurationTarget.Workspace,
                );
                vscode.window.showInformationMessage(
                    `AI i18n: Auto-extract ${!autoExtract ? 'enabled' : 'disabled'}.`,
                );
                break;
            case 'toggleRewrite':
                await config.update(
                    'i18n.autoRewrite',
                    !autoRewrite,
                    vscode.ConfigurationTarget.Workspace,
                );
                vscode.window.showInformationMessage(
                    `AI i18n: Auto-rewrite ${!autoRewrite ? 'enabled' : 'disabled'}.`,
                );
                break;
            case 'configure':
                await vscode.commands.executeCommand('ai-assistant.i18n.configureProject');
                break;
            case 'rescan':
                await vscode.commands.executeCommand('ai-assistant.i18n.rescan');
                break;
            case 'runExtract':
                await vscode.commands.executeCommand('ai-assistant.i18n.runExtractScript');
                break;
            case 'runRewrite':
                await vscode.commands.executeCommand('ai-assistant.i18n.runRewriteScript');
                break;
            case 'runRewriteBlade':
                await vscode.commands.executeCommand('ai-assistant.i18n.runRewriteBladeScript');
                break;
            case 'convertSelection':
                await vscode.commands.executeCommand('ai-assistant.i18n.convertSelectionToKey');
                break;
        }
    }
}
