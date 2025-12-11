import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder } from 'util';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const sharedDecoder = new TextDecoder('utf-8');

const GIT_TIMEOUT_MS = 30000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export interface LocaleFileInfo {
    uri: vscode.Uri;
    path: string;
    relativePath: string;
    locale: string;
    fileName: string;
}

export interface CachedLocaleContent {
    json: Record<string, any>;
    raw: string;
}

export interface GitCommitHistory {
    commits: Array<{ hash: string; date: Date; message: string }>;
    lastFetched: number;
}

/**
 * High-performance locale file cache for bulk operations.
 * Pre-loads and caches locale files, git history, and content at commits.
 */
export class LocaleCache {
    private localeFilesCache = new Map<string, LocaleFileInfo[]>();
    private headContentCache = new Map<string, CachedLocaleContent>();
    private commitContentCache = new Map<string, Record<string, any> | null>();
    private gitHistoryCache = new Map<string, GitCommitHistory>();
    private sourceFileKeyIndex = new Map<string, Set<string>>();
    private initialized = false;
    private initPromise: Promise<void> | null = null;

    constructor(
        private folder: vscode.WorkspaceFolder,
        private log?: vscode.OutputChannel,
    ) {}

    /**
     * Initialize the cache by pre-loading all locale files and their contents
     */
    async initialize(defaultLocale: string, daysBack: number = 120): Promise<void> {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this.doInitialize(defaultLocale, daysBack);
        await this.initPromise;
        this.initialized = true;
    }

    private async doInitialize(defaultLocale: string, daysBack: number): Promise<void> {
        const startTime = Date.now();
        this.log?.appendLine(`[LocaleCache] Initializing cache for ${this.folder.name}...`);

        // Discover all locale files
        const localeFiles = await this.discoverAllLocaleFiles();
        this.log?.appendLine(`[LocaleCache] Found ${localeFiles.length} locale files`);

        // Group by locale
        for (const file of localeFiles) {
            const key = file.locale;
            if (!this.localeFilesCache.has(key)) {
                this.localeFilesCache.set(key, []);
            }
            this.localeFilesCache.get(key)!.push(file);
        }

        // Pre-load HEAD content for ALL locale files (needed for cross-locale search)
        // Start with default locale for priority, then load others
        const defaultLocaleFiles = this.localeFilesCache.get(defaultLocale) || [];
        await this.preloadHeadContent(defaultLocaleFiles);
        
        // Load remaining locales in parallel
        const otherLocaleFiles = localeFiles.filter(f => f.locale !== defaultLocale);
        await this.preloadHeadContent(otherLocaleFiles);

        // Pre-fetch git history for all locale files (batched)
        await this.preloadGitHistory(localeFiles, daysBack);

        const elapsed = Date.now() - startTime;
        this.log?.appendLine(`[LocaleCache] Initialization complete in ${elapsed}ms`);
    }

    /**
     * Discover all locale files in the project
     */
    private async discoverAllLocaleFiles(): Promise<LocaleFileInfo[]> {
        const files: LocaleFileInfo[] = [];
        const basePaths = [
            path.join('resources', 'js', 'i18n', 'auto'),
            path.join('src', 'i18n'),
            path.join('src', 'locales'),
            'locales',
            'i18n',
        ];

        for (const basePath of basePaths) {
            const baseUri = vscode.Uri.file(path.join(this.folder.uri.fsPath, basePath));
            try {
                const entries = await vscode.workspace.fs.readDirectory(baseUri);
                for (const [name, type] of entries) {
                    if (type === vscode.FileType.Directory) {
                        // Locale directory (e.g., /en/, /fr/)
                        const localeDir = vscode.Uri.joinPath(baseUri, name);
                        try {
                            const localeEntries = await vscode.workspace.fs.readDirectory(localeDir);
                            for (const [fileName, fileType] of localeEntries) {
                                if (fileType === vscode.FileType.File && fileName.endsWith('.json')) {
                                    const fileUri = vscode.Uri.joinPath(localeDir, fileName);
                                    const relativePath = path.relative(this.folder.uri.fsPath, fileUri.fsPath).replace(/\\/g, '/');
                                    files.push({
                                        uri: fileUri,
                                        path: fileUri.fsPath,
                                        relativePath,
                                        locale: name,
                                        fileName,
                                    });
                                }
                            }
                        } catch {
                            // Directory access failed
                        }
                    } else if (type === vscode.FileType.File && name.endsWith('.json')) {
                        // Single locale file (e.g., en.json)
                        const locale = name.replace('.json', '');
                        const fileUri = vscode.Uri.joinPath(baseUri, name);
                        const relativePath = path.relative(this.folder.uri.fsPath, fileUri.fsPath).replace(/\\/g, '/');
                        files.push({
                            uri: fileUri,
                            path: fileUri.fsPath,
                            relativePath,
                            locale,
                            fileName: name,
                        });
                    }
                }
            } catch {
                // Base path doesn't exist
            }
        }

        return files;
    }

    /**
     * Pre-load HEAD content for locale files in parallel
     */
    private async preloadHeadContent(files: LocaleFileInfo[]): Promise<void> {
        const batchSize = 10;
        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);
            await Promise.all(batch.map(async (file) => {
                try {
                    const data = await vscode.workspace.fs.readFile(file.uri);
                    const raw = sharedDecoder.decode(data);
                    const json = JSON.parse(raw);
                    this.headContentCache.set(file.path, { json, raw });
                } catch {
                    // File read failed
                }
            }));
        }
        this.log?.appendLine(`[LocaleCache] Pre-loaded ${this.headContentCache.size} locale files from HEAD`);
    }

    /**
     * Pre-fetch git history for all locale files using a single batched command
     */
    private async preloadGitHistory(files: LocaleFileInfo[], daysBack: number): Promise<void> {
        if (files.length === 0) return;

        try {
            // Get all file histories in a single git log call
            const relativePaths = files.map(f => f.relativePath);
            const { stdout } = await execFileAsync(
                'git',
                [
                    'log',
                    `--since=${daysBack} days ago`,
                    '-n', '100',
                    '--format=%H|%ai|%s',
                    '--name-only',
                    '--',
                    ...relativePaths,
                ],
                {
                    cwd: this.folder.uri.fsPath,
                    timeout: GIT_TIMEOUT_MS,
                    maxBuffer: GIT_MAX_BUFFER,
                },
            );

            // Parse the batched output
            const lines = stdout.split('\n');
            let currentCommit: { hash: string; date: Date; message: string } | null = null;

            for (const line of lines) {
                if (line.includes('|')) {
                    const [hash, dateStr, ...messageParts] = line.split('|');
                    if (hash && dateStr) {
                        currentCommit = {
                            hash: hash.trim(),
                            date: new Date(dateStr.trim()),
                            message: messageParts.join('|').trim(),
                        };
                    }
                } else if (line.trim() && currentCommit) {
                    // This is a file path
                    const filePath = line.trim();
                    const fullPath = path.join(this.folder.uri.fsPath, filePath);
                    
                    if (!this.gitHistoryCache.has(fullPath)) {
                        this.gitHistoryCache.set(fullPath, { commits: [], lastFetched: Date.now() });
                    }
                    const history = this.gitHistoryCache.get(fullPath)!;
                    
                    // Avoid duplicates
                    if (!history.commits.find(c => c.hash === currentCommit!.hash)) {
                        history.commits.push({ ...currentCommit });
                    }
                }
            }

            this.log?.appendLine(`[LocaleCache] Pre-fetched git history for ${this.gitHistoryCache.size} files`);
        } catch (err) {
            this.log?.appendLine(`[LocaleCache] Git history batch fetch failed: ${String(err)}`);
        }
    }

    /**
     * Get all locale files for a specific locale
     */
    getLocaleFiles(locale: string): LocaleFileInfo[] {
        return this.localeFilesCache.get(locale) || [];
    }

    /**
     * Get all locale files across all locales
     */
    getAllLocaleFiles(): LocaleFileInfo[] {
        const files: LocaleFileInfo[] = [];
        for (const localeFiles of this.localeFilesCache.values()) {
            files.push(...localeFiles);
        }
        return files;
    }

    /**
     * Get cached HEAD content for a file
     */
    getHeadContent(filePath: string): CachedLocaleContent | null {
        return this.headContentCache.get(filePath) || null;
    }

    /**
     * Get cached git history for a file
     */
    getGitHistory(filePath: string): GitCommitHistory | null {
        return this.gitHistoryCache.get(filePath) || null;
    }

    /**
     * Get file content at a specific commit (with caching)
     */
    async getContentAtCommit(filePath: string, commitHash: string): Promise<Record<string, any> | null> {
        const cacheKey = `${filePath}:${commitHash}`;
        
        if (this.commitContentCache.has(cacheKey)) {
            return this.commitContentCache.get(cacheKey)!;
        }

        try {
            const relativePath = path.relative(this.folder.uri.fsPath, filePath).replace(/\\/g, '/');
            const { stdout } = await execFileAsync(
                'git',
                ['show', `${commitHash}:${relativePath}`],
                {
                    cwd: this.folder.uri.fsPath,
                    timeout: GIT_TIMEOUT_MS,
                    maxBuffer: GIT_MAX_BUFFER,
                },
            );
            
            const json = JSON.parse(stdout);
            this.commitContentCache.set(cacheKey, json);
            return json;
        } catch {
            this.commitContentCache.set(cacheKey, null);
            return null;
        }
    }

    /**
     * Search for a key in all cached HEAD content
     */
    findKeyInHeadContent(keyPath: string, keyVariations: string[]): { value: string; file: LocaleFileInfo } | null {
        for (const [filePath, content] of this.headContentCache.entries()) {
            for (const keyVariant of keyVariations) {
                const value = this.getNestedValue(content.json, keyVariant);
                if (value && typeof value === 'string') {
                    const file = this.getAllLocaleFiles().find(f => f.path === filePath);
                    if (file) {
                        return { value, file };
                    }
                }
            }
        }
        return null;
    }

    /**
     * Search for a key in git history across all cached files
     */
    async findKeyInHistoryBatch(
        keyPath: string,
        keyVariations: string[],
        maxCommitsPerFile: number = 10,
    ): Promise<{ value: string; source: string; commitHash: string } | null> {
        const allFiles = this.getAllLocaleFiles();
        
        // Try each file's history
        for (const file of allFiles) {
            const history = this.gitHistoryCache.get(file.path);
            if (!history || history.commits.length === 0) continue;

            // Only check first N commits per file for performance
            const commitsToCheck = history.commits.slice(0, maxCommitsPerFile);
            
            for (const commit of commitsToCheck) {
                const json = await this.getContentAtCommit(file.path, commit.hash);
                if (!json) continue;

                for (const keyVariant of keyVariations) {
                    const value = this.getNestedValue(json, keyVariant);
                    if (value && typeof value === 'string') {
                        return {
                            value,
                            source: `history:${commit.hash}`,
                            commitHash: commit.hash,
                        };
                    }
                }
            }
        }

        return null;
    }

    /**
     * Build source file index for faster key lookups
     */
    async buildSourceFileKeyIndex(keys: string[]): Promise<void> {
        if (keys.length === 0) return;
        
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const sourceGlobs = cfg.get<string[]>('i18n.sourceGlobs') || ['**/*.{ts,tsx,js,jsx,vue}'];
        const excludeGlobs = cfg.get<string[]>('i18n.sourceExcludeGlobs') || [
            '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
        ];
        const exclude = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;

        const seen = new Set<string>();
        const uris: vscode.Uri[] = [];
        const includes = sourceGlobs.length > 0 ? sourceGlobs : [];

        for (const include of includes) {
            try {
                const pattern = new vscode.RelativePattern(this.folder, include);
                const found = await vscode.workspace.findFiles(pattern, exclude, 500);
                for (const uri of found) {
                    const key = uri.toString();
                    if (!seen.has(key)) {
                        seen.add(key);
                        uris.push(uri);
                    }
                }
            } catch {
                // Skip invalid glob patterns
            }
        }
        
        // Build search patterns for all keys
        const keyPatterns = keys.map(key => ({
            key,
            patterns: [
                `t('${key}'`,
                `t("${key}"`,
                `$t('${key}'`,
                `$t("${key}"`,
            ],
        }));

        // Read files and index which keys they contain
        const batchSize = 20;
        for (let i = 0; i < uris.length; i += batchSize) {
            const batch = uris.slice(i, i + batchSize);
            await Promise.all(batch.map(async (uri) => {
                try {
                    const data = await vscode.workspace.fs.readFile(uri);
                    const content = sharedDecoder.decode(data);
                    
                    for (const { key, patterns } of keyPatterns) {
                        for (const pattern of patterns) {
                            if (content.includes(pattern)) {
                                if (!this.sourceFileKeyIndex.has(key)) {
                                    this.sourceFileKeyIndex.set(key, new Set());
                                }
                                this.sourceFileKeyIndex.get(key)!.add(uri.fsPath);
                                break;
                            }
                        }
                    }
                } catch {
                    // Skip files that can't be read
                }
            }));
        }
        
        this.log?.appendLine(`[LocaleCache] Built source file index for ${keys.length} keys, found ${this.sourceFileKeyIndex.size} with matches`);
    }

    /**
     * Get source files that reference a key
     */
    getSourceFilesForKey(key: string): string[] {
        const files = this.sourceFileKeyIndex.get(key);
        return files ? Array.from(files) : [];
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
     * Clear all caches
     */
    clear(): void {
        this.localeFilesCache.clear();
        this.headContentCache.clear();
        this.commitContentCache.clear();
        this.gitHistoryCache.clear();
        this.sourceFileKeyIndex.clear();
        this.initialized = false;
        this.initPromise = null;
    }
}

// Singleton instance per workspace folder
const cacheInstances = new Map<string, LocaleCache>();

export function getLocaleCache(folder: vscode.WorkspaceFolder, log?: vscode.OutputChannel): LocaleCache {
    const key = folder.uri.toString();
    if (!cacheInstances.has(key)) {
        cacheInstances.set(key, new LocaleCache(folder, log));
    }
    return cacheInstances.get(key)!;
}

export function clearLocaleCaches(): void {
    for (const cache of cacheInstances.values()) {
        cache.clear();
    }
    cacheInstances.clear();
}

