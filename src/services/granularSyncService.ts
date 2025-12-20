import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { getProjectEnv } from '../core/projectEnv';

const sharedDecoder = new TextDecoder('utf-8');
const sharedEncoder = new TextEncoder();

export type SyncMode = 'keys' | 'file' | 'full';

export interface SyncResult {
    updated: number;
    files: string[];
    mode: SyncMode;
}

export interface GranularSyncOptions {
    baseLocale?: string;
    verbose?: boolean;
    forceUpdate?: boolean;
}

function sortObjectDeep(input: unknown): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return input;
    }
    const obj = input as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
        result[key] = sortObjectDeep(obj[key]);
    }
    return result;
}

function getKeyValue(obj: unknown, keyPath: string): unknown {
    if (!obj || typeof obj !== 'object') return undefined;
    const segments = String(keyPath).split('.').filter(Boolean);
    let node: any = obj;
    for (const segment of segments) {
        if (!node || typeof node !== 'object') return undefined;
        node = node[segment];
    }
    return node;
}

function setKeyValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
    const segments = String(keyPath).split('.').filter(Boolean);
    if (!segments.length) return;

    let node: any = obj;
    for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (!node[segment] || typeof node[segment] !== 'object') {
            node[segment] = {};
        }
        node = node[segment];
    }
    node[segments[segments.length - 1]] = value;
}

function hasKeyPath(obj: unknown, keyPath: string): boolean {
    return getKeyValue(obj, keyPath) !== undefined;
}

async function readJsonFile(uri: vscode.Uri): Promise<Record<string, unknown> | null> {
    try {
        const data = await vscode.workspace.fs.readFile(uri);
        const text = sharedDecoder.decode(data);
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
}

async function writeJsonFile(uri: vscode.Uri, data: Record<string, unknown>): Promise<void> {
    const sorted = sortObjectDeep(data) as Record<string, unknown>;
    const payload = `${JSON.stringify(sorted, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(uri, sharedEncoder.encode(payload));
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function ensureDir(uri: vscode.Uri): Promise<void> {
    try {
        await vscode.workspace.fs.createDirectory(uri);
    } catch {
        // Directory may already exist
    }
}

function getFileNameForKey(keyPath: string): string {
    const segments = String(keyPath).split('.').filter(Boolean);
    if (segments.length < 1) {
        return 'common.json';
    }
    return `${segments[0]}.json`;
}

export class GranularSyncService {
    private outputChannel: vscode.OutputChannel | undefined;

    constructor(private context?: vscode.ExtensionContext) {}

    private log(message: string): void {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('AI Localizer Sync');
        }
        this.outputChannel.appendLine(message);
    }

    private async getAutoDir(folder: vscode.WorkspaceFolder): Promise<vscode.Uri> {
        try {
            const env = await getProjectEnv(folder);
            return vscode.Uri.file(path.join(env.runtimeRoot, 'auto'));
        } catch {
            // Fallback paths
            const candidates = [
                'resources/js/i18n/auto',
                'src/i18n/auto',
                'src/locales',
                'locales',
            ];
            for (const candidate of candidates) {
                const uri = vscode.Uri.joinPath(folder.uri, candidate);
                if (await fileExists(uri)) {
                    return uri;
                }
            }
            return vscode.Uri.joinPath(folder.uri, 'resources/js/i18n/auto');
        }
    }

    private async getConfiguredLocales(folder: vscode.WorkspaceFolder): Promise<string[]> {
        try {
            const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
            const data = await vscode.workspace.fs.readFile(pkgUri);
            const pkg = JSON.parse(sharedDecoder.decode(data));
            if (pkg?.aiI18n?.locales && Array.isArray(pkg.aiI18n.locales)) {
                return pkg.aiI18n.locales.filter((l: unknown) => typeof l === 'string' && l);
            }
        } catch {
            // Ignore
        }
        return [];
    }

    private async discoverLocales(
        autoDir: vscode.Uri,
        baseLocale: string
    ): Promise<Set<string>> {
        const locales = new Set<string>();

        try {
            const entries = await vscode.workspace.fs.readDirectory(autoDir);
            for (const [name, type] of entries) {
                if (type === vscode.FileType.Directory && name !== baseLocale) {
                    locales.add(name);
                } else if (type === vscode.FileType.File && name.endsWith('.json')) {
                    const localeName = name.replace(/\.json$/i, '');
                    if (localeName !== baseLocale) {
                        locales.add(localeName);
                    }
                }
            }
        } catch {
            // Directory may not exist
        }

        return locales;
    }

    /**
     * Sync specific keys only across all locales.
     * Use this for quick fixes where only a few keys need syncing.
     */
    async syncKeys(
        folder: vscode.WorkspaceFolder,
        keys: string[],
        options: GranularSyncOptions = {}
    ): Promise<SyncResult> {
        const { baseLocale = 'en', verbose = false } = options;
        const result: SyncResult = { updated: 0, files: [], mode: 'keys' };

        if (!keys.length) {
            return result;
        }

        const autoDir = await this.getAutoDir(folder);
        const baseGroupedDir = vscode.Uri.joinPath(autoDir, baseLocale);
        const useGrouped = await fileExists(baseGroupedDir);

        // Determine target locales
        const configuredLocales = await this.getConfiguredLocales(folder);
        let locales = new Set(configuredLocales.filter(l => l !== baseLocale));

        if (locales.size === 0) {
            locales = await this.discoverLocales(autoDir, baseLocale);
        }

        if (locales.size === 0) {
            if (verbose) {
                this.log('[granular-sync] No target locales found');
            }
            return result;
        }

        if (useGrouped) {
            // Group keys by their target file
            const keysByFile = new Map<string, string[]>();
            for (const key of keys) {
                const fileName = getFileNameForKey(key);
                if (!keysByFile.has(fileName)) {
                    keysByFile.set(fileName, []);
                }
                keysByFile.get(fileName)!.push(key);
            }

            for (const locale of locales) {
                const localeDir = vscode.Uri.joinPath(autoDir, locale);

                for (const [fileName, fileKeys] of keysByFile.entries()) {
                    const baseFileUri = vscode.Uri.joinPath(baseGroupedDir, fileName);
                    const targetFileUri = vscode.Uri.joinPath(localeDir, fileName);

                    const baseData = await readJsonFile(baseFileUri);
                    if (!baseData) continue;

                    const targetData = (await readJsonFile(targetFileUri)) || {};
                    let modified = false;

                    for (const key of fileKeys) {
                        const baseValue = getKeyValue(baseData, key);
                        if (baseValue === undefined) continue;

                        if (!hasKeyPath(targetData, key)) {
                            setKeyValue(targetData, key, baseValue);
                            modified = true;
                            if (verbose) {
                                this.log(`[granular-sync] Added key "${key}" to ${locale}/${fileName}`);
                            }
                        }
                    }

                    if (modified) {
                        await ensureDir(localeDir);
                        await writeJsonFile(targetFileUri, targetData);
                        result.updated++;
                        result.files.push(targetFileUri.fsPath);
                    }
                }
            }
        } else {
            // Single-file structure
            const baseFileUri = vscode.Uri.joinPath(autoDir, `${baseLocale}.json`);
            const baseData = await readJsonFile(baseFileUri);
            if (!baseData) return result;

            for (const locale of locales) {
                const targetFileUri = vscode.Uri.joinPath(autoDir, `${locale}.json`);
                const targetData = (await readJsonFile(targetFileUri)) || {};
                let modified = false;

                for (const key of keys) {
                    const baseValue = getKeyValue(baseData, key);
                    if (baseValue === undefined) continue;

                    if (!hasKeyPath(targetData, key)) {
                        setKeyValue(targetData, key, baseValue);
                        modified = true;
                        if (verbose) {
                            this.log(`[granular-sync] Added key "${key}" to ${locale}.json`);
                        }
                    }
                }

                if (modified) {
                    await writeJsonFile(targetFileUri, targetData);
                    result.updated++;
                    result.files.push(targetFileUri.fsPath);
                }
            }
        }

        if (verbose) {
            this.log(`[granular-sync] Synced ${keys.length} key(s), updated ${result.updated} file(s)`);
        }

        return result;
    }

    /**
     * Sync all keys from a specific locale JSON file to other locales.
     * Use this when operating on a single file.
     */
    async syncFile(
        folder: vscode.WorkspaceFolder,
        fileUri: vscode.Uri,
        options: GranularSyncOptions = {}
    ): Promise<SyncResult> {
        const { baseLocale = 'en', verbose = false } = options;
        const result: SyncResult = { updated: 0, files: [], mode: 'file' };

        if (!(await fileExists(fileUri))) {
            return result;
        }

        const autoDir = await this.getAutoDir(folder);
        const normalizedPath = fileUri.fsPath;

        // Infer locale and relative path from file
        const autoMarker = `${path.sep}auto${path.sep}`;
        const autoIndex = normalizedPath.indexOf(autoMarker);

        let sourceLocale = baseLocale;
        let relativeFilePath = '';

        if (autoIndex >= 0) {
            const afterAuto = normalizedPath.substring(autoIndex + autoMarker.length);
            const parts = afterAuto.split(path.sep);
            if (parts.length >= 1) {
                sourceLocale = parts[0].replace(/\.json$/i, '');
                relativeFilePath = parts.slice(1).join(path.sep);
            }
        } else {
            sourceLocale = path.basename(fileUri.fsPath, '.json');
        }

        // Only sync from base locale
        if (sourceLocale !== baseLocale) {
            if (verbose) {
                this.log(`[granular-sync] Skipping non-base locale file: ${fileUri.fsPath}`);
            }
            return result;
        }

        const sourceData = await readJsonFile(fileUri);
        if (!sourceData) return result;

        // Collect all keys from source file
        const keys: string[] = [];
        const collectKeys = (obj: unknown, prefix = ''): void => {
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
            for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
                const fullKey = prefix ? `${prefix}.${key}` : key;
                if (typeof value === 'string') {
                    keys.push(fullKey);
                } else if (value && typeof value === 'object') {
                    collectKeys(value, fullKey);
                }
            }
        };
        collectKeys(sourceData);

        if (!keys.length) return result;

        // Determine target locales
        const configuredLocales = await this.getConfiguredLocales(folder);
        let locales = new Set(configuredLocales.filter(l => l !== baseLocale));

        if (locales.size === 0) {
            locales = await this.discoverLocales(autoDir, baseLocale);
        }

        if (locales.size === 0) return result;

        const baseGroupedDir = vscode.Uri.joinPath(autoDir, baseLocale);
        const useGrouped = (await fileExists(baseGroupedDir)) && relativeFilePath;

        if (useGrouped && relativeFilePath) {
            for (const locale of locales) {
                const targetFileUri = vscode.Uri.joinPath(autoDir, locale, relativeFilePath);
                const targetData = (await readJsonFile(targetFileUri)) || {};
                let modified = false;

                for (const key of keys) {
                    const sourceValue = getKeyValue(sourceData, key);
                    if (sourceValue === undefined) continue;

                    if (!hasKeyPath(targetData, key)) {
                        setKeyValue(targetData, key, sourceValue);
                        modified = true;
                    }
                }

                if (modified) {
                    const targetDir = vscode.Uri.file(path.dirname(targetFileUri.fsPath));
                    await ensureDir(targetDir);
                    await writeJsonFile(targetFileUri, targetData);
                    result.updated++;
                    result.files.push(targetFileUri.fsPath);
                    if (verbose) {
                        this.log(`[granular-sync] Synced ${locale}/${relativeFilePath}`);
                    }
                }
            }
        } else {
            for (const locale of locales) {
                const targetFileUri = vscode.Uri.joinPath(autoDir, `${locale}.json`);
                const targetData = (await readJsonFile(targetFileUri)) || {};
                let modified = false;

                for (const key of keys) {
                    const sourceValue = getKeyValue(sourceData, key);
                    if (sourceValue === undefined) continue;

                    if (!hasKeyPath(targetData, key)) {
                        setKeyValue(targetData, key, sourceValue);
                        modified = true;
                    }
                }

                if (modified) {
                    await writeJsonFile(targetFileUri, targetData);
                    result.updated++;
                    result.files.push(targetFileUri.fsPath);
                    if (verbose) {
                        this.log(`[granular-sync] Synced ${locale}.json`);
                    }
                }
            }
        }

        if (verbose) {
            this.log(`[granular-sync] File sync completed, updated ${result.updated} file(s)`);
        }

        return result;
    }

    /**
     * Ensure specific keys exist in all locales, creating them with base locale values.
     * Unlike syncKeys, this also creates missing keys in the base locale using provided values.
     */
    async ensureKeys(
        folder: vscode.WorkspaceFolder,
        keys: string[],
        values: Record<string, string> = {},
        options: GranularSyncOptions = {}
    ): Promise<SyncResult> {
        const { baseLocale = 'en', verbose = false, forceUpdate = false } = options;
        const result: SyncResult = { updated: 0, files: [], mode: 'keys' };

        if (!keys.length) {
            return result;
        }

        const autoDir = await this.getAutoDir(folder);
        const baseGroupedDir = vscode.Uri.joinPath(autoDir, baseLocale);
        const useGrouped = await fileExists(baseGroupedDir);

        // First, ensure keys exist in base locale
        if (useGrouped) {
            const keysByFile = new Map<string, string[]>();
            for (const key of keys) {
                const fileName = getFileNameForKey(key);
                if (!keysByFile.has(fileName)) {
                    keysByFile.set(fileName, []);
                }
                keysByFile.get(fileName)!.push(key);
            }

            for (const [fileName, fileKeys] of keysByFile.entries()) {
                const baseFileUri = vscode.Uri.joinPath(baseGroupedDir, fileName);
                const baseData = (await readJsonFile(baseFileUri)) || {};
                let modified = false;

                for (const key of fileKeys) {
                    const existingValue = getKeyValue(baseData, key);
                    const providedValue = values[key];

                    if (existingValue === undefined || (forceUpdate && providedValue !== undefined)) {
                        const valueToSet = providedValue ?? key.split('.').pop() ?? key;
                        setKeyValue(baseData, key, valueToSet);
                        modified = true;
                    }
                }

                if (modified) {
                    await ensureDir(baseGroupedDir);
                    await writeJsonFile(baseFileUri, baseData);
                    result.updated++;
                    result.files.push(baseFileUri.fsPath);
                    if (verbose) {
                        this.log(`[granular-sync] Updated base locale: ${fileName}`);
                    }
                }
            }
        } else {
            const baseFileUri = vscode.Uri.joinPath(autoDir, `${baseLocale}.json`);
            const baseData = (await readJsonFile(baseFileUri)) || {};
            let modified = false;

            for (const key of keys) {
                const existingValue = getKeyValue(baseData, key);
                const providedValue = values[key];

                if (existingValue === undefined || (forceUpdate && providedValue !== undefined)) {
                    const valueToSet = providedValue ?? key.split('.').pop() ?? key;
                    setKeyValue(baseData, key, valueToSet);
                    modified = true;
                }
            }

            if (modified) {
                await ensureDir(autoDir);
                await writeJsonFile(baseFileUri, baseData);
                result.updated++;
                result.files.push(baseFileUri.fsPath);
                if (verbose) {
                    this.log(`[granular-sync] Updated base locale file`);
                }
            }
        }

        // Now sync to other locales
        const syncResult = await this.syncKeys(folder, keys, options);
        result.updated += syncResult.updated;
        result.files.push(...syncResult.files);

        return result;
    }
}

// Singleton instance for global access
let globalSyncService: GranularSyncService | undefined;

export function getGranularSyncService(context?: vscode.ExtensionContext): GranularSyncService {
    if (!globalSyncService) {
        globalSyncService = new GranularSyncService(context);
    }
    return globalSyncService;
}

