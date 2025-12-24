import * as vscode from 'vscode';
import { I18nIndex } from '../../../../core/i18nIndex';
import { setTranslationValue, setTranslationValuesBatch } from '../../../../core/i18nFs';

/**
 * Handles individual translation operations like copying and setting values
 */
export class TranslationOperations {
    constructor(
        private i18nIndex: I18nIndex,
        private log?: vscode.OutputChannel,
    ) {}

    /**
     * Copy translation from source locale to target locale for a specific key
     */
    async copyTranslationToDefaultLocale(
        documentUri: vscode.Uri,
        key: string,
        sourceLocale: string,
        targetLocale: string,
        options: { skipDiagnosticsRefresh?: boolean } = {},
    ): Promise<void> {
        // Input validation
        if (!documentUri || !key || !sourceLocale || !targetLocale) {
            throw new Error('Invalid parameters provided');
        }

        if (sourceLocale === targetLocale) {
            throw new Error('Source and target locales cannot be the same');
        }

        const record = this.i18nIndex.getRecord(key);
        if (!record) {
            throw new Error(`Key "${key}" not found in index`);
        }

        const sourceValue = record.locales.get(sourceLocale);
        if (!sourceValue || !sourceValue.trim()) {
            throw new Error(`No translation found for key "${key}" in locale "${sourceLocale}"`);
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
        const targetLocation = record.locations.find((loc: any) => loc.locale === targetLocale);
        if (!targetLocation) {
            throw new Error(`No locale file found for target locale "${targetLocale}"`);
        }

        const folder = vscode.workspace.getWorkspaceFolder(targetLocation.uri);
        if (!folder) {
            throw new Error('No workspace folder found for locale file');
        }

        await setTranslationValue(folder, targetLocale, key, sourceValue);
        
        // Refresh diagnostics if not skipped
        if (!options.skipDiagnosticsRefresh) {
            await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', targetLocation.uri, [key]);
        }
    }

    /**
     * Set translation value for a key in a specific locale
     */
    async setTranslationValue(
        folder: vscode.WorkspaceFolder,
        locale: string,
        key: string,
        value: string,
        options?: { rootName?: string }
    ): Promise<void> {
        await setTranslationValue(folder, locale, key, value, options);
    }

    /**
     * Set multiple translation values in batch for better performance
     */
    async setTranslationValuesBatch(
        folder: vscode.WorkspaceFolder,
        locale: string,
        updates: Map<string, { value: string; rootName?: string }>
    ): Promise<{ written: number; errors: string[] }> {
        return await setTranslationValuesBatch(folder, locale, updates);
    }
}
