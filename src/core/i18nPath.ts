import * as path from 'path';
import * as vscode from 'vscode';

export function inferJsonLocaleFromUri(uri: vscode.Uri): string | null {
    const parts = uri.fsPath.split(path.sep).filter(Boolean);

    // 1) Auto-generated runtime JSON: .../auto/<locale>/...
    const autoIndex = parts.lastIndexOf('auto');
    if (autoIndex >= 0 && autoIndex + 1 < parts.length) {
        const raw = parts[autoIndex + 1];
        return path.basename(raw, '.json');
    }

    // 2) Next.js / next-i18next style: .../locales/<locale>/<namespace>.json
    const localesIndex = parts.lastIndexOf('locales');
    if (localesIndex >= 0 && localesIndex + 1 < parts.length) {
        const candidate = parts[localesIndex + 1];
        if (/^[A-Za-z0-9_-]+$/.test(candidate)) {
            return candidate;
        }
    }

    // 3) Fallback: infer from filename (supports src/en.json and active.en.json)
    const fileName = path.basename(uri.fsPath);
    const match = fileName.match(/^([A-Za-z0-9_.-]+)\.json$/);
    if (match) {
        const base = match[1];
        const dotIndex = base.lastIndexOf('.');
        const candidate = dotIndex >= 0 ? base.slice(dotIndex + 1) : base;
        if (/^[A-Za-z0-9_-]+$/.test(candidate)) {
            return candidate;
        }
    }

    return null;
}
