import * as vscode from 'vscode';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Validate that a string is a safe git ref (commit hash, branch name, or tag).
 * Only allows alphanumeric characters, hyphens, underscores, slashes, dots, and ^~:
 */
function isValidGitRef(ref: string): boolean {
    if (!ref || typeof ref !== 'string') return false;
    // Git refs: alphanumeric, hyphen, underscore, slash, dot, ^, ~, @, numbers after ^ or ~
    // Reject anything with shell metacharacters: $, `, ", ', \, |, ;, &, etc.
    return /^[A-Za-z0-9_.\/\-^~@]+$/.test(ref) && ref.length < 256;
}

// Timeout for git operations (10 seconds)
const GIT_TIMEOUT_MS = 10000;
// Max buffer size for git output (5MB)
const GIT_MAX_BUFFER = 5 * 1024 * 1024;
// Max commits to check in history search
const MAX_HISTORY_COMMITS = 20;

export interface GitCommitInfo {
    hash: string;
    date: Date;
    message: string;
    author: string;
}

export interface GitFileHistory {
    commits: GitCommitInfo[];
    filePath: string;
}

/**
 * Get git commit hash for current HEAD
 */
export async function getCurrentCommitHash(
    folder: vscode.WorkspaceFolder,
): Promise<string | null> {
    try {
        // Use execFile for safer argument handling
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
            cwd: folder.uri.fsPath,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
        });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

/**
 * Get file history from git log (up to specified days back)
 */
export async function getFileHistory(
    folder: vscode.WorkspaceFolder,
    filePath: string,
    daysBack: number = 30,
    maxCommits: number = MAX_HISTORY_COMMITS,
): Promise<GitFileHistory> {
    const relativePath = path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/');
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - daysBack);
    const since = sinceDate.toISOString().split('T')[0];

    try {
        // Use execFile for safer argument handling (no shell interpolation)
        const { stdout } = await execFileAsync(
            'git',
            [
                'log',
                `--since=${since}`,
                '-n',
                String(maxCommits),
                '--format=%H|%ai|%an|%s',
                '--',
                relativePath,
            ],
            {
                cwd: folder.uri.fsPath,
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: GIT_MAX_BUFFER,
            },
        );

        const commits: GitCommitInfo[] = [];
        const lines = stdout.trim().split('\n').filter(Boolean);

        for (const line of lines) {
            const [hash, dateStr, author, ...messageParts] = line.split('|');
            if (hash && dateStr) {
                commits.push({
                    hash: hash.trim(),
                    date: new Date(dateStr.trim()),
                    message: messageParts.join('|').trim(),
                    author: author.trim(),
                });
            }
        }

        return {
            commits,
            filePath: relativePath,
        };
    } catch {
        return {
            commits: [],
            filePath: relativePath,
        };
    }
}

/**
 * Get file content at a specific commit
 */
export async function getFileContentAtCommit(
    folder: vscode.WorkspaceFolder,
    filePath: string,
    commitHash: string,
): Promise<string | null> {
    // Validate commit hash to prevent shell injection
    if (!isValidGitRef(commitHash)) {
        console.warn(`AI Localizer: Invalid git ref format: ${commitHash}`);
        return null;
    }

    const relativePath = path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/');

    try {
        // Use execFile for safer argument handling (no shell interpolation)
        const { stdout } = await execFileAsync('git', ['show', `${commitHash}:${relativePath}`], {
            cwd: folder.uri.fsPath,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
        });
        return stdout || null;
    } catch {
        return null;
    }
}

/**
 * Get diff for a file between two commits
 */
export async function getFileDiff(
    folder: vscode.WorkspaceFolder,
    filePath: string,
    fromCommit: string,
    toCommit: string = 'HEAD',
): Promise<string | null> {
    // Validate commit refs to prevent shell injection
    if (!isValidGitRef(fromCommit) || !isValidGitRef(toCommit)) {
        console.warn(`AI Localizer: Invalid git ref format: ${fromCommit} or ${toCommit}`);
        return null;
    }

    const relativePath = path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/');

    try {
        // Use execFile for safer argument handling (no shell interpolation)
        const { stdout } = await execFileAsync('git', ['diff', fromCommit, toCommit, '--', relativePath], {
            cwd: folder.uri.fsPath,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
        });
        return stdout || null;
    } catch {
        return null;
    }
}

/**
 * Find the most recent commit where a key existed in a locale file
 */
export async function findKeyInHistory(
    folder: vscode.WorkspaceFolder,
    localeFilePath: string,
    keyPath: string,
    daysBack: number = 30,
): Promise<{ commit: GitCommitInfo; value: string } | null> {
    const history = await getFileHistory(folder, localeFilePath, daysBack);

    for (const commit of history.commits) {
        const content = await getFileContentAtCommit(folder, localeFilePath, commit.hash);
        if (!content) continue;

        try {
            const json = JSON.parse(content);
            const value = getNestedValue(json, keyPath);
            if (value && typeof value === 'string') {
                return { commit, value };
            }
        } catch {
            // Invalid JSON, continue
        }
    }

    return null;
}

/**
 * Get nested value from object using dot notation path
 */
function getNestedValue(obj: any, path: string): any {
    const segments = path.split('.').filter(Boolean);
    let current = obj;
    for (const segment of segments) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        if (!Object.prototype.hasOwnProperty.call(current, segment)) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

