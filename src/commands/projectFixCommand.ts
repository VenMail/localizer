import * as vscode from 'vscode';
import * as path from 'path';
import { TextEncoder, TextDecoder } from 'util';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { pickWorkspaceFolder, runI18nScript } from '../core/workspace';
import { getGitStatus, createSnapshotCommit } from '../core/gitMonitor';
import { findCommentRanges, isPositionInComment } from './untranslated/utils/commentParser';

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

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 1: Extract and rewrite source files
                    // ═══════════════════════════════════════════════════════════════
                    progress.report({ message: 'Extracting translatable strings (i18n:extract)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runExtractScript');
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Rewriting source to use t() calls (i18n:rewrite)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runRewriteScript');
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Rewriting Blade templates (i18n:rewrite-blade)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runRewriteBladeScript');
                    if (token.isCancellationRequested) return;

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 2: Initial sync to populate all locales (ONLY sync needed)
                    // ═══════════════════════════════════════════════════════════════
                    progress.report({ message: 'Syncing locales (i18n:sync)...' });
                    // Use runSyncScriptOnly to avoid triggering fix-untranslated cascade
                    await vscode.commands.executeCommand('ai-localizer.i18n.runSyncScriptOnly');
                    if (token.isCancellationRequested) return;

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 3: Build index and fix missing refs BEFORE cleanup
                    // This ensures cleanup sees accurate key usage from source files
                    // ═══════════════════════════════════════════════════════════════
                    progress.report({ message: 'Building index...' });
                    await this.i18nIndex.ensureInitialized(true);
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Fixing missing key references (before cleanup)...' });
                    await this.bulkFixMissingReferences(folder, token, progress);
                    if (token.isCancellationRequested) return;

                    // Rebuild index after fixing refs so cleanup sees correct usage
                    await this.i18nIndex.ensureInitialized(true);
                    if (token.isCancellationRequested) return;

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 4: Cleanup unused keys (now sees correct usage)
                    // ═══════════════════════════════════════════════════════════════
                    progress.report({ message: 'Scanning for unused translation keys...' });
                    await runI18nScript('i18n:cleanup-unused', { folder });
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Automatically removing unused keys from all locale files...' });
                    const unusedResult = await this.applyUnusedReportAcrossLocales(folder, token);
                    if (unusedResult.keysRemoved > 0) {
                        console.log(`[ProjectFixCommand] Removed ${unusedResult.keysRemoved} unused key(s) from ${unusedResult.filesChanged} locale file(s)`);
                    }
                    if (token.isCancellationRequested) return;

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 5: Cleanup invalid/non-translatable keys
                    // ═══════════════════════════════════════════════════════════════
                    progress.report({ message: 'Scanning for invalid/non-translatable keys...' });
                    await runI18nScript('i18n:restore-invalid', { folder });
                    if (token.isCancellationRequested) return;

                    progress.report({ message: 'Automatically restoring inline strings and removing invalid keys...' });
                    const invalidResult = await this.applyInvalidReportAcrossLocales(folder, token);
                    if (invalidResult.keysRemoved > 0) {
                        console.log(`[ProjectFixCommand] Restored inline strings and removed ${invalidResult.keysRemoved} invalid key(s) from ${invalidResult.filesChanged} locale file(s)`);
                    }
                    if (token.isCancellationRequested) return;

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 6: Rebuild index and track removed keys
                    // NOTE: We do NOT re-sync here! Sync would bring back cleaned keys.
                    // ═══════════════════════════════════════════════════════════════
                    progress.report({ message: 'Rebuilding index after cleanup...' });
                    await this.i18nIndex.ensureInitialized(true);
                    if (token.isCancellationRequested) return;

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 7: Final check for remaining issues
                    // ═══════════════════════════════════════════════════════════════
                    progress.report({ message: 'Final verification scan...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
                    if (token.isCancellationRequested) return;

                    // Re-run missing refs fix in case cleanup created orphans
                    const postCleanupMissing = await this.scanSourceFilesForMissingRefs(folder);
                    if (postCleanupMissing.missingReferences > 0) {
                        progress.report({ message: 'Fixing any orphaned references after cleanup...' });
                        await this.bulkFixMissingReferences(folder, token, progress);
                        await this.i18nIndex.ensureInitialized(true);
                    }
                    if (token.isCancellationRequested) return;

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 8: Automatic cleanup retry loop before AI translation
                    // ═══════════════════════════════════════════════════════════════
                    // Automatically resolve any remaining issues instead of prompting user
                    const maxRetries = 2;
                    let retryCount = 0;
                    let remainingUnused = 0;
                    let remainingMissing = 0;
                    let prevUnused = -1;
                    let prevMissing = -1;

                    while (retryCount < maxRetries) {
                        if (token.isCancellationRequested) return;
                        
                        // Re-scan for remaining issues
                        await runI18nScript('i18n:cleanup-unused', { folder });
                        remainingUnused = await this.countUnusedKeysFromReport(folder);
                        const missingRefsResult = await this.scanSourceFilesForMissingRefs(folder);
                        remainingMissing = missingRefsResult.missingReferences;

                        // If nothing changed from the previous pass, stop to avoid infinite loops
                        if (remainingUnused === prevUnused && remainingMissing === prevMissing) {
                            progress.report({ message: 'No progress in last pass; stopping cleanup loop.' });
                            break;
                        }

                        // Break if all issues resolved
                        if (remainingUnused === 0 && remainingMissing === 0) {
                            progress.report({ message: 'All cleanup issues resolved. Proceeding to AI translation...' });
                            break;
                        }

                        retryCount++;
                        progress.report({ 
                            message: `Retry ${retryCount}/${maxRetries}: Automatically fixing ${remainingUnused} unused key(s) and ${remainingMissing} missing reference(s)...` 
                        });

                        // Remember current state to detect no-progress next iteration
                        prevUnused = remainingUnused;
                        prevMissing = remainingMissing;

                        // Fix remaining unused keys
                        if (remainingUnused > 0) {
                            await this.applyUnusedReportAcrossLocales(folder, token);
                            await this.i18nIndex.ensureInitialized(true);
                        }

                        // Fix remaining missing references
                        if (remainingMissing > 0) {
                            await this.bulkFixMissingReferences(folder, token, progress);
                            await this.i18nIndex.ensureInitialized(true);
                        }
                    }

                    // If issues remain after retries, log warning but continue
                    if (remainingUnused > 0 || remainingMissing > 0) {
                        const warnMsg = `Warning: ${remainingUnused} unused key(s) and ${remainingMissing} missing reference(s) remain after ${maxRetries} retry attempts. Proceeding with AI translation anyway.`;
                        progress.report({ message: warnMsg });
                        console.warn(`[ProjectFixCommand] ${warnMsg}`);
                    }

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 9: AI translation for untranslated strings
                    // ═══════════════════════════════════════════════════════════════
                    progress.report({ message: 'Detecting and translating untranslated strings (i18n:fix-untranslated)...' });
                    await vscode.commands.executeCommand('ai-localizer.i18n.runFixUntranslatedScript');
                    if (token.isCancellationRequested) return;

                    // ═══════════════════════════════════════════════════════════════
                    // PHASE 10: Final rebuild and report
                    // ═══════════════════════════════════════════════════════════════
                    progress.report({ message: 'Rebuilding translation index and diagnostics...' });
                    await this.i18nIndex.ensureInitialized(true);
                    await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
                    if (token.isCancellationRequested) return;

                    await vscode.commands.executeCommand('ai-localizer.i18n.showHealthReport');
                },
            );

            const apiKey = (await this.translationService.getApiKey())?.trim();
            const translationNote = apiKey
                ? 'AI translation was enabled for this run.'
                : 'No OpenAI API key was configured; missing translations were not auto-filled by AI.';

            vscode.window.showInformationMessage(
                `AI Localizer: Project-wide i18n fix completed for workspace "${folder.name}". ${translationNote} Review locale files and git diff as needed.`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('AI Localizer: Failed to run project-wide i18n cleanup:', err);
            vscode.window.showErrorMessage(
                `AI Localizer: Failed to run project-wide i18n cleanup. ${msg}`,
            );
        }
    }

    private async countUnusedKeysFromReport(folder: vscode.WorkspaceFolder): Promise<number> {
        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-unused-report.json');
        try {
            const data = await vscode.workspace.fs.readFile(reportUri);
            const report = JSON.parse(sharedDecoder.decode(data)) as UnusedReport;
            return Array.isArray(report.unused) ? report.unused.length : 0;
        } catch {
            return 0;
        }
    }

    private async scanSourceFilesForMissingRefs(folder: vscode.WorkspaceFolder): Promise<{
        missingReferences: number;
        filesWithMissingRefs: vscode.Uri[];
    }> {
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const sourceGlobs = cfg.get<string[]>('i18n.sourceGlobs') || ['**/*.{ts,tsx,js,jsx,vue}'];
        const excludeGlobs = cfg.get<string[]>('i18n.sourceExcludeGlobs') || [
            '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
            '**/.next/**', '**/.nuxt/**', '**/.vite/**', '**/coverage/**', '**/out/**', '**/.turbo/**',
            '**/vendor/**',
        ];
        const exclude = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;

        const seen = new Set<string>();
        const uris: vscode.Uri[] = [];
        const includes = sourceGlobs.length > 0 ? sourceGlobs : [];

        for (const include of includes) {
            try {
                const pattern = new vscode.RelativePattern(folder, include);
                const found = await vscode.workspace.findFiles(pattern, exclude);
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

        await this.i18nIndex.ensureInitialized();
        const allKeysSet = new Set(this.i18nIndex.getAllKeys());
        
        // Regex to match t('key'), $t('key'), t("key"), etc.
        const tCallRegex = /\b(\$?)t\(\s*(['"])([A-Za-z0-9_.]+)\2\s*([,)])/g;

        let missingReferences = 0;
        const filesWithMissingRefs: vscode.Uri[] = [];

        for (const uri of uris) {
            try {
                const data = await vscode.workspace.fs.readFile(uri);
                const text = sharedDecoder.decode(data);

                const commentRanges = findCommentRanges(text);

                let hasMissing = false;
                let match;
                tCallRegex.lastIndex = 0;

                while ((match = tCallRegex.exec(text)) !== null) {
                    const dollarSignLength = match[1] ? 1 : 0;
                    const tCallStart = match.index + dollarSignLength;

                    if (isPositionInComment(tCallStart, commentRanges)) {
                        continue;
                    }

                    const key = match[3];
                    if (!allKeysSet.has(key)) {
                        missingReferences++;
                        hasMissing = true;
                    }
                }

                if (hasMissing) {
                    filesWithMissingRefs.push(uri);
                }
            } catch {
                // Skip files that can't be read
            }
        }

        return { missingReferences, filesWithMissingRefs };
    }

    /**
     * Count usages of a translation key in source files.
     * Used as a safety check before deleting keys from locale files.
     */
    private async countKeyUsageInSource(folder: vscode.WorkspaceFolder, key: string): Promise<number> {
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const sourceGlobs = cfg.get<string[]>('i18n.sourceGlobs') || ['**/*.{ts,tsx,js,jsx,vue}'];
        const excludeGlobs = cfg.get<string[]>('i18n.sourceExcludeGlobs') || [
            '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
            '**/.next/**', '**/.nuxt/**', '**/.vite/**', '**/coverage/**', '**/out/**', '**/.turbo/**',
            '**/vendor/**',
        ];
        const exclude = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;

        const seen = new Set<string>();
        const uris: vscode.Uri[] = [];
        const includes = sourceGlobs.length > 0 ? sourceGlobs : [];

        for (const include of includes) {
            try {
                const pattern = new vscode.RelativePattern(folder, include);
                const found = await vscode.workspace.findFiles(pattern, exclude);
                for (const uri of found) {
                    const keyStr = uri.toString();
                    if (!seen.has(keyStr)) {
                        seen.add(keyStr);
                        uris.push(uri);
                    }
                }
            } catch {
                // Skip invalid glob patterns
            }
        }

        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tCallRegex = new RegExp(`\\b\\$?t\\(\\s*['"\`]?${escapedKey}['"\`]?\\s*(?:,|\\))`, 'g');

        let count = 0;
        for (const uri of uris) {
            try {
                const data = await vscode.workspace.fs.readFile(uri);
                const text = sharedDecoder.decode(data);
                tCallRegex.lastIndex = 0;
                while (tCallRegex.exec(text) !== null) {
                    count += 1;
                }
                // Early exit if already found enough references
                if (count > 0) break;
            } catch {
                // Ignore unreadable files
            }
        }

        return count;
    }

    private async buildSourceUsageSet(
        folder: vscode.WorkspaceFolder,
        candidateKeys: Set<string>,
    ): Promise<Set<string>> {
        const usedKeys = new Set<string>();
        if (candidateKeys.size === 0) {
            return usedKeys;
        }

        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const sourceGlobs = cfg.get<string[]>('i18n.sourceGlobs') || ['**/*.{ts,tsx,js,jsx,vue}'];
        const excludeGlobs = cfg.get<string[]>('i18n.sourceExcludeGlobs') || [
            '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
            '**/.next/**', '**/.nuxt/**', '**/.vite/**', '**/coverage/**', '**/out/**', '**/.turbo/**',
            '**/vendor/**',
        ];
        const exclude = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;

        const seen = new Set<string>();
        const uris: vscode.Uri[] = [];
        const includes = sourceGlobs.length > 0 ? sourceGlobs : [];

        for (const include of includes) {
            try {
                const pattern = new vscode.RelativePattern(folder, include);
                const found = await vscode.workspace.findFiles(pattern, exclude);
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

        // Reuse the same t() pattern and comment handling as other source scanners
        const tCallRegex = /\b(\$?)t\(\s*(['"])([A-Za-z0-9_.]+)\2\s*([,)])/g;

        for (const uri of uris) {
            try {
                const data = await vscode.workspace.fs.readFile(uri);
                const text = sharedDecoder.decode(data);

                const commentRanges = findCommentRanges(text);

                let match;
                tCallRegex.lastIndex = 0;

                while ((match = tCallRegex.exec(text)) !== null) {
                    const dollarSignLength = match[1] ? 1 : 0;
                    const tCallStart = match.index + dollarSignLength;

                    if (isPositionInComment(tCallStart, commentRanges)) {
                        continue;
                    }

                    const key = match[3];
                    if (candidateKeys.has(key)) {
                        usedKeys.add(key);
                        if (usedKeys.size === candidateKeys.size) {
                            return usedKeys;
                        }
                    }
                }
            } catch {
                // Skip files that can't be read
            }
        }

        return usedKeys;
    }

    private async bulkFixMissingReferences(
        folder: vscode.WorkspaceFolder,
        token: vscode.CancellationToken,
        progress: vscode.Progress<{ message?: string }>,
    ): Promise<number> {
        const maxPasses = 3;
        let totalFixed = 0;

        for (let pass = 1; pass <= maxPasses; pass++) {
            if (token.isCancellationRequested) return totalFixed;

            // Scan source files directly for missing references (more reliable than diagnostics)
            const issues = await this.scanSourceFilesForMissingRefs(folder);
            if (issues.missingReferences === 0 || issues.filesWithMissingRefs.length === 0) {
                break;
            }

            progress.report({
                message: `Pass ${pass}/${maxPasses}: Fixing ${issues.missingReferences} missing refs in ${issues.filesWithMissingRefs.length} file(s)...`,
            });

            let fixedThisPass = 0;
            for (const uri of issues.filesWithMissingRefs) {
                if (token.isCancellationRequested) return totalFixed;

                try {
                    await vscode.commands.executeCommand('ai-localizer.i18n.bulkFixMissingKeyReferences', uri);
                    fixedThisPass += 1;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`AI Localizer: Bulk fix failed for ${uri.fsPath}. ${msg}`);
                }
            }

            totalFixed += fixedThisPass;

            // Rebuild index after fixes to pick up newly created keys
            await this.i18nIndex.ensureInitialized(true);

            // Check if we made progress
            const afterIssues = await this.scanSourceFilesForMissingRefs(folder);
            if (afterIssues.missingReferences >= issues.missingReferences) {
                // No progress made, stop iterating
                break;
            }
        }

        return totalFixed;
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

        let usedKeys = new Set<string>();
        if (reportType === 'unused') {
            const candidateKeys = new Set<string>();
            for (const entry of entries) {
                const keyPath = (entry as any).keyPath;
                if (typeof keyPath === 'string' && keyPath) {
                    candidateKeys.add(keyPath);
                }
            }
            usedKeys = await this.buildSourceUsageSet(folder, candidateKeys);
        }

        // CRITICAL: For invalid keys, restore inline strings in code BEFORE deleting from locale files
        // This prevents creating missing translation key diagnostics
        if (reportType === 'invalid') {
            let restoredCount = 0;
            for (const entry of entries) {
                if (token.isCancellationRequested) {
                    break;
                }
                
                const invalidEntry = entry as { keyPath: string; baseValue?: string; usages?: Array<{ file: string; line: number }> };
                const usages = invalidEntry.usages || [];
                const baseValue = invalidEntry.baseValue || '';
                
                for (const usage of usages) {
                    if (!usage || typeof usage.file !== 'string' || typeof usage.line !== 'number') {
                        continue;
                    }
                    
                    try {
                        const codeFileUri = vscode.Uri.joinPath(folder.uri, usage.file);
                        const restored = await this.restoreInlineStringInFile(
                            codeFileUri,
                            invalidEntry.keyPath,
                            baseValue,
                            usage.line - 1, // Report uses 1-based line numbers
                        );
                        if (restored) {
                            restoredCount++;
                        }
                    } catch (err) {
                        console.error(`AI Localizer: Failed to restore code reference for ${invalidEntry.keyPath} in ${usage.file}:`, err);
                    }
                }
            }
            
            if (restoredCount > 0) {
                console.log(`[ProjectFixCommand] Restored ${restoredCount} inline string(s) before deleting invalid keys`);
            }
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

            // Safety guard: if the key is still referenced in source, skip deletion
            if (reportType === 'unused') {
                if (usedKeys.has(keyPath)) {
                    console.log(
                        `[ProjectFixCommand] Skipping deletion of "${keyPath}" because it is still referenced in source.`,
                    );
                    processedKeys.add(keyPath);
                    continue;
                }
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

    /**
     * Restore a single t('key') call to an inline string in a specific file
     */
    private async restoreInlineStringInFile(
        fileUri: vscode.Uri,
        keyPath: string,
        baseValue: string,
        lineNumber: number,
    ): Promise<boolean> {
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const lineText = doc.lineAt(lineNumber).text;

            const escapedKey = keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const patterns = [
                new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*\\)`, 'g'),
                new RegExp(`t\\(\\s*['"]${escapedKey}['"]\\s*,\\s*\\{[^}]*\\}\\s*\\)`, 'g'),
            ];

            let newLineText = lineText;
            let replaced = false;

            const placeholderRegex = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)\}/g;
            const hasPlaceholders = placeholderRegex.test(baseValue);

            let replacement: string;
            if (hasPlaceholders) {
                const escaped = baseValue
                    .replace(/`/g, '\\`')
                    .replace(/\$/g, '\\$');
                replacement = `\`${escaped}\``;
            } else {
                const escaped = baseValue
                    .replace(/\\/g, '\\\\')
                    .replace(/'/g, "\\'")
                    .replace(/\r?\n/g, '\\n');
                replacement = `'${escaped}'`;
            }

            for (const pattern of patterns) {
                if (pattern.test(newLineText)) {
                    newLineText = newLineText.replace(pattern, replacement);
                    replaced = true;
                    break;
                }
            }

            if (!replaced) {
                return false;
            }

            const simplifyRedundantStringFallbacks = (input: string): string => {
                let out = input;
                const withParens = /\(\s*(['"`])((?:\\.|(?!\1)[^\\\r\n])+?)\1\s*\)\s*(\|\||\?\?)\s*\(\s*\1\2\1\s*\)/g;
                const withoutParens = /(['"`])((?:\\.|(?!\1)[^\\\r\n])+?)\1\s*(\|\||\?\?)\s*\1\2\1/g;
                for (let i = 0; i < 10; i += 1) {
                    const next = out.replace(withParens, (_m, q, v) => `${q}${v}${q}`)
                        .replace(withoutParens, (_m, q, v) => `${q}${v}${q}`);
                    if (next === out) break;
                    out = next;
                }
                return out;
            };

            newLineText = simplifyRedundantStringFallbacks(newLineText);

            const edit = new vscode.WorkspaceEdit();
            const range = doc.lineAt(lineNumber).range;
            edit.replace(fileUri, range, newLineText);
            await vscode.workspace.applyEdit(edit);
            return true;
        } catch (err) {
            console.error(`AI Localizer: Failed to restore inline string for ${keyPath} at ${fileUri.fsPath}:${lineNumber}:`, err);
            return false;
        }
    }
}
