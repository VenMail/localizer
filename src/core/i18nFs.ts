import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';

// Shared encoder/decoder instances to avoid repeated allocations
const sharedDecoder = new TextDecoder('utf-8');
const sharedEncoder = new TextEncoder();

// Cache for locale directory lookups (cleared on workspace change)
const localeDirCache = new Map<string, vscode.Uri>();

/**
 * Clear the locale directory cache. Call when workspace folders change.
 */
export function clearLocaleDirCache(): void {
    localeDirCache.clear();
}

function toPascalCase(input: string): string {
    const words = String(input || '')
        .replace(/[_\-]+/g, ' ')
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
    const localeDir = await findOrCreateLocaleDir(folder, locale);
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
    const fileUri = vscode.Uri.joinPath(localeDir, fileName);
    let root: any = {};
    try {
        const data = await vscode.workspace.fs.readFile(fileUri);
        const raw = sharedDecoder.decode(data);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            root = parsed;
        }
    } catch {
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        root = {};
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
}

export async function setTranslationValueInFile(
    fileUri: vscode.Uri,
    fullKey: string,
    value: string,
): Promise<void> {
    let root: any = {};
    try {
        const data = await vscode.workspace.fs.readFile(fileUri);
        const raw = sharedDecoder.decode(data);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            root = parsed;
        }
    } catch {
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        root = {};
    }
    const segments = fullKey.split('.').filter(Boolean);
    const container = ensureDeepContainer(root, segments.slice(0, -1));
    const last = segments[segments.length - 1];
    container[last] = value;
    const payload = `${JSON.stringify(root, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(fileUri, sharedEncoder.encode(payload));
}

export async function setTranslationValue(
    folder: vscode.WorkspaceFolder,
    locale: string,
    fullKey: string,
    value: string,
    options?: { rootName?: string },
): Promise<void> {
    const localeDir = await findOrCreateLocaleDir(folder, locale);
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
    const fileUri = vscode.Uri.joinPath(localeDir, fileName);
    let root: any = {};
    try {
        const data = await vscode.workspace.fs.readFile(fileUri);
        const raw = sharedDecoder.decode(data);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            root = parsed;
        }
    } catch {
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        root = {};
    }
    const container = ensureDeepContainer(root, segments.slice(0, -1));
    const last = segments[segments.length - 1];
    container[last] = value;
    const payload = `${JSON.stringify(root, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(fileUri, sharedEncoder.encode(payload));
}

/**
 * Batch write multiple translations to locale files.
 * Groups updates by target file to minimize I/O operations.
 * This is significantly faster than calling setTranslationValue for each key.
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

    const localeDir = await findOrCreateLocaleDir(folder, locale);

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

    // Process each file once
    for (const [fileName, keyValues] of fileUpdates.entries()) {
        const fileUri = vscode.Uri.joinPath(localeDir, fileName);
        
        try {
            // Read existing content
            let root: any = {};
            try {
                const data = await vscode.workspace.fs.readFile(fileUri);
                const raw = sharedDecoder.decode(data);
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    root = parsed;
                }
            } catch {
                // File doesn't exist yet, start with empty object
            }
            if (!root || typeof root !== 'object' || Array.isArray(root)) {
                root = {};
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
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Failed to write ${fileName}: ${msg}`);
        }
    }

    return result;
}
