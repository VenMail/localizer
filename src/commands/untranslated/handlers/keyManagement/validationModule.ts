import * as vscode from 'vscode';
import { I18nIndex } from '../../../../core/i18nIndex';
import { pickWorkspaceFolder } from '../../../../core/workspace';

export interface ValidationResult {
    isValid: boolean;
    error?: string;
}

export interface CopyTranslationParams {
    documentUri: vscode.Uri;
    key: string;
    sourceLocale: string;
    targetLocale: string;
}

export interface BulkOperationParams {
    documentUri: vscode.Uri;
}

/**
 * Centralized validation for all key management operations
 */
export class ValidationModule {
    constructor(
        private i18nIndex: I18nIndex,
        private log?: vscode.OutputChannel,
    ) {}

    /**
     * Validate parameters for copy translation operation
     */
    validateCopyTranslation(params: CopyTranslationParams): ValidationResult {
        const { documentUri, key, sourceLocale, targetLocale } = params;

        if (!documentUri) {
            return { isValid: false, error: 'No document provided' };
        }

        if (!key || typeof key !== 'string' || !key.trim()) {
            return { isValid: false, error: 'Invalid key provided' };
        }

        if (!sourceLocale || typeof sourceLocale !== 'string' || !sourceLocale.trim()) {
            return { isValid: false, error: 'Invalid source locale provided' };
        }

        if (!targetLocale || typeof targetLocale !== 'string' || !targetLocale.trim()) {
            return { isValid: false, error: 'Invalid target locale provided' };
        }

        if (sourceLocale === targetLocale) {
            return { isValid: false, error: 'Source and target locales cannot be the same' };
        }

        // Validate locale format
        const localeRegex = /^[A-Za-z0-9_-]+$/;
        if (!localeRegex.test(sourceLocale)) {
            return { isValid: false, error: 'Invalid source locale format' };
        }

        if (!localeRegex.test(targetLocale)) {
            return { isValid: false, error: 'Invalid target locale format' };
        }

        return { isValid: true };
    }

    /**
     * Validate workspace folder and get it
     */
    async validateAndGetWorkspaceFolder(documentUri: vscode.Uri): Promise<{ folder: vscode.WorkspaceFolder | null; error?: string }> {
        let folder = vscode.workspace.getWorkspaceFolder(documentUri);
        
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }

        if (!folder) {
            return { 
                folder: null, 
                error: 'AI Localizer: No workspace folder available' 
            };
        }

        return { folder };
    }

    /**
     * Validate parameters for bulk operation
     */
    validateBulkOperation(params: BulkOperationParams): ValidationResult {
        const { documentUri } = params;

        if (!documentUri) {
            return { isValid: false, error: 'No document provided' };
        }

        const folder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (!folder) {
            return { isValid: false, error: 'No workspace folder found' };
        }

        return { isValid: true };
    }

    /**
     * Validate key exists in index and get record
     */
    validateKeyInIndex(key: string): { record: any; error?: string } {
        if (!key || typeof key !== 'string' || !key.trim()) {
            return { record: null, error: 'Invalid key provided' };
        }

        const record = this.i18nIndex.getRecord(key);
        if (!record) {
            return { record: null, error: `Key "${key}" not found in index` };
        }

        return { record };
    }

    /**
     * Validate translation exists in source locale
     */
    validateSourceTranslation(record: any, sourceLocale: string): ValidationResult {
        const sourceValue = record.locales.get(sourceLocale);
        if (!sourceValue || !sourceValue.trim()) {
            return { 
                isValid: false, 
                error: `No translation found for key in locale "${sourceLocale}"` 
            };
        }

        return { isValid: true };
    }

    /**
     * Validate target locale file exists
     */
    validateTargetLocaleFile(record: any, targetLocale: string): ValidationResult {
        const targetLocation = record.locations.find((loc: any) => loc.locale === targetLocale);
        if (!targetLocation) {
            return { 
                isValid: false, 
                error: `No locale file found for target locale "${targetLocale}"` 
            };
        }

        return { isValid: true };
    }

    /**
     * Comprehensive validation for copy translation operation
     */
    async validateCopyTranslationComprehensive(params: CopyTranslationParams): Promise<{
        isValid: boolean;
        error?: string;
        record?: any;
        folder?: vscode.WorkspaceFolder;
        targetLocation?: any;
    }> {
        // Basic parameter validation
        const basicValidation = this.validateCopyTranslation(params);
        if (!basicValidation.isValid) {
            return { isValid: false, error: basicValidation.error };
        }

        // Workspace folder validation
        const folderResult = await this.validateAndGetWorkspaceFolder(params.documentUri);
        if (!folderResult.folder) {
            return { isValid: false, error: folderResult.error };
        }

        // Key validation
        const keyValidation = this.validateKeyInIndex(params.key);
        if (!keyValidation.record) {
            return { isValid: false, error: keyValidation.error };
        }

        const record = keyValidation.record;

        // Source translation validation
        const sourceValidation = this.validateSourceTranslation(record, params.sourceLocale);
        if (!sourceValidation.isValid) {
            return { isValid: false, error: sourceValidation.error };
        }

        // Target locale file validation
        const targetValidation = this.validateTargetLocaleFile(record, params.targetLocale);
        if (!targetValidation.isValid) {
            return { isValid: false, error: targetValidation.error };
        }

        const targetLocation = record.locations.find((loc: any) => loc.locale === params.targetLocale);

        return {
            isValid: true,
            record,
            folder: folderResult.folder,
            targetLocation
        };
    }

    /**
     * Validate document language for bulk operations
     */
    validateDocumentLanguage(_documentUri: vscode.Uri, _supportedLanguages: string[]): ValidationResult {
        // This would typically check the document language
        // For now, we'll assume all languages are supported for missing default locale fixes
        return { isValid: true };
    }

    /**
     * Show user confirmation for overwrite operations
     */
    async confirmOverwrite(key: string, targetLocale: string): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(
            `AI Localizer: Target locale "${targetLocale}" already has a translation for "${key}". Overwrite?`,
            'Overwrite',
            'Cancel'
        );
        return choice === 'Overwrite';
    }

    /**
     * Log validation errors
     */
    logValidationError(operation: string, error: string): void {
        this.log?.appendLine(`[Validation] ${operation} validation failed: ${error}`);
    }

    /**
     * Log validation success
     */
    logValidationSuccess(operation: string): void {
        this.log?.appendLine(`[Validation] ${operation} validation passed`);
    }
}
