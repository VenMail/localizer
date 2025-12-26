import * as vscode from 'vscode';
import * as path from 'path';
import { isFileClean } from './gitMonitor';
import { runI18nScript } from './workspace';
import { getGranularSyncService } from '../services/granularSyncService';
import { isProjectDisabled } from '../utils/projectIgnore';
import { FileSystemService } from '../services/fileSystemService';
import { ProjectConfigService } from '../services/projectConfigService';

interface MonitorState {
    lastExtractTime: number;
    lastRewriteTime: number;
    lastPromptTime: number;
    pendingFiles: Set<string>;
    isProcessing: boolean;
    promptDismissedThisSession: boolean;
    outdatedScriptsChecked: boolean;
    lastScriptCheckTime: number;
}

const DEBOUNCE_DELAY = 5000; // 5 seconds - increased to reduce prompt frequency
const MIN_INTERVAL_BETWEEN_PROMPTS = 300000; // 5 minutes - minimum time between showing prompts
const SCRIPT_CHECK_INTERVAL = 86400000; // 24 hours - minimum time between script checks

export class AutoMonitor {
    private states = new Map<string, MonitorState>();
    private disposables: vscode.Disposable[] = [];
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private fileSystemService = new FileSystemService();
    private projectConfigService = new ProjectConfigService();

    constructor(private context: vscode.ExtensionContext) {
        this.setupFileWatcher();
        this.setupGitWatcher();
        this.setupWorkspaceOpenHandler();
    }

    private setupFileWatcher(): void {
        // Watch for file saves
        const saveWatcher = vscode.workspace.onDidSaveTextDocument(async (document) => {
            await this.handleFileSave(document);
        });

        this.disposables.push(saveWatcher);
    }

    private setupWorkspaceOpenHandler(): void {
        // Check for outdated scripts when workspace is opened
        const openHandler = vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
            for (const folder of event.added) {
                if (!isProjectDisabled(folder)) {
                    await this.checkForOutdatedScripts(folder);
                }
            }
        });
        
        // Also check existing workspaces on startup immediately when i18n is enabled
        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
            if (!isProjectDisabled(folder)) {
                // Check immediately on extension activation for enabled projects
                this.checkForOutdatedScripts(folder);
            }
        }
        
        this.disposables.push(openHandler);
    }

    private async checkForOutdatedScripts(folder: vscode.WorkspaceFolder): Promise<void> {
        const folderKey = folder.uri.fsPath;
        const state = this.getOrCreateState(folderKey);
        
        // Check if we've recently verified scripts (within last 24 hours)
        const now = Date.now();
        if (state.lastScriptCheckTime > 0 && (now - state.lastScriptCheckTime) < SCRIPT_CHECK_INTERVAL) {
            return; // Already checked recently
        }
        
        // Check if project is disabled
        if (isProjectDisabled(folder)) {
            this.recordScriptCheck(state, folderKey, now);
            return; // Project is disabled
        }
        
        // Check if prompts are disabled for this project
        const config = vscode.workspace.getConfiguration('i18nAI', folder.uri);
        const promptsDisabled = config.get<boolean>('disablePrompts') || false;
        
        if (promptsDisabled) {
            this.recordScriptCheck(state, folderKey, now);
            return; // Prompts are disabled for this project
        }

        // Skip script prompts for projects that don't have i18n scripts configured yet
        const hasConfiguredScripts = await this.projectConfigService.hasI18nScripts(folder);
        if (!hasConfiguredScripts) {
            this.recordScriptCheck(state, folderKey, now);
            return;
        }
        
        this.recordScriptCheck(state, folderKey, now);
        
        try {
            const outdatedScripts = await this.detectOutdatedScripts(folder);
            if (outdatedScripts.length > 0) {
                await this.promptToUpdateScripts(folder, outdatedScripts);
            }
        } catch (err) {
            console.error('Failed to check for outdated scripts:', err);
        }
    }

    private async detectOutdatedScripts(folder: vscode.WorkspaceFolder): Promise<string[]> {
        try {
            // Use checksum-based comparison instead of pattern matching
            const outdatedScripts = await this.fileSystemService.getOutdatedScripts(
                this.context, 
                folder.uri.fsPath
            );
            return outdatedScripts;
        } catch (err) {
            console.error('Failed to detect outdated scripts:', err);
            return [];
        }
    }

    private async promptToUpdateScripts(folder: vscode.WorkspaceFolder, outdatedScripts: string[]): Promise<void> {
        const choice = await vscode.window.showInformationMessage(
            `AI Localizer: Detected ${outdatedScripts.length} outdated i18n script(s) in your project: ${outdatedScripts.slice(0, 3).join(', ')}${outdatedScripts.length > 3 ? '...' : ''}`,
            {
                title: 'Update Scripts',
                description: 'Update to the latest i18n scripts and fix package.json',
                action: 'update'
            },
            {
                title: 'Ignore',
                description: 'Skip updating for now',
                action: 'ignore'
            }
        );

        if (choice?.action === 'update') {
            try {
                await vscode.commands.executeCommand('ai-localizer.i18n.configureProject');
                // vscode.window.showInformationMessage(
                //     'AI Localizer: Project configuration opened. Please update your scripts to use the latest version.'
                // );
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Failed to open project configuration: ${err}`
                );
            }
        }
    }

    private setupGitWatcher(): void {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            return;
        }

        // Monitor when git extension becomes active
        if (!gitExtension.isActive) {
            void gitExtension.activate().then(() => {
                this.subscribeToGitChanges(gitExtension);
            }, (err: unknown) => {
                console.error('Failed to activate git extension:', err);
            });
        } else {
            this.subscribeToGitChanges(gitExtension);
        }
    }

    private subscribeToGitChanges(gitExtension: vscode.Extension<any>): void {
        try {
            const git = gitExtension.exports.getAPI(1);
            
            // Listen to repository state changes
            git.repositories.forEach((repo: any) => {
                const stateDisposable = repo.state.onDidChange(() => {
                    this.handleGitStateChange(repo);
                });
                this.disposables.push(stateDisposable);
            });

            // Listen for new repositories
            const repoDisposable = git.onDidOpenRepository((repo: any) => {
                const stateDisposable = repo.state.onDidChange(() => {
                    this.handleGitStateChange(repo);
                });
                this.disposables.push(stateDisposable);
            });

            this.disposables.push(repoDisposable);
        } catch (err) {
            console.error('Failed to subscribe to git changes:', err);
        }
    }

    private async handleFileSave(document: vscode.TextDocument): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const autoMonitorEnabled = config.get<boolean>('i18n.autoMonitor', true);
        
        if (!autoMonitorEnabled) {
            return;
        }

        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            return;
        }

        // Check if project is disabled
        if (isProjectDisabled(folder)) {
            return; // Project is disabled
        }

        // Check if prompts are disabled for this project
        const i18nConfig = vscode.workspace.getConfiguration('i18nAI', document.uri);
        const promptsDisabled = i18nConfig.get<boolean>('disablePrompts') || false;
        
        if (promptsDisabled) {
            return; // Prompts are disabled for this project
        }

        // Only monitor relevant file types
        const langId = document.languageId;
        const isRelevant = [
            'javascript',
            'typescript',
            'javascriptreact',
            'typescriptreact',
            'vue',
            'blade',
            'php',
        ].includes(langId);

        if (!isRelevant) {
            return;
        }

        // Check if file has translation-eligible content
        const hasTranslatableContent = await this.hasTranslatableContent(document);
        if (!hasTranslatableContent) {
            return;
        }

        // Add to pending files
        const folderKey = folder.uri.fsPath;
        const state = this.getOrCreateState(folderKey);
        state.pendingFiles.add(document.uri.fsPath);

        // Debounce the processing
        this.scheduleProcessing(folder);
    }

    private async handleGitStateChange(repo: any): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const autoMonitorEnabled = config.get<boolean>('i18n.autoMonitor', true);
        
        if (!autoMonitorEnabled) {
            return;
        }

        const folder = vscode.workspace.getWorkspaceFolder(repo.rootUri);
        if (!folder) {
            return;
        }

        // Check if project is disabled
        if (isProjectDisabled(folder)) {
            return; // Project is disabled
        }

        // Check if prompts are disabled for this project
        const i18nConfig = vscode.workspace.getConfiguration('i18nAI', repo.rootUri);
        const promptsDisabled = i18nConfig.get<boolean>('disablePrompts') || false;
        
        if (promptsDisabled) {
            return; // Prompts are disabled for this project
        }

        // Find workspace folder for this repo
        const folders = vscode.workspace.workspaceFolders || [];
        const repoFolder = folders.find(f => f.uri.fsPath === repo.rootUri.fsPath);
        
        if (!repoFolder) {
            return;
        }

        // Check if working tree is clean (no staged or unstaged changes)
        const state = repo.state;
        const isClean = 
            (state.workingTreeChanges?.length || 0) === 0 &&
            (state.indexChanges?.length || 0) === 0;

        if (isClean) {
            // Working tree is clean, check if we should run extraction/rewrite
            await this.processCleanState(repoFolder);
        }
    }

    private async hasTranslatableContent(document: vscode.TextDocument): Promise<boolean> {
        const text = document.getText();
        
        // Check for string literals that might be translatable
        // Look for JSX text, template literals with text, or string literals
        const patterns = [
            />([^<>{}]+)</g,                    // JSX text content
            /['"`]([^'"`]{3,})['"`]/g,          // String literals (3+ chars)
            /\{\s*['"`]([^'"`]{3,})['"`]\s*\}/g, // Template expressions
        ];

        for (const pattern of patterns) {
            const matches = text.match(pattern);
            if (matches && matches.length > 0) {
                // Filter out likely non-translatable strings (URLs, code, etc.)
                const translatable = matches.some(match => {
                    const cleaned = match.replace(/[<>{}'"` ]/g, '');
                    return (
                        cleaned.length >= 3 &&
                        !/^(https?|ftp|file):\/\//i.test(cleaned) &&
                        !/^[a-z_][a-z0-9_]*$/i.test(cleaned) && // Not a variable name
                        /[a-z]/i.test(cleaned) // Contains at least one letter
                    );
                });
                
                if (translatable) {
                    return true;
                }
            }
        }

        return false;
    }

    private scheduleProcessing(folder: vscode.WorkspaceFolder): void {
        const folderKey = folder.uri.fsPath;
        
        // Clear existing timer
        const existingTimer = this.debounceTimers.get(folderKey);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Schedule new processing
        const timer = setTimeout(() => {
            this.processPendingFiles(folder);
        }, DEBOUNCE_DELAY);

        this.debounceTimers.set(folderKey, timer);
    }

    private async processPendingFiles(folder: vscode.WorkspaceFolder): Promise<void> {
        const folderKey = folder.uri.fsPath;
        const state = this.getOrCreateState(folderKey);

        if (state.isProcessing || state.pendingFiles.size === 0) {
            return;
        }

        // Check if user has disabled auto-monitoring for this workspace
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const autoExtract = config.get<boolean>('i18n.autoExtract', true);
        const autoRewrite = config.get<boolean>('i18n.autoRewrite', true);
        
        // Check if project is disabled
        if (isProjectDisabled(folder)) {
            state.pendingFiles.clear();
            return; // Project is disabled
        }
        
        // Check if prompts are disabled for this project
        const i18nConfig = vscode.workspace.getConfiguration('i18nAI', folder.uri);
        const promptsDisabled = i18nConfig.get<boolean>('disablePrompts') || false;
        
        if (promptsDisabled || (!autoExtract && !autoRewrite)) {
            // User has disabled prompts or both auto features, don't show any prompts
            state.pendingFiles.clear();
            return;
        }

        // Check if enough time has passed since last prompt
        const now = Date.now();
        const timeSinceLastPrompt = now - state.lastPromptTime;
        
        // If user dismissed prompt this session, don't show again until next session
        if (state.promptDismissedThisSession) {
            state.pendingFiles.clear();
            return;
        }
        
        // Don't show prompts too frequently
        if (timeSinceLastPrompt < MIN_INTERVAL_BETWEEN_PROMPTS) {
            // Too soon, reschedule for later
            setTimeout(() => this.processPendingFiles(folder), MIN_INTERVAL_BETWEEN_PROMPTS - timeSinceLastPrompt);
            return;
        }

        state.isProcessing = true;

        try {
            // Check if all pending files are clean in git
            const cleanFiles: string[] = [];
            for (const filePath of state.pendingFiles) {
                const fileUri = vscode.Uri.file(filePath);
                const isClean = await isFileClean(folder, fileUri);
                if (isClean) {
                    cleanFiles.push(filePath);
                }
            }

            if (cleanFiles.length === 0) {
                // No clean files yet, wait for git state change
                state.pendingFiles.clear();
                return;
            }

            // Check if extraction/rewrite has been run before
            const hasRunBefore = await this.hasRunBefore(folder);
            
            if (!hasRunBefore) {
                // First time setup - don't auto-run, just notify
                // But only if user hasn't explicitly disabled auto-extract/rewrite
                vscode.window.showInformationMessage(
                    `AI Localizer: Detected ${cleanFiles.length} file(s) with translatable content. Run "AI Localizer: Configure Project i18n" to set up auto-extraction.`,
                    'Configure Now'
                ).then(choice => {
                    if (choice === 'Configure Now') {
                        vscode.commands.executeCommand('ai-localizer.i18n.configureProject');
                    }
                });
                state.pendingFiles.clear();
                return;
            }

            // Auto-run extraction and rewrite
            // Re-check config here in case it was updated during initial setup
            const autoExtractCurrent = config.get<boolean>('i18n.autoExtract', true);
            const autoRewriteCurrent = config.get<boolean>('i18n.autoRewrite', true);

            if (autoExtractCurrent || autoRewriteCurrent) {
                const scriptsLabel = autoExtractCurrent && autoRewriteCurrent
                    ? 'i18n:extract and i18n:rewrite'
                    : autoExtractCurrent
                        ? 'i18n:extract'
                        : 'i18n:rewrite';

                const relativeFiles = cleanFiles.map((p) => vscode.workspace.asRelativePath(p));
                let filesPreview = relativeFiles[0];
                if (relativeFiles.length === 2) {
                    filesPreview = `${relativeFiles[0]}, ${relativeFiles[1]}`;
                } else if (relativeFiles.length > 2) {
                    filesPreview = `${relativeFiles[0]}, ${relativeFiles[1]}, ... (+${relativeFiles.length - 2} more)`;
                }

                const scriptsToRun: string[] = [];
                if (autoExtractCurrent) scriptsToRun.push('i18n:extract');
                if (autoRewriteCurrent) scriptsToRun.push('i18n:rewrite');
                const scriptsDetail =
                    scriptsToRun.length > 1
                        ? `"${scriptsToRun[0]}" and "${scriptsToRun[1]}"`
                        : `"${scriptsToRun[0]}"`;

                const choice = await vscode.window.showQuickPick(
                    [
                        {
                            label: `Run ${scriptsLabel} now`,
                            description:
                                cleanFiles.length === 1
                                    ? `Run for 1 clean file: ${relativeFiles[0]}`
                                    : `Run for ${cleanFiles.length} clean files (e.g. ${filesPreview})`,
                            detail: `Will run package.json script(s) ${scriptsDetail} for the changed files only and update locale JSON files.`,
                        },
                        {
                            label: 'Skip this time',
                            description: 'Do not run i18n scripts automatically right now',
                        },
                        {
                            label: 'Skip for this session',
                            description: 'Do not show this prompt again until next VS Code restart',
                        },
                        {
                            label: 'Disable auto extract/rewrite',
                            description:
                                'Stop running i18n:extract/i18n:rewrite automatically for this workspace (you can still run them manually).',
                        },
                    ],
                    {
                        placeHolder: `AI Localizer: Run ${scriptsLabel} for ${cleanFiles.length} clean file(s)?`,
                    },
                );

                // Update last prompt time
                state.lastPromptTime = Date.now();

                if (!choice || choice.label === 'Skip this time') {
                    state.pendingFiles.clear();
                    return;
                }

                if (choice.label === 'Skip for this session') {
                    state.promptDismissedThisSession = true;
                    state.pendingFiles.clear();
                    return;
                }

                if (choice.label === 'Disable auto extract/rewrite') {
                    await config.update(
                        'i18n.autoExtract',
                        false,
                        vscode.ConfigurationTarget.Workspace,
                    );
                    await config.update(
                        'i18n.autoRewrite',
                        false,
                        vscode.ConfigurationTarget.Workspace,
                    );
                    vscode.window.showInformationMessage(
                        'AI Localizer: Disabled automatic extract/rewrite for this workspace.',
                    );
                    state.pendingFiles.clear();
                    return;
                }
            }

            // Convert file paths to relative paths for passing to scripts
            const relativeFilePaths = cleanFiles.map(f => path.relative(folder.uri.fsPath, f));

            if (autoExtractCurrent) {
                await runI18nScript('i18n:extract', { 
                    folder,
                    extraArgs: relativeFilePaths 
                });
                state.lastExtractTime = Date.now();
            }

            if (autoRewriteCurrent) {
                await runI18nScript('i18n:rewrite', { 
                    folder,
                    extraArgs: relativeFilePaths 
                });
                state.lastRewriteTime = Date.now();
            }

            // Use granular sync for specific files to preserve existing translations
            // This syncs only the keys from the processed files without deleting other translations
            try {
                const syncService = getGranularSyncService();
                const config = vscode.workspace.getConfiguration('ai-localizer');
                const baseLocale = config.get<string>('i18n.defaultLocale') ?? 'en';
                
                for (const filePath of cleanFiles) {
                    const fileUri = vscode.Uri.file(filePath);
                    await syncService.syncFile(folder, fileUri, { baseLocale });
                }
            } catch (syncErr) {
                console.error('Failed to sync translations for processed files:', syncErr);
                // Don't fail the whole operation if sync fails
            }

            // Clear processed files
            for (const filePath of cleanFiles) {
                state.pendingFiles.delete(filePath);
            }

            vscode.window.showInformationMessage(
                `AI Localizer: Auto-processed ${cleanFiles.length} clean file(s).`
            );

        } catch (err) {
            console.error('Failed to process pending files:', err);
            vscode.window.showErrorMessage(`AI Localizer: Auto-processing failed. ${err}`);
        } finally {
            state.isProcessing = false;
        }
    }

    private async processCleanState(folder: vscode.WorkspaceFolder): Promise<void> {
        const folderKey = folder.uri.fsPath;
        const state = this.getOrCreateState(folderKey);

        if (state.pendingFiles.size > 0) {
            // We have pending files and git is clean, process them
            await this.processPendingFiles(folder);
        }
    }

    private async hasRunBefore(folder: vscode.WorkspaceFolder): Promise<boolean> {
        // Check if i18n scripts exist in package.json
        const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
        try {
            const data = await vscode.workspace.fs.readFile(pkgUri);
            const text = new TextDecoder('utf-8').decode(data);
            const pkg = JSON.parse(text);
            
            if (!pkg.scripts) {
                return false;
            }

            // Check if i18n scripts are configured
            return !!(
                pkg.scripts['i18n:extract'] ||
                pkg.scripts['i18n:rewrite']
            );
        } catch {
            return false;
        }
    }

    private getOrCreateState(folderKey: string): MonitorState {
        let state = this.states.get(folderKey);
        if (!state) {
            // Load persisted script check time from workspace state
            const persistedTime = this.context.workspaceState.get<number>(`ai-localizer.lastScriptCheckTime.${folderKey}`, 0);
            
            state = {
                lastExtractTime: 0,
                lastRewriteTime: 0,
                lastPromptTime: 0,
                pendingFiles: new Set(),
                isProcessing: false,
                promptDismissedThisSession: false,
                outdatedScriptsChecked: false,
                lastScriptCheckTime: persistedTime,
            };
            this.states.set(folderKey, state);
        }
        return state;
    }

    private saveScriptCheckTime(folderKey: string, time: number): void {
        this.context.workspaceState.update(`ai-localizer.lastScriptCheckTime.${folderKey}`, time);
    }

    private recordScriptCheck(state: MonitorState, folderKey: string, time: number): void {
        state.lastScriptCheckTime = time;
        this.saveScriptCheckTime(folderKey, time);
    }

    dispose(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}
