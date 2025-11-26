import * as vscode from 'vscode';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { FileSystemService } from '../services/fileSystemService';
import { I18nStatusBar } from '../core/statusBar';

/**
 * Registry for all extension commands
 */
export class CommandRegistry {
    constructor(
        private context: vscode.ExtensionContext,
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private projectConfigService: ProjectConfigService,
        private fileSystemService: FileSystemService,
        private statusBar: I18nStatusBar,
    ) {}

    /**
     * Register all commands
     */
    registerAll(): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        try {
            // Import command handlers
            const { ConfigureProjectCommand } = require('./configureProjectCommand');
            const { ConvertSelectionCommand } = require('./convertSelectionCommand');
            const { StatusCommand } = require('./statusCommand');
            const { ScriptCommands } = require('./scriptCommands');
            const { UntranslatedCommands } = require('./untranslatedCommands');
            const { ComponentCommands } = require('./componentCommands');

        // Rescan command
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.rescan', async () => {
                await this.i18nIndex.ensureInitialized(true);
                const count = this.i18nIndex.getAllKeys().length;
                vscode.window.showInformationMessage(`AI i18n: Indexed ${count} translation keys.`);
            }),
        );

        // Configure project command
        const configureCmd = new ConfigureProjectCommand(
            this.context,
            this.projectConfigService,
            this.fileSystemService,
        );
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.configureProject', () =>
                configureCmd.execute(),
            ),
        );

        // Convert selection command
        const convertCmd = new ConvertSelectionCommand(
            this.context,
            this.i18nIndex,
            this.translationService,
            this.projectConfigService,
        );
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.convertSelectionToKey', () =>
                convertCmd.execute(),
            ),
        );

        // Status command
        const statusCmd = new StatusCommand(this.statusBar, this.projectConfigService);
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.showStatus', () =>
                statusCmd.execute(),
            ),
        );

        // Script commands
        const scriptCmds = new ScriptCommands();
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.runExtractScript', () =>
                scriptCmds.runExtract(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.runRewriteScript', () =>
                scriptCmds.runRewrite(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.runSyncScript', () =>
                scriptCmds.runSync(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.runFixUntranslatedScript', () =>
                scriptCmds.runFixUntranslated(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.runRewriteBladeScript', () =>
                scriptCmds.runRewriteBlade(),
            ),
        );

        // Untranslated commands
        const untranslatedCmds = new UntranslatedCommands(
            this.i18nIndex,
            this.translationService,
        );
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.openUntranslatedReport', () =>
                untranslatedCmds.openReport(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.applyUntranslatedAiFixes', () =>
                untranslatedCmds.applyAiFixes(),
            ),
        );

        // Component commands
        const componentCmds = new ComponentCommands(this.context, this.fileSystemService);
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.openRootApp', () =>
                componentCmds.openRootApp(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.copyLanguageSwitcher', () =>
                componentCmds.copyLanguageSwitcher(),
            ),
        );

        // API Key command
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.setOpenAiApiKeySecret', async () => {
                const existing = (await this.context.secrets.get('openaiApiKey')) || '';
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter your OpenAI API key to store securely',
                    ignoreFocusOut: true,
                    value: existing,
                    password: true,
                });
                if (!input) {
                    return;
                }
                await this.translationService.setApiKey(input);
                vscode.window.showInformationMessage('AI i18n: OpenAI API key stored securely.');
            }),
        );

        } catch (error) {
            console.error('Failed to register commands:', error);
            vscode.window.showErrorMessage(`AI i18n: Failed to register commands. ${error}`);
            throw error;
        }

        return disposables;
    }
}
