import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex } from '../../../core/i18nIndex';
import { inferJsonLocaleFromUri } from '../../../core/i18nPath';
import { TranslationService } from '../../../services/translationService';
import { setLaravelTranslationValue, setTranslationValuesBatch } from '../../../core/i18nFs';
import { getGranularSyncService } from '../../../services/granularSyncService';
import { pickWorkspaceFolder } from '../../../core/workspace';
import { operationLock, OperationType } from '../utils/operationLock';
import { isProjectDisabled } from '../../../utils/projectIgnore';

export interface TranslationItem {
    key: string;
    defaultValue: string;
    defaultLocale: string;
}

export class TranslationHandler {
    constructor(
        private i18nIndex: I18nIndex,
        private translationService: TranslationService,
        private context?: vscode.ExtensionContext,
    ) {}

    /**
     * Check if operation can proceed, showing warning if blocked
     */
    private async canProceed(operationType: OperationType, description: string): Promise<boolean> {
        if (!operationLock.isOperationRunning()) {
            return true;
        }
        const current = operationLock.getCurrentOperation();
        if (current?.type === operationType) {
            return true;
        }
        const blockingMsg = operationLock.getBlockingOperationMessage();
        vscode.window.showWarningMessage(
            `AI Localizer: Cannot start "${description}" - ${blockingMsg}. Please wait for it to complete.`
        );
        return false;
    }

    /**
     * Get root name from a translation record
     */
    getRootNameForRecord(record: any): string {
        if (!record || !Array.isArray(record.locations) || !record.locations.length) {
            return 'common';
        }
        const defaultLocale = record.defaultLocale;
        let location = record.locations.find((loc: any) => loc && loc.locale === defaultLocale);
        if (!location) {
            location = record.locations[0];
        }
        if (!location || !location.uri) {
            return 'common';
        }
        const base = path.basename(location.uri.fsPath, '.json');
        if (!base) {
            return 'common';
        }
        return base.toLowerCase();
    }

    private isLaravelRecord(record: any): boolean {
        if (!record || !Array.isArray(record.locations)) {
            return false;
        }
        for (const loc of record.locations) {
            const uri: vscode.Uri | undefined = loc && loc.uri;
            if (!uri) {
                continue;
            }
            const fsPath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
            if (fsPath.includes('/lang/') || fsPath.includes('/resources/lang/')) {
                return true;
            }
        }
        return false;
    }

    private isLaravelLocaleFileUri(uri: vscode.Uri): boolean {
        const fsPath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
        if (!fsPath.endsWith('.php')) {
            return false;
        }
        return fsPath.includes('/lang/') || fsPath.includes('/resources/lang/');
    }

    /**
     * Apply quick fix for untranslated key
     */
    async applyQuickFix(
        documentUri: vscode.Uri,
        key: string,
        locales: string[],
    ): Promise<void> {
        let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        const syncService = getGranularSyncService(this.context);
        await syncService.syncKeys(folder, [key]);

        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(key);
        if (!record) {
            vscode.window.showInformationMessage(
                `AI Localizer: No translation record found for key ${key}.`,
            );
            return;
        }

        const defaultLocale = record.defaultLocale;
        const defaultValue = record.locales.get(defaultLocale);
        if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
            vscode.window.showInformationMessage(
                `AI Localizer: Default locale value not found for key ${key}.`,
            );
            return;
        }

        const targetLocales = locales.filter((l) => l && l !== defaultLocale);
        if (!targetLocales.length) {
            vscode.window.showInformationMessage(
                'AI Localizer: No target locales to translate for this key.',
            );
            return;
        }

        const rootName = this.getRootNameForRecord(record);
        const isLaravel = this.isLaravelRecord(record);

        // Sync missing keys with placeholder values for JSON-based locales only
        const placeholderUpdates = new Map<string, Map<string, { value: string; rootName?: string }>>();
        if (!isLaravel) {
            for (const locale of targetLocales) {
                const current = record.locales.get(locale);
                if (typeof current !== 'string' || !current.trim()) {
                    let localeUpdates = placeholderUpdates.get(locale);
                    if (!localeUpdates) {
                        localeUpdates = new Map();
                        placeholderUpdates.set(locale, localeUpdates);
                    }
                    localeUpdates.set(key, { value: defaultValue, rootName });
                }
            }

            for (const [locale, updates] of placeholderUpdates.entries()) {
                await setTranslationValuesBatch(folder, locale, updates);
            }
        }

        const translations = await this.translationService.translateToLocales(
            defaultValue,
            defaultLocale,
            targetLocales,
            'text',
            true,
        );

        if (!translations || translations.size === 0) {
            const choice = await vscode.window.showInformationMessage(
                'AI Localizer: No translations were generated for this quick fix (check API key and settings).',
                'Open OpenAI API Key Settings',
                'Dismiss',
            );
            if (choice === 'Open OpenAI API Key Settings') {
                await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
            }
            return;
        }

        // Write AI translations
        if (isLaravel) {
            for (const [locale, newValue] of translations.entries()) {
                await setLaravelTranslationValue(folder, locale, key, newValue);
            }
        } else {
            const translationUpdates = new Map<string, Map<string, { value: string; rootName?: string }>>();
            for (const [locale, newValue] of translations.entries()) {
                let localeUpdates = translationUpdates.get(locale);
                if (!localeUpdates) {
                    localeUpdates = new Map();
                    translationUpdates.set(locale, localeUpdates);
                }
                localeUpdates.set(key, { value: newValue, rootName });
            }

            for (const [locale, updates] of translationUpdates.entries()) {
                await setTranslationValuesBatch(folder, locale, updates);
            }
        }

        vscode.window.showInformationMessage(
            `AI Localizer: Applied AI translations for ${key} in ${translations.size} locale(s).`,
        );
    }

    /**
     * Translate all untranslated keys in a locale file
     */
    async translateAllUntranslatedInFile(
        documentUri: vscode.Uri,
        pruneReportsCallback: (folder: vscode.WorkspaceFolder, fixed: Array<{ locale: string; keyPath: string }>) => Promise<void>,
    ): Promise<void> {
        const targetUri = documentUri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            vscode.window.showInformationMessage(
                'AI Localizer: No active document to translate.',
            );
            return;
        }

        // Check if another operation is blocking
        if (!(await this.canProceed('translation-file', 'Translate All in File'))) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(targetUri);
        const isJsonFile = doc.languageId === 'json' || doc.languageId === 'jsonc';
        const isLaravelLocaleFile = this.isLaravelLocaleFileUri(targetUri);
        if (!isJsonFile && !isLaravelLocaleFile) {
            vscode.window.showInformationMessage(
                'AI Localizer: Bulk translate only applies to locale JSON or Laravel lang files.',
            );
            return;
        }

        let folder = vscode.workspace.getWorkspaceFolder(targetUri) ?? undefined;
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        // Check if project is disabled
        if (isProjectDisabled(folder)) {
            vscode.window.showWarningMessage(
                'AI Localizer: Project is disabled. Enable it via workspace settings before using translation features.'
            );
            return;
        }

        const syncService = getGranularSyncService(this.context);
        await syncService.syncFile(folder, targetUri);

        await this.i18nIndex.ensureInitialized();

        const fileInfo = this.i18nIndex.getKeysForFile(targetUri);
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const globalDefaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

        const fileLocale: string | null = fileInfo?.locale || inferJsonLocaleFromUri(targetUri);

        if (!fileLocale) {
            vscode.window.showInformationMessage(
                'AI Localizer: Could not determine locale for this file.',
            );
            return;
        }

        if (fileLocale === globalDefaultLocale) {
            await this.translateMissingLocalesFromDefaultFile(
                folder,
                targetUri,
                fileInfo,
                globalDefaultLocale,
                pruneReportsCallback,
            );
            return;
        }

        const targetLocale: string = fileLocale;
        const keysToTranslate: TranslationItem[] = [];
        const keysInFile = fileInfo?.keys || [];

        for (const key of keysInFile) {
            const record = this.i18nIndex.getRecord(key);
            if (!record) continue;

            const defaultLocale = record.defaultLocale || globalDefaultLocale;
            if (targetLocale === defaultLocale) continue;

            const defaultValue = record.locales.get(defaultLocale);
            if (typeof defaultValue !== 'string' || !defaultValue.trim()) continue;

            const currentValue = record.locales.get(targetLocale);
            const needsTranslation =
                !currentValue ||
                !currentValue.trim() ||
                currentValue.trim() === defaultValue.trim();

            if (needsTranslation) {
                keysToTranslate.push({ key, defaultValue, defaultLocale });
            }
        }

        if (!keysToTranslate.length) {
            vscode.window.showInformationMessage(
                `AI Localizer: No untranslated keys found for locale ${targetLocale}.`,
            );
            return;
        }

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: `Translate ${keysToTranslate.length} key(s)`,
                    description: `Use AI to translate ${keysToTranslate.length} untranslated key(s) to ${targetLocale}`,
                },
                { label: 'Cancel', description: 'Do not translate' },
            ],
            {
                placeHolder: `AI Localizer: Translate ${keysToTranslate.length} untranslated key(s) in this file?`,
            },
        );
        if (!choice || choice.label === 'Cancel') {
            return;
        }

        // Acquire lock for file translation
        const result = await operationLock.withGlobalLock(
            'translation-file',
            `Translating ${vscode.workspace.asRelativePath(targetUri)}`,
            async () => {
                let translatedCount = 0;
                const fixed: { locale: string; keyPath: string }[] = [];
                const relPath = vscode.workspace.asRelativePath(targetUri);
                const progressTitle = `AI Localizer: Translating ${targetLocale} (${relPath})...`;

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: progressTitle,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        if (token.isCancellationRequested) return;

                        const batchItems = keysToTranslate.map((item) => ({
                            id: item.key,
                            text: item.defaultValue,
                            defaultLocale: item.defaultLocale,
                        }));

                        const translations = await this.translationService.translateBatchToLocale(
                            batchItems,
                            targetLocale,
                            'text',
                            true,
                        );

                        if (!translations || translations.size === 0 || token.isCancellationRequested) {
                            return;
                        }

                        const batchUpdates = new Map<string, { value: string; rootName?: string }>();
                        for (const item of keysToTranslate) {
                            if (token.isCancellationRequested) break;
                            const newValue = translations.get(item.key);
                            if (!newValue) continue;
                            const record = this.i18nIndex.getRecord(item.key);
                            const rootName = record ? this.getRootNameForRecord(record) : 'common';
                            batchUpdates.set(item.key, { value: newValue, rootName });
                        }

                        if (batchUpdates.size > 0 && !token.isCancellationRequested) {
                            progress.report({
                                message: `Writing ${batchUpdates.size} translation(s) to ${targetLocale}...`,
                            });

                            if (isLaravelLocaleFile) {
                                for (const [fullKey, { value }] of batchUpdates.entries()) {
                                    await setLaravelTranslationValue(folder!, targetLocale, fullKey, value);
                                    translatedCount += 1;
                                    fixed.push({ locale: targetLocale, keyPath: fullKey });
                                }
                            } else {
                                const writeResult = await setTranslationValuesBatch(folder!, targetLocale, batchUpdates);
                                translatedCount = writeResult.written;

                                for (const [key] of batchUpdates.entries()) {
                                    fixed.push({ locale: targetLocale, keyPath: key });
                                }

                                if (writeResult.errors.length > 0) {
                                    console.error('AI Localizer: Some translations failed to write:', writeResult.errors);
                                }
                            }
                        }
                    },
                );

                return { fixed, translatedCount };
            }
        );

        if (!result) {
            return;
        }

        const { fixed, translatedCount } = result;

        if (fixed.length > 0) {
            await pruneReportsCallback(folder, fixed);
        }

        if (translatedCount > 0) {
            vscode.window.showInformationMessage(
                `AI Localizer: Translated ${translatedCount} key(s) in ${targetLocale}.`,
            );

            // Rescan to refresh index and diagnostics after bulk translation
            try {
                await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
            } catch {
                // Ignore rescan failures; translations are already written
            }
        } else {
            const apiChoice = await vscode.window.showInformationMessage(
                'AI Localizer: No translations were generated (check API key and settings).',
                'Open OpenAI API Key Settings',
                'Dismiss',
            );
            if (apiChoice === 'Open OpenAI API Key Settings') {
                await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
            }
        }
    }

    /**
     * Translate missing locales from default file
     */
    private async translateMissingLocalesFromDefaultFile(
        folder: vscode.WorkspaceFolder,
        documentUri: vscode.Uri,
        fileInfo: { locale: string; keys: string[] } | null,
        globalDefaultLocale: string,
        pruneReportsCallback: (folder: vscode.WorkspaceFolder, fixed: Array<{ locale: string; keyPath: string }>) => Promise<void>,
    ): Promise<void> {
        const isLaravelDefaultFile = this.isLaravelLocaleFileUri(documentUri);
        const keysInFile = fileInfo?.keys || [];
        if (!keysInFile.length) {
            vscode.window.showInformationMessage(
                'AI Localizer: No translation keys found in this file.',
            );
            return;
        }

        const missingPerLocale = new Map<string, TranslationItem[]>();

        // Primary source of truth: current untranslated diagnostics for this file
        const fileDiagnostics = vscode.languages.getDiagnostics(documentUri);
        if (fileDiagnostics && fileDiagnostics.length) {
            try {
                const { parseUntranslatedDiagnostic } = await import('../utils/diagnosticParser');

                for (const d of fileDiagnostics) {
                    if (String(d.code) !== 'ai-i18n.untranslated') continue;

                    const parsed = parseUntranslatedDiagnostic(String(d.message || ''));
                    if (!parsed || !parsed.key || !parsed.locales || !parsed.locales.length) continue;

                    const key = parsed.key;
                    if (!keysInFile.includes(key)) continue;

                    const record = this.i18nIndex.getRecord(key);
                    if (!record) continue;

                    const defaultLocale = record.defaultLocale || globalDefaultLocale;
                    const defaultValue = record.locales.get(defaultLocale);
                    if (typeof defaultValue !== 'string' || !defaultValue.trim()) continue;

                    for (const locale of parsed.locales) {
                        if (!locale || locale === defaultLocale) continue;

                        let list = missingPerLocale.get(locale);
                        if (!list) {
                            list = [];
                            missingPerLocale.set(locale, list);
                        }
                        list.push({ key, defaultValue, defaultLocale });
                    }
                }
            } catch {
                // If diagnostic parsing fails for any reason, fall back to index-based detection below
            }
        }

        // Fallback when no untranslated diagnostics were found: infer missing locales from index
        if (!missingPerLocale.size) {
            const allLocales = this.i18nIndex.getAllLocales();

            for (const key of keysInFile) {
                const record = this.i18nIndex.getRecord(key);
                if (!record) continue;

                const defaultLocale = record.defaultLocale || globalDefaultLocale;
                const defaultValue = record.locales.get(defaultLocale);
                if (typeof defaultValue !== 'string' || !defaultValue.trim()) continue;
                const trimmedDefault = defaultValue.trim();

                for (const locale of allLocales) {
                    if (!locale || locale === defaultLocale) continue;
                    const currentValue = record.locales.get(locale);
                    const current = typeof currentValue === 'string' ? currentValue.trim() : '';
                    const needsTranslation = !current || current === trimmedDefault;
                    if (!needsTranslation) continue;

                    let list = missingPerLocale.get(locale);
                    if (!list) {
                        list = [];
                        missingPerLocale.set(locale, list);
                    }
                    list.push({ key, defaultValue, defaultLocale });
                }
            }
        }

        if (!missingPerLocale.size) {
            vscode.window.showInformationMessage(
                'AI Localizer: No untranslated keys found for non-default locales in this file.',
            );
            return;
        }

        const localeEntries = Array.from(missingPerLocale.entries());
        let selectedLocales: string[];
        let translateAll = false;

        if (localeEntries.length === 1) {
            selectedLocales = [localeEntries[0][0]];
        } else {
            const totalKeys = localeEntries.reduce((sum, [, list]) => sum + list.length, 0);
            const items: Array<vscode.QuickPickItem & { locale?: string; isAll?: boolean }> = [
                {
                    label: `$(globe) All locales (${localeEntries.length} locales, ${totalKeys} keys)`,
                    description: `Translate all missing keys for all ${localeEntries.length} locales at once`,
                    isAll: true,
                },
                { label: '---', kind: vscode.QuickPickItemKind.Separator },
                ...localeEntries.map(([locale, list]) => {
                    const count = list.length;
                    return {
                        label: `${locale} (${count} key${count === 1 ? '' : 's'})`,
                        description: undefined,
                        locale,
                    };
                }),
            ];

            const choice = await vscode.window.showQuickPick(items, {
                placeHolder:
                    'AI Localizer: Select target locale(s) to translate missing keys for this file',
            });
            if (!choice) return;

            if ((choice as any).isAll) {
                translateAll = true;
                selectedLocales = localeEntries.map(([locale]) => locale);
            } else {
                const selectedLocale = (choice as any).locale;
                if (!selectedLocale) return;
                selectedLocales = [selectedLocale];
            }
        }

        const totalKeysToTranslate = translateAll
            ? localeEntries.reduce((sum, [, list]) => sum + list.length, 0)
            : missingPerLocale.get(selectedLocales[0])?.length || 0;

        const confirmLabel = translateAll
            ? `Translate all ${totalKeysToTranslate} key(s) to ${selectedLocales.length} locale(s)`
            : `Translate ${totalKeysToTranslate} key(s) to ${selectedLocales[0]}`;

        const confirm = await vscode.window.showQuickPick(
            [
                {
                    label: confirmLabel,
                    description: translateAll
                        ? `Use AI to translate missing keys for all ${selectedLocales.length} locales`
                        : `Use AI to translate ${totalKeysToTranslate} untranslated key(s) to ${selectedLocales[0]}`,
                },
                { label: 'Cancel', description: 'Do not translate' },
            ],
            { placeHolder: `AI Localizer: ${confirmLabel}?` },
        );
        if (!confirm || confirm.label === 'Cancel') return;

        // Acquire lock for bulk translation
        const result = await operationLock.withGlobalLock(
            'translation-file',
            `Translating from ${vscode.workspace.asRelativePath(documentUri)}`,
            async () => {
                const relPath = vscode.workspace.asRelativePath(documentUri);
                let totalTranslatedCount = 0;
                const fixed: { locale: string; keyPath: string }[] = [];

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: translateAll
                            ? `AI Localizer: Translating ${selectedLocales.length} locale(s) (${relPath})...`
                            : `AI Localizer: Translating ${selectedLocales[0]} (${relPath})...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        for (let i = 0; i < selectedLocales.length; i++) {
                            if (token.isCancellationRequested) break;

                            const selectedLocale = selectedLocales[i];
                            const keysToTranslate = missingPerLocale.get(selectedLocale) || [];
                            if (!keysToTranslate.length) continue;

                            progress.report({
                                message: `Translating ${selectedLocale} (${i + 1}/${selectedLocales.length}): ${keysToTranslate.length} key(s)...`,
                                increment: (100 / selectedLocales.length) * (i === 0 ? 0 : 1),
                            });

                            const batchItems = keysToTranslate.map((item) => ({
                                id: item.key,
                                text: item.defaultValue,
                                defaultLocale: item.defaultLocale,
                            }));

                            const translations = await this.translationService.translateBatchToLocale(
                                batchItems,
                                selectedLocale,
                                'text',
                                true,
                            );

                            if (!translations || translations.size === 0 || token.isCancellationRequested) {
                                continue;
                            }

                            const batchUpdates = new Map<string, { value: string; rootName?: string }>();
                            for (const item of keysToTranslate) {
                                if (token.isCancellationRequested) break;
                                const newValue = translations.get(item.key);
                                if (!newValue) continue;
                                const record = this.i18nIndex.getRecord(item.key);
                                const rootName = record ? this.getRootNameForRecord(record) : 'common';
                                batchUpdates.set(item.key, { value: newValue, rootName });
                            }

                            if (batchUpdates.size > 0 && !token.isCancellationRequested) {
                                progress.report({
                                    message: `Writing ${batchUpdates.size} translation(s) to ${selectedLocale}...`,
                                    increment: (100 / selectedLocales.length) * 0.5,
                                });

                                if (isLaravelDefaultFile) {
                                    for (const [fullKey, { value }] of batchUpdates.entries()) {
                                        await setLaravelTranslationValue(folder, selectedLocale, fullKey, value);
                                        totalTranslatedCount += 1;
                                        fixed.push({ locale: selectedLocale, keyPath: fullKey });
                                    }
                                } else {
                                    const writeResult = await setTranslationValuesBatch(folder, selectedLocale, batchUpdates);
                                    totalTranslatedCount += writeResult.written;

                                    for (const [key] of batchUpdates.entries()) {
                                        fixed.push({ locale: selectedLocale, keyPath: key });
                                    }

                                    if (writeResult.errors.length > 0) {
                                        console.error(
                                            `AI Localizer: Some translations failed to write for ${selectedLocale}:`,
                                            writeResult.errors,
                                        );
                                    }
                                }
                            }

                            progress.report({ increment: (100 / selectedLocales.length) * 0.5 });
                        }
                    },
                );

                return { fixed, totalTranslatedCount, selectedLocales, translateAll };
            }
        );

        if (!result) {
            return;
        }

        const { fixed, totalTranslatedCount, selectedLocales: selLocales, translateAll: transAll } = result;

        if (fixed.length > 0) {
            await pruneReportsCallback(folder, fixed);
        }

        if (totalTranslatedCount > 0) {
            const localeSummary = transAll
                ? `${totalTranslatedCount} key(s) across ${selLocales.length} locale(s)`
                : `${totalTranslatedCount} key(s) in ${selLocales[0]}`;
            vscode.window.showInformationMessage(`AI Localizer: Translated ${localeSummary}.`);

            // Rescan to refresh index and diagnostics after bulk translation from default file
            try {
                await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
            } catch {
                // Ignore rescan failures; translations are already written
            }
        } else {
            const apiChoice = await vscode.window.showInformationMessage(
                'AI Localizer: No translations were generated (check API key and settings).',
                'Open OpenAI API Key Settings',
                'Dismiss',
            );
            if (apiChoice === 'Open OpenAI API Key Settings') {
                await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
            }
        }
    }

    /**
     * Translate all untranslated keys in the entire project
     */
    async translateAllUntranslatedInProject(
        pruneReportsCallback: (folder: vscode.WorkspaceFolder, fixed: Array<{ locale: string; keyPath: string }>) => Promise<void>,
        generateAutoIgnoreCallback: (folder: vscode.WorkspaceFolder) => Promise<void>,
    ): Promise<void> {
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        // Filter out disabled projects
        const enabledFolders = folders.filter(folder => !isProjectDisabled(folder));
        if (enabledFolders.length === 0) {
            vscode.window.showWarningMessage(
                'AI Localizer: All workspace folders are disabled. Enable them via workspace settings before using translation features.'
            );
            return;
        }

        if (enabledFolders.length < folders.length) {
            vscode.window.showInformationMessage(
                `AI Localizer: Skipping ${folders.length - enabledFolders.length} disabled workspace folder(s).`
            );
        }

        // Check if another operation is blocking
        if (!(await this.canProceed('translation-project', 'Fix All i18n Issues in Project'))) {
            return;
        }

        let folder: vscode.WorkspaceFolder | undefined;
        if (enabledFolders.length === 1) {
            folder = enabledFolders[0];
        } else {
            folder = await pickWorkspaceFolder();
        }

        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        await vscode.commands.executeCommand('ai-localizer.i18n.runSyncScript');
        await this.i18nIndex.ensureInitialized();

        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const globalDefaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

        const allKeys = this.i18nIndex.getAllKeys();
        if (!allKeys.length) {
            vscode.window.showInformationMessage(
                'AI Localizer: No translation keys found to translate.',
            );
            return;
        }

        const allLocales = this.i18nIndex.getAllLocales();
        if (!allLocales.length) {
            vscode.window.showInformationMessage(
                'AI Localizer: No locales detected in this workspace.',
            );
            return;
        }

        const missingPerLocale = new Map<string, TranslationItem[]>();
        const sampleFileByLocale = new Map<string, vscode.Uri>();

        for (const key of allKeys) {
            const record = this.i18nIndex.getRecord(key);
            if (!record) continue;

            const defaultLocale = record.defaultLocale || globalDefaultLocale;
            const defaultValue = record.locales.get(defaultLocale);
            if (typeof defaultValue !== 'string' || !defaultValue.trim()) continue;
            const base = defaultValue.trim();

            for (const locale of allLocales) {
                if (!locale || locale === defaultLocale) continue;
                const currentValue = record.locales.get(locale);
                const current = typeof currentValue === 'string' ? currentValue.trim() : '';
                const needsTranslation = !current || current === base;
                if (!needsTranslation) continue;

                if (!sampleFileByLocale.has(locale) && record.locations && record.locations.length) {
                    const locEntry = record.locations.find((l) => l.locale === locale) || record.locations[0];
                    if (locEntry) {
                        sampleFileByLocale.set(locale, locEntry.uri);
                    }
                }

                let list = missingPerLocale.get(locale);
                if (!list) {
                    list = [];
                    missingPerLocale.set(locale, list);
                }
                list.push({ key, defaultValue, defaultLocale });
            }
        }

        if (!missingPerLocale.size) {
            vscode.window.showInformationMessage(
                'AI Localizer: No untranslated keys found for non-default locales in this workspace.',
            );
            return;
        }

        let totalKeys = 0;
        for (const list of missingPerLocale.values()) {
            totalKeys += list.length;
        }

        const confirm = await vscode.window.showQuickPick(
            [
                {
                    label: `Translate ${totalKeys} key(s)`,
                    description: `Use AI to translate ${totalKeys} untranslated key(s) across ${missingPerLocale.size} locale(s)`,
                },
                { label: 'Cancel', description: 'Do not translate' },
            ],
            {
                placeHolder: `AI Localizer: Translate ${totalKeys} untranslated key(s) across all locales in this workspace?`,
            },
        );

        if (!confirm || confirm.label === 'Cancel') return;

        // Acquire global lock for the entire project translation operation
        const result = await operationLock.withGlobalLock(
            'translation-project',
            'Fix All i18n Issues in Project',
            async () => {
                const localeEntries = Array.from(missingPerLocale.entries());
                const maxConcurrent = 4;
                let completedLocales = 0;
                let translatedTotal = 0;
                const fixed: { locale: string; keyPath: string }[] = [];

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'AI Localizer: Translating all locales...',
                        cancellable: true,
                    },
                    async (progress, token) => {
                        if (token.isCancellationRequested) return;

                        let index = 0;
                        let lastReported = 0;

                        const worker = async () => {
                            while (true) {
                                const current = index;
                                index += 1;
                                if (current >= localeEntries.length || token.isCancellationRequested) {
                                    break;
                                }

                                const [locale, items] = localeEntries[current];

                                try {
                                    const batchItems = items.map((item) => ({
                                        id: item.key,
                                        text: item.defaultValue,
                                        defaultLocale: item.defaultLocale,
                                    }));

                                    const translations = await this.translationService.translateBatchToLocale(
                                        batchItems,
                                        locale,
                                        'text',
                                        true,
                                    );

                                    if (!translations || translations.size === 0 || token.isCancellationRequested) {
                                        continue;
                                    }

                                    const jsonBatchUpdates = new Map<string, { value: string; rootName?: string }>();
                                    const laravelUpdates = new Map<string, string>();
                                    for (const item of items) {
                                        if (token.isCancellationRequested) break;
                                        const newValue = translations.get(item.key);
                                        if (!newValue) continue;
                                        const record = this.i18nIndex.getRecord(item.key);
                                        const isLaravel = record && this.isLaravelRecord(record);
                                        if (isLaravel) {
                                            laravelUpdates.set(item.key, newValue);
                                        } else {
                                            const rootName = record ? this.getRootNameForRecord(record) : 'common';
                                            jsonBatchUpdates.set(item.key, { value: newValue, rootName });
                                        }
                                    }

                                    if (!token.isCancellationRequested) {
                                        if (jsonBatchUpdates.size > 0) {
                                            const writeResult = await setTranslationValuesBatch(folder!, locale, jsonBatchUpdates);
                                            translatedTotal += writeResult.written;

                                            for (const [key] of jsonBatchUpdates.entries()) {
                                                fixed.push({ locale, keyPath: key });
                                            }

                                            if (writeResult.errors.length > 0) {
                                                console.error(
                                                    `AI Localizer: Some translations failed to write for ${locale}:`,
                                                    writeResult.errors,
                                                );
                                            }
                                        }

                                        if (laravelUpdates.size > 0) {
                                            for (const [fullKey, value] of laravelUpdates.entries()) {
                                                await setLaravelTranslationValue(folder!, locale, fullKey, value);
                                                translatedTotal += 1;
                                                fixed.push({ locale, keyPath: fullKey });
                                            }
                                        }
                                    }
                                } catch (err) {
                                    console.error(`AI Localizer: Failed to translate keys for locale ${locale}:`, err);
                                } finally {
                                    completedLocales += 1;
                                    const percent = (completedLocales / localeEntries.length) * 100;
                                    const sampleUri = sampleFileByLocale.get(locale);
                                    const fileLabel = sampleUri
                                        ? vscode.workspace.asRelativePath(sampleUri, false)
                                        : undefined;
                                    const baseMsg = `${completedLocales} of ${localeEntries.length} locale(s)`;
                                    const message = fileLabel
                                        ? `${baseMsg} — ${locale} (${fileLabel})`
                                        : `${baseMsg} — ${locale}`;
                                    progress.report({
                                        message,
                                        increment: percent - lastReported,
                                    });
                                    lastReported = percent;
                                }
                            }
                        };

                        const workers: Promise<void>[] = [];
                        const workerCount = Math.min(maxConcurrent, localeEntries.length);
                        for (let i = 0; i < workerCount; i += 1) {
                            workers.push(worker());
                        }
                        await Promise.all(workers);
                    },
                );

                return { fixed, translatedTotal };
            },
        );

        if (!result) {
            return;
        }

        const { fixed, translatedTotal } = result;

        if (fixed.length > 0) {
            await pruneReportsCallback(folder, fixed);
        }

        if (translatedTotal > 0) {
            vscode.window.showInformationMessage(
                `AI Localizer: Translated ${translatedTotal} key(s) across ${missingPerLocale.size} locale(s).`,
            );
            await generateAutoIgnoreCallback(folder);

            // Rescan once after project-wide bulk translation completes
            try {
                await vscode.commands.executeCommand('ai-localizer.i18n.rescan');
            } catch {
                // Ignore rescan failures; translations are already written
            }
        } else {
            const apiChoice = await vscode.window.showInformationMessage(
                'AI Localizer: No translations were generated (check API key and settings).',
                'Open OpenAI API Key Settings',
                'Dismiss',
            );
            if (apiChoice === 'Open OpenAI API Key Settings') {
                await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
            }
        }
    }

    /**
     * Fix placeholder mismatch by re-translating the value
     */
    async fixPlaceholderMismatch(documentUri: vscode.Uri, key: string, locale: string): Promise<void> {
        let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(key);
        if (!record) {
            vscode.window.showInformationMessage(
                `AI Localizer: No translation record found for key ${key}.`,
            );
            return;
        }

        const defaultLocale = record.defaultLocale;
        const defaultValue = record.locales.get(defaultLocale);
        if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
            vscode.window.showInformationMessage(
                `AI Localizer: Default locale value not found for key ${key}.`,
            );
            return;
        }

        const translations = await this.translationService.translateToLocales(
            defaultValue,
            defaultLocale,
            [locale],
            'text',
            true,
        );

        if (!translations || translations.size === 0) {
            const choice = await vscode.window.showInformationMessage(
                'AI Localizer: No translation generated (check API key and settings).',
                'Open OpenAI API Key Settings',
                'Dismiss',
            );
            if (choice === 'Open OpenAI API Key Settings') {
                await vscode.commands.executeCommand('ai-localizer.setOpenAiApiKeySecret');
            }
            return;
        }

        const newValue = translations.get(locale);
        if (newValue) {
            const { setTranslationValue } = await import('../../../core/i18nFs');
            const rootName = this.getRootNameForRecord(record);
            await setTranslationValue(folder, locale, key, newValue, { rootName });

            vscode.window.showInformationMessage(
                `AI Localizer: Fixed placeholder mismatch for ${key} in ${locale}.`,
            );
        }
    }
}


