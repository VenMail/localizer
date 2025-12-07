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
    private sourceContentCache = new Map<string, string>();

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
        const daysBack = options?.daysBack ?? 365;
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
        let foundSuspiciousValue = false; // Track if we found suspicious values

        for (const filePath of normalizedPaths) {
            if (totalCommitsChecked >= maxCommits || foundSuspiciousValue) break;

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
                            // Quality check: if the value looks like a badly extracted placeholder
                            // (e.g., "Value1 allowed value2 sent" instead of "{value1} allowed {value2} sent"),
                            // skip locale history entirely and go straight to source history
                            const isSuspicious = this.hasSuspiciousPlaceholderPattern(value);
                            
                            if (isSuspicious) {
                                this.log?.appendLine(
                                    `${logPrefix} ⚠️  Found suspicious value in history (${commit.hash.slice(0, 7)}): "${value.slice(0, 50)}..." - will skip locale history and try source history instead`
                                );
                                console.log(`[GitRecovery] SUSPICIOUS VALUE DETECTED: "${value}"`);
                                foundSuspiciousValue = true;
                                break;
                            }
                            
                            this.log?.appendLine(
                                `${logPrefix} ✓ Found clean value in history (${commit.hash.slice(0, 7)}): ${keyVariant} = "${value.slice(0, 50)}..."`
                            );
                            const result = { value, source: `locale-history:${path.basename(filePath)}@${commit.hash.slice(0, 7)}` };
                            this.gitRecoveryCache.set(cacheKey, result);
                            return result;
                        }
                    }
                    
                    if (foundSuspiciousValue) break;
                }
            } catch (err) {
                this.log?.appendLine(`${logPrefix} History fetch failed for ${filePath}: ${String(err)}`);
            }
        }

        // 3. Search in HEAD for all possible files (skip if we found suspicious locale values)
        if (!foundSuspiciousValue) {
            this.log?.appendLine(`${logPrefix} Searching current HEAD for key in any locale file`);
            for (const filePath of normalizedPaths) {
                try {
                    const content = await getFileContentAtCommit(folder, filePath, 'HEAD');
                    if (content) {
                        const json = JSON.parse(content);
                        for (const keyVariant of keyVariations) {
                            const value = getNestedValue(json, keyVariant);
                            if (value && typeof value === 'string') {
                                // Quality check: skip suspicious placeholder patterns
                                if (this.hasSuspiciousPlaceholderPattern(value)) {
                                    this.log?.appendLine(
                                        `${logPrefix} Found suspicious value in HEAD: "${value.slice(0, 50)}..." - will try source history instead`
                                    );
                                    foundSuspiciousValue = true;
                                    break;
                                }
                                
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
        } else {
            this.log?.appendLine(`${logPrefix} Skipping HEAD search due to suspicious locale values`);
        }

        // 4. BACKUP: Search source files for original hardcoded text
        this.log?.appendLine(`${logPrefix} Trying backup strategy: searching source file git history`);
        const sourceResult = await this.searchAllSourceFilesForKey(folder, key, locale, daysBack, logPrefix);
        if (sourceResult) {
            this.gitRecoveryCache.set(cacheKey, sourceResult);
            return sourceResult;
        }

        this.log?.appendLine(`${logPrefix} Key "${key}" not found in any git history (checked ${totalCommitsChecked} locale commits)`);
        return null;
    }

    /**
     * Recover original text from a specific source file's git history
     * @param folder Workspace folder
     * @param sourceFilePath Path to the source file containing the key
     * @param key Translation key to recover
     * @param locale Locale to recover (for placeholder hints)
     * @param daysBack Number of days to search back
     * @param logPrefix Log prefix for output
     */
    async recoverFromSourceFileHistory(
        folder: vscode.WorkspaceFolder,
        sourceFilePath: string,
        key: string,
        locale: string,
        daysBack: number,
        logPrefix: string,
    ): Promise<RecoveryResult | null> {
        try {
            const result = await this.extractOriginalTextFromSourceHistory(
                folder,
                sourceFilePath,
                key,
                daysBack,
                logPrefix,
            );
            return result;
        } catch (err) {
            this.log?.appendLine(`${logPrefix} Error searching ${sourceFilePath}: ${String(err)}`);
            return null;
        }
    }

    /**
     * Search all source files for a key and recover from git history
     */
    private async searchAllSourceFilesForKey(
        folder: vscode.WorkspaceFolder,
        key: string,
        locale: string,
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
        const hintWords = extractHintWords(key);
        const placeholderHints = this.extractPlaceholderHints(sourceFilePath, key);

        let currentContent: string;
        try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFilePath));
            currentContent = new TextDecoder().decode(data);
            this.sourceContentCache.set(sourceFilePath, currentContent);
        } catch {
            return null;
        }

        const tCallPatterns = [
            new RegExp(`\\bt\\(\\s*['"]${escapeRegExp(key)}['"]`, 'g'),
            new RegExp(`\\$t\\(\\s*['"]${escapeRegExp(key)}['"]`, 'g'),
        ];

        // Cap search window to 90 days for performance
        const effectiveDaysBack = Math.min(daysBack, 365);
        const history = await getFileHistory(folder, sourceFilePath, effectiveDaysBack, 50);
        if (history.commits.length === 0) return null;

        this.log?.appendLine(`${logPrefix} Searching ${history.commits.length} commits in ${relPath}`);

        // Strategy 0: prioritize commits mentioning i18n/translate and check their diffs first
        const keywordCommits: Array<{ current: string; previous: string }> = [];
        let firstKeywordIdx = -1;
        for (let i = 0; i < history.commits.length; i++) {
            const commit = history.commits[i];
            if (/i18n|translat|lang|locale|intl/i.test(commit.message)) {
                if (firstKeywordIdx === -1) firstKeywordIdx = i;
                const prev = history.commits[i + 1]?.hash;
                if (prev) {
                    keywordCommits.push({ current: commit.hash, previous: prev });
                }
            }
        }

        const extractFromDiffLines = async (fromCommit: string, toCommit: string): Promise<RecoveryResult | null> => {
            const diff = await getFileDiff(folder, sourceFilePath, fromCommit, toCommit);
            if (!diff) return null;
            const diffLines = diff.split('\n');
            const removedLines: string[] = [];
            const addedLines: string[] = [];
            for (const line of diffLines) {
                if (line.startsWith('-') && !line.startsWith('---')) {
                    removedLines.push(line.slice(1));
                } else if (line.startsWith('+') && !line.startsWith('+++')) {
                    addedLines.push(line.slice(1));
                }
            }

            const candidates: Array<{ text: string; score: number }> = [];
            const addedHasTCall = addedLines.some((l) => /\bt\(\s*['"]/.test(l) || /\$t\(\s*['"]/.test(l));
            const placeholderPattern = /\{[a-zA-Z_][a-zA-Z0-9_]*\}/g;
            const looksLikeKey = (txt: string) => txt.includes('.') && !/\s/.test(txt);

            // First, extract from individual lines
            for (const line of removedLines) {
                const texts = extractAllUserTextFromContent(line, hintWords);
                for (const t of texts) {
                    const lower = t.text.toLowerCase();
                    const hintMatches = hintWords.filter(h => lower.includes(h)).length;
                    const phMatches = placeholderHints.filter(p => lower.includes(p)).length;
                    if (looksLikeKey(t.text)) continue;
                    if (hintMatches === 0 && phMatches === 0) continue;
                    let score = t.score;
                    for (const ph of placeholderHints) {
                        if (t.text.toLowerCase().includes(ph)) score += 3;
                    }
                    const placeholders = (t.text.match(placeholderPattern) || []).length;
                    if (placeholders > 0) score += 2;
                    if (addedHasTCall) score += 3;
                    candidates.push({ text: t.text, score });
                }
            }

            // CRITICAL: Also extract from joined lines (handles multi-line template literals)
            if (removedLines.length > 1) {
                const joinedRemoved = removedLines.join('\n');
                const joinedTexts = extractAllUserTextFromContent(joinedRemoved, hintWords);
                
                for (const t of joinedTexts) {
                    const lower = t.text.toLowerCase();
                    const hintMatches = hintWords.filter(h => lower.includes(h)).length;
                    const phMatches = placeholderHints.filter(p => lower.includes(p)).length;
                    if (looksLikeKey(t.text)) continue;
                    if (hintMatches === 0 && phMatches === 0) continue;
                    let score = t.score;
                    for (const ph of placeholderHints) {
                        if (t.text.toLowerCase().includes(ph)) score += 3;
                    }
                    const placeholders = (t.text.match(placeholderPattern) || []).length;
                    if (placeholders > 0) score += 2;
                    if (addedHasTCall) score += 3;
                    candidates.push({ text: t.text, score });
                }
            }

            if (!candidates.length) return null;
            candidates.sort((a, b) => b.score - a.score);
            const best = candidates.find(c => this.isAcceptableCandidate(c.text, hintWords, placeholderHints));
            if (best && best.score >= 5) {
                return {
                    value: best.text,
                    source: `diff:${fromCommit.slice(0, 7)}..${toCommit.slice(0, 7)}`,
                };
            }
            return null;
        };

        for (const pair of keywordCommits) {
            const result = await extractFromDiffLines(pair.previous, pair.current);
            if (result) {
                this.log?.appendLine(`${logPrefix} Recovered from keyword commit ${pair.current.slice(0, 7)}`);
                return result;
            }
        }

        // STRATEGY 1: Find commit that introduced t('key') and analyze diff
        const diffResult = await this.findOriginalTextFromDiff(folder, sourceFilePath, key, history, logPrefix, placeholderHints);
        if (diffResult) return diffResult;

        // STRATEGY 2: Find a commit without t('key')
        const orderedCommits =
            firstKeywordIdx > -1 ? history.commits.slice(firstKeywordIdx) : history.commits;

        let bestCandidate: { value: string; source: string; score: number } | null = null;
        for (const commit of orderedCommits) {
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
                    const best = candidates.find(c => this.isAcceptableCandidate(c.text, hintWords, placeholderHints));

                    if (best && best.score >= 6) {
                        if (!bestCandidate || best.score > bestCandidate.score) {
                            bestCandidate = {
                                value: best.text,
                                source: `source:${commit.hash}:${relPath}`,
                                score: best.score,
                            };
                        }
                    }
                }
            }
        }

        if (bestCandidate) {
            this.log?.appendLine(
                `${logPrefix} Found matching text (score=${bestCandidate.score}) in ${relPath} @ ${bestCandidate.source.split(':')[1]?.slice(0, 7)}`
            );
            return { value: bestCandidate.value, source: bestCandidate.source };
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
        placeholderHints: string[],
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
                        hunkRemovedTexts.push(
                            ...texts.filter(t => this.hasSignal(t.text, hintWords, placeholderHints) && !this.isKeyLike(t.text))
                        );
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
                hunkRemovedTexts.push(
                    ...texts.filter(t => this.hasSignal(t.text, hintWords, placeholderHints) && !this.isKeyLike(t.text))
                );
            }
        }

        // Also try extracting from individual removed lines
        for (const line of diffLines) {
            if (line.startsWith('-') && !line.startsWith('---')) {
                const extracted = extractHardcodedStringFromLine(line.slice(1), key);
                if (extracted) {
                    if (this.hasSignal(extracted, hintWords, placeholderHints) && !this.isKeyLike(extracted)) {
                        const score = calculateTextRelevanceScore(extracted, hintWords);
                        hunkRemovedTexts.push({ text: extracted, score: score + 5 });
                    }
                }
            }
        }

        if (hunkRemovedTexts.length > 0) {
            hunkRemovedTexts.sort((a, b) => b.score - a.score);
            const best = hunkRemovedTexts.find(t => this.isAcceptableCandidate(t.text, hintWords, placeholderHints));

            if (best && best.score >= 3) {
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
     * Extract placeholder names from current source usage of the key for better matching.
     */
    private extractPlaceholderHints(sourceFilePath: string, key: string): string[] {
        const loadAndCache = async (): Promise<string> => {
            try {
                const data = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFilePath));
                const decoded = new TextDecoder().decode(data);
                this.sourceContentCache.set(sourceFilePath, decoded);
                return decoded;
            } catch {
                return '';
            }
        };

        const content = this.sourceContentCache.get(sourceFilePath);
        if (!content) {
            // Best-effort synchronous return when not cached: return empty to avoid async ripple
            // and schedule cache fill for future calls.
            void loadAndCache();
            return [];
        }

        const placeholders = new Set<string>();
        const pattern = new RegExp(`\\bt\\(\\s*['"]${escapeRegExp(key)}['"]\\s*,\\s*\\{([^}]+)\\}`, 'g');
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const obj = match[1];
            const props = obj.split(/[:,]/).map((p) => p.trim());
            for (const p of props) {
                if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p)) {
                    placeholders.add(p.toLowerCase());
                }
            }
        }
        return Array.from(placeholders);
    }

    private isKeyLike(text: string): boolean {
        return text.includes('.') && !/\s/.test(text);
    }

    /**
     * Check if a value looks like a badly extracted placeholder pattern.
     * Examples of suspicious patterns:
     * - "Value1 allowed value2 sent" (should be "{value1} allowed {value2} sent")
     * - "Total value1 items" (should be "Total {value1} items")
     * - "Found total domains" (missing placeholders entirely)
     */
    private hasSuspiciousPlaceholderPattern(value: string): boolean {
        // Pattern 1: Contains "value1", "value2", etc. WITHOUT braces
        // This indicates placeholder names were extracted but not properly wrapped
        // First, remove all valid {placeholder} patterns from the text
        const withoutValidPlaceholders = value.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, '');
        
        // Now check if "value1", "value2", etc. appear in the remaining text (not in braces)
        if (/\b[Vv]alue\d+\b/.test(withoutValidPlaceholders)) {
            return true;
        }

        // Pattern 2: Contains common placeholder variable names in PascalCase or camelCase without braces
        // e.g., "Total Count items" instead of "Total {count} items"
        const commonPlaceholders = /\b(Count|Total|Name|Value|Item|User|Email|Date|Time|Status|Type|Id)\b/;
        const hasCommonPlaceholder = commonPlaceholders.test(value);
        
        // If it has a common placeholder word AND the key suggests it should have interpolation
        // (e.g., key contains "value1", "count", "total"), it's suspicious
        if (hasCommonPlaceholder) {
            // Additional check: if the value has multiple capital words in sequence, it's likely mangled
            // e.g., "Value1 Allowed Value2 Sent"
            if (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(value)) {
                return true;
            }
        }

        // Pattern 3: Key name suggests placeholders but value has none
        // This is less reliable, so we'll skip for now to avoid false positives

        return false;
    }

    private hasSignal(text: string, hintWords: string[], placeholderHints: string[]): boolean {
        const lower = text.toLowerCase();
        const hasHint = hintWords.some(h => lower.includes(h));
        const hasPlaceholder = placeholderHints.some(p => lower.includes(p));
        return hasHint || hasPlaceholder;
    }

    private isAcceptableCandidate(text: string, hintWords: string[], placeholderHints: string[]): boolean {
        const trimmed = text.trim();
        if (!trimmed) return false;
        if (trimmed.length > 160) return false;
        if (trimmed.includes('\n')) return false;
        if (this.isKeyLike(trimmed)) return false;
        if (!(/\s/.test(trimmed) || /\{[a-zA-Z_]/.test(trimmed))) return false;
        if (!this.hasSignal(trimmed, hintWords, placeholderHints)) return false;
        return this.meetsHintThreshold(trimmed, hintWords, placeholderHints);
    }

    private meetsHintThreshold(text: string, hintWords: string[], placeholderHints: string[]): boolean {
        const lower = text.toLowerCase();
        const hintMatches = hintWords.filter(h => lower.includes(h)).length;
        const placeholderMatches = placeholderHints.filter(p => lower.includes(p)).length;
        
        // CRITICAL: Also count ANY placeholders in the text (even if they don't match hint names)
        // This handles cases where placeholder names differ between git history and current code
        const anyPlaceholders = (text.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) || []).length;
        
        const target = hintWords.length >= 3 ? Math.ceil(hintWords.length * 0.6) : 1;
        if (hintMatches >= target) return true;
        
        // Be lenient: if we have ANY placeholders and match most hint words, accept it
        if (hintMatches >= target - 1 && (placeholderMatches > 0 || anyPlaceholders > 0) && hintWords.length >= 2) {
            return true;
        }
        
        return false;
    }

    /**
     * Get extract ref from commit tracker
     */
    getExtractCommitRef(folder: vscode.WorkspaceFolder): { commitHash: string } | null {
        if (!this.context) return null;
        return CommitTracker.getExtractCommitRef(this.context, folder);
    }
}

