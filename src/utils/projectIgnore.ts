import * as vscode from 'vscode';

// Legacy support for .i18n.ignore files (will be checked if workspace setting is not set)
export const I18N_IGNORE_FILE = '.i18n.ignore';

/**
 * Check if the extension is disabled for a project via VS Code workspace settings
 * Falls back to checking .i18n.ignore file for backward compatibility
 */
export function isProjectDisabled(workspaceFolder?: vscode.WorkspaceFolder): boolean {
    if (!workspaceFolder) {
        // Check all workspace folders if no specific folder provided
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }
        return workspaceFolders.some(folder => isProjectDisabled(folder));
    }

    // First check the new workspace setting
    const config = vscode.workspace.getConfiguration('ai-localizer', workspaceFolder.uri);
    const disabledViaConfig = config.get<boolean>('disabled', false);
    if (disabledViaConfig) {
        return true;
    }

    // Fall back to legacy .i18n.ignore file check for backward compatibility
    const ignoreFilePath = require('path').join(workspaceFolder.uri.fsPath, I18N_IGNORE_FILE);
    return require('fs').existsSync(ignoreFilePath);
}

/**
 * Disable the extension for a project using VS Code workspace settings
 * This is the preferred method over creating .i18n.ignore files
 */
export async function disableProject(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration('ai-localizer', workspaceFolder.uri);
        await config.update('disabled', true, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(
            `AI Localizer: Extension disabled for project. Updated workspace settings.`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            `Failed to disable AI Localizer: ${message}`
        );
        throw error;
    }
}

/**
 * Enable the extension for a project using VS Code workspace settings
 */
export async function enableProject(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration('ai-localizer', workspaceFolder.uri);
        await config.update('disabled', false, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(
            `AI Localizer: Extension enabled for project. Updated workspace settings.`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            `Failed to enable AI Localizer: ${message}`
        );
        throw error;
    }
}
