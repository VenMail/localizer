import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'util';
import { I18nIndex } from '../core/i18nIndex';
import { pickWorkspaceFolder } from '../core/workspace';
import { getGitStatus, createSnapshotCommit } from '../core/gitMonitor';
import { GitRecoveryHandler } from './untranslated/handlers/gitRecoveryHandler';
import { operationLock } from './untranslated/utils/operationLock';
import { findCommentRanges, isPositionInComment } from './untranslated/utils/commentParser';

const sharedDecoder = new TextDecoder('utf-8');
const sharedEncoder = new TextEncoder();

type Replacement = {
    start: number;
    end: number;
    replacement: string;
    key: string;
};

export class UninstallProjectI18nCommand {
    private gitRecoveryHandler: GitRecoveryHandler;

    constructor(
        private i18nIndex: I18nIndex,
        private context?: vscode.ExtensionContext,
        private log?: vscode.OutputChannel,
    ) {
        this.gitRecoveryHandler = new GitRecoveryHandler(context, log);
    }

    async execute(): Promise<void> {
        const folder = await pickWorkspaceFolder();
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        const lockedResult = await operationLock.withGlobalLock(
            'key-management',
            `Uninstall i18n from ${folder.name}`,
            async (token) => this.executeWithLock(folder, token),
            { cancellable: true },
        );

        if (lockedResult === null) {
            return;
        }
    }

    private async executeWithLock(folder: vscode.WorkspaceFolder, token?: vscode.CancellationToken): Promise<void> {
        const status = await getGitStatus(folder);
        if (token?.isCancellationRequested) {
            return;
        }

        if (!status.hasGit) {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Continue without git snapshot',
                        description: 'Proceed without creating a snapshot git commit.',
                    },
                    {
                        label: 'Cancel',
                        description: 'Do not uninstall i18n right now.',
                    },
                ],
                {
                    placeHolder:
                        'AI Localizer: No git repository detected for this workspace. Continue without a snapshot commit?',
                },
            );

            if (!choice || choice.label !== 'Continue without git snapshot') {
                return;
            }
        } else if (status.isDirty) {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'Create snapshot commit and continue',
                        description: 'Create a git commit before uninstalling i18n.',
                    },
                    {
                        label: 'Continue without snapshot (not recommended)',
                        description: 'Uninstall i18n without taking a snapshot first.',
                    },
                    {
                        label: 'Cancel',
                        description: 'Do not uninstall i18n right now.',
                    },
                ],
                {
                    placeHolder:
                        'AI Localizer: Workspace has uncommitted changes. Create a snapshot git commit before uninstalling i18n?',
                },
            );

            if (!choice || choice.label === 'Cancel') {
                return;
            }

            if (choice.label === 'Create snapshot commit and continue') {
                const snapshot = await createSnapshotCommit(folder, 'chore: i18n pre-uninstall snapshot');
                if (!snapshot.success) {
                    const message = snapshot.error
                        ? `AI Localizer: Failed to create git snapshot commit. ${snapshot.error}`
                        : 'AI Localizer: Failed to create git snapshot commit.';
                    vscode.window.showErrorMessage(message);
                    return;
                }
            }
        }

        const confirm = await vscode.window.showQuickPick(
            [
                {
                    label: 'Uninstall i18n (replace t() calls with strings)',
                    description: 'Revert i18n key usage back to string literals across this workspace.',
                },
                {
                    label: 'Cancel',
                    description: 'Do not uninstall i18n right now.',
                },
            ],
            {
                placeHolder: 'AI Localizer: Uninstall/remove i18n from this project?',
            },
        );

        if (!confirm || confirm.label !== 'Uninstall i18n (replace t() calls with strings)') {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `AI Localizer: Uninstalling i18n from ${folder.name}...`,
                cancellable: true,
            },
            async (progress, progressToken) => {
                if (progressToken.isCancellationRequested || token?.isCancellationRequested) {
                    return;
                }

                progress.report({ message: 'Building translation index...' });
                await this.i18nIndex.ensureInitialized(true);

                if (progressToken.isCancellationRequested || token?.isCancellationRequested) {
                    return;
                }

                const defaultLocale =
                    vscode.workspace.getConfiguration('ai-localizer').get<string>('i18n.defaultLocale') || 'en';

                const localeUris = await this.gitRecoveryHandler.getLocaleFileUris(
                    folder,
                    defaultLocale,
                    this.i18nIndex,
                );

                progress.report({ message: 'Scanning source files for t() calls...' });
                const sourceUris = await this.collectSourceFileUris(folder);

                if (progressToken.isCancellationRequested || token?.isCancellationRequested) {
                    return;
                }

                let filesChanged = 0;
                let totalReplacements = 0;
                let missingKeys = 0;

                const maxFiles = sourceUris.length;
                for (let i = 0; i < sourceUris.length; i += 1) {
                    const uri = sourceUris[i];
                    if (progressToken.isCancellationRequested || token?.isCancellationRequested) {
                        return;
                    }
                    const pct = maxFiles > 0 ? Math.round((i / maxFiles) * 100) : 0;
                    progress.report({ message: `Processing ${i + 1}/${maxFiles} (${pct}%)`, increment: 0 });

                    const result = await this.processFile(folder, uri, defaultLocale, localeUris);
                    if (result.changed) {
                        filesChanged += 1;
                        totalReplacements += result.replacements;
                    }
                    missingKeys += result.missingKeys;
                }

                progress.report({ message: 'Optionally cleaning up i18n scripts/config...' });

                const cleanupChoice = await vscode.window.showQuickPick(
                    [
                        {
                            label: 'Remove AI Localizer i18n scripts from package.json and /scripts',
                            description: 'Removes i18n:* scripts and deletes AI Localizer scripts in /scripts.',
                        },
                        {
                            label: 'Skip cleanup',
                            description: 'Leave scripts and config files untouched.',
                        },
                    ],
                    { placeHolder: 'AI Localizer: Clean up i18n scripts and config files too?' },
                );

                if (cleanupChoice && cleanupChoice.label.startsWith('Remove AI Localizer i18n scripts')) {
                    await this.cleanupProjectI18nScripts(folder);
                }

                vscode.window.showInformationMessage(
                    `AI Localizer: i18n uninstall completed for "${folder.name}". Updated ${filesChanged} file(s), made ${totalReplacements} replacement(s).` +
                        (missingKeys > 0
                            ? ` ${missingKeys} key(s) were missing from the index and required recovery/fallback.`
                            : ''),
                );
            },
        );
    }

    private async collectSourceFileUris(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const sourceGlobs = cfg.get<string[]>('i18n.sourceGlobs') || [
            '**/*.{ts,tsx,js,jsx,vue,php}',
            '**/*.blade.php',
        ];
        const excludeGlobs = cfg.get<string[]>('i18n.sourceExcludeGlobs') || [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/build/**',
            '**/.next/**',
            '**/.nuxt/**',
            '**/.vite/**',
            '**/coverage/**',
            '**/out/**',
            '**/.turbo/**',
            '**/vendor/**',
        ];

        const exclude = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;
        const seen = new Set<string>();
        const out: vscode.Uri[] = [];

        for (const include of sourceGlobs) {
            try {
                const pattern = new vscode.RelativePattern(folder, include);
                const found = await vscode.workspace.findFiles(pattern, exclude);
                for (const uri of found) {
                    const key = uri.toString();
                    if (!seen.has(key)) {
                        seen.add(key);
                        out.push(uri);
                    }
                }
            } catch {
                // ignore
            }
        }

        return out;
    }

    private async processFile(
        folder: vscode.WorkspaceFolder,
        uri: vscode.Uri,
        defaultLocale: string,
        localeUris: vscode.Uri[],
    ): Promise<{ changed: boolean; replacements: number; missingKeys: number }> {
        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch {
            return { changed: false, replacements: 0, missingKeys: 0 };
        }

        const text = doc.getText();
        if (!text || !/\b\$?t\s*\(|__\s*\(/.test(text)) {
            return { changed: false, replacements: 0, missingKeys: 0 };
        }

        const commentRanges = findCommentRanges(text);

        const replacements: Replacement[] = [];
        let missingKeys = 0;

        const tryAddReplacement = (start: number, end: number, replacement: string, key: string) => {
            if (start < 0 || end <= start || end > text.length) {
                return;
            }
            if (isPositionInComment(start, commentRanges)) {
                return;
            }
            for (const r of replacements) {
                const overlap = !(end <= r.start || start >= r.end);
                if (overlap) {
                    return;
                }
            }
            replacements.push({ start, end, replacement, key });
        };

        const tCallPattern = /\b\$?t\s*\(\s*(['"`])([^'"`]+)\1/g;
        const phpCallPattern = /\b__\s*\(\s*(['"`])([^'"`]+)\1/g;

        const handleCallMatches = async (pattern: RegExp) => {
            pattern.lastIndex = 0;
            while (true) {
                const match = pattern.exec(text);
                if (!match) break;

                const callStart = match.index;
                const key = match[2];
                if (!key || !/^[A-Za-z0-9_\.\-]+$/.test(key)) {
                    continue;
                }

                const callEnd = this.findCallExpressionEnd(text, callStart);
                if (callEnd === null) {
                    continue;
                }

                const callText = text.slice(callStart, callEnd);
                const valueInfo = await this.resolveKeyToValue(
                    folder,
                    uri.fsPath,
                    key,
                    defaultLocale,
                    localeUris,
                    callText,
                );

                if (!valueInfo) {
                    missingKeys += 1;
                    continue;
                }

                tryAddReplacement(callStart, callEnd, valueInfo.replacementExpr, key);
            }
        };

        await handleCallMatches(tCallPattern);
        await handleCallMatches(phpCallPattern);

        // Best-effort: if we removed all t() calls from the file, remove the AI Localizer
        // import for t to avoid leaving an unused import behind.
        if (replacements.length > 0) {
            const simulated = this.applyReplacementsToText(text, replacements);
            const hasRemainingTCall = this.hasTCallOutsideComments(simulated);
            if (!hasRemainingTCall) {
                const cfg = vscode.workspace.getConfiguration('ai-localizer');
                const tImportPath = cfg.get<string>('i18n.tImportPath') || '@/i18n';
                const importRanges = this.findTImportRanges(text, tImportPath);
                for (const r of importRanges) {
                    tryAddReplacement(r.start, r.end, '', '__import__');
                }
            }
        }

        if (replacements.length === 0) {
            return { changed: false, replacements: 0, missingKeys };
        }

        const edit = new vscode.WorkspaceEdit();
        replacements.sort((a, b) => b.start - a.start);
        for (const r of replacements) {
            const range = new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end));
            edit.replace(uri, range, r.replacement);
        }

        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
            await doc.save();
        }

        return { changed: applied, replacements: replacements.length, missingKeys };
    }

    private async resolveKeyToValue(
        folder: vscode.WorkspaceFolder,
        sourceFilePath: string,
        key: string,
        defaultLocale: string,
        localeUris: vscode.Uri[],
        callText: string,
    ): Promise<{ replacementExpr: string } | null> {
        const record = this.i18nIndex.getRecord(key);
        const defaultValue = record?.locales?.get(defaultLocale);

        const optionsText = this.extractFirstObjectArg(callText);
        const optionsMap = optionsText ? this.parseSimpleObjectLiteral(optionsText) : null;

        let resolvedValue = defaultValue;
        let mustRecoverFromGit = this.isSuspiciousReplacement(key, resolvedValue || '', optionsMap);

        if (!resolvedValue || mustRecoverFromGit) {
            const recovered = await this.gitRecoveryHandler.recoverFromSourceFileHistory(
                folder,
                sourceFilePath,
                key,
                defaultLocale,
                365,
                '[Uninstall]'
            );

            if (recovered?.value) {
                resolvedValue = recovered.value;
                mustRecoverFromGit = false;
            }
        }

        if (!resolvedValue) {
            const recoveredFromLocale = await this.gitRecoveryHandler.recoverKeyFromGit(folder, localeUris, key, defaultLocale, {
                daysBack: 365,
                maxCommits: 100,
                extractRef: null,
                logPrefix: '[Uninstall]',
            });
            if (recoveredFromLocale?.value) {
                resolvedValue = recoveredFromLocale.value;
            }
        }

        if (!resolvedValue) {
            return null;
        }

        const placeholders = this.extractPlaceholders(resolvedValue);
        if (placeholders.length > 0 && optionsMap) {
            const tpl = this.tryBuildTemplateLiteral(resolvedValue, placeholders, optionsMap);
            if (tpl) {
                return { replacementExpr: tpl };
            }
        }

        return { replacementExpr: this.toSingleQuotedJsString(resolvedValue) };
    }

    private isSuspiciousReplacement(key: string, value: string, options: Map<string, string> | null): boolean {
        const trimmed = String(value || '').trim();
        if (!trimmed) return true;
        if (trimmed === key) return true;

        if (/^[A-Za-z0-9_]+(\.[A-Za-z0-9_\-]+)+$/.test(trimmed) && !/\s/.test(trimmed)) {
            return true;
        }

        const lowerKey = key.toLowerCase();
        const looksLabelish =
            lowerKey.includes('.label.') ||
            lowerKey.includes('.button.') ||
            lowerKey.includes('.title.') ||
            lowerKey.includes('.heading.') ||
            lowerKey.includes('.placeholder.');
        const words = trimmed.split(/\s+/).filter(Boolean);
        if (looksLabelish && words.length >= 10) {
            return true;
        }

        const placeholders = this.extractPlaceholders(trimmed);
        if (placeholders.length > 0) {
            if (!options) {
                return true;
            }
            for (const p of placeholders) {
                if (!options.has(p)) {
                    return true;
                }
            }
        }

        return false;
    }

    private extractPlaceholders(value: string): string[] {
        const out: string[] = [];
        const seen = new Set<string>();
        const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(value))) {
            const name = m[1];
            if (!seen.has(name)) {
                seen.add(name);
                out.push(name);
            }
        }
        return out;
    }

    private extractFirstObjectArg(callText: string): string | null {
        const commaIdx = callText.indexOf(',');
        if (commaIdx === -1) return null;

        const afterComma = callText.slice(commaIdx + 1);
        const braceIdx = afterComma.indexOf('{');
        if (braceIdx === -1) return null;

        const absoluteStart = commaIdx + 1 + braceIdx;
        const end = this.findMatchingBracket(callText, absoluteStart, '{', '}');
        if (end === null) return null;

        return callText.slice(absoluteStart, end + 1);
    }

    private parseSimpleObjectLiteral(text: string): Map<string, string> | null {
        const trimmed = text.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
            return null;
        }

        const inner = trimmed.slice(1, -1).trim();
        if (!inner) {
            return new Map();
        }

        const parts: string[] = [];
        let current = '';
        let depthParen = 0;
        let depthBrace = 0;
        let depthBracket = 0;
        let quote: 'single' | 'double' | 'template' | null = null;

        for (let i = 0; i < inner.length; i += 1) {
            const ch = inner[i];
            const prev = i > 0 ? inner[i - 1] : '';

            if (quote) {
                current += ch;
                if (quote === 'single' && ch === "'" && prev !== '\\') quote = null;
                if (quote === 'double' && ch === '"' && prev !== '\\') quote = null;
                if (quote === 'template' && ch === '`' && prev !== '\\') quote = null;
                continue;
            }

            if (ch === "'") {
                quote = 'single';
                current += ch;
                continue;
            }
            if (ch === '"') {
                quote = 'double';
                current += ch;
                continue;
            }
            if (ch === '`') {
                quote = 'template';
                current += ch;
                continue;
            }

            if (ch === '(') depthParen += 1;
            if (ch === ')') depthParen = Math.max(0, depthParen - 1);
            if (ch === '{') depthBrace += 1;
            if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
            if (ch === '[') depthBracket += 1;
            if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);

            if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
                const part = current.trim();
                if (part) parts.push(part);
                current = '';
                continue;
            }

            current += ch;
        }

        const last = current.trim();
        if (last) parts.push(last);

        const map = new Map<string, string>();
        for (const part of parts) {
            const colonIdx = part.indexOf(':');
            if (colonIdx === -1) {
                const name = part.trim();
                if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
                    map.set(name, name);
                }
                continue;
            }

            const left = part.slice(0, colonIdx).trim();
            const right = part.slice(colonIdx + 1).trim();

            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(left)) {
                continue;
            }
            if (!right) {
                continue;
            }
            map.set(left, right);
        }

        return map;
    }

    private tryBuildTemplateLiteral(
        value: string,
        placeholders: string[],
        options: Map<string, string>,
    ): string | null {
        let out = '`';
        let cursor = 0;

        while (cursor < value.length) {
            const nextOpen = value.indexOf('{', cursor);
            if (nextOpen === -1) {
                out += this.escapeTemplateStatic(value.slice(cursor));
                break;
            }
            const nextClose = value.indexOf('}', nextOpen + 1);
            if (nextClose === -1) {
                return null;
            }

            const name = value.slice(nextOpen + 1, nextClose);
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || !options.has(name)) {
                return null;
            }

            out += this.escapeTemplateStatic(value.slice(cursor, nextOpen));
            out += '${' + options.get(name) + '}';
            cursor = nextClose + 1;
        }

        out += '`';
        return out;
    }

    private escapeTemplateStatic(text: string): string {
        return text
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
    }

    private toSingleQuotedJsString(value: string): string {
        const escaped = String(value)
            .replace(/\\/g, '\\\\')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/\t/g, '\\t')
            .replace(/'/g, "\\'");
        return `'${escaped}'`;
    }

    private findCallExpressionEnd(text: string, callStart: number): number | null {
        const openParen = text.indexOf('(', callStart);
        if (openParen === -1) return null;

        let depth = 0;
        let quote: 'single' | 'double' | 'template' | null = null;

        for (let i = openParen; i < text.length; i += 1) {
            const ch = text[i];
            const prev = i > 0 ? text[i - 1] : '';

            if (quote) {
                if (quote === 'single' && ch === "'" && prev !== '\\') quote = null;
                if (quote === 'double' && ch === '"' && prev !== '\\') quote = null;
                if (quote === 'template' && ch === '`' && prev !== '\\') quote = null;
                continue;
            }

            if (ch === "'") {
                quote = 'single';
                continue;
            }
            if (ch === '"') {
                quote = 'double';
                continue;
            }
            if (ch === '`') {
                quote = 'template';
                continue;
            }

            if (ch === '(') depth += 1;
            if (ch === ')') {
                depth -= 1;
                if (depth === 0) {
                    return i + 1;
                }
            }
        }

        return null;
    }

    private findMatchingBracket(
        text: string,
        start: number,
        open: string,
        close: string,
    ): number | null {
        let depth = 0;
        let quote: 'single' | 'double' | 'template' | null = null;

        for (let i = start; i < text.length; i += 1) {
            const ch = text[i];
            const prev = i > 0 ? text[i - 1] : '';

            if (quote) {
                if (quote === 'single' && ch === "'" && prev !== '\\') quote = null;
                if (quote === 'double' && ch === '"' && prev !== '\\') quote = null;
                if (quote === 'template' && ch === '`' && prev !== '\\') quote = null;
                continue;
            }

            if (ch === "'") {
                quote = 'single';
                continue;
            }
            if (ch === '"') {
                quote = 'double';
                continue;
            }
            if (ch === '`') {
                quote = 'template';
                continue;
            }

            if (ch === open) {
                depth += 1;
            } else if (ch === close) {
                depth -= 1;
                if (depth === 0) {
                    return i;
                }
            }
        }

        return null;
    }

    private async cleanupProjectI18nScripts(folder: vscode.WorkspaceFolder): Promise<void> {
        await this.cleanupPackageJsonScripts(folder);

        const targets: vscode.Uri[] = [
            vscode.Uri.joinPath(folder.uri, 'scripts', 'extract-i18n.js'),
            vscode.Uri.joinPath(folder.uri, 'scripts', 'replace-i18n.js'),
            vscode.Uri.joinPath(folder.uri, 'scripts', 'sync-i18n.js'),
            vscode.Uri.joinPath(folder.uri, 'scripts', 'fix-untranslated.js'),
            vscode.Uri.joinPath(folder.uri, 'scripts', 'rewrite-i18n-blade.js'),
            vscode.Uri.joinPath(folder.uri, 'scripts', 'cleanup-i18n-unused.js'),
            vscode.Uri.joinPath(folder.uri, 'scripts', 'restore-i18n-invalid.js'),
            vscode.Uri.joinPath(folder.uri, 'scripts', 'i18n-ignore-patterns.json'),
            vscode.Uri.joinPath(folder.uri, 'scripts', 'package.json'),
            vscode.Uri.joinPath(folder.uri, 'scripts', '.i18n-untranslated-report.json'),
            vscode.Uri.joinPath(folder.uri, 'scripts', '.i18n-untranslated-untranslated.json'),
            vscode.Uri.joinPath(folder.uri, 'scripts', '.i18n-untranslated-compact.json'),
            vscode.Uri.joinPath(folder.uri, 'scripts', '.i18n-unused-report.json'),
            vscode.Uri.joinPath(folder.uri, 'scripts', '.i18n-invalid-report.json'),
            vscode.Uri.joinPath(folder.uri, 'scripts', '.i18n-review-generated.json'),
        ];

        for (const uri of targets) {
            try {
                await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
            } catch {
                // ignore
            }
        }

        try {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, 'scripts', 'lib'), {
                recursive: true,
                useTrash: false,
            });
        } catch {
            // ignore
        }
    }

    private async cleanupPackageJsonScripts(folder: vscode.WorkspaceFolder): Promise<void> {
        const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
        let raw: string;
        try {
            raw = sharedDecoder.decode(await vscode.workspace.fs.readFile(pkgUri));
        } catch {
            return;
        }

        let json: any;
        try {
            json = JSON.parse(raw);
        } catch {
            return;
        }

        if (json && typeof json === 'object') {
            if (json.aiI18n && typeof json.aiI18n === 'object') {
                delete json.aiI18n;
            }

            if (json.scripts && typeof json.scripts === 'object') {
                const scriptKeys = [
                    'i18n:extract',
                    'i18n:rewrite',
                    'i18n:sync',
                    'i18n:fix-untranslated',
                    'i18n:rewrite-blade',
                    'i18n:cleanup-unused',
                    'i18n:restore-invalid',
                ];

                const aiLocalizerScriptRe =
                    /\bnode\s+\.?\/?scripts\/(extract-i18n|replace-i18n|sync-i18n|fix-untranslated|rewrite-i18n-blade|cleanup-i18n-unused|restore-i18n-invalid)\.js\b/i;

                for (const k of scriptKeys) {
                    if (typeof json.scripts[k] === 'string' && aiLocalizerScriptRe.test(json.scripts[k])) {
                        delete json.scripts[k];
                    }
                }

                if (json.scripts.postbuild === 'npm run i18n:sync') {
                    delete json.scripts.postbuild;
                }
            }

            const updated = JSON.stringify(json, null, 2);
            await vscode.workspace.fs.writeFile(pkgUri, sharedEncoder.encode(`${updated}\n`));
        }
    }

    private applyReplacementsToText(source: string, replacements: Replacement[]): string {
        let out = source;
        const sorted = [...replacements].sort((a, b) => b.start - a.start);
        for (const r of sorted) {
            out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
        }
        return out;
    }

    private hasTCallOutsideComments(text: string): boolean {
        const ranges = findCommentRanges(text);
        const re = /\b\$?t\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            if (!isPositionInComment(m.index, ranges)) {
                return true;
            }
        }
        return false;
    }

    private findTImportRanges(text: string, importPath: string): Array<{ start: number; end: number }> {
        const escaped = importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(
            `(^|\\r?\\n)([\\t ]*import\\s*\\{\\s*t\\s*\\}\\s*from\\s*['\"]${escaped}['\"]\\s*;?[\\t ]*)(?=\\r?\\n|$)`,
            'g',
        );

        const ranges: Array<{ start: number; end: number }> = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const full = m[0];
            const prefix = m[1] || '';
            const importStmt = m[2] || '';
            const stmtStart = m.index + prefix.length;
            const stmtEnd = stmtStart + importStmt.length;
            const lineEnd = this.findLineEnd(text, stmtEnd);
            ranges.push({ start: stmtStart, end: lineEnd });
        }
        return ranges;
    }

    private findLineEnd(text: string, from: number): number {
        const nextNl = text.indexOf('\n', from);
        if (nextNl === -1) {
            return text.length;
        }
        return nextNl + 1;
    }
}
