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

/**
 * Registry for all extension commands
 */
export class CommandRegistry {
    private diagnosticAnalyzer: DiagnosticAnalyzer;

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

    /**
     * Register all commands
     */
    registerAll(): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        try {
            this.log.appendLine('[CommandRegistry] Registering commands and diagnostics listeners...');

            const untranslatedDiagnostics = vscode.languages.createDiagnosticCollection('ai-i18n-untranslated');
            disposables.push(untranslatedDiagnostics);

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
            this.context,
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
        );
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
            vscode.commands.registerCommand('ai-localizer.i18n.applyUntranslatedAiFixes', () =>
                untranslatedCmds.applyAiFixes(),
            ),
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
                (documentUri?: vscode.Uri) => {
                    const uri = documentUri || vscode.window.activeTextEditor?.document.uri;
                    if (!uri) {
                        vscode.window.showWarningMessage('AI Localizer: No document available.');
                        return;
                    }
                    return untranslatedCmds.bulkFixMissingKeyReferences(uri);
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

        const handleLocaleChange = async (uri: vscode.Uri) => {
            this.log.appendLine(`[Watch] Locale file change detected: ${uri.fsPath}`);

            const beforeInfo = this.i18nIndex.getKeysForFile(uri);
            const beforeKeys = beforeInfo?.keys || [];

            await this.i18nIndex.updateFile(uri);

            const afterInfo = this.i18nIndex.getKeysForFile(uri);
            const afterKeys = afterInfo?.keys || [];

            const changedKeySet = new Set<string>();
            for (const k of beforeKeys) changedKeySet.add(k);
            for (const k of afterKeys) changedKeySet.add(k);

            this.log.appendLine(
                `[Watch] Keys changed in ${uri.fsPath}: ` +
                `Before: ${beforeKeys.length}, After: ${afterKeys.length}, Changed set: ${changedKeySet.size}`
            );

            // Always include the changed file itself so its diagnostics are cleared/updated.
            const impactedUriStrings = new Set<string>([uri.toString()]);

            // For each changed key, re-analyze all locale files that contain that key.
            for (const key of changedKeySet) {
                const record = this.i18nIndex.getRecord(key);
                if (!record) {
                    this.log.appendLine(`[Watch] Key ${key} not found in index (deleted from all locales)`);
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
                
                this.log.appendLine(
                    `[Watch] Key '${key}' impacts ${record.locations.length} locale file(s)`
                );
            }

            const impactedUris = Array.from(impactedUriStrings).map((s) => vscode.Uri.parse(s));
            this.log.appendLine(
                `[Watch] Recomputing diagnostics for ${impactedUris.length} locale file(s) ` +
                    `due to change in ${uri.fsPath}.`,
            );

            const extraKeys = Array.from(changedKeySet);
            for (const targetUri of impactedUris) {
                this.log.appendLine(`[Watch] Analyzing impacted file: ${targetUri.fsPath}`);
                await this.refreshFileDiagnostics(untranslatedDiagnostics, targetUri, extraKeys);
            }
        };

        for (const folder of folders) {
            for (const glob of localeGlobs) {
                const pattern = new vscode.RelativePattern(folder, glob);
                const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                watcher.onDidChange(handleLocaleChange, undefined, disposables);
                watcher.onDidCreate(handleLocaleChange, undefined, disposables);
                watcher.onDidDelete(handleLocaleChange, undefined, disposables);
                disposables.push(watcher);
            }
        }

        void this.refreshAllDiagnostics(untranslatedDiagnostics);

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
    ): Promise<void> {
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
        collection.set(uri, diagnostics);
    }

    /**
     * Refresh diagnostics for all locale files (full refresh).
     */
    private async refreshAllDiagnostics(
        collection: vscode.DiagnosticCollection,
    ): Promise<void> {
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
    }
}
