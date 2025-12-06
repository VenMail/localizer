import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder } from 'util';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { LocaleCache, getLocaleCache } from '../utils/localeCache';
import {
    getKeyPathVariations,
    extractAllUserTextFromContent,
    extractHardcodedStringFromLine,
    calculateTextRelevanceScore,
    extractHintWords,
    escapeRegExp,
} from '../utils';
import { CommitTracker } from '../../../core/commitTracker';

const execFileAsync = promisify(execFile);
const sharedDecoder = new TextDecoder('utf-8');

const GIT_TIMEOUT_MS = 30000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const PARALLEL_BATCH_SIZE = 5;

export interface BatchRecoveryResult {
    key: string;
    value: string | null;
    source: string;
    error?: string;
}

export interface BatchRecoveryOptions {
    daysBack?: number;
    maxCommitsPerFile?: number;
    extractRef?: { commitHash: string } | null;
}

/**
 * High-performance batch recovery handler for bulk fixing missing translations.
 * Uses pre-loaded caches and parallel processing for maximum speed.
 */
export class BatchRecoveryHandler {
    private recoveryCache = new Map<string, { value: string; source: string }>();
    private sourceContentCache = new Map<string, string>();
    private diffCache = new Map<string, string>();

    constructor(
        private context?: vscode.ExtensionContext,
        private log?: vscode.OutputChannel,
    ) {}

    /**
     * Recover multiple keys in parallel using cached data
     */
    async recoverKeysBatch(
        folder: vscode.WorkspaceFolder,
        keys: string[],
        locale: string,
        options?: BatchRecoveryOptions,
    ): Promise<Map<string, BatchRecoveryResult>> {
        const results = new Map<string, BatchRecoveryResult>();
        const extractRef = options?.extractRef ?? null;
        const maxCommitsPerFile = options?.maxCommitsPerFile ?? 15;
        const daysBack = options?.daysBack ?? 120; // Increased from 90

        // Initialize cache (respect daysBack for git history window)
        const cache = getLocaleCache(folder, this.log);
        await cache.initialize(locale, daysBack);

        this.log?.appendLine(`[BatchRecovery] Starting batch recovery for ${keys.length} keys`);
        const startTime = Date.now();

        // PHASE 1: Check recovery cache for already-found keys
        const uncachedKeys: string[] = [];
        for (const key of keys) {
            const cacheKey = `${folder.uri.fsPath}::${locale}::${key}`;
            const cached = this.recoveryCache.get(cacheKey);
            if (cached) {
                results.set(key, { key, value: cached.value, source: cached.source });
            } else {
                uncachedKeys.push(key);
            }
        }
        
        if (uncachedKeys.length === 0) {
            this.log?.appendLine(`[BatchRecovery] All ${keys.length} keys found in cache`);
            return results;
        }
        
        this.log?.appendLine(`[BatchRecovery] ${results.size} cache hits, ${uncachedKeys.length} to search`);

        // PHASE 2: Try extractRef commit first (if available)
        if (extractRef) {
            await this.searchExtractRefBatch(folder, cache, uncachedKeys, locale, extractRef.commitHash, results);
        }

        // Filter out found keys
        let stillMissing = uncachedKeys.filter(k => !results.has(k));
        
        if (stillMissing.length === 0) {
            this.logCompletion(startTime, keys.length, results.size);
            return results;
        }

        // PHASE 3: Search HEAD content for target locale (fastest)
        this.searchHeadContentBatch(cache, stillMissing, locale, results);

        // Filter out found keys
        stillMissing = stillMissing.filter(k => !results.has(k));
        
        if (stillMissing.length === 0) {
            this.logCompletion(startTime, keys.length, results.size);
            return results;
        }

        // PHASE 3.5: Search HEAD content for ALL locales (key might exist in another locale)
        this.searchAllLocalesHeadContent(cache, stillMissing, results);
        stillMissing = stillMissing.filter(k => !results.has(k));

        if (stillMissing.length === 0) {
            this.logCompletion(startTime, keys.length, results.size);
            return results;
        }

        // PHASE 4: Search git history for target locale (batched)
        await this.searchGitHistoryBatch(folder, cache, stillMissing, locale, maxCommitsPerFile, results);

        // Filter out found keys
        stillMissing = stillMissing.filter(k => !results.has(k));

        if (stillMissing.length === 0) {
            this.logCompletion(startTime, keys.length, results.size);
            return results;
        }

        // PHASE 4.5: Search git history for ALL locales
        await this.searchAllLocalesGitHistory(folder, cache, stillMissing, locale, maxCommitsPerFile, results);
        stillMissing = stillMissing.filter(k => !results.has(k));

        if (stillMissing.length === 0) {
            this.logCompletion(startTime, keys.length, results.size);
            return results;
        }

        // PHASE 5: Search source file git history (backup strategy)
        await this.searchSourceFilesParallel(folder, cache, stillMissing, locale, daysBack, results);

        this.logCompletion(startTime, keys.length, results.size);
        return results;
    }

    /**
     * Search extractRef commit for all keys at once
     */
    private async searchExtractRefBatch(
        folder: vscode.WorkspaceFolder,
        cache: LocaleCache,
        keys: string[],
        locale: string,
        commitHash: string,
        results: Map<string, BatchRecoveryResult>,
    ): Promise<void> {
        this.log?.appendLine(`[BatchRecovery] Checking extract ref commit: ${commitHash}`);
        
        const localeFiles = cache.getLocaleFiles(locale);
        
        // Build all key variations upfront
        const keyVariationsMap = new Map<string, string[]>();
        for (const key of keys) {
            keyVariationsMap.set(key, getKeyPathVariations(key));
        }

        // Check each locale file
        for (const file of localeFiles) {
            const json = await cache.getContentAtCommit(file.path, commitHash);
            if (!json) continue;

            // Search all keys in this file
            for (const key of keys) {
                if (results.has(key)) continue;
                
                const variations = keyVariationsMap.get(key)!;
                for (const keyVariant of variations) {
                    const value = this.getNestedValue(json, keyVariant);
                    if (value && typeof value === 'string') {
                        const cacheKey = `${folder.uri.fsPath}::${locale}::${key}`;
                        const result = { value, source: `ref:${commitHash}` };
                        this.recoveryCache.set(cacheKey, result);
                        results.set(key, { key, value, source: result.source });
                        break;
                    }
                }
            }
        }
    }

    /**
     * Search HEAD content for all keys at once
     */
    private searchHeadContentBatch(
        cache: LocaleCache,
        keys: string[],
        locale: string,
        results: Map<string, BatchRecoveryResult>,
    ): void {
        this.log?.appendLine(`[BatchRecovery] Searching HEAD content for ${keys.length} keys in ${locale}`);
        
        const localeFiles = cache.getLocaleFiles(locale);
        
        for (const key of keys) {
            if (results.has(key)) continue;
            
            const variations = getKeyPathVariations(key);
            
            for (const file of localeFiles) {
                const content = cache.getHeadContent(file.path);
                if (!content) continue;

                for (const keyVariant of variations) {
                    const value = this.getNestedValue(content.json, keyVariant);
                    if (value && typeof value === 'string') {
                        results.set(key, { key, value, source: 'head' });
                        break;
                    }
                }
                
                if (results.has(key)) break;
            }
        }
    }

    /**
     * Search HEAD content across ALL locales (key might exist in another locale)
     */
    private searchAllLocalesHeadContent(
        cache: LocaleCache,
        keys: string[],
        results: Map<string, BatchRecoveryResult>,
    ): void {
        this.log?.appendLine(`[BatchRecovery] Searching ALL locales HEAD content for ${keys.length} keys`);
        
        const allFiles = cache.getAllLocaleFiles();
        
        for (const key of keys) {
            if (results.has(key)) continue;
            
            const variations = getKeyPathVariations(key);
            
            for (const file of allFiles) {
                const content = cache.getHeadContent(file.path);
                if (!content) continue;

                for (const keyVariant of variations) {
                    const value = this.getNestedValue(content.json, keyVariant);
                    if (value && typeof value === 'string') {
                        results.set(key, { key, value, source: `head:${file.locale}` });
                        break;
                    }
                }
                
                if (results.has(key)) break;
            }
        }
    }

    /**
     * Search git history for all keys in parallel batches
     */
    private async searchGitHistoryBatch(
        folder: vscode.WorkspaceFolder,
        cache: LocaleCache,
        keys: string[],
        locale: string,
        maxCommitsPerFile: number,
        results: Map<string, BatchRecoveryResult>,
    ): Promise<void> {
        this.log?.appendLine(`[BatchRecovery] Searching git history (${locale}) for ${keys.length} keys`);
        
        const localeFiles = cache.getLocaleFiles(locale);
        
        // Pre-build key variations
        const keyVariationsMap = new Map<string, string[]>();
        for (const key of keys) {
            keyVariationsMap.set(key, getKeyPathVariations(key));
        }

        // Process files in parallel batches
        for (let i = 0; i < localeFiles.length; i += PARALLEL_BATCH_SIZE) {
            const batch = localeFiles.slice(i, i + PARALLEL_BATCH_SIZE);
            
            await Promise.all(batch.map(async (file) => {
                const history = cache.getGitHistory(file.path);
                if (!history || history.commits.length === 0) return;

                const commitsToCheck = history.commits.slice(0, maxCommitsPerFile);
                
                for (const commit of commitsToCheck) {
                    const json = await cache.getContentAtCommit(file.path, commit.hash);
                    if (!json) continue;

                    for (const key of keys) {
                        if (results.has(key)) continue;
                        
                        const variations = keyVariationsMap.get(key)!;
                        for (const keyVariant of variations) {
                            const value = this.getNestedValue(json, keyVariant);
                            if (value && typeof value === 'string') {
                                const cacheKey = `${folder.uri.fsPath}::${locale}::${key}`;
                                const result = { value, source: `history:${commit.hash}` };
                                this.recoveryCache.set(cacheKey, result);
                                results.set(key, { key, value, source: result.source });
                                break;
                            }
                        }
                    }
                }
            }));
        }
    }

    /**
     * Search git history across ALL locales for missing keys
     */
    private async searchAllLocalesGitHistory(
        folder: vscode.WorkspaceFolder,
        cache: LocaleCache,
        keys: string[],
        requestedLocale: string,
        maxCommitsPerFile: number,
        results: Map<string, BatchRecoveryResult>,
    ): Promise<void> {
        this.log?.appendLine(`[BatchRecovery] Searching ALL locales git history for ${keys.length} keys`);
        
        const allFiles = cache.getAllLocaleFiles();
        
        // Pre-build key variations
        const keyVariationsMap = new Map<string, string[]>();
        for (const key of keys) {
            keyVariationsMap.set(key, getKeyPathVariations(key));
        }

        // Process files in parallel batches
        for (let i = 0; i < allFiles.length; i += PARALLEL_BATCH_SIZE) {
            const batch = allFiles.slice(i, i + PARALLEL_BATCH_SIZE);
            
            await Promise.all(batch.map(async (file) => {
                const history = cache.getGitHistory(file.path);
                if (!history || history.commits.length === 0) return;

                const commitsToCheck = history.commits.slice(0, maxCommitsPerFile);
                
                for (const commit of commitsToCheck) {
                    const json = await cache.getContentAtCommit(file.path, commit.hash);
                    if (!json) continue;

                    for (const key of keys) {
                        if (results.has(key)) continue;
                        
                        const variations = keyVariationsMap.get(key)!;
                        for (const keyVariant of variations) {
                            const value = this.getNestedValue(json, keyVariant);
                            if (value && typeof value === 'string') {
                                // Cache under the requested locale to align with lookups
                                const cacheKey = `${folder.uri.fsPath}::${requestedLocale}::${key}`;
                                const result = { value, source: `history:${file.locale}:${commit.hash}` };
                                this.recoveryCache.set(cacheKey, result);
                                results.set(key, { key, value, source: result.source });
                                break;
                            }
                        }
                    }
                }
            }));
        }
    }

    /**
     * Search source files for original hardcoded text in parallel
     */
    private async searchSourceFilesParallel(
        folder: vscode.WorkspaceFolder,
        cache: LocaleCache,
        keys: string[],
        locale: string,
        daysBack: number,
        results: Map<string, BatchRecoveryResult>,
    ): Promise<void> {
        this.log?.appendLine(`[BatchRecovery] Searching source files for ${keys.length} keys`);
        
        // Build source file index for all missing keys at once
        await cache.buildSourceFileKeyIndex(keys);

        // Process keys in parallel
        for (let i = 0; i < keys.length; i += PARALLEL_BATCH_SIZE) {
            const batch = keys.slice(i, i + PARALLEL_BATCH_SIZE);
            
            await Promise.allSettled(batch.map(async (key) => {
                if (results.has(key)) return;
                
                const sourceFiles = cache.getSourceFilesForKey(key);
                if (sourceFiles.length === 0) {
                    results.set(key, { key, value: null, source: 'not_found' });
                    return;
                }

                const result = await this.extractOriginalTextFromSource(folder, sourceFiles[0], key, daysBack);
                if (result) {
                    const cacheKey = `${folder.uri.fsPath}::${locale}::${key}`;
                    this.recoveryCache.set(cacheKey, result);
                    results.set(key, { key, value: result.value, source: result.source });
                } else {
                    results.set(key, { key, value: null, source: 'not_found' });
                }
            }));
        }
    }

    /**
     * Extract original hardcoded text from source file git history
     */
    private async extractOriginalTextFromSource(
        folder: vscode.WorkspaceFolder,
        sourceFilePath: string,
        key: string,
        daysBack: number,
    ): Promise<{ value: string; source: string } | null> {
        const relPath = path.relative(folder.uri.fsPath, sourceFilePath);

        // Get current content
        let currentContent = this.sourceContentCache.get(sourceFilePath);
        if (!currentContent) {
            try {
                const data = await vscode.workspace.fs.readFile(vscode.Uri.file(sourceFilePath));
                currentContent = sharedDecoder.decode(data);
                this.sourceContentCache.set(sourceFilePath, currentContent);
            } catch {
                return null;
            }
        }

        const tCallPattern = new RegExp(`\\b\\$?t\\(\\s*['"]${escapeRegExp(key)}['"]`);

        // Get file history
        try {
            const { stdout } = await execFileAsync(
                'git',
                ['log', `--since=${daysBack} days ago`, '-n', '30', '--format=%H', '--', relPath.replace(/\\/g, '/')],
                { cwd: folder.uri.fsPath, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
            );

            const commits = stdout.trim().split('\n').filter(Boolean);
            if (commits.length < 2) return null;

            // Find the commit that introduced the t() call
            let commitWithTCall: string | null = null;
            let commitWithoutTCall: string | null = null;

            for (let i = 0; i < commits.length - 1; i++) {
                const content = await this.getSourceContentAtCommit(folder, sourceFilePath, commits[i]);
                if (!content) continue;

                if (tCallPattern.test(content)) {
                    commitWithTCall = commits[i];
                    const nextContent = await this.getSourceContentAtCommit(folder, sourceFilePath, commits[i + 1]);
                    if (nextContent && !tCallPattern.test(nextContent)) {
                        commitWithoutTCall = commits[i + 1];
                        break;
                    }
                }
            }

            if (!commitWithTCall || !commitWithoutTCall) return null;

            // Get diff between commits
            const result = await this.extractFromDiff(folder, sourceFilePath, commitWithoutTCall, commitWithTCall, key);
            if (result) {
                return { value: result, source: `diff:${commitWithoutTCall.slice(0, 7)}..${commitWithTCall.slice(0, 7)}` };
            }

            // Fallback: search old content for matching text
            const oldContent = await this.getSourceContentAtCommit(folder, sourceFilePath, commitWithoutTCall);
            if (oldContent) {
                const hintWords = extractHintWords(key);
                const candidates = extractAllUserTextFromContent(oldContent, hintWords);
                if (candidates.length > 0) {
                    candidates.sort((a, b) => b.score - a.score);
                    if (candidates[0].score >= 5) {
                        return {
                            value: candidates[0].text,
                            source: `source:${commitWithoutTCall.slice(0, 7)}`,
                        };
                    }
                }
            }
        } catch {
            // Git operation failed
        }

        return null;
    }

    /**
     * Get source file content at a specific commit
     */
    private async getSourceContentAtCommit(
        folder: vscode.WorkspaceFolder,
        filePath: string,
        commitHash: string,
    ): Promise<string | null> {
        const cacheKey = `src:${filePath}:${commitHash}`;
        if (this.sourceContentCache.has(cacheKey)) {
            return this.sourceContentCache.get(cacheKey) || null;
        }

        try {
            const relPath = path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/');
            const { stdout } = await execFileAsync(
                'git',
                ['show', `${commitHash}:${relPath}`],
                { cwd: folder.uri.fsPath, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
            );
            this.sourceContentCache.set(cacheKey, stdout);
            return stdout;
        } catch {
            this.sourceContentCache.set(cacheKey, '');
            return null;
        }
    }

    /**
     * Extract original text from git diff
     */
    private async extractFromDiff(
        folder: vscode.WorkspaceFolder,
        filePath: string,
        fromCommit: string,
        toCommit: string,
        key: string,
    ): Promise<string | null> {
        const diffKey = `${filePath}:${fromCommit}:${toCommit}`;
        let diff = this.diffCache.get(diffKey);

        if (!diff) {
            try {
                const relPath = path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/');
                const { stdout } = await execFileAsync(
                    'git',
                    ['diff', fromCommit, toCommit, '--', relPath],
                    { cwd: folder.uri.fsPath, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
                );
                diff = stdout;
                this.diffCache.set(diffKey, diff);
            } catch {
                return null;
            }
        }

        if (!diff) return null;

        const tCallPattern = new RegExp(`\\b\\$?t\\(\\s*['"]${escapeRegExp(key)}['"]`);
        const hintWords = extractHintWords(key);
        const diffLines = diff.split('\n');
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

        // Extract from individual removed lines
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
            if (hunkRemovedTexts[0].score >= 3) {
                return hunkRemovedTexts[0].text;
            }
        }

        return null;
    }

    /**
     * Get nested value from object using dot notation path
     */
    private getNestedValue(obj: any, path: string): any {
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

    /**
     * Get extract commit ref from commit tracker
     */
    getExtractCommitRef(folder: vscode.WorkspaceFolder): { commitHash: string } | null {
        if (!this.context) return null;
        return CommitTracker.getExtractCommitRef(this.context, folder);
    }

    private logCompletion(startTime: number, totalKeys: number, foundKeys: number): void {
        const elapsed = Date.now() - startTime;
        this.log?.appendLine(
            `[BatchRecovery] Completed in ${elapsed}ms: ${foundKeys}/${totalKeys} keys recovered`
        );
    }

    /**
     * Clear all caches
     */
    clearCaches(): void {
        this.recoveryCache.clear();
        this.sourceContentCache.clear();
        this.diffCache.clear();
    }
}

// Singleton instance per extension context
let batchRecoveryInstance: BatchRecoveryHandler | null = null;

export function getBatchRecoveryHandler(
    context?: vscode.ExtensionContext,
    log?: vscode.OutputChannel,
): BatchRecoveryHandler {
    if (!batchRecoveryInstance) {
        batchRecoveryInstance = new BatchRecoveryHandler(context, log);
    }
    return batchRecoveryInstance;
}

