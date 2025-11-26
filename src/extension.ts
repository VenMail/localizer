import * as vscode from 'vscode';
import { I18nIndex } from './core/i18nIndex';
import { AutoMonitor } from './core/autoMonitor';
import { I18nStatusBar } from './core/statusBar';
import { registerI18nProviders } from './providers/i18nProviders';
import { CommandRegistry } from './commands/commandRegistry';
import { TranslationService } from './services/translationService';
import { ProjectConfigService } from './services/projectConfigService';
import { FileSystemService } from './services/fileSystemService';

export function activate(context: vscode.ExtensionContext) {
    try {
        const i18nIndex = new I18nIndex();
        void i18nIndex.ensureInitialized().catch((err) => {
            console.error('AI i18n: Failed to build translation index:', err);
        });

        // Initialize status bar
        const statusBar = new I18nStatusBar();
        context.subscriptions.push(statusBar);

        // Initialize auto-monitor for detecting new translatable content
        const autoMonitor = new AutoMonitor();
        context.subscriptions.push(autoMonitor);

        // Update status bar based on configuration
        const config = vscode.workspace.getConfiguration('ai-assistant');
        statusBar.setMonitoring(config.get<boolean>('i18n.autoMonitor', true));

        // Register IntelliSense providers for all supported file types
        // Provides hover, go-to-definition, and autocomplete for translation keys
        registerI18nProviders(context, i18nIndex);

        // Initialize services and centralized command registry
        const translationService = new TranslationService(context);
        const projectConfigService = new ProjectConfigService();
        const fileSystemService = new FileSystemService();
        const registry = new CommandRegistry(
            context,
            i18nIndex,
            translationService,
            projectConfigService,
            fileSystemService,
            statusBar,
        );
        const disposables = registry.registerAll();
        context.subscriptions.push(...disposables);

        console.log('AI i18n extension activated successfully');
    } catch (error) {
        console.error('Failed to activate AI i18n extension:', error);
        vscode.window.showErrorMessage(`AI i18n: Extension activation failed. ${error}`);
        throw error;
    }
}

export function deactivate() {}
