import * as vscode from 'vscode';
import { I18nIndex } from '../../../../core/i18nIndex';
import { canProceedWithOperation } from '../../utils/operationLock';
import { TranslationOperations } from './translationOperations';
import { parseMissingDefaultDiagnostic } from '../../utils/diagnosticParser';

export interface BulkOperationResult {
    fixed: number;
    errors: string[];
    affectedFiles: Set<vscode.Uri>;
}

/**
 * Handles bulk operations with progress tracking, logging, and operation locking
 */
export class BulkOperations {
    constructor(
        private i18nIndex: I18nIndex,
        private translationOps: TranslationOperations,
        private log?: vscode.OutputChannel,
    ) {}

    /**
     * Bulk fix missing default locale translations in a file
     */
    async bulkFixMissingDefaultTranslations(documentUri: vscode.Uri): Promise<BulkOperationResult> {
        // Input validation
        if (!documentUri) {
            throw new Error('No document provided');
        }

        const folder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (!folder) {
            throw new Error('No workspace folder found');
        }

        // Check if another operation is blocking
        if (!(await canProceedWithOperation('key-management', 'Bulk Fix Missing Default Translations'))) {
            throw new Error('Operation blocked by another running operation');
        }

        this.log?.appendLine(
            `[BulkFixMissingDefaults] Starting for ${documentUri.fsPath}`,
        );

        // Get all diagnostics for the document
        const diagnostics = vscode.languages.getDiagnostics(documentUri);
        const missingDefaultDiagnostics = diagnostics.filter(d => d.code === 'ai-i18n.missing-default');

        if (missingDefaultDiagnostics.length === 0) {
            this.log?.appendLine('[BulkFixMissingDefaults] No missing default locale translations found');
            return { fixed: 0, errors: [], affectedFiles: new Set() };
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
                        this.log?.appendLine('[BulkFixMissingDefaults] Operation cancelled by user');
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
                            const targetLocation = record.locations.find((loc: any) => loc.locale === defaultLocale);
                            if (targetLocation) {
                                affectedFiles.add(targetLocation.uri);
                            }
                        }
                        
                        await this.translationOps.copyTranslationToDefaultLocale(
                            documentUri, 
                            key, 
                            sourceLocale, 
                            defaultLocale, 
                            { skipDiagnosticsRefresh: true }
                        );
                        fixed++;
                        this.log?.appendLine(`[BulkFixMissingDefaults] Fixed: ${key} (${sourceLocale} -> ${defaultLocale})`);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        errors.push(`Failed to fix "${key}": ${msg}`);
                        this.log?.appendLine(`[BulkFixMissingDefaults] Error fixing "${key}": ${msg}`);
                    }
                }

                return { fixed, errors, affectedFiles };
            }
        );

        // Refresh diagnostics for all affected files after bulk operation
        let refreshErrors: string[] = [];
        if (progress.fixed > 0) {
            try {
                this.log?.appendLine(`[BulkFixMissingDefaults] Refreshing diagnostics for ${progress.affectedFiles.size + 1} files`);
                
                // Refresh the original document
                await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', documentUri);
                
                // Refresh any other affected files
                for (const fileUri of progress.affectedFiles) {
                    if (fileUri.toString() !== documentUri.toString()) {
                        try {
                            await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', fileUri);
                        } catch (fileErr) {
                            const msg = fileErr instanceof Error ? fileErr.message : String(fileErr);
                            refreshErrors.push(`Failed to refresh diagnostics for ${fileUri.fsPath}: ${msg}`);
                            this.log?.appendLine(`[BulkFixMissingDefaults] Diagnostics refresh warning: ${msg}`);
                        }
                    }
                }
            } catch (refreshErr) {
                const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
                refreshErrors.push(`Failed to refresh diagnostics: ${msg}`);
                this.log?.appendLine(`[BulkFixMissingDefaults] Diagnostics refresh error: ${msg}`);
            }
        }

        const allErrors = [...progress.errors, ...refreshErrors];
        this.log?.appendLine(
            `[BulkFixMissingDefaults] Completed: ${progress.fixed} fixed, ${allErrors.length} errors`
        );

        return {
            fixed: progress.fixed,
            errors: allErrors,
            affectedFiles: progress.affectedFiles
        };
    }

    /**
     * Generic bulk operation with progress tracking
     */
    async executeBulkOperation<T>(
        title: string,
        items: T[],
        processor: (item: T, progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<void>,
        options: {
            cancellable?: boolean;
            logPrefix?: string;
        } = {}
    ): Promise<{ processed: number; errors: string[] }> {
        const logPrefix = options.logPrefix || '[BulkOperation]';
        
        const progress = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: options.cancellable ?? true,
            },
            async (progress, token) => {
                let processed = 0;
                const errors: string[] = [];

                for (let i = 0; i < items.length; i++) {
                    if (token.isCancellationRequested) {
                        this.log?.appendLine(`${logPrefix} Operation cancelled by user`);
                        break;
                    }

                    const item = items[i];
                    
                    try {
                        await processor(item, progress);
                        processed++;
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        errors.push(`Failed to process item: ${msg}`);
                        this.log?.appendLine(`${logPrefix} Error: ${msg}`);
                    }
                }

                return { processed, errors };
            }
        );

        this.log?.appendLine(
            `${logPrefix} Completed: ${progress.processed} processed, ${progress.errors.length} errors`
        );

        return progress;
    }
}
