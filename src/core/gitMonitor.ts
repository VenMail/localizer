import * as vscode from 'vscode';
import * as path from 'path';

export interface GitStatus {
    hasGit: boolean;
    isDirty: boolean;
    untrackedFiles: string[];
    modifiedFiles: string[];
}

/**
 * Check if a workspace folder has git initialized
 */
export async function hasGitRepo(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const gitDir = vscode.Uri.joinPath(folder.uri, '.git');
    try {
        const stat = await vscode.workspace.fs.stat(gitDir);
        return stat.type === vscode.FileType.Directory;
    } catch {
        return false;
    }
}

/**
 * Get git status for a workspace folder
 */
export async function getGitStatus(folder: vscode.WorkspaceFolder): Promise<GitStatus> {
    const hasGit = await hasGitRepo(folder);
    if (!hasGit) {
        return {
            hasGit: false,
            isDirty: false,
            untrackedFiles: [],
            modifiedFiles: [],
        };
    }

    // Use VS Code's built-in git extension API if available
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) {
        return {
            hasGit: true,
            isDirty: false,
            untrackedFiles: [],
            modifiedFiles: [],
        };
    }

    try {
        if (!gitExtension.isActive) {
            await gitExtension.activate();
        }

        const git = gitExtension.exports.getAPI(1);
        const repo = git.repositories.find((r: any) => 
            r.rootUri.fsPath === folder.uri.fsPath
        );

        if (!repo) {
            return {
                hasGit: true,
                isDirty: false,
                untrackedFiles: [],
                modifiedFiles: [],
            };
        }

        const state = repo.state;
        const workingTreeChanges = state.workingTreeChanges || [];
        const indexChanges = state.indexChanges || [];
        
        const untrackedFiles: string[] = [];
        const modifiedFiles: string[] = [];

        for (const change of workingTreeChanges) {
            const uri = change.uri;
            if (!uri) continue;
            
            const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
            
            // Status codes from git
            if (change.status === 7) { // Untracked
                untrackedFiles.push(relativePath);
            } else if (change.status === 0 || change.status === 5) { // Modified or Added
                modifiedFiles.push(relativePath);
            }
        }

        for (const change of indexChanges) {
            const uri = change.uri;
            if (!uri) continue;
            
            const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
            if (!modifiedFiles.includes(relativePath)) {
                modifiedFiles.push(relativePath);
            }
        }

        const isDirty = workingTreeChanges.length > 0 || indexChanges.length > 0;

        return {
            hasGit: true,
            isDirty,
            untrackedFiles,
            modifiedFiles,
        };
    } catch (err) {
        console.error('Failed to get git status:', err);
        return {
            hasGit: true,
            isDirty: false,
            untrackedFiles: [],
            modifiedFiles: [],
        };
    }
}

/**
 * Check if a file is clean (committed and not modified)
 */
export async function isFileClean(
    folder: vscode.WorkspaceFolder,
    fileUri: vscode.Uri
): Promise<boolean> {
    const status = await getGitStatus(folder);
    if (!status.hasGit) {
        return false; // No git, can't determine clean state
    }

    const relativePath = path.relative(folder.uri.fsPath, fileUri.fsPath);
    const normalizedPath = relativePath.replace(/\\/g, '/');

    // File is dirty if it's in untracked or modified lists
    const isDirty = 
        status.untrackedFiles.some(f => f.replace(/\\/g, '/') === normalizedPath) ||
        status.modifiedFiles.some(f => f.replace(/\\/g, '/') === normalizedPath);

    return !isDirty;
}
