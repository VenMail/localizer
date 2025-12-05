import * as vscode from 'vscode';
import * as path from 'path';
import { TextEncoder, TextDecoder } from 'util';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { pickWorkspaceFolder, runI18nScript } from '../core/workspace';
import { getGitStatus, createSnapshotCommit } from '../core/gitMonitor';

const sharedDecoder = new TextDecoder('utf-8');
const sharedEncoder = new TextEncoder();

interface FileBucket {
    uri: vscode.Uri;
    json: Record<string, unknown>;
    changed: boolean;
    deletedKeys: string[];
}

interface ReportCleanupResult {
    filesChanged: number;
    keysRemoved: number;
}

interface UnusedReport {
    generatedAt?: string;
    baseLocale: string;
    autoDir: string;
    unused: Array<{ keyPath: string; baseFileRel: string }>;
}

interface InvalidReport {
    generatedAt?: string;
    baseLocale: string;
    autoDir: string;
    invalid: Array<{ keyPath: string; baseFileRel: string }>;
}

export class ProjectFixCommand {
    constructor(
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private projectConfigService: ProjectConfigService,
    ) {}

    async execute(): Promise<void> {
        try {
            const folder = await pickWorkspaceFolder();
            if (!folder) {
                vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
                return;
            }

            const hasScripts = await this.projectConfigService.hasI18nScripts(folder);
            if (!hasScripts) {
                const setupChoice = await vscode.window.showQuickPick(
                    [
                        {
                            label: 'Configure project i18n and continue',
                            description: 'Copy scripts into this project and update package.json scripts.',
                        },
                        {
                            label: 'Cancel',
                            description: 'Do not run project-wide fixes right now.',
                        },
                    ],
                    {
                        placeHolder:
                            'AI Localizer: Project i18n scripts are not configured for this workspace. Configure them now?',
                    },
                );

                if (!setupChoice || setupChoice.label !== 'Configure project i18n and continue') {
                    return;
                }

                await vscode.commands.executeCommand('ai-localizer.i18n.configureProject');
            }

            const status = await getGitStatus(folder);
            if (!status.hasGit) {
                const choice = await vscode.window.showQuickPick(
                    [
                        {
                            label: 'Continue without git snapshot',
                            description: 'Run project-wide fixes without creating a git commit.',
                        },
                        {
                            label: 'Cancel',
                            description: 'Do not run project-wide fixes right now.',
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
                            description:
                                'Stage tracked changes, create a git commit, and then run project-wide i18n fixes.',
                        },
                        {
                            label: 'Continue without snapshot (not recommended)',
                            description:
                                'Run project-wide i18n fixes without taking a snapshot git commit first.',
                        },
                        {
                            label: 'Cancel',
                            description: 'Do not run project-wide fixes right now.',
                        },
                    ],
                    {
                        placeHolder:
                            'AI Localizer: Workspace has uncommitted changes. Create a snapshot git commit before running project-wide i18n fixes?',
                    },
                );

                if (!choice || choice.label === 'Cancel') {
                    return;
                }

                if (choice.label === 'Create snapshot commit and continue') {
                    const snapshot = await createSnapshotCommit(
                        folder,
                        'chore: i18n pre-cleanup snapshot',
                    );
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
                        label: 'Run full project-wide i18n cleanup',
                        description:
                            'Run extract, rewrite, sync, cleanup, fix missing references, and AI translation.',
                    },
                    {
                        label: 'Cancel',
                        description: 'Do not run project-wide fixes right now.',
                    },
                ],
                {
                    placeHolder:
                        'AI Localizer: Fix all i18n issues in this project (one-time cleanup)?',
                },
            );

            if (!confirm || confirm.label !== 'Run full project-wide i18n cleanup') {
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'AI Localizer: Fixing all i18n issues in project...',
                    cancellable: true,
                },
                async (progress, token) => {
                    if (token.isCancellationRequested) return;

                    // Phase 1: Extract and rewrite source files
                    progress.report({ message: 'Extracting translatable strings (i18n:extract)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runExtractScript');
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Rewriting source to use t() calls (i18n:rewrite)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runRewriteScript');
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Rewriting Blade templates (i18n:rewrite-blade)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runRewriteBladeScript');
                    if (token.isCancellationRequested) return;

                    // Phase 2: Initial sync to populate all locales
                    progress.report({ message: 'Syncing locales (i18n:sync)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runSyncScript');
                    if (token.isCancellationRequested) return;

                    // Phase 3: Build index and track keys before cleanup
                    progress.report({ message: 'Rebuilding index before cleanup...' });
                    await this.i18nIndex.ensureInitialized(true);
                    const keysBeforeCleanup = new Set(this.i18nIndex.getAllKeys());
                    if (token.isCancellationRequested) return;

                    // Phase 4: Cleanup unused keys (analyze + delete from all locale files)
                    progress.report({ message: 'Analyzing unused keys (i18n:cleanup-unused)...' });
                    await runI18nScript('i18n:cleanup-unused', { folder });
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Removing unused keys from all locale files...' });
                    await this.applyUnusedReportAcrossLocales(folder, token);
                    if (token.isCancellationRequested) return;

                    // Phase 5: Cleanup invalid/non-translatable keys
                    progress.report({ message: 'Analyzing invalid/non-translatable keys (i18n:restore-invalid)...' });
                    await runI18nScript('i18n:restore-invalid', { folder });
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Removing invalid keys from all locale files...' });
                    await this.applyInvalidReportAcrossLocales(folder, token);
                    if (token.isCancellationRequested) return;

                    // Phase 6: Re-sync after cleanup to ensure consistency
                    progress.report({ message: 'Resyncing locales after cleanup (i18n:sync)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runSyncScript');
                    if (token.isCancellationRequested) return;

                    // Phase 7: Final cleanup pass (sync may have reintroduced unused keys)
                    progress.report({ message: 'Final cleanup pass: analyzing unused keys...' });
                    await runI18nScript('i18n:cleanup-unused', { folder });
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Final cleanup pass: removing unused keys...' });
                    await this.applyUnusedReportAcrossLocales(folder, token);
                    if (token.isCancellationRequested) return;

                    // Phase 8: Rebuild index and fix missing key references
                    progress.report({ message: 'Rebuilding index after cleanup...' });
                    await this.i18nIndex.ensureInitialized(true);
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Fixing missing key references across source files...' });
                    await this.bulkFixMissingReferencesInProject(folder, token);
                    if (token.isCancellationRequested) return;

                    // Track removed keys for auto-ignore
                    const keysAfterCleanup = new Set(this.i18nIndex.getAllKeys());
                    const removedKeys: string[] = [];
                    for (const k of keysBeforeCleanup) {
                        if (!keysAfterCleanup.has(k)) {
                            removedKeys.push(k);
                        }
                    }
                    if (removedKeys.length) {
                        await this.appendKeysToAutoIgnore(folder, removedKeys);
                    }

                    // Phase 9: Rescan diagnostics to check for remaining issues
                    progress.report({ message: 'Scanning for remaining i18n issues...' });
                    await this.i18nIndex.ensureInitialized(true);
                    await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
                    if (token.isCancellationRequested) return;

                    // Phase 10: Guard check before AI translation
                    const remainingIssues = this.countRemainingI18nIssues(folder);
                    if (remainingIssues.unusedKeys > 0 || remainingIssues.missingReferences > 0) {
                        const skipChoice = await vscode.window.showQuickPick(
                            [
                                {
                                    label: 'Skip AI translation',
                                    description: `There are still ${remainingIssues.unusedKeys} unused key(s) and ${remainingIssues.missingReferences} missing reference(s). Fix these first.`,
                                },
                                {
                                    label: 'Continue anyway',
                                    description: 'Proceed with AI translation despite remaining issues (not recommended).',
                                },
                            ],
                            {
                                placeHolder: 'AI Localizer: Remaining i18n issues detected. Skip AI translation?',
                            },
                        );

                        if (!skipChoice || skipChoice.label === 'Skip AI translation') {
                            progress.report({ message: 'Skipped AI translation due to remaining issues.' });
                            await vscode.commands.executeCommand('ai-localizer.i18n.showHealthReport');
                            return;
                        }
                    }

                    // Phase 11: AI translation for untranslated strings
                    progress.report({ message: 'Detecting and translating untranslated strings (i18n:fix-untranslated)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runFixUntranslatedScript');
                    if (token.isCancellationRequested) return;

                    // Phase 12: Final rebuild and report
                    progress.report({ message: 'Rebuilding translation index and diagnostics...' });
                    await this.i18nIndex.ensureInitialized(true);
                    await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
                    if (token.isCancellationRequested) return;

                    await vscode.commands.executeCommand('ai-localizer.i18n.showHealthReport');
                },
            );

            const apiKey = (await this.translationService.getApiKey())?.trim();
            const extraNote = apiKey
                ? 'AI translation was enabled for this run; review locale files and diffs as needed.'
                : 'No OpenAI API key was configured; missing translations were not auto-filled by AI.';

            vscode.window.showInformationMessage(
                `AI Localizer: Project-wide i18n cleanup completed for workspace "${folder.name}". ${extraNote}`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('AI Localizer: Failed to run project-wide i18n cleanup:', err);
            vscode.window.showErrorMessage(
                `AI Localizer: Failed to run project-wide i18n cleanup. ${msg}`,
            );
        }
    }

    private countRemainingI18nIssues(folder: vscode.WorkspaceFolder): { unusedKeys: number; missingReferences: number } {
        const allDiagnostics = vscode.languages.getDiagnostics();
        let unusedKeys = 0;
        let missingReferences = 0;

        for (const [uri, diagnostics] of allDiagnostics) {
            if (!uri.fsPath.startsWith(folder.uri.fsPath)) continue;

            for (const diag of diagnostics) {
                const code = String(diag.code);
                if (code === 'ai-i18n.unused') {
                    unusedKeys += 1;
                } else if (code === 'ai-i18n.missing-reference' || code === 'ai-i18n.missing') {
                    missingReferences += 1;
                }
            }
        }

        return { unusedKeys, missingReferences };
    }

    private async bulkFixMissingReferencesInProject(
        folder: vscode.WorkspaceFolder,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const includeGlobs =
            cfg.get<string[]>('i18n.sourceGlobs') || ['**/*.{ts,tsx,js,jsx,vue}'];
        const excludeGlobs =
            cfg.get<string[]>('i18n.sourceExcludeGlobs') || [
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
            ];

        const include =
            includeGlobs.length === 1 ? includeGlobs[0] : `{${includeGlobs.join(',')}}`;
        const exclude = excludeGlobs.length ? `{${excludeGlobs.join(',')}}` : undefined;
        const includePattern = new vscode.RelativePattern(folder, include);
        const excludePattern = exclude ? new vscode.RelativePattern(folder, exclude) : undefined;

        const uris = await vscode.workspace.findFiles(includePattern, excludePattern, undefined, token);
        if (!uris.length) {
            return;
        }

        for (const uri of uris) {
            if (token.isCancellationRequested) {
                return;
            }
            try {
                await vscode.commands.executeCommand('ai-localizer.i18n.bulkFixMissingKeyReferences', uri);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`AI Localizer: Bulk fix missing references failed for ${uri.fsPath}. ${msg}`);
            }
        }
    }

    private async appendKeysToAutoIgnore(folder: vscode.WorkspaceFolder, keys: string[]): Promise<void> {
        if (!keys.length) return;
        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const autoUri = vscode.Uri.joinPath(scriptsDir, '.i18n-auto-ignore.json');

        let existing: Record<string, unknown> = {};
        try {
            const data = await vscode.workspace.fs.readFile(autoUri);
            const parsed = JSON.parse(sharedDecoder.decode(data));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                existing = parsed as Record<string, unknown>;
            }
        } catch {
            // file may not exist; we'll create it
        }

        const exactSet = new Set<string>(
            Array.isArray(existing.exact) ? (existing.exact as unknown[]).map((v) => String(v)) : [],
        );

        const initialSize = exactSet.size;
        for (const k of keys) {
            exactSet.add(k);
        }

        if (exactSet.size === initialSize) {
            return;
        }

        existing.exact = Array.from(exactSet).sort();
        if (!Array.isArray(existing.exactInsensitive)) existing.exactInsensitive = [];
        if (!Array.isArray(existing.contains)) existing.contains = [];

        const payload = `${JSON.stringify(existing, null, 2)}\n`;
        await vscode.workspace.fs.createDirectory(scriptsDir);
        await vscode.workspace.fs.writeFile(autoUri, sharedEncoder.encode(payload));
    }

    private deleteKeyPathInObject(obj: Record<string, unknown>, keyPath: string): boolean {
        const segments = String(keyPath).split('.').filter(Boolean);
        if (!segments.length) return false;

        let deleted = false;
        const helper = (target: Record<string, unknown>, index: number): boolean => {
            const key = segments[index];
            if (!(key in target)) {
                return false;
            }
            if (index === segments.length - 1) {
                delete target[key];
                deleted = true;
                return Object.keys(target).length === 0;
            }
            const child = target[key];
            if (!child || typeof child !== 'object' || Array.isArray(child)) {
                return false;
            }
            const shouldDeleteChild = helper(child as Record<string, unknown>, index + 1);
            if (shouldDeleteChild) {
                delete target[key];
            }
            return Object.keys(target).length === 0;
        };

        helper(obj, 0);
        return deleted;
    }

    private async listLocalesInDir(autoDirUri: vscode.Uri): Promise<string[]> {
        const locales: string[] = [];
        try {
            const entries = await vscode.workspace.fs.readDirectory(autoDirUri);
            for (const [name, type] of entries) {
                if (type === vscode.FileType.Directory) {
                    locales.push(name);
                } else if (type === vscode.FileType.File && name.endsWith('.json')) {
                    const localeName = name.replace(/\.json$/i, '');
                    if (!locales.includes(localeName)) {
                        locales.push(localeName);
                    }
                }
            }
        } catch {
            // directory might not exist
        }
        return locales;
    }

    private async applyUnusedReportAcrossLocales(
        folder: vscode.WorkspaceFolder,
        token: vscode.CancellationToken,
    ): Promise<ReportCleanupResult> {
        return this.applyReportAcrossLocales(folder, token, 'unused');
    }

    private async applyInvalidReportAcrossLocales(
        folder: vscode.WorkspaceFolder,
        token: vscode.CancellationToken,
    ): Promise<ReportCleanupResult> {
        return this.applyReportAcrossLocales(folder, token, 'invalid');
    }

    private async applyReportAcrossLocales(
        folder: vscode.WorkspaceFolder,
        token: vscode.CancellationToken,
        reportType: 'unused' | 'invalid',
    ): Promise<ReportCleanupResult> {
        const reportFileName = reportType === 'unused'
            ? '.i18n-unused-report.json'
            : '.i18n-invalid-report.json';
        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const reportUri = vscode.Uri.joinPath(scriptsDir, reportFileName);

        let report: UnusedReport | InvalidReport;
        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            report = JSON.parse(sharedDecoder.decode(data));
        } catch {
            return { filesChanged: 0, keysRemoved: 0 };
        }

        const entries = (reportType === 'unused'
            ? (report as UnusedReport).unused
            : (report as InvalidReport).invalid) || [];

        if (!entries.length || !report.autoDir || !report.baseLocale) {
            return { filesChanged: 0, keysRemoved: 0 };
        }

        const autoDirUri = vscode.Uri.joinPath(folder.uri, report.autoDir);
        const locales = await this.listLocalesInDir(autoDirUri);
        if (!locales.length) {
            return { filesChanged: 0, keysRemoved: 0 };
        }

        const byFile = new Map<string, FileBucket>();
        const processedKeys = new Set<string>();

        for (const entry of entries) {
            if (token.isCancellationRequested) {
                return { filesChanged: 0, keysRemoved: processedKeys.size };
            }

            const { keyPath, baseFileRel } = entry;
            if (!keyPath || !baseFileRel || processedKeys.has(keyPath)) {
                continue;
            }

            for (const locale of locales) {
                if (token.isCancellationRequested) {
                    return { filesChanged: 0, keysRemoved: processedKeys.size };
                }

                const fileRel = baseFileRel.startsWith(report.baseLocale)
                    ? path.join(locale, path.relative(report.baseLocale, baseFileRel))
                    : baseFileRel;
                const fileUri = vscode.Uri.joinPath(autoDirUri, fileRel);
                const mapKey = fileUri.toString();

                let bucket = byFile.get(mapKey);
                if (!bucket) {
                    try {
                        const data = await vscode.workspace.fs.readFile(fileUri);
                        const parsed = JSON.parse(sharedDecoder.decode(data));
                        const json = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                            ? parsed as Record<string, unknown>
                            : {};
                        bucket = { uri: fileUri, json, changed: false, deletedKeys: [] };
                        byFile.set(mapKey, bucket);
                    } catch {
                        continue;
                    }
                }

                if (this.deleteKeyPathInObject(bucket.json, keyPath)) {
                    bucket.changed = true;
                    if (!bucket.deletedKeys.includes(keyPath)) {
                        bucket.deletedKeys.push(keyPath);
                    }
                }
            }

            processedKeys.add(keyPath);
        }

        let filesChanged = 0;
        for (const bucket of byFile.values()) {
            if (!bucket.changed) continue;
            if (token.isCancellationRequested) {
                return { filesChanged, keysRemoved: processedKeys.size };
            }

            const payload = `${JSON.stringify(bucket.json, null, 2)}\n`;
            await vscode.workspace.fs.writeFile(bucket.uri, sharedEncoder.encode(payload));
            filesChanged += 1;
            await this.i18nIndex.updateFile(bucket.uri);
            await vscode.commands.executeCommand(
                'ai-localizer.i18n.refreshFileDiagnostics',
                bucket.uri,
                bucket.deletedKeys,
            );
        }

        return { filesChanged, keysRemoved: processedKeys.size };
    }
}
