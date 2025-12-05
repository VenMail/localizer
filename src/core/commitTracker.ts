import * as vscode from 'vscode';
import { getCurrentCommitHash } from './gitHistory';

interface ScriptCommitRef {
    scriptName: string;
    commitHash: string;
    timestamp: number;
    folderPath: string;
}

/**
 * Service to track commit refs before running extract/replace scripts
 * Stores commit refs in workspace storage
 */
export class CommitTracker {
    private static readonly STORAGE_KEY = 'i18n.scriptCommitRefs';

    /**
     * Save commit ref before running a script
     */
    static async saveCommitRef(
        context: vscode.ExtensionContext,
        folder: vscode.WorkspaceFolder,
        scriptName: string,
    ): Promise<void> {
        const commitHash = await getCurrentCommitHash(folder);
        if (!commitHash) {
            console.warn(`AI Localizer: Could not get commit hash for ${scriptName}`);
            return;
        }

        const ref: ScriptCommitRef = {
            scriptName,
            commitHash,
            timestamp: Date.now(),
            folderPath: folder.uri.fsPath,
        };

        const existing = context.workspaceState.get<ScriptCommitRef[]>(CommitTracker.STORAGE_KEY) || [];
        const updated = existing.filter(
            (r) => !(r.scriptName === scriptName && r.folderPath === folder.uri.fsPath),
        );
        updated.push(ref);

        // Keep only last 50 entries
        const trimmed = updated.slice(-50);
        await context.workspaceState.update(CommitTracker.STORAGE_KEY, trimmed);
    }

    /**
     * Get commit ref for a script
     */
    static getCommitRef(
        context: vscode.ExtensionContext,
        folder: vscode.WorkspaceFolder,
        scriptName: string,
    ): ScriptCommitRef | null {
        const refs = context.workspaceState.get<ScriptCommitRef[]>(CommitTracker.STORAGE_KEY) || [];
        return (
            refs.find((r) => r.scriptName === scriptName && r.folderPath === folder.uri.fsPath) || null
        );
    }

    /**
     * Get all commit refs for a folder
     */
    static getCommitRefsForFolder(
        context: vscode.ExtensionContext,
        folder: vscode.WorkspaceFolder,
    ): ScriptCommitRef[] {
        const refs = context.workspaceState.get<ScriptCommitRef[]>(CommitTracker.STORAGE_KEY) || [];
        return refs.filter((r) => r.folderPath === folder.uri.fsPath);
    }

    /**
     * Get commit ref for extract script (most recent)
     */
    static getExtractCommitRef(
        context: vscode.ExtensionContext,
        folder: vscode.WorkspaceFolder,
    ): ScriptCommitRef | null {
        const refs = CommitTracker.getCommitRefsForFolder(context, folder);
        const extractRefs = refs.filter((r) => r.scriptName === 'i18n:extract');
        if (extractRefs.length === 0) return null;
        return extractRefs.sort((a, b) => b.timestamp - a.timestamp)[0];
    }

    /**
     * Get commit ref for replace script (most recent)
     */
    static getReplaceCommitRef(
        context: vscode.ExtensionContext,
        folder: vscode.WorkspaceFolder,
    ): ScriptCommitRef | null {
        const refs = CommitTracker.getCommitRefsForFolder(context, folder);
        const replaceRefs = refs.filter((r) => r.scriptName === 'i18n:rewrite' || r.scriptName === 'i18n:replace');
        if (replaceRefs.length === 0) return null;
        return replaceRefs.sort((a, b) => b.timestamp - a.timestamp)[0];
    }
}

