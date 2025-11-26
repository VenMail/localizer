import * as vscode from 'vscode';
import * as path from 'path';
import { isFileClean } from './gitMonitor';
import { runI18nScript } from './workspace';

interface MonitorState {
    lastExtractTime: number;
    lastRewriteTime: number;
    pendingFiles: Set<string>;
    isProcessing: boolean;
}

const DEBOUNCE_DELAY = 3000; // 3 seconds
const MIN_INTERVAL_BETWEEN_RUNS = 30000; // 30 seconds

export class AutoMonitor {
    private states = new Map<string, MonitorState>();
    private disposables: vscode.Disposable[] = [];
    private debounceTimers = new Map<string, NodeJS.Timeout>();

    constructor() {
        this.setupFileWatcher();
        this.setupGitWatcher();
    }

    private setupFileWatcher(): void {
        // Watch for file saves
        const saveWatcher = vscode.workspace.onDidSaveTextDocument(async (document) => {
            await this.handleFileSave(document);
        });

        this.disposables.push(saveWatcher);
    }

    private setupGitWatcher(): void {
        // Watch for git status changes using VS Code's git extension
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
        const config = vscode.workspace.getConfiguration('ai-assistant');
        const autoMonitorEnabled = config.get<boolean>('i18n.autoMonitor', true);
        
        if (!autoMonitorEnabled) {
            return;
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

        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
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
        const config = vscode.workspace.getConfiguration('ai-assistant');
        const autoMonitorEnabled = config.get<boolean>('i18n.autoMonitor', true);
        
        if (!autoMonitorEnabled) {
            return;
        }

        // Find workspace folder for this repo
        const folders = vscode.workspace.workspaceFolders || [];
        const folder = folders.find(f => f.uri.fsPath === repo.rootUri.fsPath);
        
        if (!folder) {
            return;
        }

        // Check if working tree is clean (no staged or unstaged changes)
        const state = repo.state;
        const isClean = 
            (state.workingTreeChanges?.length || 0) === 0 &&
            (state.indexChanges?.length || 0) === 0;

        if (isClean) {
            // Working tree is clean, check if we should run extraction/rewrite
            await this.processCleanState(folder);
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

        // Check if enough time has passed since last run
        const now = Date.now();
        const timeSinceLastExtract = now - state.lastExtractTime;
        
        if (timeSinceLastExtract < MIN_INTERVAL_BETWEEN_RUNS) {
            // Too soon, reschedule
            setTimeout(() => this.processPendingFiles(folder), MIN_INTERVAL_BETWEEN_RUNS - timeSinceLastExtract);
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
                vscode.window.showInformationMessage(
                    `AI i18n: Detected ${cleanFiles.length} file(s) with translatable content. Run "AI i18n: Configure Project i18n" to set up auto-extraction.`,
                    'Configure Now'
                ).then(choice => {
                    if (choice === 'Configure Now') {
                        vscode.commands.executeCommand('ai-assistant.i18n.configureProject');
                    }
                });
                state.pendingFiles.clear();
                return;
            }

            // Auto-run extraction and rewrite
            const config = vscode.workspace.getConfiguration('ai-assistant');
            const autoExtract = config.get<boolean>('i18n.autoExtract', true);
            const autoRewrite = config.get<boolean>('i18n.autoRewrite', true);

            if (autoExtract) {
                await runI18nScript('i18n:extract');
                state.lastExtractTime = Date.now();
            }

            if (autoRewrite) {
                await runI18nScript('i18n:rewrite');
                state.lastRewriteTime = Date.now();
            }

            // Clear processed files
            for (const filePath of cleanFiles) {
                state.pendingFiles.delete(filePath);
            }

            vscode.window.showInformationMessage(
                `AI i18n: Auto-processed ${cleanFiles.length} clean file(s).`
            );

        } catch (err) {
            console.error('Failed to process pending files:', err);
            vscode.window.showErrorMessage(`AI i18n: Auto-processing failed. ${err}`);
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
            state = {
                lastExtractTime: 0,
                lastRewriteTime: 0,
                pendingFiles: new Set(),
                isProcessing: false,
            };
            this.states.set(folderKey, state);
        }
        return state;
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
