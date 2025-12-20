import * as vscode from 'vscode';
import { disableProject, enableProject, isProjectDisabled } from '../utils/projectIgnore';

/**
 * Command to disable the extension for the current project using VS Code workspace settings
 */
export class DisableProjectCommand {
    constructor(private context: vscode.ExtensionContext) {}

    async execute(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        if (isProjectDisabled(workspaceFolder)) {
            vscode.window.showInformationMessage(
                'AI Localizer is already disabled for this project.'
            );
            return;
        }

        const choice = await vscode.window.showWarningMessage(
            'Disable AI Localizer for this project? This will update your workspace settings.',
            'Disable',
            'Cancel'
        );

        if (choice === 'Disable') {
            await disableProject(workspaceFolder);
        }
    }
}

/**
 * Command to re-enable the extension for the current project using VS Code workspace settings
 */
export class EnableProjectCommand {
    constructor(private context: vscode.ExtensionContext) {}

    async execute(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        if (!isProjectDisabled(workspaceFolder)) {
            vscode.window.showInformationMessage(
                'AI Localizer is already enabled for this project.'
            );
            return;
        }

        await enableProject(workspaceFolder);
    }
}
