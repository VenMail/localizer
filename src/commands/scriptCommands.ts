import * as vscode from 'vscode';
import { runI18nScript } from '../core/workspace';

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

    async runSync(): Promise<void> {
        await runI18nScript('i18n:sync', { context: this.context });
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
