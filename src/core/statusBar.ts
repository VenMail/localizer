import * as vscode from 'vscode';
import { isProjectDisabled } from '../utils/projectIgnore';

export class I18nStatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private isMonitoring = false;
    private pendingCount = 0;
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'ai-localizer.i18n.showStatus';
        
        // Listen for configuration changes to update status bar
        const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('ai-localizer')) {
                this.updateDisplay();
            }
        });
        
        // Listen for workspace folder changes
        const workspaceChangeDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.updateDisplay();
        });
        
        this.disposables.push(configChangeDisposable, workspaceChangeDisposable);
        this.updateDisplay();
    }

    setMonitoring(enabled: boolean): void {
        this.isMonitoring = enabled;
        this.updateDisplay();
    }

    setPendingCount(count: number): void {
        this.pendingCount = count;
        this.updateDisplay();
    }

    setProcessing(isProcessing: boolean): void {
        if (isProcessing) {
            this.statusBarItem.text = '$(sync~spin) AI Localizer: Processing...';
            this.statusBarItem.tooltip = 'Running extraction and rewrite scripts';
        } else {
            this.updateDisplay();
        }
    }

    private updateDisplay(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        // Handle no workspace folders
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.statusBarItem.text = '$(globe) AI i18n';
            this.statusBarItem.tooltip = 'No workspace folder open';
            this.statusBarItem.show();
            return;
        }

        // Check disabled state for all folders
        const disabledFolders = workspaceFolders.filter(folder => isProjectDisabled(folder));
        const disabledCount = disabledFolders.length;
        const totalCount = workspaceFolders.length;

        if (disabledCount === totalCount) {
            // All folders disabled
            this.statusBarItem.text = '$(x) AI i18n (Disabled)';
            this.statusBarItem.tooltip = 'All workspace folders disabled - click to manage';
        } else if (disabledCount > 0) {
            // Some folders disabled - be more concise
            this.statusBarItem.text = `$(warning) AI i18n (${disabledCount} disabled)`;
            this.statusBarItem.tooltip = `${disabledCount} workspace folder(s) disabled - click to manage settings`;
        } else if (!this.isMonitoring) {
            this.statusBarItem.text = '$(globe) AI i18n';
            this.statusBarItem.tooltip = 'Auto-monitoring disabled - click to configure';
        } else if (this.pendingCount > 0) {
            this.statusBarItem.text = `$(eye) AI Localizer: ${this.pendingCount} pending`;
            this.statusBarItem.tooltip = `Monitoring ${this.pendingCount} file(s) with translatable content`;
        } else {
            this.statusBarItem.text = '$(eye) AI i18n';
            this.statusBarItem.tooltip = 'Auto-monitoring enabled - watching for translatable content';
        }
        this.statusBarItem.show();
    }

    show(): void {
        this.statusBarItem.show();
    }

    hide(): void {
        this.statusBarItem.hide();
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this.statusBarItem.dispose();
    }
}
