import * as vscode from 'vscode';
import { I18nIndex } from '../../core/i18nIndex';
import { TranslationService } from '../../services/translationService';
import { ProjectConfigService } from '../../services/projectConfigService';
import { parseMissingDefaultDiagnostic } from './utils/diagnosticParser';

import {
    GitRecoveryHandler,
    TranslationHandler,
    KeyManagementHandler,
    CleanupHandler,
    StyleHandler,
    ReportHandler,
} from './handlers';

/**
 * Commands for handling untranslated strings
 * This is a facade class that delegates to specialized handlers
 */
export class UntranslatedCommands {
    private gitRecoveryHandler: GitRecoveryHandler;
    private translationHandler: TranslationHandler;
    private keyManagementHandler: KeyManagementHandler;
    private cleanupHandler: CleanupHandler;
    private styleHandler: StyleHandler;
    private reportHandler: ReportHandler;

    constructor(
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private projectConfigService: ProjectConfigService,
        private context?: vscode.ExtensionContext,
        private log?: vscode.OutputChannel,
    ) {
        // Initialize handlers
        this.gitRecoveryHandler = new GitRecoveryHandler(context, log);
        
        this.translationHandler = new TranslationHandler(
            i18nIndex,
            translationService,
            context,
        );
        
        this.keyManagementHandler = new KeyManagementHandler(
            i18nIndex,
            this.gitRecoveryHandler,
            translationService,
            context,
            log,
        );
        
        this.cleanupHandler = new CleanupHandler(
            i18nIndex,
            (keyPath, uris, defaultValue) => this.keyManagementHandler.deleteKeyFromLocaleFiles(keyPath, uris, defaultValue),
        );
        
        this.styleHandler = new StyleHandler(i18nIndex);
        
        this.reportHandler = new ReportHandler(
            i18nIndex,
            translationService,
            (record) => this.translationHandler.getRootNameForRecord(record),
        );
    }

    /**
     * Cleanup all pending guard timeouts. Call on extension deactivation.
     */
    dispose(): void {
        this.keyManagementHandler.dispose();
    }

    // ==================== Report Operations ====================

    async openReport(): Promise<void> {
        return this.reportHandler.openReport();
    }

    async applyAiFixes(): Promise<void> {
        return this.reportHandler.applyAiFixes(
            (folder, fixed) => this.reportHandler.pruneUntranslatedReports(folder, fixed),
        );
    }

    async showHealthReport(): Promise<void> {
        return this.reportHandler.showHealthReport();
    }

    async generateAutoIgnore(folderArg?: vscode.WorkspaceFolder): Promise<void> {
        return this.reportHandler.generateAutoIgnore(folderArg);
    }

    async reviewSelection(_documentUri?: vscode.Uri): Promise<void> {
        return this.reportHandler.reviewSelection(
            (uri, key, locales) => this.translationHandler.applyQuickFix(uri, key, locales),
        );
    }

    // ==================== Translation Operations ====================

    async applyQuickFix(
        documentUri: vscode.Uri,
        key: string,
        locales: string[],
    ): Promise<void> {
        return this.translationHandler.applyQuickFix(documentUri, key, locales);
    }

    async translateAllUntranslatedInFile(documentUri?: vscode.Uri): Promise<void> {
        const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            vscode.window.showInformationMessage('AI Localizer: No active document to translate.');
            return;
        }
        return this.translationHandler.translateAllUntranslatedInFile(
            targetUri,
            (folder, fixed) => this.reportHandler.pruneUntranslatedReports(folder, fixed),
        );
    }

    async translateAllUntranslatedInProject(): Promise<void> {
        return this.translationHandler.translateAllUntranslatedInProject(
            (folder, fixed) => this.reportHandler.pruneUntranslatedReports(folder, fixed),
            (folder) => this.reportHandler.generateAutoIgnore(folder),
        );
    }

    async fixPlaceholderMismatch(documentUri: vscode.Uri, key: string, locale: string): Promise<void> {
        return this.translationHandler.fixPlaceholderMismatch(documentUri, key, locale);
    }

    // ==================== Key Management Operations ====================

    async fixMissingKeyReference(
        documentUri: vscode.Uri,
        position: { line: number; character: number },
        key: string,
    ): Promise<void> {
        return this.keyManagementHandler.fixMissingKeyReference(documentUri, position, key);
    }

    async addKeyToIgnoreList(folderUri: vscode.Uri, key: string): Promise<void> {
        return this.keyManagementHandler.addKeyToIgnoreList(folderUri, key);
    }

    async bulkFixMissingKeyReferences(documentUri: vscode.Uri): Promise<void> {
        return this.keyManagementHandler.bulkFixMissingKeyReferences(documentUri);
    }

    async guardDeleteDefaultLocaleKey(
        localeUri: vscode.Uri,
        keyPath: string,
        defaultValue: string,
    ): Promise<boolean> {
        return this.keyManagementHandler.guardDeleteDefaultLocaleKey(localeUri, keyPath, defaultValue);
    }

    // ==================== Cleanup Operations ====================

    async cleanupUnusedInFile(documentUri?: vscode.Uri): Promise<void> {
        return this.cleanupHandler.cleanupUnusedInFile(documentUri);
    }

    async removeUnusedKeyInFile(documentUri: vscode.Uri, keyPath: string): Promise<void> {
        return this.cleanupHandler.removeUnusedKeyInFile(documentUri, keyPath);
    }

    async restoreInvalidInFile(documentUri?: vscode.Uri): Promise<void> {
        return this.cleanupHandler.restoreInvalidInFile(documentUri);
    }

    async removeInvalidKeyInFile(documentUri: vscode.Uri, keyPath: string): Promise<void> {
        return this.cleanupHandler.removeInvalidKeyInFile(documentUri, keyPath);
    }

    async restoreInvalidKeyInCode(
        documentUri: vscode.Uri,
        position: { line: number; character: number },
        key: string,
    ): Promise<void> {
        return this.cleanupHandler.restoreInvalidKeyInCode(documentUri, position, key);
    }

    // ==================== Style Operations ====================

    async applyStyleSuggestionQuickFix(
        documentUri: vscode.Uri,
        key: string,
        locale: string,
        suggested: string,
    ): Promise<void> {
        return this.styleHandler.applyStyleSuggestionQuickFix(documentUri, key, locale, suggested);
    }

    async applyAllStyleSuggestionsInFile(documentUri?: vscode.Uri): Promise<void> {
        return this.styleHandler.applyAllStyleSuggestionsInFile(documentUri);
    }

    async fixAllIssuesInFile(documentUri?: vscode.Uri): Promise<void> {
        return this.styleHandler.fixAllIssuesInFile(documentUri);
    }

    // ==================== Missing Default Locale Operations ====================

    async copyTranslationToDefaultLocale(
        documentUri: vscode.Uri,
        key: string,
        sourceLocale: string,
        targetLocale: string,
        options: { skipDiagnosticsRefresh?: boolean } = {},
    ): Promise<void> {
        // Input validation
        if (!documentUri || !key || !sourceLocale || !targetLocale) {
            vscode.window.showErrorMessage('AI Localizer: Invalid parameters provided.');
            return;
        }

        if (sourceLocale === targetLocale) {
            vscode.window.showErrorMessage('AI Localizer: Source and target locales cannot be the same.');
            return;
        }

        const record = this.i18nIndex.getRecord(key);
        if (!record) {
            vscode.window.showErrorMessage(`AI Localizer: Key "${key}" not found in index.`);
            return;
        }

        const sourceValue = record.locales.get(sourceLocale);
        if (!sourceValue || !sourceValue.trim()) {
            vscode.window.showErrorMessage(`AI Localizer: No translation found for key "${key}" in locale "${sourceLocale}".`);
            return;
        }

        // Check if target locale already has a translation
        const targetValue = record.locales.get(targetLocale);
        if (targetValue && targetValue.trim()) {
            const overwrite = await vscode.window.showWarningMessage(
                `AI Localizer: Target locale "${targetLocale}" already has a translation for "${key}". Overwrite?`,
                'Overwrite',
                'Cancel'
            );
            if (overwrite !== 'Overwrite') {
                return;
            }
        }

        // Find the target locale file
        const targetLocation = record.locations.find(loc => loc.locale === targetLocale);
        if (!targetLocation) {
            vscode.window.showErrorMessage(`AI Localizer: No locale file found for target locale "${targetLocale}".`);
            return;
        }

        try {
            // Use the folder-based setTranslationValue function
            const folder = vscode.workspace.getWorkspaceFolder(targetLocation.uri);
            if (!folder) {
                vscode.window.showErrorMessage(`AI Localizer: No workspace folder found for locale file.`);
                return;
            }

            // Import the setTranslationValue function
            const { setTranslationValue } = await import('../../core/i18nFs');
            await setTranslationValue(folder, targetLocale, key, sourceValue);
            
            // Show success message
            vscode.window.showInformationMessage(
                `AI Localizer: Copied translation for "${key}" from ${sourceLocale} to ${targetLocale}.`
            );

            // Refresh diagnostics for the affected file (skip if requested for bulk operations)
            if (!options.skipDiagnosticsRefresh) {
                await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', targetLocation.uri, [key]);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`AI Localizer: Failed to copy translation. ${msg}`);
        }
    }

    async bulkFixMissingDefaultTranslations(documentUri: vscode.Uri): Promise<void> {
        // Input validation
        if (!documentUri) {
            vscode.window.showErrorMessage('AI Localizer: No document provided.');
            return;
        }

        const folder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (!folder) {
            vscode.window.showErrorMessage('AI Localizer: No workspace folder found.');
            return;
        }

        // Get all diagnostics for the document
        const diagnostics = vscode.languages.getDiagnostics(documentUri);
        const missingDefaultDiagnostics = diagnostics.filter(d => d.code === 'ai-i18n.missing-default');

        if (missingDefaultDiagnostics.length === 0) {
            vscode.window.showInformationMessage('AI Localizer: No missing default locale translations found in this file.');
            return;
        }

        // Track all affected files for diagnostics refresh
        const affectedFiles = new Set<vscode.Uri>();

        const progress = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `AI Localizer: Fixing ${missingDefaultDiagnostics.length} missing default locale translations`,
                cancellable: true,
            },
            async (progress, token) => {
                let fixed = 0;
                const errors: string[] = [];

                for (let i = 0; i < missingDefaultDiagnostics.length; i++) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const diagnostic = missingDefaultDiagnostics[i];
                    const message = String(diagnostic.message || '');
                    
                    // Parse the diagnostic message
                    const parsed = parseMissingDefaultDiagnostic(message);
                    if (!parsed) {
                        errors.push(`Failed to parse diagnostic: ${message.substring(0, 100)}...`);
                        continue;
                    }

                    const { key, defaultLocale, existingLocales } = parsed;
                    
                    if (existingLocales.length === 0) {
                        errors.push(`No existing locales found for key "${key}"`);
                        continue;
                    }

                    progress.report({
                        increment: (100 / missingDefaultDiagnostics.length),
                        message: `Fixing "${key}" (${i + 1}/${missingDefaultDiagnostics.length})`,
                    });

                    try {
                        // Use the first existing locale as the source
                        const sourceLocale = existingLocales[0];
                        
                        // Get the record to find target file for diagnostics refresh
                        const record = this.i18nIndex.getRecord(key);
                        if (record) {
                            const targetLocation = record.locations.find(loc => loc.locale === defaultLocale);
                            if (targetLocation) {
                                affectedFiles.add(targetLocation.uri);
                            }
                        }
                        
                        await this.copyTranslationToDefaultLocale(documentUri, key, sourceLocale, defaultLocale, { skipDiagnosticsRefresh: true });
                        fixed++;
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        errors.push(`Failed to fix "${key}": ${msg}`);
                    }
                }

                return { fixed, errors };
            }
        );

        // Refresh diagnostics for all affected files after bulk operation
        let refreshErrors: string[] = [];
        if (progress.fixed > 0) {
            try {
                // Refresh the original document
                await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', documentUri);
                
                // Refresh any other affected files
                for (const fileUri of affectedFiles) {
                    if (fileUri.toString() !== documentUri.toString()) {
                        try {
                            await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', fileUri);
                        } catch (fileErr) {
                            // Log but don't fail the operation
                            console.warn(`Failed to refresh diagnostics for ${fileUri.fsPath}:`, fileErr);
                        }
                    }
                }
            } catch (refreshErr) {
                const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
                refreshErrors.push(`Failed to refresh diagnostics: ${msg}`);
            }
        }

        // Show results
        const parts: string[] = [];
        if (progress.fixed > 0) {
            parts.push(`Fixed ${progress.fixed} translation${progress.fixed === 1 ? '' : 's'}`);
        }
        const allErrors = [...progress.errors, ...refreshErrors];
        if (allErrors.length > 0) {
            parts.push(`${allErrors.length} error${allErrors.length === 1 ? '' : 's'}`);
        }

        if (parts.length > 0) {
            const message = `AI Localizer: ${parts.join(', ')}.`;
            if (allErrors.length > 0) {
                vscode.window.showWarningMessage(message, 'Show Errors').then(choice => {
                    if (choice === 'Show Errors') {
                        vscode.window.showErrorMessage(allErrors.join('\n'));
                    }
                });
            } else {
                vscode.window.showInformationMessage(message);
            }
        }
    }
}

