import * as vscode from 'vscode';
import { runI18nScript, pickWorkspaceFolder } from '../core/workspace';
import { getGranularSyncService, SyncResult, GranularSyncOptions } from '../services/granularSyncService';

export type SyncScope = 'keys' | 'file' | 'full';

export interface GranularSyncParams {
    scope: SyncScope;
    keys?: string[];
    fileUri?: vscode.Uri;
    folder?: vscode.WorkspaceFolder;
    options?: GranularSyncOptions;
}

/**
 * Commands for running i18n scripts
 */
export class ScriptCommands {
    constructor(private context?: vscode.ExtensionContext) {}

    async runExtract(): Promise<void> {
        await runI18nScript('i18n:extract', { context: this.context });
    }

    async runRewrite(): Promise<void> {
        await runI18nScript('i18n:rewrite', { context: this.context });
    }

    /**
     * Run full sync via external script (original behavior).
     * Use for project-wide operations.
     */
    async runSync(): Promise<void> {
        await runI18nScript('i18n:sync', { context: this.context });
    }

    /**
     * Run granular sync with specified scope.
     * - 'keys': Sync only specific keys (for quick fixes)
     * - 'file': Sync only keys from a specific file
     * - 'full': Full project sync (delegates to runSync)
     */
    async runGranularSync(params: GranularSyncParams): Promise<SyncResult | null> {
        const { scope, keys, fileUri, options = {} } = params;
        let { folder } = params;

        if (scope === 'full') {
            await this.runSync();
            return { updated: -1, files: [], mode: 'full' };
        }

        if (!folder) {
            const active = vscode.window.activeTextEditor;
            folder = active
                ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
                : undefined;
            if (!folder) {
                folder = await pickWorkspaceFolder();
            }
        }

        if (!folder) {
            return null;
        }

        const syncService = getGranularSyncService(this.context);

        // Get default locale from config
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const baseLocale = options.baseLocale ?? config.get<string>('i18n.defaultLocale') ?? 'en';
        const mergedOptions = { ...options, baseLocale };

        if (scope === 'keys' && keys && keys.length > 0) {
            return syncService.syncKeys(folder, keys, mergedOptions);
        }

        if (scope === 'file' && fileUri) {
            return syncService.syncFile(folder, fileUri, mergedOptions);
        }

        return null;
    }

    /**
     * Sync specific keys only (most efficient for quick fixes).
     */
    async syncKeys(
        keys: string[],
        folder?: vscode.WorkspaceFolder,
        options?: GranularSyncOptions
    ): Promise<SyncResult | null> {
        return this.runGranularSync({ scope: 'keys', keys, folder, options });
    }

    /**
     * Sync all keys from a specific file.
     */
    async syncFile(
        fileUri: vscode.Uri,
        folder?: vscode.WorkspaceFolder,
        options?: GranularSyncOptions
    ): Promise<SyncResult | null> {
        return this.runGranularSync({ scope: 'file', fileUri, folder, options });
    }

    /**
     * Ensure keys exist in all locales, creating them if missing.
     */
    async ensureKeys(
        keys: string[],
        values: Record<string, string> = {},
        folder?: vscode.WorkspaceFolder,
        options?: GranularSyncOptions
    ): Promise<SyncResult | null> {
        if (!folder) {
            const active = vscode.window.activeTextEditor;
            folder = active
                ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
                : undefined;
            if (!folder) {
                folder = await pickWorkspaceFolder();
            }
        }

        if (!folder) {
            return null;
        }

        const syncService = getGranularSyncService(this.context);
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const baseLocale = options?.baseLocale ?? config.get<string>('i18n.defaultLocale') ?? 'en';
        const mergedOptions = { ...options, baseLocale };

        return syncService.ensureKeys(folder, keys, values, mergedOptions);
    }

    async runFixUntranslated(): Promise<void> {
        await runI18nScript('i18n:fix-untranslated', { context: this.context });
    }

    async runRewriteBlade(): Promise<void> {
        await runI18nScript('i18n:rewrite-blade', { context: this.context });
    }

    async runCleanupUnused(): Promise<void> {
        await runI18nScript('i18n:cleanup-unused', { context: this.context });
    }

    async runRestoreInvalid(): Promise<void> {
        await runI18nScript('i18n:restore-invalid', { context: this.context });
    }
}
