import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectConfigService } from '../services/projectConfigService';
import { FileSystemService } from '../services/fileSystemService';
import { pickWorkspaceFolder } from '../core/workspace';

/**
 * Command to configure project i18n settings
 */
export class ConfigureProjectCommand {
    constructor(
        private context: vscode.ExtensionContext,
        private projectConfigService: ProjectConfigService,
        private fileSystemService: FileSystemService,
    ) {}

    async execute(): Promise<void> {
        // Get workspace folder
        const active = vscode.window.activeTextEditor;
        let folder = active
            ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
            : undefined;
        
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }

        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available to configure.');
            return;
        }

        try {
            // Configure scripts
            await this.projectConfigService.configureDefaultScripts(folder);

            // Prompt for locales
            const locales = await this.projectConfigService.promptForLocales();
            if (locales) {
                await this.projectConfigService.updateConfig(folder, { locales });
            }

            // Prompt for source root
            const config = await this.projectConfigService.readConfig(folder);
            const srcRootAlreadySet = config?.srcRoot && config.srcRoot.length > 0;

            if (!srcRootAlreadySet) {
                const srcRoot = await this.projectConfigService.promptForSrcRoot(folder);
                if (srcRoot) {
                    await this.projectConfigService.updateConfig(folder, { srcRoot });
                }
            }

            // Prompt for postbuild script
            const currentConfig = await this.projectConfigService.readConfig(folder);
            if (currentConfig && !currentConfig.scripts.postbuild) {
                const choice = await vscode.window.showQuickPick(
                    [
                        { label: 'Yes', description: 'Run i18n sync after build' },
                        { label: 'No', description: 'Leave postbuild unchanged' },
                    ],
                    { placeHolder: 'Wire AI i18n scripts into postbuild?' },
                );

                if (choice && choice.label === 'Yes') {
                    await this.projectConfigService.updateConfig(folder, {
                        scripts: {
                            postbuild: 'npm run i18n:sync',
                        },
                    });
                }
            }

            // Copy scripts to project
            await this.fileSystemService.copyScriptsToProject(
                this.context,
                folder.uri.fsPath,
            );

            // Prompt for OpenAI API key if not already configured so automatic
            // AI translations can work out of the box.
            const existingSecret = (await this.context.secrets.get('openaiApiKey')) || '';
            const cfg = vscode.workspace.getConfiguration('ai-localizer');
            const existingCfgKey = (cfg.get<string>('openaiApiKey') || '').trim();
            if (!existingSecret && !existingCfgKey) {
                const choice = await vscode.window.showInformationMessage(
                    'AI Localizer: To enable automatic AI translations, configure an OpenAI API key. You can obtain a key from https://platform.openai.com/api-keys.',
                    'Enter API key',
                    'Open signup page',
                    'Skip',
                );

                if (choice === 'Enter API key') {
                    await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
                } else if (choice === 'Open signup page') {
                    await vscode.env.openExternal(
                        vscode.Uri.parse('https://platform.openai.com/api-keys'),
                    );
                }
            }

            vscode.window.showInformationMessage(
                'AI Localizer: Project i18n scripts and configuration have been set up.',
            );
        } catch (err) {
            console.error('Failed to configure project:', err);
            vscode.window.showErrorMessage(`AI Localizer: Configuration failed. ${err}`);
        }
    }
}
