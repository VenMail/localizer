import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder } from 'util';
import { getProjectEnv } from './projectEnv';
import { inferJsonLocaleFromUri, parseLocaleJson } from './i18nLocale';
import { stripUtf8Bom } from './i18nFs';
import { ProjectConfigService } from '../services/projectConfigService';
import { detectFrameworkProfile } from '../frameworks/detection';

const MAX_LOCALE_FILE_SIZE_BYTES = Number(process.env.AI_I18N_MAX_LOCALE_SIZE || 2 * 1024 * 1024);
const INDEX_CONCURRENCY = Number(process.env.AI_I18N_INDEX_CONCURRENCY || 16);

export type TranslationRecord = {
    key: string;
    locales: Map<string, string>;
    defaultLocale: string;
    locations: { locale: string; uri: vscode.Uri }[];
    /** Tracks which file type currently provides the locale's canonical value */
    localeSourcePriority?: Map<string, number>;
};

// Shared decoder instance to avoid repeated allocations
const sharedDecoder = new TextDecoder('utf-8');

export class I18nIndex {
    private keyMap = new Map<string, TranslationRecord>();
    private defaultLocale = 'en';
    private initializing: Promise<void> | null = null;
    private fileToKeys = new Map<string, { locale: string; keys: string[] }>();
    private projectConfigService = new ProjectConfigService();

    async ensureInitialized(force = false): Promise<void> {
        if (!force && this.keyMap.size > 0) {
            return;
        }
        if (this.initializing) {
            if (!force) {
                return this.initializing;
            }
            // Wait for current initialization to complete before forcing rebuild
            await this.initializing;
        }
        this.initializing = this.buildIndex();
        await this.initializing;
        this.initializing = null;
    }

    private async buildIndex(): Promise<void> {
        this.keyMap.clear();
        this.fileToKeys.clear();

        const config = vscode.workspace.getConfiguration('ai-localizer');
        this.defaultLocale = config.get<string>('i18n.defaultLocale') || 'en';
        const enabled = config.get<boolean>('i18n.enabled');
        const debugEnabled = config.get<boolean>('debug.enabled');
        
        if (debugEnabled) {
            console.log(`[I18nIndex] Building index - enabled: ${enabled}, defaultLocale: ${this.defaultLocale}`);
        }
        
        if (enabled === false) {
            if (debugEnabled) {
                console.log('[I18nIndex] I18n disabled in settings, skipping index build');
            }
            return;
        }

        const userGlobs = config.get<string[]>('i18n.localeGlobs');
        if (debugEnabled) {
            console.log(`[I18nIndex] User-defined locale globs: ${JSON.stringify(userGlobs)}`);
        }
        
        const defaultGlobs: string[] = [
            'resources/js/i18n/auto/**/*.json',
            'src/i18n/**/*.json',
            'src/locales/**/*.json',
            'locales/**/*.json',
            '**/locales/**/*.json',
            'i18n/**/*.json',
            // Python / Django / Flask gettext catalogs (.po)
            '**/locale/*/LC_MESSAGES/*.po',
            '**/locales/*/LC_MESSAGES/*.po',
            '**/translations/*/LC_MESSAGES/*.po',
            // .NET / ASP.NET RESX resources (conventionally under Resources/)
            '**/Resources/**/*.resx',
        ];
        if (debugEnabled) {
            console.log(`[I18nIndex] Default globs: ${JSON.stringify(defaultGlobs)}`);
        }

        // Combine default globs with user-defined additional globs
        const baseGlobs: string[] = [...defaultGlobs];
        if (userGlobs && userGlobs.length) {
            baseGlobs.push(...userGlobs);
        }
        if (debugEnabled) {
            console.log(`[I18nIndex] Combined base globs: ${JSON.stringify(baseGlobs)}`);
        }

        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) {
            return;
        }

        // Always ensure Laravel PHP locale files are scanned, but only for folders that look like Laravel
        const laravelPhpGlobs: string[] = [
            'lang/**/*.php',
            'resources/lang/**/*.php',
        ];
        const folderLaravelGlobs = new Map<string, string[]>();
        for (const folder of folders) {
            const shouldIncludeLaravel = await this.folderLooksLikeLaravel(folder);
            if (debugEnabled) {
                console.log(`[I18nIndex] Folder ${folder.uri.fsPath} looks like Laravel: ${shouldIncludeLaravel}`);
            }
            
            // FALLBACK: If framework detection fails but we have PHP files, include Laravel globs anyway
            // This ensures Laravel translation files are discovered even if detection fails
            if (shouldIncludeLaravel) {
                folderLaravelGlobs.set(folder.uri.fsPath, laravelPhpGlobs);
            } else {
                // Check if this folder has any PHP files that might be Laravel
                const hasPhpFiles = await this.folderHasPhpFiles(folder);
                if (debugEnabled) {
                    console.log(`[I18nIndex] Folder ${folder.uri.fsPath} has PHP files: ${hasPhpFiles}`);
                }
                if (hasPhpFiles) {
                    if (debugEnabled) {
                        console.log(`[I18nIndex] Including Laravel globs as fallback for PHP project`);
                    }
                    folderLaravelGlobs.set(folder.uri.fsPath, laravelPhpGlobs);
                }
            }
        }

        // For mixed projects, add appropriate globs for each framework
        const mixedProjectGlobs = new Map<string, string[]>();
        for (const folder of folders) {
            const profile = await detectFrameworkProfile(folder);
            if (profile?.kind === 'mixed') {
                const globs: string[] = [];
                
                // Add Laravel PHP globs if Laravel is in the mix
                if (profile.frameworks.includes('laravel')) {
                    globs.push(
                        'lang/**/*.php',
                        'resources/lang/**/*.php',
                    );
                }
                
                // Add React/Vue JSON globs (shared between React and Vue)
                if (profile.frameworks.includes('react') || profile.frameworks.includes('vue')) {
                    globs.push(
                        'resources/js/i18n/**/*.json',
                        'resources/js/locales/**/*.json',
                        'resources/js/auto/**/*.json',
                        'src/i18n/**/*.json',
                        'src/locales/**/*.json',
                    );
                }
                
                // Add Nuxt JSON globs if Nuxt is in the mix
                if (profile.frameworks.includes('nuxt')) {
                    globs.push(
                        'locales/**/*.json',
                        'i18n/**/*.json',
                    );
                }
                
                mixedProjectGlobs.set(folder.uri.fsPath, globs);
            }
        }

        const fileKeySet = new Set<string>();
        const fileList: vscode.Uri[] = [];
        for (const folder of folders) {
            // Start from the shared base globs for every folder
            let effectiveGlobs: string[] = [...baseGlobs];

            // Add Laravel-specific globs if this folder looks like Laravel
            const laravelGlobs = folderLaravelGlobs.get(folder.uri.fsPath);
            if (laravelGlobs) {
                effectiveGlobs.push(...laravelGlobs);
            }

            // Add mixed project globs for Laravel + Inertia projects
            const mixedGlobs = mixedProjectGlobs.get(folder.uri.fsPath);
            if (mixedGlobs) {
                effectiveGlobs.push(...mixedGlobs);
            }

            // When localeGlobs is not explicitly configured, augment the
            // base globs with framework-specific runtime roots so we pick
            // up generated/auto JSON files without losing generic paths
            // like locales/** or i18n/**.
            if (!userGlobs) {
                try {
                    const env = await getProjectEnv(folder);
                    effectiveGlobs.push(
                        `${env.runtimeRoot}/auto/**/*.json`,
                        `${env.runtimeRoot}/**/*.json`,
                    );
                } catch {
                    // If framework/env detection fails, fall back to baseGlobs only
                }
            }

            for (const glob of effectiveGlobs) {
                const pattern = new vscode.RelativePattern(folder, glob);
                const found = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
                if (debugEnabled) {
                    console.log(`[I18nIndex] Glob '${glob}' found ${found.length} files`);
                    for (const f of found) {
                        console.log(`[I18nIndex] Found file: ${f.toString()}`);
                    }
                }
                for (const f of found) {
                    const key = f.toString();
                    if (!fileKeySet.has(key)) {
                        fileKeySet.add(key);
                        fileList.push(f);
                    }
                }
            }
        }

        async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
            if (items.length === 0) return;
            let idx = 0;
            const workers: Promise<void>[] = [];
            const worker = async () => {
                while (true) {
                    const current = idx;
                    idx += 1;
                    if (current >= items.length) break;
                    const it = items[current];
                    try {
                        await fn(it);
                    } catch (err) {
                        console.error('i18nIndex: worker failure:', err);
                    }
                }
            };
            const count = Math.min(limit, items.length);
            for (let i = 0; i < count; i += 1) workers.push(worker());
            await Promise.all(workers);
        }

        await mapLimit(fileList, INDEX_CONCURRENCY, async (file) => {
            try {
                const stat = await vscode.workspace.fs.stat(file);
                if (typeof stat?.size === 'number' && stat.size > MAX_LOCALE_FILE_SIZE_BYTES) {
                    return;
                }
            } catch {
                return;
            }

            let text: string | null = null;
            try {
                const data = await vscode.workspace.fs.readFile(file);
                text = this.decodeLocaleText(data);
            } catch (err) {
                console.error(`Failed to read locale file ${file.fsPath}:`, err);
                return;
            }
            if (!text) return;

            const ext = path.extname(file.fsPath).toLowerCase();
            if (ext === '.json') {
                const json = parseLocaleJson(text);
                if (json === null) {
                    console.error(`Failed to parse JSON in ${file.fsPath}`);
                    return;
                }
                const locale = this.inferLocaleFromPath(file);
                if (!locale) {
                    return;
                }
                this.walkJson('', json, locale, file);
            } else if (ext === '.php') {
                const info = this.inferLaravelLocaleAndRoot(file);
                if (!info) {
                    return;
                }
                this.walkLaravelPhpFile(text, info.locale, file, info.root);
            } else if (ext === '.resx') {
                const locale = this.inferDotNetLocaleFromResxPath(file);
                if (!locale) {
                    return;
                }
                this.walkResxFile(text, locale, file);
            } else if (ext === '.po') {
                const locale = this.inferPoLocaleFromPath(file);
                if (!locale) {
                    return;
                }
                this.walkPoFile(text, locale, file);
            }
        });
    }

    private registerTranslation(
        locale: string,
        uri: vscode.Uri,
        key: string,
        value: string,
    ): void {
        const debugEnabled = vscode.workspace.getConfiguration('ai-localizer').get<boolean>('debug.enabled');
        
        if (debugEnabled && locale === this.defaultLocale) {
            console.log(`[I18nIndex] Registering default locale translation: key='${key}', locale='${locale}', value='${value}'`);
        }
        
        let record = this.keyMap.get(key);
        if (!record) {
            record = {
                key,
                locales: new Map<string, string>(),
                defaultLocale: this.defaultLocale,
                locations: [],
                localeSourcePriority: new Map<string, number>(),
            };
            this.keyMap.set(key, record);
        }
        const locationPriority = this.getLocationPriority(uri);

        if (!record.localeSourcePriority) {
            record.localeSourcePriority = new Map<string, number>();
        }

        const previousPriority = record.localeSourcePriority.get(locale);
        if (previousPriority === undefined || locationPriority <= previousPriority) {
            record.locales.set(locale, value);
            record.localeSourcePriority.set(locale, locationPriority);
        }
        
        const uriStr = uri.toString();
        // Use string comparison for faster location lookup
        const locationKey = `${locale}:${uriStr}`;
        if (!record.locations.some((l) => `${l.locale}:${l.uri.toString()}` === locationKey)) {
            const newLocation = { locale, uri };
            let inserted = false;
            for (let i = 0; i < record.locations.length; i += 1) {
                const existing = record.locations[i];
                if (existing.locale !== locale) {
                    continue;
                }
                const existingPriority = this.getLocationPriority(existing.uri);
                if (locationPriority < existingPriority) {
                    record.locations.splice(i, 0, newLocation);
                    inserted = true;
                    break;
                }
            }
            if (!inserted) {
                record.locations.push(newLocation);
            }
        }

        const fileKey = uriStr;
        let entry = this.fileToKeys.get(fileKey);
        if (!entry) {
            entry = { locale, keys: [] };
            this.fileToKeys.set(fileKey, entry);
        }
        // Use Set for O(1) key deduplication via casting
        const entryAny = entry as any;
        if (!entryAny.keySet) {
            entryAny.keySet = new Set<string>(entry.keys);
        }
        if (!entryAny.keySet.has(key)) {
            entryAny.keySet.add(key);
            entry.keys.push(key);
        }
    }

    private getLocationPriority(uri: vscode.Uri): number {
        const ext = path.extname(uri.fsPath).toLowerCase();
        if (ext === '.json') {
            return 0;
        }
        if (ext === '.resx' || ext === '.po') {
            return 1;
        }
        if (ext === '.php') {
            return 2;
        }
        return 3;
    }

    private inferLocaleFromPath(uri: vscode.Uri): string | null {
        return inferJsonLocaleFromUri(uri);
    }

    private inferPoLocaleFromPath(uri: vscode.Uri): string | null {
        const parts = uri.fsPath.split(path.sep).filter(Boolean);
        const markers = ['locale', 'locales', 'translations'];

        for (const marker of markers) {
            const idx = parts.lastIndexOf(marker);
            if (idx >= 0 && idx + 1 < parts.length) {
                const candidate = parts[idx + 1];
                if (/^[A-Za-z0-9_@.-]+$/.test(candidate)) {
                    return candidate;
                }
            }
        }

        return null;
    }

    private inferDotNetLocaleFromResxPath(uri: vscode.Uri): string | null {
        const fileName = path.basename(uri.fsPath);

        // Match patterns like:
        //   - Resources.en.resx
        //   - SharedResources.fr-FR.resx
        //   - Views.Home.de.resx
        const match = fileName.match(/^(.+?)\.([A-Za-z]{2}(?:-[A-Za-z0-9]{2,})?)\.resx$/);
        if (match) {
            return match[2];
        }

        // Fallback: treat culture-neutral .resx as default locale
        if (/^.+\.resx$/i.test(fileName)) {
            return this.defaultLocale;
        }

        return null;
    }

    private async folderLooksLikeLaravel(folder: vscode.WorkspaceFolder): Promise<boolean> {
        const projectConfig = await this.projectConfigService.readConfig(folder);
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const debugEnabled = config.get<boolean>('debug.enabled');
        
        if (debugEnabled) {
            console.log(`[I18nIndex] Project config for ${folder.uri.fsPath}:`, projectConfig);
        }
        
        // If project explicitly configures locales, trust that over heuristics
        if (projectConfig?.locales?.length) {
            if (debugEnabled) {
                console.log(`[I18nIndex] Project has explicit locale config, not using Laravel heuristics`);
            }
            return false;
        }
        const profile = await detectFrameworkProfile(folder);
        if (debugEnabled) {
            console.log(`[I18nIndex] Framework profile for ${folder.uri.fsPath}:`, profile);
            console.log(`[I18nIndex] Folder ${folder.uri.fsPath} detected as Laravel: ${profile?.kind === 'laravel'}`);
        }
        return profile?.kind === 'laravel';
    }

    private async folderHasPhpFiles(folder: vscode.WorkspaceFolder): Promise<boolean> {
        try {
            const pattern = new vscode.RelativePattern(folder, '**/*.php');
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1);
            return files.length > 0;
        } catch {
            return false;
        }
    }

    private inferLaravelLocaleAndRoot(uri: vscode.Uri): { locale: string; root: string } | null {
        const parts = uri.fsPath.split(path.sep).filter(Boolean);
        const langIndex = parts.lastIndexOf('lang');
        if (langIndex < 0 || langIndex + 2 >= parts.length) {
            return null;
        }

        const locale = parts[langIndex + 1];
        const afterLocale = parts.slice(langIndex + 2);
        if (afterLocale.length === 0) {
            return null;
        }

        const fileName = afterLocale[afterLocale.length - 1];
        const baseName = path.basename(fileName, '.php');
        const prefixParts = afterLocale.slice(0, afterLocale.length - 1);
        prefixParts.push(baseName);
        const root = prefixParts.join('.');

        if (!locale || !root) {
            return null;
        }

        return { locale, root };
    }

    private decodeLocaleText(data: Uint8Array): string | null {
        if (!data || data.length === 0) {
            return '';
        }

        // Fast path: no NUL bytes, assume UTF-8
        let hasNul = false;
        for (let i = 0; i < data.length; i += 1) {
            if (data[i] === 0) {
                hasNul = true;
                break;
            }
        }
        // Strip UTF-8 BOM (EF BB BF) before decoding.
        let utf8Start = 0;
        if (
            data.length >= 3 &&
            data[0] === 0xef &&
            data[1] === 0xbb &&
            data[2] === 0xbf
        ) {
            utf8Start = 3;
        }

        if (!hasNul) {
            try {
                const decoded = sharedDecoder.decode(utf8Start ? data.subarray(utf8Start) : data);
                return stripUtf8Bom(decoded);
            } catch (err) {
                console.error('Failed to decode locale file as UTF-8:', err);
                return null;
            }
        }

        // Heuristic: treat as UTF-16LE (common for Windows "Unicode" files).
        // Strip BOM if present (FF FE)
        let start = 0;
        if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
            start = 2;
        }
        const codeUnits: number[] = [];
        for (let i = start; i + 1 < data.length; i += 2) {
            const cu = data[i] | (data[i + 1] << 8);
            codeUnits.push(cu);
        }
        try {
            return stripUtf8Bom(String.fromCharCode(...codeUnits));
        } catch (err) {
            console.error('Failed to decode locale file as UTF-16LE:', err);
            return null;
        }
    }

    private walkJson(prefix: string, node: unknown, locale: string, uri: vscode.Uri): void {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (Array.isArray(node)) {
            // Handle go-i18n style catalogs: an array of objects with id/key and translation/message fields.
            for (const element of node) {
                if (!element || typeof element !== 'object' || Array.isArray(element)) {
                    continue;
                }
                const obj = element as Record<string, unknown>;
                const idValue =
                    typeof obj.id === 'string'
                        ? obj.id
                        : typeof obj.key === 'string'
                        ? obj.key
                        : null;
                if (!idValue) {
                    continue;
                }
                const rawValue =
                    (obj.translation as unknown) ??
                    (obj.message as unknown) ??
                    (obj.text as unknown) ??
                    (obj.other as unknown);
                if (typeof rawValue !== 'string' || !rawValue.trim()) {
                    continue;
                }
                const key = prefix ? `${prefix}.${idValue}` : idValue;
                this.registerTranslation(locale, uri, key, rawValue);
            }
            return;
        }

        const recordNode = node as Record<string, unknown>;
        for (const [key, value] of Object.entries(recordNode)) {
            const nextKey = prefix ? `${prefix}.${key}` : key;
            if (typeof value === 'string') {
                this.registerTranslation(locale, uri, nextKey, value);
            } else if (value && typeof value === 'object') {
                this.walkJson(nextKey, value, locale, uri);
            }
        }
    }

    private walkPoFile(text: string, locale: string, uri: vscode.Uri): void {
        const lines = text.split(/\r?\n/);
        let currentMsgIdParts: string[] | null = null;
        let currentMsgStrParts: string[] | null = null;
        let inMsgId = false;
        let inMsgStr = false;

        const decodePoString = (input: string): string => {
            const match = input.match(/"([\s\S]*)"/);
            if (!match) {
                return '';
            }
            let s = match[1];
            s = s.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
            return s;
        };

        const flushEntry = () => {
            if (!currentMsgIdParts) {
                return;
            }
            const msgid = currentMsgIdParts.join('');
            if (!msgid) {
                currentMsgIdParts = null;
                currentMsgStrParts = null;
                inMsgId = false;
                inMsgStr = false;
                return;
            }
            const msgstr =
                currentMsgStrParts && currentMsgStrParts.length > 0
                    ? currentMsgStrParts.join('')
                    : msgid;

            const key = msgid;
            const value = msgstr;
            if (key) {
                this.registerTranslation(locale, uri, key, value);
            }

            currentMsgIdParts = null;
            currentMsgStrParts = null;
            inMsgId = false;
            inMsgStr = false;
        };

        for (const rawLine of lines) {
            const line = rawLine.trim();

            if (!line) {
                flushEntry();
                continue;
            }

            if (line.startsWith('#')) {
                // Comment line; does not affect current entry
                continue;
            }

            if (line.startsWith('msgid ')) {
                flushEntry();
                inMsgId = true;
                inMsgStr = false;
                currentMsgIdParts = [];
                currentMsgStrParts = null;
                const str = decodePoString(line.slice('msgid '.length));
                currentMsgIdParts.push(str);
                continue;
            }

            if (line.startsWith('msgid_plural')) {
                // Ignore plural ids; keep using the singular msgid as the key
                continue;
            }

            if (line.startsWith('msgstr')) {
                inMsgId = false;
                inMsgStr = true;
                currentMsgStrParts = [];
                const idx = line.indexOf('"');
                if (idx >= 0) {
                    const str = decodePoString(line.slice(idx));
                    currentMsgStrParts.push(str);
                }
                continue;
            }

            if (line.startsWith('msgstr[')) {
                inMsgId = false;
                inMsgStr = true;
                if (!currentMsgStrParts) {
                    currentMsgStrParts = [];
                }
                const idx = line.indexOf('"');
                if (idx >= 0) {
                    const str = decodePoString(line.slice(idx));
                    currentMsgStrParts.push(str);
                }
                continue;
            }

            if (line.startsWith('"')) {
                const str = decodePoString(line);
                if (inMsgId && currentMsgIdParts) {
                    currentMsgIdParts.push(str);
                } else if (inMsgStr && currentMsgStrParts) {
                    currentMsgStrParts.push(str);
                }
            }
        }

        flushEntry();
    }

    private walkResxFile(text: string, locale: string, uri: vscode.Uri): void {
        // Lightweight RESX parser: extract <data name="Key"><value>Text</value></data>
        const dataRegex = /<data\s+[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/data>/gi;
        let match: RegExpExecArray | null;

        const decodeEntities = (input: string): string => {
            return input
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'");
        };

        while ((match = dataRegex.exec(text)) !== null) {
            const name = match[1];
            const body = match[2];
            const valueMatch = /<value[^>]*>([\s\S]*?)<\/value>/i.exec(body);
            if (!valueMatch) {
                continue;
            }
            const rawValue = valueMatch[1].trim();
            if (!rawValue) {
                continue;
            }
            const normalized = decodeEntities(rawValue.replace(/\r?\n+/g, ' ').trim());
            if (!normalized) {
                continue;
            }
            this.registerTranslation(locale, uri, name, normalized);
        }
    }

    private walkLaravelPhpFile(text: string, locale: string, uri: vscode.Uri, rootPrefix: string): void {
        const length = text.length;
        const returnMatch = /return[\s\S]*?(\[|array\s*\()/i.exec(text);
        if (!returnMatch) {
            return;
        }

        let index = returnMatch.index;

        const skipWhitespaceAndComments = (start: number): number => {
            let pos = start;
            while (pos < length) {
                const ch = text[pos];
                if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
                    pos += 1;
                    continue;
                }
                if (ch === '/' && pos + 1 < length) {
                    const next = text[pos + 1];
                    if (next === '/') {
                        pos += 2;
                        while (pos < length && text[pos] !== '\n') {
                            pos += 1;
                        }
                        continue;
                    }
                    if (next === '*') {
                        pos += 2;
                        while (pos + 1 < length && !(text[pos] === '*' && text[pos + 1] === '/')) {
                            pos += 1;
                        }
                        if (pos + 1 < length) {
                            pos += 2;
                        }
                        continue;
                    }
                }
                break;
            }
            return pos;
        };

        const parseString = (start: number): { value: string; next: number } | null => {
            const quote = text[start];
            if (quote !== '\'' && quote !== '"') {
                return null;
            }
            let pos = start + 1;
            let result = '';
            while (pos < length) {
                const ch = text[pos];
                if (ch === '\\') {
                    if (pos + 1 < length) {
                        const nextCh = text[pos + 1];
                        result += nextCh;
                        pos += 2;
                        continue;
                    }
                    pos += 1;
                    continue;
                }
                if (ch === quote) {
                    return { value: result, next: pos + 1 };
                }
                result += ch;
                pos += 1;
            }
            return null;
        };

        const parseArray = (startIndex: number, prefix: string): number => {
            let pos = startIndex;
            const open = text[pos];
            const close = open === '[' ? ']' : ')';
            pos += 1;

            while (pos < length) {
                pos = skipWhitespaceAndComments(pos);
                if (pos >= length) {
                    break;
                }
                const ch = text[pos];
                if (ch === close) {
                    return pos + 1;
                }
                if (ch === ',') {
                    pos += 1;
                    continue;
                }

                const keyLit = parseString(pos);
                if (!keyLit) {
                    while (pos < length && text[pos] !== ',' && text[pos] !== close) {
                        pos += 1;
                    }
                    continue;
                }
                const key = keyLit.value;
                pos = skipWhitespaceAndComments(keyLit.next);

                if (text.slice(pos, pos + 2) !== '=>') {
                    while (pos < length && text[pos] !== ',' && text[pos] !== close) {
                        pos += 1;
                    }
                    continue;
                }

                pos += 2;
                pos = skipWhitespaceAndComments(pos);
                if (pos >= length) {
                    break;
                }

                const valueChar = text[pos];
                const currentPrefix = prefix ? `${prefix}.${key}` : key;

                if (valueChar === '\'' || valueChar === '"') {
                    const valueLit = parseString(pos);
                    if (valueLit) {
                        const fullKey = rootPrefix ? `${rootPrefix}.${currentPrefix}` : currentPrefix;
                        this.registerTranslation(locale, uri, fullKey, valueLit.value);
                        pos = valueLit.next;
                    }
                } else if (valueChar === '[') {
                    pos = parseArray(pos, currentPrefix);
                } else if (
                    (valueChar === 'a' || valueChar === 'A') &&
                    text.slice(pos, pos + 5).toLowerCase() === 'array'
                ) {
                    let j = pos + 5;
                    j = skipWhitespaceAndComments(j);
                    if (text[j] === '(') {
                        pos = parseArray(j, currentPrefix);
                    } else {
                        pos = j;
                    }
                } else {
                    while (pos < length && text[pos] !== ',' && text[pos] !== close) {
                        pos += 1;
                    }
                }
            }

            return pos;
        };

        while (index < length && text[index] !== '[' && text[index] !== '(') {
            index += 1;
        }
        if (index >= length) {
            return;
        }

        index = skipWhitespaceAndComments(index);
        if (index >= length) {
            return;
        }

        const ch = text[index];
        if (ch === '[' || ch === '(') {
            parseArray(index, '');
        }
    }

    getRecord(key: string): TranslationRecord | undefined {
        return this.keyMap.get(key);
    }

    getAllKeys(): string[] {
        return Array.from(this.keyMap.keys());
    }

    getKeysForFile(uri: vscode.Uri): { locale: string; keys: string[] } | null {
        const entry = this.fileToKeys.get(uri.toString());
        return entry || null;
    }

    /**
     * Return the set of all locales present across the workspace, derived from file-to-keys map.
     */
    getAllLocales(): string[] {
        const set = new Set<string>();
        for (const entry of this.fileToKeys.values()) {
            if (entry?.locale) {
                set.add(entry.locale);
            }
        }
        return Array.from(set);
    }

    async updateFile(uri: vscode.Uri): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-localizer');
        this.defaultLocale = config.get<string>('i18n.defaultLocale') || 'en';

        const fileKey = uri.toString();
        const existing = this.fileToKeys.get(fileKey);
        const existingLocale = existing?.locale;
        
        if (existing) {
            for (const key of existing.keys) {
                const record = this.keyMap.get(key);
                if (!record) {
                    continue;
                }
                record.locations = record.locations.filter(
                    (loc) => loc.uri.toString() !== fileKey,
                );
                record.locales.delete(existing.locale);
                if (record.locales.size === 0) {
                    this.keyMap.delete(key);
                }
            }
            // Don't delete fileToKeys entry yet - we'll update it below
        }

        let stat: vscode.FileStat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        } catch {
            // File was deleted; contributions have already been removed.
            this.fileToKeys.delete(fileKey);
            return;
        }

        if (typeof stat?.size === 'number' && stat.size > MAX_LOCALE_FILE_SIZE_BYTES) {
            return;
        }

        let text: string | null = null;
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            text = this.decodeLocaleText(data);
        } catch (err) {
            console.error(`Failed to read locale file ${uri.fsPath}:`, err);
            return;
        }
        if (!text) return;

        const ext = path.extname(uri.fsPath).toLowerCase();
        if (ext === '.json') {
            const json = parseLocaleJson(text);
            if (json === null) {
                console.error(`Failed to parse JSON in ${uri.fsPath}`);
                return;
            }

            const locale = this.inferLocaleFromPath(uri) || existingLocale;
            if (!locale || typeof locale !== 'string' || !locale.trim()) {
                // Can't determine locale, remove the entry
                this.fileToKeys.delete(fileKey);
                return;
            }

            // Always set/update the fileToKeys entry, even if no keys are found
            // This preserves locale information for empty files
            this.fileToKeys.set(fileKey, { locale: locale.trim(), keys: [] });

            this.walkJson('', json, locale, uri);
        } else if (ext === '.php') {
            const info = this.inferLaravelLocaleAndRoot(uri);
            const locale = info?.locale || existingLocale;
            if (!info || !locale || typeof locale !== 'string' || !locale.trim()) {
                this.fileToKeys.delete(fileKey);
                return;
            }

            this.fileToKeys.set(fileKey, { locale: locale.trim(), keys: [] });

            this.walkLaravelPhpFile(text, locale, uri, info.root);
        } else if (ext === '.resx') {
            const locale = this.inferDotNetLocaleFromResxPath(uri) || existingLocale;
            if (!locale || typeof locale !== 'string' || !locale.trim()) {
                this.fileToKeys.delete(fileKey);
                return;
            }

            this.fileToKeys.set(fileKey, { locale: locale.trim(), keys: [] });

            this.walkResxFile(text, locale, uri);
        } else if (ext === '.po') {
            const locale = this.inferPoLocaleFromPath(uri) || existingLocale;
            if (!locale || typeof locale !== 'string' || !locale.trim()) {
                this.fileToKeys.delete(fileKey);
                return;
            }

            this.fileToKeys.set(fileKey, { locale: locale.trim(), keys: [] });

            this.walkPoFile(text, locale, uri);
        }
    }

    /**
     * Find known translations for a given base-locale text across all keys.
     * This is used to auto-reuse translations when the same UI string appears
     * again (e.g. "Hide Password" / "Show Password").
     */
    findTranslationsForBaseText(baseText: string, defaultLocaleOverride?: string): Map<string, string> {
        const result = new Map<string, string>();
        if (!baseText) {
            return result;
        }

        const baseLocale = defaultLocaleOverride || this.defaultLocale;

        for (const record of this.keyMap.values()) {
            const baseValue = record.locales.get(baseLocale);
            if (baseValue !== baseText) {
                continue;
            }

            for (const [locale, value] of record.locales.entries()) {
                if (locale === baseLocale) {
                    continue;
                }
                if (typeof value !== 'string' || !value.trim()) {
                    continue;
                }

                const existing = result.get(locale);
                if (!existing) {
                    result.set(locale, value);
                } else if (existing === value) {
                    // Same value seen again – fine, keep it.
                } else {
                    // Conflicting translations for the same base text. To avoid
                    // surprising overwrites, keep the first one we saw.
                }
            }
        }

        return result;
    }
}

export function extractKeyAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
): { key: string; range: vscode.Range } | null {
    const line = document.lineAt(position.line).text;
    if (!line) return null;

    // Clamp initial index to the line bounds
    let index = position.character;
    if (index >= line.length) {
        index = line.length - 1;
    }
    if (index < 0) {
        index = 0;
    }

    // Scan left to find the opening quote for the key. We deliberately
    // skip quote characters that look like closing quotes (i.e. the
    // character immediately after them is not an identifier character),
    // so that positions just after the string still resolve correctly.
    let quoteIndex = index;
    let quoteChar: string | null = null;
    while (quoteIndex >= 0) {
        const ch = line[quoteIndex];
        if (ch === '\'' || ch === '"') {
            const nextCh = line[quoteIndex + 1];
            if (nextCh && /[A-Za-z0-9_.-]/.test(nextCh)) {
                quoteChar = ch;
                break;
            }
        }
        quoteIndex -= 1;
    }

    if (quoteChar === null) {
        return null;
    }

    const start = quoteIndex + 1;
    let right = start;
    while (right < line.length && line[right] !== quoteChar) {
        right += 1;
    }

    const keyText = line.slice(start, right);
    if (!keyText || !/^[A-Za-z0-9_.-]+$/.test(keyText)) {
        return null;
    }

    const range = new vscode.Range(
        new vscode.Position(position.line, start),
        new vscode.Position(position.line, right),
    );
    return { key: keyText, range };
}

export function escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_{}[\]()#+\-.!])/g, '\\$1');
}

function stableHashForSlug(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
        const ch = input.charCodeAt(i);
        hash = (hash << 5) - hash + ch;
        hash |= 0;
    }
    return Math.abs(hash).toString(36).slice(0, 8);
}

export function slugifyForKey(text: string, maxWords = 4, maxLength = 48): string {
    const original = String(text || '');
    const normalized = original
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '');
    const words = normalized.toLowerCase().match(/[a-z0-9]+/g) || [];
    const sliced = words.slice(0, maxWords);
    let slug = sliced.join('_');
    if (!slug) {
        const trimmed = original.trim();
        if (trimmed) {
            slug = `text_${stableHashForSlug(trimmed)}`;
        } else {
            slug = 'text';
        }
    }
    if (slug.length > maxLength) {
        slug = slug.slice(0, maxLength).replace(/_+$/, '');
    }
    return slug;
}
