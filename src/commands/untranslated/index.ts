import * as vscode from 'vscode';
import { I18nIndex } from '../../core/i18nIndex';
import { TranslationService } from '../../services/translationService';
import { ProjectConfigService } from '../../services/projectConfigService';

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

    async reviewSelection(documentUri?: vscode.Uri): Promise<void> {
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
}

