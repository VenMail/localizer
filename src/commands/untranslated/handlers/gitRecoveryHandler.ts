import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder } from 'util';
import { getFileContentAtCommit, getFileDiff, getFileHistory } from '../../../core/gitHistory';
import { CommitTracker } from '../../../core/commitTracker';
import {
    getNestedValue,
    getKeyPathVariations,
    extractAllUserTextFromContent,
    extractHardcodedStringFromLine,
    calculateTextRelevanceScore,
    extractHintWords,
    escapeRegExp,
} from '../utils';

export interface GitRecoveryOptions {
    daysBack?: number;
    maxCommits?: number;
    perDayCommitLimit?: number;
    extractRef?: { commitHash: string } | null;
    logPrefix?: string;
}

export interface RecoveryResult {
    value: string;
    source: string;
}

export class GitRecoveryHandler {
    private gitRecoveryCache = new Map<string, RecoveryResult>();

    constructor(
        private context?: vscode.ExtensionContext,
        private log?: vscode.OutputChannel,
    ) {}

    /**
     * Clear the recovery cache
     */
    clearCache(): void {
        this.gitRecoveryCache.clear();
    }

    /**
     * Get all locale files in a folder for a given locale
     */
    async getAllLocaleFilesInFolder(
        folder: vscode.WorkspaceFolder,
        locale: string,
    ): Promise<string[]> {
        const files: string[] = [];
        const basePaths = [
            path.join('resources', 'js', 'i18n', 'auto'),
            path.join('src', 'i18n'),
            path.join('src', 'locales'),
            'locales',
            'i18n',
        ];

        for (const basePath of basePaths) {
            const groupedDir = path.join(folder.uri.fsPath, basePath, locale);
            try {
                const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(groupedDir));
                for (const [name, type] of entries) {
                    if (type === vscode.FileType.File && name.endsWith('.json')) {
                        files.push(path.join(groupedDir, name));
                    }
                }
            } catch {
                // Directory doesn't exist
            }

            const singleFile = path.join(folder.uri.fsPath, basePath, `${locale}.json`);
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(singleFile));
                files.push(singleFile);
            } catch {
                // File doesn't exist
            }
        }

        return files;
    }

    /**
     * Get locale file URIs using the i18n index or fallback patterns
     */
    async getLocaleFileUris(
        folder: vscode.WorkspaceFolder,
        locale: string,
        i18nIndex: { getAllKeys(): string[]; getRecord(key: string): any; ensureInitialized(): Promise<void> },
    ): Promise<vscode.Uri[]> {
        await i18nIndex.ensureInitialized();
        const allKeys = i18nIndex.getAllKeys();
        const urisFromIndex = new Set<string>();

        for (const key of allKeys) {
            const record = i18nIndex.getRecord(key);
            if (!record) continue;
            for (const loc of record.locations) {
                if (loc.locale === locale) {
                    urisFromIndex.add(loc.uri.toString());
                }
            }
        }

        if (urisFromIndex.size > 0) {
            return Array.from(urisFromIndex).map(s => vscode.Uri.parse(s));
        }

        // Fallback: Try common directory patterns
        const uris: vscode.Uri[] = [];
        const basePaths = [
            ['resources', 'js', 'i18n', 'auto'],
            ['src', 'i18n'],
            ['src', 'locales'],
            ['locales'],
            ['i18n'],
        ];

        for (const basePath of basePaths) {
            const localeDir = vscode.Uri.joinPath(folder.uri, ...basePath, locale);
            try {
                const entries = await vscode.workspace.fs.readDirectory(localeDir);
                for (const [name, type] of entries) {
                    if (type === vscode.FileType.File && name.endsWith('.json')) {
                        uris.push(vscode.Uri.joinPath(localeDir, name));
                    }
                }
                if (uris.length > 0) break;
            } catch {
                const singleFile = vscode.Uri.joinPath(folder.uri, ...basePath, `${locale}.json`);
                try {
                    await vscode.workspace.fs.stat(singleFile);
                    uris.push(singleFile);
                    break;
                } catch {
                    // Continue
                }
            }
        }

        return uris;
    }

    /**
     * Enhanced git recovery for missing keys
     */
    async recoverKeyFromGit(
        folder: vscode.WorkspaceFolder,
        localeUris: vscode.Uri[],
        key: string,
        locale: string,
        options?: GitRecoveryOptions,
    ): Promise<RecoveryResult | null> {
        const daysBack = options?.daysBack ?? 90;
        const maxCommits = options?.maxCommits ?? 100;
        const extractRef = options?.extractRef ?? null;
        const logPrefix = options?.logPrefix ?? '[GitRecovery]';

        const cacheKey = `${folder.uri.fsPath}::${locale}::${key}`;
        const cached = this.gitRecoveryCache.get(cacheKey);
        if (cached) {
            this.log?.appendLine(`${logPrefix} Cache hit for ${key}`);
            return cached;
        }

        const allLocaleFiles = await this.getAllLocaleFilesInFolder(folder, locale);
        const localeFilePaths = [
            ...localeUris.map(u => u.fsPath),
            ...allLocaleFiles,
        ];
        const uniqueFilePaths = [...new Set(localeFilePaths.map(p => p.toLowerCase()))];
        const normalizedPaths = uniqueFilePaths.map(p =>
            localeFilePaths.find(original => original.toLowerCase() === p) || p
        );

        this.log?.appendLine(`${logPrefix} Searching ${normalizedPaths.length} file(s) for key "${key}"`);

        const keyVariations = getKeyPathVariations(key);
        this.log?.appendLine(`${logPrefix} Key variations: ${keyVariations.join(', ')}`);

        // 1. First, try the extractRef commit
        if (extractRef) {
            this.log?.appendLine(`${logPrefix} Checking extract ref commit: ${extractRef.commitHash}`);
            for (const filePath of normalizedPaths) {
                try {
                    const content = await getFileContentAtCommit(folder, filePath, extractRef.commitHash);
                    if (content) {
                        const json = JSON.parse(content);
                        for (const keyVariant of keyVariations) {
                            const value = getNestedValue(json, keyVariant);
                            if (value && typeof value === 'string') {
                                const result = { value, source: `ref:${extractRef.commitHash}` };
                                this.gitRecoveryCache.set(cacheKey, result);
                                this.log?.appendLine(`${logPrefix} Found in extract ref: ${keyVariant} = "${value.slice(0, 50)}..."`);
                                return result;
                            }
                        }
                    }
                } catch {
                    // Continue
                }
            }
        }

        // 2. Search git history for each file
        const commitJsonCache = new Map<string, any>();
        let totalCommitsChecked = 0;

        for (const filePath of normalizedPaths) {
            if (totalCommitsChecked >= maxCommits) break;

            try {
                const history = await getFileHistory(folder, filePath, daysBack, maxCommits);
                this.log?.appendLine(`${logPrefix} Found ${history.commits.length} commits for ${path.basename(filePath)}`);

                for (const commit of history.commits) {
                    if (totalCommitsChecked >= maxCommits) break;
                    totalCommitsChecked++;

                    const cacheKeyJson = `${filePath}:${commit.hash}`;
                    let json = commitJsonCache.get(cacheKeyJson);

                    if (!json) {
                        try {
                            const content = await getFileContentAtCommit(folder, filePath, commit.hash);
                            if (content) {
                                json = JSON.parse(content);
                                commitJsonCache.set(cacheKeyJson, json);
                            }
                        } catch {
                            continue;
                        }
                    }

                    if (!json) continue;

                    for (const keyVariant of keyVariations) {
                        const value = getNestedValue(json, keyVariant);
                        if (value && typeof value === 'string') {
                            const result = { value, source: `history:${commit.hash}` };
                            this.gitRecoveryCache.set(cacheKey, result);
                            this.log?.appendLine(
                                `${logPrefix} Found in history (${commit.hash.slice(0, 7)}): ${keyVariant} = "${value.slice(0, 50)}..."`
                            );
                            return result;
                        }
                    }
                }
            } catch (err) {
                this.log?.appendLine(`${logPrefix} History fetch failed for ${filePath}: ${String(err)}`);
            }
        }

        // 3. Search in HEAD for all possible files
        this.log?.appendLine(`${logPrefix} Searching current HEAD for key in any locale file`);
        for (const filePath of normalizedPaths) {
            try {
                const content = await getFileContentAtCommit(folder, filePath, 'HEAD');
                if (content) {
                    const json = JSON.parse(content);
                    for (const keyVariant of keyVariations) {
                        const value = getNestedValue(json, keyVariant);
                        if (value && typeof value === 'string') {
                            const result = { value, source: 'head' };
                            this.gitRecoveryCache.set(cacheKey, result);
                            this.log?.appendLine(`${logPrefix} Found in HEAD: ${keyVariant} = "${value.slice(0, 50)}..."`);
                            return result;
                        }
                    }
                }
            } catch {
                // Continue
            }
        }

        // 4. BACKUP: Search source files for original hardcoded text
        this.log?.appendLine(`${logPrefix} Trying backup strategy: searching source file git history`);
        const sourceResult = await this.recoverFromSourceFileHistory(folder, key, daysBack, logPrefix);
        if (sourceResult) {
            this.gitRecoveryCache.set(cacheKey, sourceResult);
            return sourceResult;
        }

        this.log?.appendLine(`${logPrefix} Key "${key}" not found in any git history (checked ${totalCommitsChecked} locale commits)`);
        return null;
    }

    /**
     * Recover original text from source file git history
     */
    private async recoverFromSourceFileHistory(
        folder: vscode.WorkspaceFolder,
        key: string,
        daysBack: number,
        logPrefix: string,
    ): Promise<RecoveryResult | null> {
        const sourceFiles = await this.findSourceFilesWithKey(folder, key);
        if (sourceFiles.length === 0) {
            this.log?.appendLine(`${logPrefix} No source files found referencing key "${key}"`);
            return null;
        }

        this.log?.appendLine(`${logPrefix} Found ${sourceFiles.length} source file(s) referencing "${key}"`);

        for (const sourceFile of sourceFiles) {
            try {
                const result = await this.extractOriginalTextFromSourceHistory(
                    folder,
                    sourceFile,
                    key,
                    daysBack,
                    logPrefix,
                );
                if (result) return result;
            } catch (err) {
                this.log?.appendLine(`${logPrefix} Error searching ${sourceFile}: ${String(err)}`);
            }
        }

        return null;
    }

    /**
     * Find source files that contain t('key') or $t('key')
     */
    private async findSourceFilesWithKey(
        folder: vscode.WorkspaceFolder,
        key: string,
    ): Promise<string[]> {
        const files: string[] = [];
        const searchPatterns = [
            `t('${key}'`,
            `t("${key}"`,
            `$t('${key}'`,
            `$t("${key}"`,
        ];

        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const sourceGlobs = cfg.get<string[]>('i18n.sourceGlobs') || ['**/*.{ts,tsx,js,jsx,vue}'];
        const excludeGlobs = cfg.get<string[]>('i18n.sourceExcludeGlobs') || [
            '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
        ];

        const include = sourceGlobs.length === 1 ? sourceGlobs[0] : `{${sourceGlobs.join(',')}}`;
        const exclude = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;

        const pattern = new vscode.RelativePattern(folder, include);
        const uris = await vscode.workspace.findFiles(pattern, exclude, 500);

        for (const uri of uris) {
            try {
                const data = await vscode.workspace.fs.readFile(uri);
                const content = new TextDecoder().decode(data);

                for (const searchPattern of searchPatterns) {
                    if (content.includes(searchPattern)) {
                        files.push(uri.fsPath);
                        break;
                    }
                }
            } catch {
                // Skip files that can't be read
            }
        }

        return files;
    }

    /**
     * Extract original hardcoded text from source file git history
     */
    private async extractOriginalTextFromSourceHistory(
        folder: vscode.WorkspaceFolder,
        sourceFilePath: string,
        key: string,
        daysBack: number,
        logPrefix: string,
    ): Promise<RecoveryResult | null> {
        const relPath = path.relative(folder.uri.fsPath, sourceFilePath);

        let currentContent: string;
        try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFilePath));
            currentContent = new TextDecoder().decode(data);
        } catch {
            return null;
        }

        const tCallPatterns = [
            new RegExp(`\\bt\\(\\s*['"]${escapeRegExp(key)}['"]`, 'g'),
            new RegExp(`\\$t\\(\\s*['"]${escapeRegExp(key)}['"]`, 'g'),
        ];

        const history = await getFileHistory(folder, sourceFilePath, daysBack, 50);
        if (history.commits.length === 0) return null;

        this.log?.appendLine(`${logPrefix} Searching ${history.commits.length} commits in ${relPath}`);

        // STRATEGY 1: Find commit that introduced t('key') and analyze diff
        const diffResult = await this.findOriginalTextFromDiff(folder, sourceFilePath, key, history, logPrefix);
        if (diffResult) return diffResult;

        // STRATEGY 2: Find a commit without t('key')
        const hintWords = extractHintWords(key);

        for (const commit of history.commits) {
            const oldContent = await getFileContentAtCommit(folder, sourceFilePath, commit.hash);
            if (!oldContent) continue;

            let hasTCall = false;
            for (const pattern of tCallPatterns) {
                pattern.lastIndex = 0;
                if (pattern.test(oldContent)) {
                    hasTCall = true;
                    break;
                }
            }

            if (!hasTCall) {
                this.log?.appendLine(`${logPrefix} Commit ${commit.hash.slice(0, 7)} doesn't have t('${key}') - searching for matching text`);

                const candidates = extractAllUserTextFromContent(oldContent, hintWords);

                if (candidates.length > 0) {
                    candidates.sort((a, b) => b.score - a.score);
                    const best = candidates[0];

                    if (best.score >= 5) {
                        this.log?.appendLine(
                            `${logPrefix} Found matching text (score=${best.score}) in ${relPath} @ ${commit.hash.slice(0, 7)}: "${best.text.slice(0, 50)}..."`
                        );
                        return {
                            value: best.text,
                            source: `source:${commit.hash}:${relPath}`,
                        };
                    }
                }
            }
        }

        return null;
    }

    /**
     * Find original text by analyzing the diff that introduced the t() call
     */
    private async findOriginalTextFromDiff(
        folder: vscode.WorkspaceFolder,
        sourceFilePath: string,
        key: string,
        history: { commits: Array<{ hash: string; date: Date; message: string; author: string }> },
        logPrefix: string,
    ): Promise<RecoveryResult | null> {
        const tCallPattern = new RegExp(`\\b\\$?t\\(\\s*['"]${escapeRegExp(key)}['"]`);

        let commitWithTCall: string | null = null;
        let commitWithoutTCall: string | null = null;

        for (let i = 0; i < history.commits.length; i++) {
            const commit = history.commits[i];
            const content = await getFileContentAtCommit(folder, sourceFilePath, commit.hash);
            if (!content) continue;

            if (tCallPattern.test(content)) {
                commitWithTCall = commit.hash;
                if (i + 1 < history.commits.length) {
                    commitWithoutTCall = history.commits[i + 1].hash;
                }
            } else if (commitWithTCall) {
                commitWithoutTCall = commit.hash;
                break;
            }
        }

        if (!commitWithTCall || !commitWithoutTCall) return null;

        this.log?.appendLine(
            `${logPrefix} Found t('${key}') introduced between ${commitWithoutTCall.slice(0, 7)} and ${commitWithTCall.slice(0, 7)}`
        );

        const diff = await getFileDiff(folder, sourceFilePath, commitWithoutTCall, commitWithTCall);
        if (!diff) return null;

        const diffLines = diff.split('\n');
        const hintWords = extractHintWords(key);

        const hunkRemovedTexts: Array<{ text: string; score: number }> = [];
        let currentHunkRemoved: string[] = [];
        let currentHunkAdded: string[] = [];

        for (const line of diffLines) {
            if (line.startsWith('@@')) {
                if (currentHunkAdded.some(l => tCallPattern.test(l))) {
                    for (const removed of currentHunkRemoved) {
                        const texts = extractAllUserTextFromContent(removed, hintWords);
                        hunkRemovedTexts.push(...texts);
                    }
                }
                currentHunkRemoved = [];
                currentHunkAdded = [];
                continue;
            }

            if (line.startsWith('-') && !line.startsWith('---')) {
                currentHunkRemoved.push(line.slice(1));
            } else if (line.startsWith('+') && !line.startsWith('+++')) {
                currentHunkAdded.push(line.slice(1));
            }
        }

        // Process last hunk
        if (currentHunkAdded.some(l => tCallPattern.test(l))) {
            for (const removed of currentHunkRemoved) {
                const texts = extractAllUserTextFromContent(removed, hintWords);
                hunkRemovedTexts.push(...texts);
            }
        }

        // Also try extracting from individual removed lines
        for (const line of diffLines) {
            if (line.startsWith('-') && !line.startsWith('---')) {
                const extracted = extractHardcodedStringFromLine(line.slice(1), key);
                if (extracted) {
                    const score = calculateTextRelevanceScore(extracted, hintWords);
                    hunkRemovedTexts.push({ text: extracted, score: score + 5 });
                }
            }
        }

        if (hunkRemovedTexts.length > 0) {
            hunkRemovedTexts.sort((a, b) => b.score - a.score);
            const best = hunkRemovedTexts[0];

            if (best.score >= 3) {
                this.log?.appendLine(
                    `${logPrefix} Found original text from diff (score=${best.score}): "${best.text.slice(0, 50)}..."`
                );
                return {
                    value: best.text,
                    source: `diff:${commitWithoutTCall}..${commitWithTCall}`,
                };
            }
        }

        return null;
    }

    /**
     * Get extract ref from commit tracker
     */
    getExtractCommitRef(folder: vscode.WorkspaceFolder): { commitHash: string } | null {
        if (!this.context) return null;
        return CommitTracker.getExtractCommitRef(this.context, folder);
    }
}

