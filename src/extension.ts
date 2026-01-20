import * as vscode from 'vscode';
import { I18nIndex } from './core/i18nIndex';
import { AutoMonitor } from './core/autoMonitor';
import { I18nStatusBar } from './core/statusBar';
import { registerI18nProviders } from './providers/i18nProviders';
import { CommandRegistry } from './commands/commandRegistry';
import { TranslationService } from './services/translationService';
import { ProjectConfigService } from './services/projectConfigService';
import { FileSystemService } from './services/fileSystemService';
import { isProjectDisabled } from './utils/projectIgnore';

export function activate(context: vscode.ExtensionContext) {
    try {
        // Check if extension is disabled for ALL workspace folders BEFORE creating any resources
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.every(folder => isProjectDisabled(folder))) {
            vscode.window.showWarningMessage(
                `AI Localizer is disabled for all workspace folders. Enable via workspace settings or remove .i18n.ignore files.`
            );
            return; // Safe early return - no resources created yet
        }
        
        // Show warning for partially disabled workspaces but continue activation
        if (workspaceFolders && workspaceFolders.some(folder => isProjectDisabled(folder))) {
            const disabledFolders = workspaceFolders
                .filter(folder => isProjectDisabled(folder))
                .map(folder => folder.name);
            
            vscode.window.showWarningMessage(
                `AI Localizer is disabled for: ${disabledFolders.join(', ')}. Other folders remain active.`
            );
        }

        const output = vscode.window.createOutputChannel('AI i18n');
        output.appendLine('[activate] Activating AI i18n extension...');

        const i18nIndex = new I18nIndex();
        void i18nIndex.ensureInitialized().catch((err) => {
            console.error('AI Localizer: Failed to build translation index:', err);
            const details = err instanceof Error ? err.stack || err.message : String(err);
            output.appendLine(`[activate] Failed to build translation index: ${details}`);
        });

        // Initialize status bar
        const statusBar = new I18nStatusBar();
        context.subscriptions.push(statusBar, output);

        // Initialize auto-monitor for detecting new translatable content
        const autoMonitor = new AutoMonitor(context);
        context.subscriptions.push(autoMonitor);

        // Update status bar based on configuration
        const config = vscode.workspace.getConfiguration('ai-localizer');
        statusBar.setMonitoring(config.get<boolean>('i18n.autoMonitor', true));

        // Register IntelliSense providers for all supported file types
        // Provides hover, go-to-definition, and autocomplete for translation keys
        registerI18nProviders(context, i18nIndex);

        // Initialize services and centralized command registry
        const translationService = new TranslationService(context, output);
        const projectConfigService = new ProjectConfigService();
        const fileSystemService = new FileSystemService();
        
        // Register ProjectConfigService for disposal to prevent watcher memory leak
        context.subscriptions.push({
            dispose: () => projectConfigService.dispose()
        });
        
        const registry = new CommandRegistry(
            context,
            i18nIndex,
            translationService,
            projectConfigService,
            fileSystemService,
            statusBar,
            output,
        );
        const disposables = registry.registerAll();
        context.subscriptions.push(...disposables);

        output.appendLine('[activate] AI i18n extension activated successfully');
        console.log('AI i18n extension activated successfully');
    } catch (error) {
        console.error('Failed to activate AI i18n extension:', error);
        vscode.window.showErrorMessage(`AI Localizer: Extension activation failed. ${error}`);
        throw error;
    }
}

export function deactivate() {}
