import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';

// Shared encoder/decoder instances to avoid repeated allocations
export const sharedDecoder = new TextDecoder('utf-8');
export const sharedEncoder = new TextEncoder();

// Cache for locale directory lookups (cleared on workspace change)
const localeDirCache = new Map<string, vscode.Uri>();

// Simple file-level mutex for preventing concurrent writes to the same file
const fileMutex = new Map<string, Promise<void>>();
const mutexTimeout = 30000; // 30 second max wait

/**
 * Acquire a file-level lock for writing operations.
 * Ensures only one write operation can occur at a time for a given file.
 */
export async function withFileMutex<T>(fileUri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
    const key = fileUri.toString();
    
    // Wait for any existing operation on this file
    let existing = fileMutex.get(key);
    if (existing) {
        const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error(`File lock timeout: ${fileUri.fsPath}`)), mutexTimeout);
        });
        try {
            await Promise.race([existing, timeoutPromise]);
        } catch {
            // Previous operation timed out or failed, proceed anyway
        }
    }
    
    // Create our lock
    let resolver: () => void;
    const ourLock = new Promise<void>((resolve) => {
        resolver = resolve;
    });
    fileMutex.set(key, ourLock);
    
    try {
        return await operation();
    } finally {
        resolver!();
        // Only delete if it's still our lock (prevent race with next operation)
        if (fileMutex.get(key) === ourLock) {
            fileMutex.delete(key);
        }
    }
}

/**
 * Clear the locale directory cache. Call when workspace folders change.
 */
export function clearLocaleDirCache(): void {
    localeDirCache.clear();
}

function toPascalCase(input: string): string {
    const words = String(input || '')
        .replace(/[-_]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return '';
    return words
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');
}

export function deriveNamespaceFromFile(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
    const root = folder.uri.fsPath;
    const full = uri.fsPath;
    let rel = path.relative(root, full);
    const normalized = rel.replace(/\\/g, '/');
    const candidates = ['resources/js', 'src', 'resources/views'];
    for (const marker of candidates) {
        const idx = normalized.indexOf(`${marker}/`);
        if (idx !== -1) {
            rel = normalized.slice(idx + marker.length + 1);
            break;
        }
    }
    rel = rel.replace(/\\/g, '/');
    const withoutExt = rel.replace(/\.[^.]+$/, '');
    const rawSegments = withoutExt.split('/').filter(Boolean);
    const filteredSegments = rawSegments.filter((segment, index) => {
        const lower = segment.toLowerCase();
        if (index === 0 && (lower === 'pages' || lower === 'components')) {
            return false;
        }
        return true;
    });
    const segments = (filteredSegments.length ? filteredSegments : rawSegments)
        .map((segment) => toPascalCase(segment))
        .filter(Boolean);
    if (!segments.length) {
        return 'Common';
    }
    return segments.join('.');
}

export function deriveRootFromFile(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
    const full = uri.fsPath.replace(/\\/g, '/');
    if (full.includes('/resources/views/')) {
        return 'views';
    }

    const jsMarker = '/resources/js/';
    const srcMarker = '/src/';
    let tail: string | null = null;

    const jsIndex = full.indexOf(jsMarker);
    if (jsIndex !== -1) {
        tail = full.slice(jsIndex + jsMarker.length);
    } else {
        const srcIndex = full.indexOf(srcMarker);
        if (srcIndex !== -1) {
            tail = full.slice(srcIndex + srcMarker.length);
        }
    }

    if (tail) {
        const parts = tail.split('/').filter(Boolean);
        if (parts.length) {
            return parts[0].toLowerCase();
        }
    }

    const root = folder.uri.fsPath;
    const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/');
    const parts = rel.split('/').filter(Boolean);
    if (parts.length) {
        return parts[0].toLowerCase();
    }
    return 'common';
}

function decodeLocaleText(data: Uint8Array): string | null {
    if (!data || data.length === 0) {
        return '';
    }

    let hasNul = false;
    for (let i = 0; i < data.length; i += 1) {
        if (data[i] === 0) {
            hasNul = true;
            break;
        }
    }

    if (!hasNul) {
        try {
            return sharedDecoder.decode(data);
        } catch (err) {
            console.error('Failed to decode locale file as UTF-8:', err);
            return null;
        }
    }

    // Heuristic: treat as UTF-16LE (common for Windows "Unicode" files)
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
        return String.fromCharCode(...codeUnits);
    } catch (err) {
        console.error('Failed to decode locale file as UTF-16LE:', err);
        return null;
    }
}

type LocaleWriteTarget =
    | { mode: 'file'; fileUri: vscode.Uri }
    | { mode: 'dir'; localeDir: vscode.Uri };

async function resolveLocaleWriteTarget(
    folder: vscode.WorkspaceFolder,
    locale: string,
): Promise<LocaleWriteTarget> {
    const cfg = vscode.workspace.getConfiguration('ai-localizer', folder.uri);
    const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';
    const bases = ['resources/js/i18n/auto', 'src/i18n', 'src/locales', 'locales', 'i18n'];

    for (const base of bases) {
        const baseUri = vscode.Uri.file(path.join(folder.uri.fsPath, base));
        try {
            const stat = await vscode.workspace.fs.stat(baseUri);
            if (stat.type !== vscode.FileType.Directory) {
                continue;
            }
        } catch {
            continue;
        }

        const localeDirUri = vscode.Uri.file(path.join(baseUri.fsPath, locale));
        try {
            const dirStat = await vscode.workspace.fs.stat(localeDirUri);
            if (dirStat.type === vscode.FileType.Directory) {
                return { mode: 'dir', localeDir: localeDirUri };
            }
        } catch {
        }

        const localeFileUri = vscode.Uri.file(path.join(baseUri.fsPath, `${locale}.json`));
        try {
            const fileStat = await vscode.workspace.fs.stat(localeFileUri);
            if (fileStat.type === vscode.FileType.File) {
                return { mode: 'file', fileUri: localeFileUri };
            }
        } catch {
        }

        // If the base dir uses single-file locales (<locale>.json at the base),
        // treat this locale as single-file even if it doesn't exist yet.
        const baseLocaleFileUri = vscode.Uri.file(
            path.join(baseUri.fsPath, `${defaultLocale}.json`),
        );
        try {
            const baseFileStat = await vscode.workspace.fs.stat(baseLocaleFileUri);
            if (baseFileStat.type === vscode.FileType.File) {
                return { mode: 'file', fileUri: localeFileUri };
            }
        } catch {
        }
    }

    const localeDir = await findOrCreateLocaleDir(folder, locale);
    return { mode: 'dir', localeDir };
}

async function readLocaleJsonObject(fileUri: vscode.Uri): Promise<{ root: any; ok: boolean }> {
    try {
        const data = await vscode.workspace.fs.readFile(fileUri);
        const decoded = decodeLocaleText(data);
        if (decoded === null) {
            return { root: {}, ok: false };
        }
        const trimmed = decoded.trim();
        if (!trimmed) {
            return { root: {}, ok: true };
        }
        const parsed = JSON.parse(decoded);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { root: {}, ok: false };
        }
        return { root: parsed, ok: true };
    } catch (err) {
        const anyErr: any = err;
        if (anyErr && typeof anyErr.code === 'string' && anyErr.code === 'FileNotFound') {
            return { root: {}, ok: true };
        }
        return { root: {}, ok: false };
    }
}

async function findOrCreateLocaleDir(folder: vscode.WorkspaceFolder, locale: string): Promise<vscode.Uri> {
    // Check cache first
    const cacheKey = `${folder.uri.fsPath}::${locale}`;
    const cached = localeDirCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const bases = ['resources/js/i18n/auto', 'src/i18n', 'src/locales', 'locales', 'i18n'];
    for (const base of bases) {
        const baseUri = vscode.Uri.file(path.join(folder.uri.fsPath, base));
        try {
            const stat = await vscode.workspace.fs.stat(baseUri);
            if (stat.type === vscode.FileType.Directory) {
                const localeUri = vscode.Uri.file(path.join(baseUri.fsPath, locale));
                try {
                    const locStat = await vscode.workspace.fs.stat(localeUri);
                    if (locStat.type === vscode.FileType.Directory) {
                        localeDirCache.set(cacheKey, localeUri);
                        return localeUri;
                    }
                } catch {
                    await vscode.workspace.fs.createDirectory(localeUri);
                    localeDirCache.set(cacheKey, localeUri);
                    return localeUri;
                }
            }
        } catch {
        }
    }
    const fallback = vscode.Uri.file(path.join(folder.uri.fsPath, 'resources/js/i18n/auto', locale));
    await vscode.workspace.fs.createDirectory(fallback);
    localeDirCache.set(cacheKey, fallback);
    return fallback;
}

async function findOrCreateLaravelLocaleDir(
    folder: vscode.WorkspaceFolder,
    locale: string,
): Promise<vscode.Uri> {
    const cacheKey = `${folder.uri.fsPath}::laravel::${locale}`;
    const cached = localeDirCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const roots = ['lang', path.join('resources', 'lang')];
    for (const root of roots) {
        const baseDir = path.join(folder.uri.fsPath, root);
        const baseUri = vscode.Uri.file(baseDir);
        try {
            const stat = await vscode.workspace.fs.stat(baseUri);
            if (stat.type === vscode.FileType.Directory) {
                const localeUri = vscode.Uri.file(path.join(baseDir, locale));
                try {
                    const locStat = await vscode.workspace.fs.stat(localeUri);
                    if (locStat.type === vscode.FileType.Directory) {
                        localeDirCache.set(cacheKey, localeUri);
                        return localeUri;
                    }
                } catch {
                    await vscode.workspace.fs.createDirectory(localeUri);
                    localeDirCache.set(cacheKey, localeUri);
                    return localeUri;
                }
            }
        } catch {
        }
    }

    // Fallback: create lang/<locale>
    const fallbackBase = path.join(folder.uri.fsPath, 'lang');
    const fallbackBaseUri = vscode.Uri.file(fallbackBase);
    try {
        await vscode.workspace.fs.createDirectory(fallbackBaseUri);
    } catch {
    }
    const fallbackLocaleUri = vscode.Uri.file(path.join(fallbackBase, locale));
    try {
        await vscode.workspace.fs.createDirectory(fallbackLocaleUri);
    } catch {
    }
    localeDirCache.set(cacheKey, fallbackLocaleUri);
    return fallbackLocaleUri;
}

function serializePhpValue(node: any, indentLevel: number): string {
    const indentUnit = '    ';
    const indent = indentUnit.repeat(indentLevel);
    const childIndent = indentUnit.repeat(indentLevel + 1);

    if (typeof node === 'string') {
        const escaped = node.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `'${escaped}'`;
    }

    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return '[]';
    }

    const keys = Object.keys(node);
    if (!keys.length) {
        return '[]';
    }

    let result = '[\n';
    for (const key of keys) {
        const value = (node as any)[key];
        result += `${childIndent}'${key}' => ${serializePhpValue(value, indentLevel + 1)},\n`;
    }
    result += `${indent}]`;
    return result;
}

function parseLaravelPhpArray(text: string): { preamble: string; root: any } {
    const length = text.length;
    const match = /return[\s\S]*?(\[|array\s*\()/i.exec(text);
    if (!match) {
        return { preamble: text.trimEnd(), root: {} };
    }

    const preamble = text.slice(0, match.index).trimEnd();
    let index = match.index;

    while (index < length && text[index] !== '[' && text[index] !== '(') {
        index += 1;
    }
    if (index >= length) {
        return { preamble, root: {} };
    }

    const root: any = {};

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
                    while (pos < length && text[pos] !== '\n') pos += 1;
                    continue;
                }
                if (next === '*') {
                    pos += 2;
                    while (pos + 1 < length && !(text[pos] === '*' && text[pos + 1] === '/')) pos += 1;
                    if (pos + 1 < length) pos += 2;
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

    const parseArray = (startIndex: number, target: any): number => {
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
            if (valueChar === '\'' || valueChar === '"') {
                const valueLit = parseString(pos);
                if (valueLit) {
                    target[key] = valueLit.value;
                    pos = valueLit.next;
                }
            } else if (valueChar === '[') {
                const child: any = {};
                pos = parseArray(pos, child);
                target[key] = child;
            } else if (
                (valueChar === 'a' || valueChar === 'A') &&
                text.slice(pos, pos + 5).toLowerCase() === 'array'
            ) {
                let j = pos + 5;
                j = skipWhitespaceAndComments(j);
                if (text[j] === '(') {
                    const child: any = {};
                    pos = parseArray(j, child);
                    target[key] = child;
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

    if (text[index] === '[' || text[index] === '(') {
        parseArray(index, root);
    }

    return { preamble, root };
}

function inferLaravelRootFromUri(uri: vscode.Uri): string | null {
    const parts = uri.fsPath.split(path.sep).filter(Boolean);
    const langIndex = parts.lastIndexOf('lang');
    if (langIndex < 0 || langIndex + 2 >= parts.length) {
        return null;
    }

    const afterLocale = parts.slice(langIndex + 2);
    if (afterLocale.length === 0) {
        return null;
    }

    const fileName = afterLocale[afterLocale.length - 1];
    const baseName = path.basename(fileName, '.php');
    const prefixParts = afterLocale.slice(0, afterLocale.length - 1);
    prefixParts.push(baseName);
    const root = prefixParts.join('.');

    if (!root) {
        return null;
    }

    return root;
}

export async function readLaravelKeyValueFromFile(
    fileUri: vscode.Uri,
    fullKey: string,
): Promise<string | undefined> {
    let text = '';
    try {
        const data = await vscode.workspace.fs.readFile(fileUri);
        const decoded = decodeLocaleText(data);
        if (!decoded) {
            return undefined;
        }
        text = decoded;
    } catch {
        return undefined;
    }

    const { root } = parseLaravelPhpArray(text);
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        return undefined;
    }

    const rootPrefix = inferLaravelRootFromUri(fileUri);
    if (!rootPrefix) {
        return undefined;
    }

    const segments = fullKey.split('.').filter(Boolean);
    const prefixParts = rootPrefix.split('.').filter(Boolean);
    if (!segments.length || segments.length < prefixParts.length) {
        return undefined;
    }

    for (let i = 0; i < prefixParts.length; i += 1) {
        if (segments[i] !== prefixParts[i]) {
            return undefined;
        }
    }

    const relativeSegments = segments.slice(prefixParts.length);
    if (!relativeSegments.length) {
        return undefined;
    }

    const value = getDeepValue(root, relativeSegments);
    return typeof value === 'string' ? value : undefined;
}

function getDeepValue(root: any, segments: string[]): unknown {
    let node: any = root;
    for (const seg of segments) {
        if (!node || typeof node !== 'object') return undefined;
        node = node[seg];
    }
    return node;
}

function ensureDeepContainer(root: any, segments: string[]): any {
    let node: any = root;
    for (const seg of segments) {
        if (!node || typeof node !== 'object') {
            break;
        }
        if (!Object.prototype.hasOwnProperty.call(node, seg) || typeof node[seg] !== 'object' || Array.isArray(node[seg])) {
            node[seg] = {};
        }
        node = node[seg];
    }
    return node;
}

export async function upsertTranslationKey(
    folder: vscode.WorkspaceFolder,
    locale: string,
    fullKey: string,
    value: string,
    options?: { rootName?: string },
): Promise<void> {
    const target = await resolveLocaleWriteTarget(folder, locale);
    const segments = fullKey.split('.').filter(Boolean);

    if (target.mode === 'file') {
        await withFileMutex(target.fileUri, async () => {
            const { root, ok } = await readLocaleJsonObject(target.fileUri);
            if (!ok) {
                throw new Error(`Failed to parse locale JSON: ${target.fileUri.fsPath}`);
            }
            const existing = getDeepValue(root, segments);
            if (typeof existing === 'string') {
                return;
            }
            const container = ensureDeepContainer(root, segments.slice(0, -1));
            const last = segments[segments.length - 1];
            container[last] = value;
            const payload = `${JSON.stringify(root, null, 2)}\n`;
            await vscode.workspace.fs.writeFile(target.fileUri, sharedEncoder.encode(payload));
        });
        return;
    }

    const first = segments[0] || 'Common';
    let fileName: string;
    if (first === 'Commons') {
        fileName = 'commons.json';
    } else if (options?.rootName) {
        fileName = `${options.rootName.toLowerCase()}.json`;
    } else {
        const group = first || 'Common';
        fileName = `${group.toLowerCase()}.json`;
    }

    const fileUri = vscode.Uri.joinPath(target.localeDir, fileName);

    await withFileMutex(fileUri, async () => {
        const { root, ok } = await readLocaleJsonObject(fileUri);
        if (!ok) {
            throw new Error(`Failed to parse locale JSON: ${fileUri.fsPath}`);
        }
        const existing = getDeepValue(root, segments);
        if (typeof existing === 'string') {
            return;
        }
        const container = ensureDeepContainer(root, segments.slice(0, -1));
        const last = segments[segments.length - 1];
        container[last] = value;
        const payload = `${JSON.stringify(root, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(fileUri, sharedEncoder.encode(payload));
    });
}

export async function setTranslationValueInFile(
    fileUri: vscode.Uri,
    fullKey: string,
    value: string,
): Promise<void> {
    await withFileMutex(fileUri, async () => {
        const { root, ok } = await readLocaleJsonObject(fileUri);
        if (!ok) {
            throw new Error(`Failed to parse locale JSON: ${fileUri.fsPath}`);
        }
        const segments = fullKey.split('.').filter(Boolean);
        const container = ensureDeepContainer(root, segments.slice(0, -1));
        const last = segments[segments.length - 1];
        container[last] = value;
        const payload = `${JSON.stringify(root, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(fileUri, sharedEncoder.encode(payload));
    });
}

export async function setLaravelTranslationValue(
    folder: vscode.WorkspaceFolder,
    locale: string,
    fullKey: string,
    value: string,
): Promise<void> {
    const segments = fullKey.split('.').filter(Boolean);
    if (!segments.length) {
        return;
    }
    const group = segments[0];
    const relativeSegments = segments.slice(1);

    const localeDir = await findOrCreateLaravelLocaleDir(folder, locale);
    const fileUri = vscode.Uri.file(path.join(localeDir.fsPath, `${group}.php`));

    await withFileMutex(fileUri, async () => {
        let text = '';
        try {
            const data = await vscode.workspace.fs.readFile(fileUri);
            const decoded = decodeLocaleText(data);
            if (decoded) {
                text = decoded;
            }
        } catch {
            // File doesn't exist yet; we'll create it.
        }

        const { preamble, root } = parseLaravelPhpArray(text || '');
        let obj: any = root && typeof root === 'object' && !Array.isArray(root) ? root : {};

        const container = ensureDeepContainer(obj, relativeSegments.slice(0, -1));
        const last = relativeSegments[relativeSegments.length - 1] || group;
        container[last] = value;

        const arrayCode = serializePhpValue(obj, 1);

        let header = preamble;
        if (!header || !header.includes('<?php')) {
            header = '<?php';
        }
        header = header.trimEnd();

        let final = `${header}\n\nreturn ${arrayCode};\n`;
        await vscode.workspace.fs.writeFile(fileUri, sharedEncoder.encode(final));
    });
}

export async function setTranslationValue(
    folder: vscode.WorkspaceFolder,
    locale: string,
    fullKey: string,
    value: string,
    options?: { rootName?: string },
): Promise<void> {
    const target = await resolveLocaleWriteTarget(folder, locale);
    if (target.mode === 'file') {
        await setTranslationValueInFile(target.fileUri, fullKey, value);
        return;
    }

    const segments = fullKey.split('.').filter(Boolean);
    const first = segments[0] || 'Common';
    let fileName: string;
    if (first === 'Commons') {
        fileName = 'commons.json';
    } else if (options?.rootName) {
        fileName = `${options.rootName.toLowerCase()}.json`;
    } else {
        const group = first || 'Common';
        fileName = `${group.toLowerCase()}.json`;
    }
    const fileUri = vscode.Uri.joinPath(target.localeDir, fileName);

    await withFileMutex(fileUri, async () => {
        const { root, ok } = await readLocaleJsonObject(fileUri);
        if (!ok) {
            throw new Error(`Failed to parse locale JSON: ${fileUri.fsPath}`);
        }
        const container = ensureDeepContainer(root, segments.slice(0, -1));
        const last = segments[segments.length - 1];
        container[last] = value;
        const payload = `${JSON.stringify(root, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(fileUri, sharedEncoder.encode(payload));
    });
}

/**
 * Batch write multiple translations to locale files.
 * Groups updates by target file to minimize I/O operations.
 * This is significantly faster than calling setTranslationValue for each key.
 * Uses file-level locking to prevent race conditions.
 * 
 * @param folder - Workspace folder
 * @param locale - Target locale
 * @param updates - Map of fullKey -> { value, rootName }
 */
export async function setTranslationValuesBatch(
    folder: vscode.WorkspaceFolder,
    locale: string,
    updates: Map<string, { value: string; rootName?: string }>,
): Promise<{ written: number; errors: string[] }> {
    const result = { written: 0, errors: [] as string[] };
    if (!updates.size) {
        return result;
    }

    const target = await resolveLocaleWriteTarget(folder, locale);

    if (target.mode === 'file') {
        try {
            await withFileMutex(target.fileUri, async () => {
                const { root, ok } = await readLocaleJsonObject(target.fileUri);
                if (!ok) {
                    throw new Error(`Failed to parse locale JSON: ${target.fileUri.fsPath}`);
                }

                for (const [fullKey, { value }] of updates.entries()) {
                    const segments = fullKey.split('.').filter(Boolean);
                    const container = ensureDeepContainer(root, segments.slice(0, -1));
                    const last = segments[segments.length - 1];
                    container[last] = value;
                    result.written += 1;
                }

                const payload = `${JSON.stringify(root, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(target.fileUri, sharedEncoder.encode(payload));
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Failed to write ${target.fileUri.fsPath}: ${msg}`);
        }
        return result;
    }

    const localeDir = target.localeDir;

    // Group updates by target file
    const fileUpdates = new Map<string, Map<string, string>>();
    
    for (const [fullKey, { value, rootName }] of updates.entries()) {
        const segments = fullKey.split('.').filter(Boolean);
        const first = segments[0] || 'Common';
        let fileName: string;
        if (first === 'Commons') {
            fileName = 'commons.json';
        } else if (rootName) {
            fileName = `${rootName.toLowerCase()}.json`;
        } else {
            const group = first || 'Common';
            fileName = `${group.toLowerCase()}.json`;
        }

        let fileMap = fileUpdates.get(fileName);
        if (!fileMap) {
            fileMap = new Map<string, string>();
            fileUpdates.set(fileName, fileMap);
        }
        fileMap.set(fullKey, value);
    }

    // Process each file once with file-level locking
    for (const [fileName, keyValues] of fileUpdates.entries()) {
        const fileUri = vscode.Uri.joinPath(localeDir, fileName);
        
        try {
            // Use file mutex to prevent concurrent writes to the same file
            await withFileMutex(fileUri, async () => {
                // Read existing content (fresh read while holding lock)
                const { root, ok } = await readLocaleJsonObject(fileUri);
                if (!ok) {
                    throw new Error(`Failed to parse locale JSON: ${fileUri.fsPath}`);
                }

                // Apply all updates for this file
                for (const [fullKey, value] of keyValues.entries()) {
                    const segments = fullKey.split('.').filter(Boolean);
                    const container = ensureDeepContainer(root, segments.slice(0, -1));
                    const last = segments[segments.length - 1];
                    container[last] = value;
                    result.written += 1;
                }

                // Write once
                const payload = `${JSON.stringify(root, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(fileUri, sharedEncoder.encode(payload));
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Failed to write ${fileName}: ${msg}`);
        }
    }

    return result;
}
