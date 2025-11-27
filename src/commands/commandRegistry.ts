import * as vscode from 'vscode';
import { I18nIndex } from '../core/i18nIndex';
import { TranslationService } from '../services/translationService';
import { ProjectConfigService } from '../services/projectConfigService';
import { FileSystemService } from '../services/fileSystemService';
import { I18nStatusBar } from '../core/statusBar';
import { DiagnosticAnalyzer, getDiagnosticConfig } from '../services/diagnosticAnalyzer';

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
            // Import command handlers
            const { ConfigureProjectCommand } = require('./configureProjectCommand');
            const { ConvertSelectionCommand } = require('./convertSelectionCommand');
            const { StatusCommand } = require('./statusCommand');
            const { ScriptCommands } = require('./scriptCommands');
            const { UntranslatedCommands } = require('./untranslatedCommands');
            const { ComponentCommands } = require('./componentCommands');

            const untranslatedDiagnostics = vscode.languages.createDiagnosticCollection('ai-i18n-untranslated');
            disposables.push(untranslatedDiagnostics);

        // Rescan command
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.rescan', async () => {
                await this.i18nIndex.ensureInitialized(true);
                const count = this.i18nIndex.getAllKeys().length;
                vscode.window.showInformationMessage(`AI i18n: Indexed ${count} translation keys.`);
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
            vscode.commands.registerCommand('ai-assistant.i18n.configureProject', () =>
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
            vscode.commands.registerCommand('ai-assistant.i18n.convertSelectionToKey', () =>
                convertCmd.execute(),
            ),
        );

        // Status command
        const statusCmd = new StatusCommand(this.statusBar, this.projectConfigService);
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.showStatus', () =>
                statusCmd.execute(),
            ),
        );

        // Script commands
        const scriptCmds = new ScriptCommands();
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.runExtractScript', () =>
                scriptCmds.runExtract(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.runRewriteScript', () =>
                scriptCmds.runRewrite(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.runSyncScript', () =>
                scriptCmds.runSync(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.runFixUntranslatedScript', () =>
                scriptCmds.runFixUntranslated(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.runRewriteBladeScript', () =>
                scriptCmds.runRewriteBlade(),
            ),
        );

        // Untranslated commands
        const untranslatedCmds = new UntranslatedCommands(
            this.i18nIndex,
            this.translationService,
        );
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.openUntranslatedReport', () =>
                untranslatedCmds.openReport(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.applyUntranslatedAiFixes', () =>
                untranslatedCmds.applyAiFixes(),
            ),
            vscode.commands.registerCommand(
                'ai-assistant.i18n.applyUntranslatedQuickFix',
                (documentUri: vscode.Uri, key: string, locales: string[]) =>
                    untranslatedCmds.applyQuickFix(documentUri, key, locales),
            ),
            vscode.commands.registerCommand(
                'ai-assistant.i18n.gotoTranslationFromHover',
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
                        console.error('AI i18n: Failed to go to translation from hover:', err);
                    }
                },
            ),
        );

        // Component commands
        const componentCmds = new ComponentCommands(this.context, this.fileSystemService);
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.i18n.openRootApp', () =>
                componentCmds.openRootApp(),
            ),
            vscode.commands.registerCommand('ai-assistant.i18n.copyLanguageSwitcher', () =>
                componentCmds.copyLanguageSwitcher(),
            ),
        );

        // API Key command
        disposables.push(
            vscode.commands.registerCommand('ai-assistant.setOpenAiApiKeySecret', async () => {
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
                vscode.window.showInformationMessage('AI i18n: OpenAI API key stored securely.');
            }),
        );

        const folders = vscode.workspace.workspaceFolders || [];
        const globalCfg = vscode.workspace.getConfiguration('ai-assistant');
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
            vscode.window.showErrorMessage(`AI i18n: Failed to register commands. ${error}`);
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

        const diagnostics = await this.diagnosticAnalyzer.analyzeFile(uri, config, extraKeys);
        collection.set(uri, diagnostics);
    }

    /**
     * Refresh diagnostics for all locale files (full refresh).
     */
    private async refreshAllDiagnostics(
        collection: vscode.DiagnosticCollection,
    ): Promise<void> {
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
        await this.diagnosticAnalyzer.loadStyleReport(folders);
        await this.diagnosticAnalyzer.loadIgnorePatterns(folders);

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
