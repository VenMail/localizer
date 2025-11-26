import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder } from 'util';

const MAX_LOCALE_FILE_SIZE_BYTES = Number(process.env.AI_I18N_MAX_LOCALE_SIZE || 2 * 1024 * 1024);
const INDEX_CONCURRENCY = Number(process.env.AI_I18N_INDEX_CONCURRENCY || 16);

export type TranslationRecord = {
    key: string;
    locales: Map<string, string>;
    defaultLocale: string;
    locations: { locale: string; uri: vscode.Uri }[];
};

export class I18nIndex {
    private keyMap = new Map<string, TranslationRecord>();
    private defaultLocale = 'en';
    private initializing: Promise<void> | null = null;

    async ensureInitialized(force = false): Promise<void> {
        if (!force && this.keyMap.size > 0) {
            return;
        }
        if (this.initializing && !force) {
            return this.initializing;
        }
        this.initializing = this.buildIndex();
        await this.initializing;
        this.initializing = null;
    }

    private async buildIndex(): Promise<void> {
        this.keyMap.clear();

        const config = vscode.workspace.getConfiguration('ai-assistant');
        this.defaultLocale = config.get<string>('i18n.defaultLocale') || 'en';
        const enabled = config.get<boolean>('i18n.enabled');
        if (enabled === false) {
            return;
        }

        const localeGlobs =
            config.get<string[]>('i18n.localeGlobs') || [
                'resources/js/i18n/auto/**/*.json',
                'src/i18n/**/*.json',
                'src/locales/**/*.json',
                'locales/**/*.json',
                'i18n/**/*.json',
            ];

        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) {
            return;
        }

        const decoder = new TextDecoder('utf-8');

        const fileKeySet = new Set<string>();
        const fileList: vscode.Uri[] = [];
        for (const folder of folders) {
            for (const glob of localeGlobs) {
                const pattern = new vscode.RelativePattern(folder, glob);
                const found = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
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
                text = decoder.decode(data);
            } catch (err) {
                console.error(`Failed to read locale file ${file.fsPath}:`, err);
                return;
            }
            if (!text) return;
            let json: unknown;
            try {
                json = JSON.parse(text);
            } catch (err) {
                console.error(`Failed to parse JSON in ${file.fsPath}:`, err);
                return;
            }
            const locale = this.inferLocaleFromPath(file);
            if (!locale) {
                return;
            }
            this.walkJson('', json, locale, file);
        });
    }

    private inferLocaleFromPath(uri: vscode.Uri): string | null {
        const parts = uri.fsPath.split(path.sep).filter(Boolean);
        const autoIndex = parts.lastIndexOf('auto');
        if (autoIndex >= 0 && autoIndex + 1 < parts.length) {
            const raw = parts[autoIndex + 1];
            return path.basename(raw, '.json');
        }
        const fileName = path.basename(uri.fsPath);
        const match = fileName.match(/^([A-Za-z0-9_-]+)\.json$/);
        if (match) {
            return match[1];
        }
        return null;
    }

    private walkJson(prefix: string, node: unknown, locale: string, uri: vscode.Uri): void {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return;
        }
        const recordNode = node as Record<string, unknown>;
        for (const [key, value] of Object.entries(recordNode)) {
            const nextKey = prefix ? `${prefix}.${key}` : key;
            if (typeof value === 'string') {
                let record = this.keyMap.get(nextKey);
                if (!record) {
                    record = {
                        key: nextKey,
                        locales: new Map<string, string>(),
                        defaultLocale: this.defaultLocale,
                        locations: [],
                    };
                    this.keyMap.set(nextKey, record);
                }
                record.locales.set(locale, value);
                if (!record.locations.some((l) => l.locale === locale && l.uri.toString() === uri.toString())) {
                    record.locations.push({ locale, uri });
                }
            } else if (value && typeof value === 'object') {
                this.walkJson(nextKey, value, locale, uri);
            }
        }
    }

    getRecord(key: string): TranslationRecord | undefined {
        return this.keyMap.get(key);
    }

    getAllKeys(): string[] {
        return Array.from(this.keyMap.keys());
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
            if (nextCh && /[A-Za-z0-9_.]/.test(nextCh)) {
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
    if (!keyText || !/^[A-Za-z0-9_.]+$/.test(keyText)) {
        return null;
    }

    const range = new vscode.Range(
        new vscode.Position(position.line, start),
        new vscode.Position(position.line, right),
    );
    return { key: keyText, range };
}

export function escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_{}\[\]()#+\-.!])/g, '\\$1');
}

export function slugifyForKey(text: string, maxWords = 4, maxLength = 48): string {
    const normalized = String(text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '');
    const words = normalized.toLowerCase().match(/[a-z0-9]+/g) || [];
    const sliced = words.slice(0, maxWords);
    let slug = sliced.join('_');
    if (!slug) {
        slug = 'text';
    }
    if (slug.length > maxLength) {
        slug = slug.slice(0, maxLength);
    }
    return slug;
}
