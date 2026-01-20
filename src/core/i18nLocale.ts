import * as path from 'path';
import * as vscode from 'vscode';

const LOCALE_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/;
const LOCALE_FILE_REGEX = /^([A-Za-z0-9_.-]+)\.json$/;

export function normalizeLocale(locale: string): string {
    return locale.replace(/_/g, '-');
}

export function inferJsonLocaleFromUri(uri: vscode.Uri): string | null {
    const parts = uri.fsPath.split(path.sep).filter(Boolean);

    // 1) Auto-generated runtime JSON: .../auto/<locale>/...
    const autoIndex = parts.lastIndexOf('auto');
    if (autoIndex >= 0 && autoIndex + 1 < parts.length) {
        const raw = parts[autoIndex + 1];
        const candidate = path.basename(raw, '.json');
        return candidate ? normalizeLocale(candidate) : null;
    }

    // 2) Next.js / next-i18next style: .../locales/<locale>/<namespace>.json
    const localesIndex = parts.lastIndexOf('locales');
    if (localesIndex >= 0 && localesIndex + 1 < parts.length) {
        const candidate = parts[localesIndex + 1];
        if (LOCALE_SEGMENT_REGEX.test(candidate)) {
            return normalizeLocale(candidate);
        }
    }

    // 3) Fallback: infer from filename (supports src/en.json and active.en.json)
    const fileName = path.basename(uri.fsPath);
    const match = fileName.match(LOCALE_FILE_REGEX);
    if (match) {
        const base = match[1];
        const dotIndex = base.lastIndexOf('.');
        const candidate = dotIndex >= 0 ? base.slice(dotIndex + 1) : base;
        if (LOCALE_SEGMENT_REGEX.test(candidate)) {
            return normalizeLocale(candidate);
        }
    }

    return null;
}

export function parseLocaleJson(text: string): unknown | null {
    const trimmed = (text || '').trim();
    if (!trimmed) {
        return {};
    }

    const withoutComments = stripJsonComments(text);
    const withoutTrailingCommas = stripTrailingCommas(withoutComments);

    try {
        return JSON.parse(withoutTrailingCommas);
    } catch {
        return null;
    }
}

export function parseLocaleJsonWithError(text: string): { result: unknown | null; error?: string; errorLine?: number } {
    const trimmed = (text || '').trim();
    if (!trimmed) {
        return { result: {} };
    }

    const withoutComments = stripJsonComments(text);
    const withoutTrailingCommas = stripTrailingCommas(withoutComments);

    try {
        return { result: JSON.parse(withoutTrailingCommas) };
    } catch (error) {
        if (error instanceof SyntaxError) {
            // Try to extract line number from the error message
            const lineMatch = error.message.match(/line (\d+)/i);
            const errorLine = lineMatch ? parseInt(lineMatch[1], 10) : undefined;
            return { 
                result: null, 
                error: error.message,
                errorLine
            };
        }
        return { 
            result: null, 
            error: error instanceof Error ? error.message : 'Unknown JSON parsing error'
        };
    }
}

export function getLocaleValue(parsed: unknown, fullKey: string): string | null {
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    if (Array.isArray(parsed)) {
        for (const element of parsed) {
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
            if (!idValue || idValue !== fullKey) {
                continue;
            }
            const rawValue =
                (obj.translation as unknown) ??
                (obj.message as unknown) ??
                (obj.text as unknown) ??
                (obj.other as unknown);
            if (typeof rawValue === 'string') {
                return rawValue;
            }
        }
        return null;
    }

    const record = parsed as Record<string, unknown>;
    if (fullKey in record && typeof record[fullKey] === 'string') {
        return record[fullKey] as string;
    }

    const parts = fullKey.split('.').filter(Boolean);
    let current: unknown = record;

    for (const part of parts) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return null;
        }
        const node = current as Record<string, unknown>;
        if (!(part in node)) {
            return null;
        }
        current = node[part];
    }

    return typeof current === 'string' ? current : null;
}

function stripJsonComments(input: string): string {
    let output = '';
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        const next = input[i + 1];

        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
                output += ch;
            }
            continue;
        }

        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }

        if (inString) {
            output += ch;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            output += ch;
            continue;
        }

        if (ch === '/' && next === '/') {
            inLineComment = true;
            i += 1;
            continue;
        }

        if (ch === '/' && next === '*') {
            inBlockComment = true;
            i += 1;
            continue;
        }

        output += ch;
    }

    return output;
}

function stripTrailingCommas(input: string): string {
    let output = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];

        if (inString) {
            output += ch;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            output += ch;
            continue;
        }

        if (ch === '}' || ch === ']') {
            let j = output.length - 1;
            while (j >= 0 && /\s/.test(output[j])) {
                j -= 1;
            }
            if (j >= 0 && output[j] === ',') {
                output = output.slice(0, j) + output.slice(j + 1);
            }
            output += ch;
            continue;
        }

        output += ch;
    }

    return output;
}
