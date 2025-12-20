import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export const I18N_IGNORE_FILE = '.i18n.ignore';

/**
 * Check if the extension is disabled for a project via .i18n.ignore file
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

    const ignoreFilePath = path.join(workspaceFolder.uri.fsPath, I18N_IGNORE_FILE);
    return fs.existsSync(ignoreFilePath);
}

/**
 * Create .i18n.ignore file in the project root
 */
export async function createIgnoreFile(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const ignoreFilePath = path.join(workspaceFolder.uri.fsPath, I18N_IGNORE_FILE);
    
    try {
        await fs.promises.writeFile(ignoreFilePath, '# AI Localizer is disabled for this project\n');
        vscode.window.showInformationMessage(
            `AI Localizer: Extension disabled for project. Created ${I18N_IGNORE_FILE} file.`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            `Failed to create ${I18N_IGNORE_FILE}: ${message}`
        );
        throw error;
    }
}

/**
 * Remove .i18n.ignore file from the project root
 */
export async function removeIgnoreFile(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const ignoreFilePath = path.join(workspaceFolder.uri.fsPath, I18N_IGNORE_FILE);
    
    try {
        if (fs.existsSync(ignoreFilePath)) {
            await fs.promises.unlink(ignoreFilePath);
            vscode.window.showInformationMessage(
                `AI Localizer: Extension re-enabled for project. Removed ${I18N_IGNORE_FILE} file.`
            );
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            `Failed to remove ${I18N_IGNORE_FILE}: ${message}`
        );
        throw error;
    }
}
