import * as vscode from 'vscode';

export class I18nStatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private isMonitoring = false;
    private pendingCount = 0;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'ai-assistant.i18n.showStatus';
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
            this.statusBarItem.text = '$(sync~spin) AI i18n: Processing...';
            this.statusBarItem.tooltip = 'Running extraction and rewrite scripts';
        } else {
            this.updateDisplay();
        }
    }

    private updateDisplay(): void {
        if (!this.isMonitoring) {
            this.statusBarItem.text = '$(globe) AI i18n';
            this.statusBarItem.tooltip = 'Auto-monitoring disabled. Click to configure.';
            this.statusBarItem.show();
            return;
        }

        if (this.pendingCount > 0) {
            this.statusBarItem.text = `$(eye) AI i18n: ${this.pendingCount} pending`;
            this.statusBarItem.tooltip = `Monitoring ${this.pendingCount} file(s) with translatable content. Will process when committed to git.`;
        } else {
            this.statusBarItem.text = '$(eye) AI i18n';
            this.statusBarItem.tooltip = 'Auto-monitoring enabled. Watching for translatable content.';
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
        this.statusBarItem.dispose();
    }
}
