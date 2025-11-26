import { runI18nScript } from '../core/workspace';

/**
 * Commands for running i18n scripts
 */
export class ScriptCommands {
    async runExtract(): Promise<void> {
        await runI18nScript('i18n:extract');
    }

    async runRewrite(): Promise<void> {
        await runI18nScript('i18n:rewrite');
    }

    async runSync(): Promise<void> {
        await runI18nScript('i18n:sync');
    }

    async runFixUntranslated(): Promise<void> {
        await runI18nScript('i18n:fix-untranslated');
    }

    async runRewriteBlade(): Promise<void> {
        await runI18nScript('i18n:rewrite-blade');
    }
}
