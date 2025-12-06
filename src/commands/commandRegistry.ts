import * as vscode from 'vscode';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { FileSystemService } from '../services/fileSystemService';
import { I18nStatusBar } from '../core/statusBar';
import { DiagnosticAnalyzer, getDiagnosticConfig } from '../services/diagnosticAnalyzer';

// Static imports for command handlers (avoids runtime require() overhead)
import { ConfigureProjectCommand } from './configureProjectCommand';
import { ConvertSelectionCommand } from './convertSelectionCommand';
import { StatusCommand } from './statusCommand';
import { ScriptCommands } from './scriptCommands';
import { UntranslatedCommands } from './untranslatedCommands';
import { ComponentCommands } from './componentCommands';
import { ScaffoldMessagesCommand } from './scaffoldMessagesCommand';
import { ProjectFixCommand } from './projectFixCommand';
import { operationLock } from './untranslated/utils/operationLock';
import { ReviewGeneratedService } from '../services/reviewGeneratedService';
import * as path from 'path';

/**
 * Registry for all extension commands
 */
export class CommandRegistry {
    private diagnosticAnalyzer: DiagnosticAnalyzer;
    private refreshAllDiagnosticsPromise: Promise<void> | null = null;
    private localeDiagnosticsDebounce = new Map<string, NodeJS.Timeout>();
    private static readonly LOCALE_DIAG_DEBOUNCE_MS = 1200;

    constructor(
        private context: vscode.ExtensionContext,
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private projectConfigService: ProjectConfigService,
        private fileSystemService: FileSystemService,
        private statusBar: I18nStatusBar,
        private log: vscode.OutputChannel,
    ) {
        this.diagnosticAnalyzer = new DiagnosticAnalyzer(
            i18nIndex,
            projectConfigService,
            log,
        );
    }

    private clearLocaleDebounceTimers(): void {
        for (const timer of this.localeDiagnosticsDebounce.values()) {
            clearTimeout(timer);
        }
        this.localeDiagnosticsDebounce.clear();
    }

    /**
     * Register all commands
     */
    registerAll(): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        try {
            this.log.appendLine('[CommandRegistry] Registering commands and diagnostics listeners...');

            const untranslatedDiagnostics = vscode.languages.createDiagnosticCollection('ai-i18n-untranslated');
            disposables.push(untranslatedDiagnostics);
            const sourceFileDiagnostics = vscode.languages.createDiagnosticCollection('ai-i18n-missing-refs');
            disposables.push(sourceFileDiagnostics);
            const reviewDiagnostics = vscode.languages.createDiagnosticCollection('ai-i18n-review');
            disposables.push(reviewDiagnostics);
            const reviewService = new ReviewGeneratedService(this.i18nIndex, this.log);
            const reviewDocumentSelector: vscode.DocumentSelector = [
                { scheme: 'file', pattern: '**/scripts/.i18n-review-generated.json' },
            ];
            let refreshAllSourceDiagnosticsPromise: Promise<void> | null = null;

            // Ensure debounce timers are cleared on dispose
            disposables.push({
                dispose: () => {
                    this.clearLocaleDebounceTimers();
                },
            });

        // Rescan command
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.i18n.rescan', async () => {
                await this.i18nIndex.ensureInitialized(true);
                const count = this.i18nIndex.getAllKeys().length;

                const foldersForState = vscode.workspace.workspaceFolders || [];
                const folderKey =
                    foldersForState.length > 0
                        ? foldersForState.map((f) => f.uri.fsPath).join('|')
                        : 'no-workspace';
                const rewriteOfferedKey = `ai-i18n:firstRewriteOffered:${folderKey}`;
                const languageSwitcherOfferedKey = `ai-i18n:languageSwitcherOffered:${folderKey}`;
                const rewriteOffered = this.context.workspaceState.get<boolean>(
                    rewriteOfferedKey,
                );
                const languageSwitcherOffered = this.context.workspaceState.get<boolean>(
                    languageSwitcherOfferedKey,
                );

                if (count === 0) {
                    const choice = await vscode.window.showInformationMessage(
                        'AI Localizer: No translation keys were found. Run the first-time setup now to configure scripts, extract keys, sync locales, rewrite code, and (optionally) auto-translate missing entries?',
                        'Run first-time setup',
                        'Cancel',
                    );
                    if (choice === 'Run first-time setup') {
                        await vscode.commands.executeCommand('ai-localizer.i18n.firstTimeSetup');
                    }
                } else {
                    if (!rewriteOffered) {
                        const localesAfterBootstrap = this.i18nIndex.getAllLocales();
                        const rewriteChoice = await vscode.window.showInformationMessage(
                            `AI Localizer: Indexed ${count} translation key(s)` +
                                (localesAfterBootstrap.length
                                    ? ` across ${localesAfterBootstrap.length} locale(s): ${localesAfterBootstrap.join(', ')}`
                                    : ''
                                ) +
                                '. Run the rewrite step now to replace inline strings with t() calls?',
                            'Run rewrite now',
                            'Skip for now',
                        );

                        if (rewriteChoice === 'Run rewrite now') {
                            await vscode.commands.executeCommand('ai-localizer.i18n.runRewriteScript');
                        }

                        await this.context.workspaceState.update(rewriteOfferedKey, true);
                    }

                    if (!languageSwitcherOffered) {
                        const lsChoice = await vscode.window.showInformationMessage(
                            'AI Localizer: Install a LanguageSwitcher component into your app now?',
                            'Install LanguageSwitcher',
                            'Skip for now',
                        );

                        if (lsChoice === 'Install LanguageSwitcher') {
                            await vscode.commands.executeCommand('ai-localizer.i18n.copyLanguageSwitcher');
                        }

                        await this.context.workspaceState.update(languageSwitcherOfferedKey, true);
                    } else if (rewriteOffered) {
                        vscode.window.showInformationMessage(
                            `AI Localizer: Indexed ${count} translation keys.`,
                        );
                    }
                }

                await this.refreshAllDiagnostics(untranslatedDiagnostics);
                await refreshAllSourceDiagnostics();
            }),
        );

        // Configure project command
        const configureCmd = new ConfigureProjectCommand(
            this.context,
            this.projectConfigService,
            this.fileSystemService,
        );
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.i18n.configureProject', () =>
                configureCmd.execute(),
            ),
        );

        // Convert selection command
        const convertCmd = new ConvertSelectionCommand(
            this.context,
            this.i18nIndex,
            this.translationService,
            this.projectConfigService,
            untranslatedDiagnostics,
        );
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.i18n.convertSelectionToKey', () =>
                convertCmd.execute(),
            ),
        );

        // Status command
        const statusCmd = new StatusCommand(this.statusBar, this.projectConfigService);
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.i18n.showStatus', () =>
                statusCmd.execute(),
            ),
        );

        // Project-wide fix command
        const projectFixCmd = new ProjectFixCommand(
            this.i18nIndex,
            this.translationService,
            this.projectConfigService,
        );
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.i18n.fixAllIssuesInProject', () =>
                projectFixCmd.execute(),
            ),
        );

        // Script commands
        const scriptCmds = new ScriptCommands(this.context);
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.i18n.runExtractScript', () =>
                scriptCmds.runExtract(),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.runRewriteScript', () =>
                scriptCmds.runRewrite(),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.runSyncScript', async () => {
                await scriptCmds.runSync();

                const apiKey = (await this.translationService.getApiKey())?.trim();
                if (apiKey) {
                    await scriptCmds.runFixUntranslated();
                    await vscode.commands.executeCommand('ai-localizer.i18n.applyUntranslatedAiFixes');
                }
            }),
            // Lightweight sync: only runs i18n:sync without triggering fix-untranslated cascade
            // Used by single-key quick fixes to avoid regenerating reports mid-translation
            vscode.commands.registerCommand('ai-localizer.i18n.runSyncScriptOnly', () =>
                scriptCmds.runSync(),
            ),
            // Granular sync: sync only specific keys (most efficient for quick fixes)
            vscode.commands.registerCommand(
                'ai-localizer.i18n.syncKeys',
                async (keys: string[], folder?: vscode.WorkspaceFolder) =>
                    scriptCmds.syncKeys(keys, folder),
            ),
            // Granular sync: sync all keys from a specific file
            vscode.commands.registerCommand(
                'ai-localizer.i18n.syncFile',
                async (fileUri: vscode.Uri, folder?: vscode.WorkspaceFolder) =>
                    scriptCmds.syncFile(fileUri, folder),
            ),
            // Ensure keys exist in all locales (create if missing)
            vscode.commands.registerCommand(
                'ai-localizer.i18n.ensureKeys',
                async (keys: string[], values?: Record<string, string>, folder?: vscode.WorkspaceFolder) =>
                    scriptCmds.ensureKeys(keys, values ?? {}, folder),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.runFixUntranslatedScript', async () => {
                await scriptCmds.runFixUntranslated();

                const apiKey = (await this.translationService.getApiKey())?.trim();
                if (apiKey) {
                    await vscode.commands.executeCommand('ai-localizer.i18n.applyUntranslatedAiFixes');
                }
            }),
            vscode.commands.registerCommand('ai-localizer.i18n.runRewriteBladeScript', () =>
                scriptCmds.runRewriteBlade(),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.runCleanupUnusedScript', () =>
                scriptCmds.runCleanupUnused(),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.runRestoreInvalidScript', () =>
                scriptCmds.runRestoreInvalid(),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.firstTimeSetup', async () => {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'AI Localizer: First-time project setup',
                        cancellable: false,
                    },
                    async (progress) => {
                        try {
                            progress.report({ message: 'Configuring project i18n (scripts, locales, srcRoot)...' });
                            await configureCmd.execute();

                            progress.report({ message: 'Running initial extract (i18n:extract)...' });
                            await scriptCmds.runExtract();

                            progress.report({ message: 'Syncing locales (i18n:sync)...' });
                            await scriptCmds.runSync();

                            const apiKey = (await this.translationService.getApiKey())?.trim();
                            let ranAiFixes = false;
                            if (apiKey) {
                                progress.report({ message: 'Filling missing translations with AI (i18n:fix-untranslated)...' });
                                await scriptCmds.runFixUntranslated();
                                await vscode.commands.executeCommand('ai-localizer.i18n.applyUntranslatedAiFixes');
                                ranAiFixes = true;
                            }

                            progress.report({ message: 'Rewriting source code to use t() calls (i18n:rewrite)...' });
                            await scriptCmds.runRewrite();

                            try {
                                const foldersForEnv = vscode.workspace.workspaceFolders || [];
                                const primaryFolder = foldersForEnv[0];
                                if (primaryFolder) {
                                    const projectEnvModule = require('../core/projectEnv') as typeof import('../core/projectEnv');
                                    const env = await projectEnvModule.getProjectEnv(primaryFolder);
                                    if (env.bundler === 'vite') {
                                        progress.report({ message: 'Scaffolding Vite messages loader (auto/**/*.json)...' });
                                        await vscode.commands.executeCommand('ai-localizer.i18n.scaffoldMessagesLoader');
                                    }
                                }
                            } catch (scaffoldErr) {
                                const msg = scaffoldErr instanceof Error ? scaffoldErr.message : String(scaffoldErr);
                                this.log.appendLine(`[FirstTimeSetup] Failed to scaffold messages loader: ${msg}`);
                            }

                            progress.report({ message: 'Building translation index and diagnostics...' });
                            await this.i18nIndex.ensureInitialized(true);
                            const keyCount = this.i18nIndex.getAllKeys().length;
                            const locales = this.i18nIndex.getAllLocales();

                            await this.refreshAllDiagnostics(untranslatedDiagnostics);

                            const foldersForState = vscode.workspace.workspaceFolders || [];
                            const folderKey =
                                foldersForState.length > 0
                                    ? foldersForState.map((f) => f.uri.fsPath).join('|')
                                    : 'no-workspace';
                            const languageSwitcherOfferedKey = `ai-i18n:languageSwitcherOffered:${folderKey}`;
                            const languageSwitcherOffered = this.context.workspaceState.get<boolean>(
                                languageSwitcherOfferedKey,
                            );

                            if (!languageSwitcherOffered) {
                                const lsChoice = await vscode.window.showInformationMessage(
                                    'AI Localizer: Install a LanguageSwitcher component into your app now?',
                                    'Install LanguageSwitcher',
                                    'Skip for now',
                                );

                                if (lsChoice === 'Install LanguageSwitcher') {
                                    await vscode.commands.executeCommand('ai-localizer.i18n.copyLanguageSwitcher');
                                }

                                await this.context.workspaceState.update(languageSwitcherOfferedKey, true);
                            }

                            const parts: string[] = [];
                            parts.push(`AI i18n setup complete: ${keyCount} key(s)`);
                            if (locales.length) {
                                parts.push(`across ${locales.length} locale(s): ${locales.join(', ')}`);
                            }
                            if (!apiKey) {
                                parts.push('No OpenAI API key configured; you can add one later to enable automatic translations.');
                            } else if (ranAiFixes) {
                                parts.push('AI attempted to fill missing translations; review locale files as needed.');
                            }

                            vscode.window.showInformationMessage(parts.join(' '));
                        } catch (error) {
                            const msg = error instanceof Error ? error.message : String(error);
                            this.log.appendLine(`[FirstTimeSetup] Failed: ${msg}`);
                            vscode.window.showErrorMessage(`AI Localizer: First-time setup failed. ${msg}`);
                        }
                    },
                );
            }),
        );

        // Untranslated commands
        const untranslatedCmds = new UntranslatedCommands(
            this.i18nIndex,
            this.translationService,
            this.projectConfigService,
            this.context,
            this.log,
        );
        // Register cleanup for UntranslatedCommands
        disposables.push({ dispose: () => untranslatedCmds.dispose() });
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.i18n.openUntranslatedReport', () =>
                untranslatedCmds.openReport(),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.refreshFileDiagnostics',
                async (uri: vscode.Uri, extraKeys?: string[]) => {
                    if (!uri) return;
                    await this.refreshFileDiagnostics(untranslatedDiagnostics, uri, extraKeys);
                },
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.invalidateReportKeys',
                (keys: string[]) => {
                    if (keys && keys.length > 0) {
                        this.diagnosticAnalyzer.invalidateUntranslatedReportKeys(keys);
                    }
                },
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.applyUntranslatedAiFixes', () =>
                untranslatedCmds.applyAiFixes(),
            ),
            vscode.commands.registerCommand('ai-localizer.reviewGenerated.refresh', async () => {
                const folder = vscode.workspace.workspaceFolders?.[0];
                if (!folder) return;
                await reviewService.refreshDiagnostics(folder, reviewDiagnostics);
            }),
            vscode.commands.registerCommand('ai-localizer.reviewGenerated.apply', async () => {
                const folder = vscode.workspace.workspaceFolders?.[0];
                const editor = vscode.window.activeTextEditor;
                if (!folder || !editor) return;
                await reviewService.applyReviewFile(folder, editor.document);
                await reviewService.refreshDiagnostics(folder, reviewDiagnostics);
            }),
            vscode.commands.registerCommand('ai-localizer.reviewGenerated.showHistory', async () => {
                const folder = vscode.workspace.workspaceFolders?.[0];
                const editor = vscode.window.activeTextEditor;
                if (!folder || !editor) return;
                await reviewService.showGitHistoryForCursor(folder, editor.document, editor.selection.active);
            }),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.applyUntranslatedQuickFix',
                (documentUri: vscode.Uri, key: string, locales: string[]) =>
                    untranslatedCmds.applyQuickFix(documentUri, key, locales),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.reviewSelection', () =>
                untranslatedCmds.reviewSelection(),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.generateAutoIgnore', () =>
                untranslatedCmds.generateAutoIgnore(),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.showHealthReport', () =>
                untranslatedCmds.showHealthReport(),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.applyStyleSuggestionQuickFix',
                (documentUri: vscode.Uri, key: string, locale: string, suggested: string) =>
                    untranslatedCmds.applyStyleSuggestionQuickFix(documentUri, key, locale, suggested),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.applyAllStyleSuggestionsInFile',
                (documentUri?: vscode.Uri) => untranslatedCmds.applyAllStyleSuggestionsInFile(documentUri),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.fixAllIssuesInFile',
                (documentUri?: vscode.Uri) => untranslatedCmds.fixAllIssuesInFile(documentUri),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.cleanupUnusedKeysInFile',
                (documentUri?: vscode.Uri) => untranslatedCmds.cleanupUnusedInFile(documentUri),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.restoreInvalidKeysInFile',
                (documentUri?: vscode.Uri) => untranslatedCmds.restoreInvalidInFile(documentUri),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.bulkFixMissingKeyReferences',
                async (documentUri?: vscode.Uri) => {
                    const uri = documentUri || vscode.window.activeTextEditor?.document.uri;
                    if (!uri) {
                        vscode.window.showWarningMessage('AI Localizer: No document available.');
                        return;
                    }
                    try {
                        await untranslatedCmds.bulkFixMissingKeyReferences(uri);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.error('AI Localizer: Failed to bulk fix missing key references:', err);
                        vscode.window.showErrorMessage(`AI Localizer: Failed to fix missing references. ${msg}`);
                    }
                },
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.translateAllUntranslatedInFile',
                (documentUri?: vscode.Uri) => untranslatedCmds.translateAllUntranslatedInFile(documentUri),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.translateAllUntranslatedInProject',
                () => untranslatedCmds.translateAllUntranslatedInProject(),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.removeUnusedKeyInFile',
                (documentUri: vscode.Uri, keyPath: string) =>
                    untranslatedCmds.removeUnusedKeyInFile(documentUri, keyPath),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.removeInvalidKeyInFile',
                (documentUri: vscode.Uri, keyPath: string) =>
                    untranslatedCmds.removeInvalidKeyInFile(documentUri, keyPath),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.restoreInvalidKeyInCode',
                (documentUri: vscode.Uri, position: { line: number; character: number }, key: string) =>
                    untranslatedCmds.restoreInvalidKeyInCode(documentUri, position, key),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.fixMissingKeyReference',
                (documentUri: vscode.Uri, position: { line: number; character: number }, key: string) =>
                    untranslatedCmds.fixMissingKeyReference(documentUri, position, key),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.addKeyToIgnoreList',
                (folderUri: vscode.Uri, key: string) =>
                    untranslatedCmds.addKeyToIgnoreList(folderUri, key),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.fixPlaceholderMismatch',
                (documentUri: vscode.Uri, key: string, locale: string) =>
                    untranslatedCmds.fixPlaceholderMismatch(documentUri, key, locale),
            ),
            vscode.commands.registerCommand(
                'ai-localizer.i18n.gotoTranslationFromHover',
                async (args: { uri: string; position: { line: number; character: number } }) => {
                    try {
                        if (!args || !args.uri || !args.position) {
                            return;
                        }
                        const uri = vscode.Uri.parse(args.uri);
                        const position = new vscode.Position(
                            args.position.line,
                            args.position.character,
                        );
                        const locations =
                            (await vscode.commands.executeCommand(
                                'vscode.executeDefinitionProvider',
                                uri,
                                position,
                            )) || [];
                        const first = Array.isArray(locations) && locations.length > 0
                            ? (locations[0] as vscode.Location)
                            : undefined;
                        if (!first) {
                            return;
                        }
                        const doc = await vscode.workspace.openTextDocument(first.uri);
                        const editor = await vscode.window.showTextDocument(doc, {
                            preview: false,
                        });
                        editor.selection = new vscode.Selection(first.range.start, first.range.start);
                        editor.revealRange(
                            first.range,
                            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
                        );
                    } catch (err) {
                        console.error('AI Localizer: Failed to go to translation from hover:', err);
                    }
                },
            ),
        );

        // Component commands
        const componentCmds = new ComponentCommands(this.context, this.fileSystemService);
        const scaffoldMessagesCmd = new ScaffoldMessagesCommand(this.context);
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.i18n.openRootApp', () =>
                componentCmds.openRootApp(),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.copyLanguageSwitcher', () =>
                componentCmds.copyLanguageSwitcher(),
            ),
            vscode.commands.registerCommand('ai-localizer.i18n.scaffoldMessagesLoader', () =>
                scaffoldMessagesCmd.execute(),
            ),
        );

        // API Key command
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.setOpenAiApiKeySecret', async () => {
                const existing = (await this.context.secrets.get('openaiApiKey')) || '';
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter your OpenAI API key to store securely',
                    ignoreFocusOut: true,
                    value: existing,
                    password: true,
                });
                if (!input) {
                    return;
                }
                await this.translationService.setApiKey(input);
                vscode.window.showInformationMessage('AI Localizer: OpenAI API key stored securely.');
            }),
        );

        const folders = vscode.workspace.workspaceFolders || [];
        const globalCfg = vscode.workspace.getConfiguration('ai-localizer');
        const localeGlobs =
            globalCfg.get<string[]>('i18n.localeGlobs') || [
                'resources/js/i18n/auto/**/*.json',
                'src/i18n/**/*.json',
                'src/locales/**/*.json',
                'locales/**/*.json',
                'i18n/**/*.json',
            ];

        const sourceIncludeGlobs =
            globalCfg.get<string[]>('i18n.sourceGlobs') || ['**/*.{ts,tsx,js,jsx,vue}'];
        const sourceExcludeGlobs =
            globalCfg.get<string[]>('i18n.sourceExcludeGlobs') || [
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

        const collectSourceFileUris = async (): Promise<vscode.Uri[]> => {
            const diagConfig = getDiagnosticConfig();
            const verbose = diagConfig.verboseLogging === true;
            const include =
                sourceIncludeGlobs.length === 1
                    ? sourceIncludeGlobs[0]
                    : `{${sourceIncludeGlobs.join(',')}}`;
            const exclude =
                sourceExcludeGlobs.length > 0 ? `{${sourceExcludeGlobs.join(',')}}` : undefined;
            const uris = await vscode.workspace.findFiles(include, exclude);
            if (verbose) {
                this.log.appendLine(
                    `[Diagnostics] Collected ${uris.length} source file(s) for missing reference scan.`,
                );
            }
            return uris;
        };

        const handleLocaleChange = async (uri: vscode.Uri) => {
            const currentOp = operationLock.getCurrentOperation();
            const isBulkOp =
                currentOp &&
                ['key-management', 'translation-project', 'translation-file', 'cleanup-unused', 'cleanup-invalid', 'style-fix'].includes(
                    currentOp.type,
                );

            if (isBulkOp) {
                // Skip locale change handling while bulk ops are running
                return;
            }
            const diagConfig = getDiagnosticConfig();
            const verbose = diagConfig.verboseLogging === true;
            if (verbose) {
                this.log.appendLine(`[Watch] Locale file change detected: ${uri.fsPath}`);
            }

            const beforeInfo = this.i18nIndex.getKeysForFile(uri);
            const beforeKeys = beforeInfo?.keys || [];

            await this.i18nIndex.updateFile(uri);

            const afterInfo = this.i18nIndex.getKeysForFile(uri);
            const afterKeys = afterInfo?.keys || [];

            const changedKeySet = new Set<string>();
            for (const k of beforeKeys) changedKeySet.add(k);
            for (const k of afterKeys) changedKeySet.add(k);

            if (verbose) {
                this.log.appendLine(
                    `[Watch] Keys changed in ${uri.fsPath}: ` +
                    `Before: ${beforeKeys.length}, After: ${afterKeys.length}, Changed set: ${changedKeySet.size}`
                );
            }

            // Always include the changed file itself so its diagnostics are cleared/updated.
            const impactedUriStrings = new Set<string>([uri.toString()]);

            // For each changed key, re-analyze all locale files that contain that key.
            for (const key of changedKeySet) {
                const record = this.i18nIndex.getRecord(key);
                if (!record) {
                    if (verbose) {
                        this.log.appendLine(`[Watch] Key ${key} not found in index (deleted from all locales)`);
                    }
                    continue;
                }
                
                // Always include default locale file for this key
                const defaultLocale = record.defaultLocale;
                const defaultLoc = record.locations.find(l => l.locale === defaultLocale);
                if (defaultLoc) {
                    impactedUriStrings.add(defaultLoc.uri.toString());
                }
                
                // Include all other locales where this key appears
                for (const loc of record.locations) {
                    impactedUriStrings.add(loc.uri.toString());
                }
                
                if (verbose) {
                    this.log.appendLine(
                        `[Watch] Key '${key}' impacts ${record.locations.length} locale file(s)`
                    );
                }
            }

            const impactedUris = Array.from(impactedUriStrings).map((s) => vscode.Uri.parse(s));
            if (verbose) {
                this.log.appendLine(
                    `[Watch] Recomputing diagnostics for ${impactedUris.length} locale file(s) ` +
                        `due to change in ${uri.fsPath}.`,
                );
            }

            const extraKeys = Array.from(changedKeySet);
            for (const targetUri of impactedUris) {
                if (verbose) {
                    this.log.appendLine(`[Watch] Analyzing impacted file: ${targetUri.fsPath}`);
                }
                await this.refreshFileDiagnostics(untranslatedDiagnostics, targetUri, extraKeys);
            }
        };

        const isSourceFile = (languageId: string): boolean => {
            return ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'vue'].includes(languageId);
        };

        // Debounce map for source file analysis
        const sourceFileDebounceTimers = new Map<string, NodeJS.Timeout>();
        const SOURCE_FILE_DEBOUNCE_MS = 500;

        const refreshSourceFileDiagnostics = async (document: vscode.TextDocument, immediate = false) => {
            const currentOp = operationLock.getCurrentOperation();
            if (currentOp?.type === 'key-management') {
                // Skip source diagnostics refresh while bulk key management is running
                return;
            }
            if (!isSourceFile(document.languageId)) {
                return;
            }

            const config = getDiagnosticConfig();
            if (!config.enabled || !config.missingReferenceEnabled) {
                sourceFileDiagnostics.delete(document.uri);
                return;
            }

            const uriKey = document.uri.toString();

            // Clear existing timer
            const existingTimer = sourceFileDebounceTimers.get(uriKey);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            const doAnalysis = async () => {
                sourceFileDebounceTimers.delete(uriKey);
                const diagnostics = await this.diagnosticAnalyzer.analyzeSourceFile(document.uri, config);
                sourceFileDiagnostics.set(document.uri, diagnostics);
            };

            if (immediate) {
                await doAnalysis();
            } else {
                // Debounce to avoid analyzing on every keystroke
                const timer = setTimeout(() => {
                    void doAnalysis();
                }, SOURCE_FILE_DEBOUNCE_MS);
                sourceFileDebounceTimers.set(uriKey, timer);
            }
        };

        // Enhanced locale change handler that also refreshes source file diagnostics
        const enhancedHandleLocaleChange = async (uri: vscode.Uri) => {
            await handleLocaleChange(uri);
            // After locale files change, refresh diagnostics for all open source files
            for (const editor of vscode.window.visibleTextEditors) {
                if (isSourceFile(editor.document.languageId)) {
                    await refreshSourceFileDiagnostics(editor.document);
                }
            }
        };

        const refreshAllSourceDiagnostics = async (): Promise<void> => {
            if (refreshAllSourceDiagnosticsPromise) {
                await refreshAllSourceDiagnosticsPromise;
                return;
            }

            refreshAllSourceDiagnosticsPromise = (async () => {
                const config = getDiagnosticConfig();
                if (!config.enabled || !config.missingReferenceEnabled) {
                    sourceFileDiagnostics.clear();
                    return;
                }
                const verbose = config.verboseLogging === true;

                await this.i18nIndex.ensureInitialized();
                const uris = await collectSourceFileUris();
                if (verbose) {
                    this.log.appendLine(
                    `[Diagnostics] Scanning ${uris.length} source file(s) for missing translation key references...`,
                    );
                }

                const results = await Promise.all(
                    uris.map(async (uri) => {
                        const diagnostics = await this.diagnosticAnalyzer.analyzeSourceFile(uri, config);
                        return { uri, diagnostics };
                    }),
                );

                sourceFileDiagnostics.clear();
                for (const { uri, diagnostics } of results) {
                    sourceFileDiagnostics.set(uri, diagnostics);
                }
            })();

            try {
                await refreshAllSourceDiagnosticsPromise;
            } finally {
                refreshAllSourceDiagnosticsPromise = null;
            }
        };

        // Review file IntelliSense (Ctrl+Click navigation)
        disposables.push(
            vscode.languages.registerDefinitionProvider(reviewDocumentSelector, {
                provideDefinition: (document, position) => reviewService.provideDefinition(document, position),
            }),
            vscode.languages.registerDocumentLinkProvider(reviewDocumentSelector, {
                provideDocumentLinks: (document, token) => reviewService.provideDocumentLinks(document, token),
            }),
        );

        // Register watchers ONCE with the enhanced handler (avoids duplicate registrations)
        for (const folder of folders) {
            for (const glob of localeGlobs) {
                const pattern = new vscode.RelativePattern(folder, glob);
                const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                watcher.onDidChange(enhancedHandleLocaleChange, undefined, disposables);
                watcher.onDidCreate(enhancedHandleLocaleChange, undefined, disposables);
                watcher.onDidDelete(enhancedHandleLocaleChange, undefined, disposables);
                disposables.push(watcher);
            }

            // Watch review-generated file
            const reviewWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, 'scripts/.i18n-review-generated.json'),
            );
            const refreshReview = async () => {
                await reviewService.refreshDiagnostics(folder, reviewDiagnostics);
            };
            reviewWatcher.onDidChange(refreshReview, undefined, disposables);
            reviewWatcher.onDidCreate(refreshReview, undefined, disposables);
            reviewWatcher.onDidDelete(() => reviewDiagnostics.clear(), undefined, disposables);
            disposables.push(reviewWatcher);
        }

        void this.refreshAllDiagnostics(untranslatedDiagnostics);
        void refreshAllSourceDiagnostics();
        
        // Cleanup debounce timers on dispose
        disposables.push({
            dispose: () => {
                for (const timer of sourceFileDebounceTimers.values()) {
                    clearTimeout(timer);
                }
                sourceFileDebounceTimers.clear();
            },
        });

        // Refresh diagnostics when source files are opened (immediate)
        disposables.push(
            vscode.workspace.onDidOpenTextDocument(async (document) => {
                await refreshSourceFileDiagnostics(document, true);
            }),
        );

        // Refresh diagnostics when source files are changed (debounced)
        disposables.push(
            vscode.workspace.onDidChangeTextDocument(async (event) => {
                await refreshSourceFileDiagnostics(event.document, false);
            }),
        );

        // Refresh diagnostics when source files are saved (immediate)
        disposables.push(
            vscode.workspace.onDidSaveTextDocument(async (document) => {
                // If review file saved, apply changes and refresh diagnostics
                if (document.uri.fsPath.endsWith(`${path.sep}scripts${path.sep}.i18n-review-generated.json`)) {
                    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
                    if (folder) {
                        await reviewService.applyReviewFile(folder, document);
                        await reviewService.refreshDiagnostics(folder, reviewDiagnostics);
                    }
                    return;
                }
                await refreshSourceFileDiagnostics(document, true);
            }),
        );

        // Clear diagnostics when source files are closed
        disposables.push(
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (isSourceFile(document.languageId)) {
                    sourceFileDiagnostics.delete(document.uri);
                }
            }),
        );

        // Register command to manually refresh source file diagnostics
        disposables.push(
            vscode.commands.registerCommand('ai-localizer.i18n.refreshSourceFileDiagnostics', async () => {
                for (const editor of vscode.window.visibleTextEditors) {
                    await refreshSourceFileDiagnostics(editor.document);
                }
            }),
        );

        // Analyze currently open source files (immediate)
        for (const editor of vscode.window.visibleTextEditors) {
            if (isSourceFile(editor.document.languageId)) {
                void refreshSourceFileDiagnostics(editor.document, true);
            }
        }

        } catch (error) {
            console.error('Failed to register commands:', error);
            const details =
                error instanceof Error ? error.stack || error.message : String(error);
            this.log.appendLine(`[CommandRegistry] Failed to register commands: ${details}`);
            vscode.window.showErrorMessage(`AI Localizer: Failed to register commands. ${error}`);
            throw error;
        }

        return disposables;
    }

    /**
     * Refresh diagnostics for a single file (incremental update).
     */
    private async refreshFileDiagnostics(
        collection: vscode.DiagnosticCollection,
        uri: vscode.Uri,
        extraKeys?: string[],
        options?: { force?: boolean },
    ): Promise<void> {
        const currentOp = operationLock.getCurrentOperation();
        const shouldDebounce =
            currentOp &&
            !options?.force &&
            ['key-management', 'translation-project', 'translation-file', 'cleanup-unused', 'cleanup-invalid', 'style-fix'].includes(
                currentOp.type,
            );

        const uriKey = uri.toString();

        if (shouldDebounce) {
            const existing = this.localeDiagnosticsDebounce.get(uriKey);
            if (existing) {
                clearTimeout(existing);
            }
            const timer = setTimeout(() => {
                this.localeDiagnosticsDebounce.delete(uriKey);
                void this.refreshFileDiagnostics(collection, uri, extraKeys, { force: true });
            }, CommandRegistry.LOCALE_DIAG_DEBOUNCE_MS);
            this.localeDiagnosticsDebounce.set(uriKey, timer);
            return;
        }

        const config = getDiagnosticConfig();
        if (!config.enabled) {
            collection.delete(uri);
            return;
        }

        const folders = vscode.workspace.workspaceFolders || [];
        await this.diagnosticAnalyzer.loadStyleReport(folders);
        await this.diagnosticAnalyzer.loadIgnorePatterns(folders);

        // Invalidate stale untranslated report entries for changed keys
        // This ensures that manually edited translations are re-evaluated
        // against the actual values rather than stale report data
        if (extraKeys && extraKeys.length > 0) {
            this.diagnosticAnalyzer.invalidateUntranslatedReportKeys(extraKeys);
        }

        const diagnostics = await this.diagnosticAnalyzer.analyzeFile(uri, config, extraKeys);
        // Deduplicate diagnostics (sometimes multiple analyzers report the same issue)
        const seen = new Set<string>();
        const deduped = diagnostics.filter((d) => {
            const key = `${d.range.start.line}:${d.range.start.character}:${d.message}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        collection.set(uri, deduped);
    }

    /**
     * Refresh diagnostics for all locale files (full refresh).
     */
    private async refreshAllDiagnostics(
        collection: vscode.DiagnosticCollection,
        options?: { force?: boolean },
    ): Promise<void> {
        const currentOp = operationLock.getCurrentOperation();
        if (currentOp?.type === 'key-management' && !options?.force) {
            // Skip full diagnostics refresh while bulk key management runs
            return;
        }
        if (this.refreshAllDiagnosticsPromise) {
            await this.refreshAllDiagnosticsPromise;
            return;
        }

        this.refreshAllDiagnosticsPromise = (async () => {
        this.diagnosticAnalyzer.resetCaches();
        await this.i18nIndex.ensureInitialized();

        const config = getDiagnosticConfig();
        if (!config.enabled) {
            collection.clear();
            this.log.appendLine('[Diagnostics] Diagnostics disabled; clearing.');
            return;
        }

        const allKeys = this.i18nIndex.getAllKeys();
        if (!allKeys.length) {
            collection.clear();
            this.log.appendLine(
                '[Diagnostics] No translation keys found in index; clearing diagnostics.',
            );
            return;
        }

        this.log.appendLine(
            `[Diagnostics] Found ${allKeys.length} translation key(s) in index.`,
        );

        const folders = vscode.workspace.workspaceFolders || [];
        await this.diagnosticAnalyzer.loadStyleReport(folders, true);
        await this.diagnosticAnalyzer.loadIgnorePatterns(folders, true);
        await this.diagnosticAnalyzer.loadUntranslatedReport(folders, true);

        const diagnosticMap = await this.diagnosticAnalyzer.analyzeAll(config);

        collection.clear();
        for (const [uriString, diagnostics] of diagnosticMap) {
            collection.set(vscode.Uri.parse(uriString), diagnostics);
        }

        this.log.appendLine(
            `[Diagnostics] Updated diagnostics for ${diagnosticMap.size} locale file(s).`,
        );
        })();

        try {
            await this.refreshAllDiagnosticsPromise;
        } finally {
            this.refreshAllDiagnosticsPromise = null;
        }
    }
}
