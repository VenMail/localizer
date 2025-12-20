import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Validate that a string is a safe git ref (commit hash, branch name, or tag).
 * Only allows alphanumeric characters, hyphens, underscores, slashes, dots, and ^~:
 */
function isValidGitRef(ref: string): boolean {
    if (!ref || typeof ref !== 'string') return false;
    // Git refs: alphanumeric, hyphen, underscore, slash, dot, ^, ~, @, numbers after ^ or ~
    // Reject anything with shell metacharacters: $, `, ", ', \, |, ;, &, etc.
    return /^[A-Za-z0-9_.^~@/-]+$/.test(ref) && ref.length < 256;
}

// Timeout for git operations (30 seconds for larger repos)
const GIT_TIMEOUT_MS = 30000;
// Max buffer size for git output (10MB for larger files)
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
// Max commits to check in history search (increased for better recovery)
const MAX_HISTORY_COMMITS = 100;

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
        const commits = await readHistory(relativePath, folder.uri.fsPath, `--since=${since}`, maxCommits);

        // Fallback: if no commits in the window, get the latest commits without date filter
        if (commits.length === 0) {
            const fallback = await readHistory(relativePath, folder.uri.fsPath, null, maxCommits);
            return {
                commits: fallback,
                filePath: relativePath,
            };
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

async function readHistory(
    relativePath: string,
    cwd: string,
    sinceFlag: string | null,
    maxCommits: number,
): Promise<GitCommitInfo[]> {
    const args = [
        'log',
        ...(sinceFlag ? [sinceFlag] : []),
        '-n',
        String(maxCommits),
        '--format=%H|%ai|%an|%s',
        '--',
        relativePath,
    ];

    const { stdout } = await execFileAsync(
        'git',
        args,
        {
            cwd,
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
    return commits;
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
 * Generate key path variations to try when searching.
 * Handles cases where key structure doesn't match file structure.
 */
function getKeyPathVariations(keyPath: string): string[] {
    const variations: string[] = [keyPath];
    const parts = keyPath.split('.').filter(Boolean);
    
    if (parts.length > 1) {
        variations.push(parts.slice(1).join('.'));
        if (parts.length > 2) {
            variations.push(parts.slice(2).join('.'));
        }
        variations.push(parts[parts.length - 1]);
        if (parts.length > 2) {
            variations.push(parts.slice(-2).join('.'));
        }
    }
    
    return variations;
}

/**
 * Find the most recent commit where a key existed in a locale file.
 * Tries multiple key path variations for better recovery rate.
 */
export async function findKeyInHistory(
    folder: vscode.WorkspaceFolder,
    localeFilePath: string,
    keyPath: string,
    daysBack: number = 90,
): Promise<{ commit: GitCommitInfo; value: string; keyVariant: string } | null> {
    const history = await getFileHistory(folder, localeFilePath, daysBack);
    const keyVariations = getKeyPathVariations(keyPath);
    const seenCommits = new Set<string>();

    // Priority 1: commits mentioning i18n/translate (and their immediate predecessors)
    const keywordIndices = history.commits
        .map((c, idx) => ({ c, idx }))
        .filter(({ c }) => /i18n|translat/i.test(c.message));

    const tryCommitContent = async (commit: GitCommitInfo): Promise<{ commit: GitCommitInfo; value: string; keyVariant: string } | null> => {
        if (seenCommits.has(commit.hash)) return null;
        seenCommits.add(commit.hash);

        const content = await getFileContentAtCommit(folder, localeFilePath, commit.hash);
        if (!content) return null;
        try {
            const json = JSON.parse(content);
            for (const keyVariant of keyVariations) {
                const value = getNestedValue(json, keyVariant);
                if (value && typeof value === 'string') {
                    return { commit, value, keyVariant };
                }
            }
        } catch {
            // ignore invalid JSON
        }
        return null;
    };

    for (const { c, idx } of keywordIndices) {
        const hit = await tryCommitContent(c);
        if (hit) return hit;
        const prev = history.commits[idx + 1];
        if (prev) {
            const prevHit = await tryCommitContent(prev);
            if (prevHit) return prevHit;
        }
    }

    for (const commit of history.commits) {
        const hit = await tryCommitContent(commit);
        if (hit) return hit;
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

