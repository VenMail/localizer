import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex } from '../../../../core/i18nIndex';
import { setLaravelTranslationValue, setTranslationValue, setTranslationValuesBatch } from '../../../../core/i18nFs';

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
        options: { skipDiagnosticsRefresh?: boolean; skipOverwritePrompt?: boolean } = {},
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
            // Skip prompt during bulk operations
            if (!options.skipOverwritePrompt) {
                const overwrite = await vscode.window.showWarningMessage(
                    `AI Localizer: Target locale "${targetLocale}" already has a translation for "${key}". Overwrite?`,
                    'Overwrite',
                    'Cancel'
                );
                if (overwrite !== 'Overwrite') {
                    return;
                }
            }
            // In bulk operations, we silently skip keys that already have values
            // (they should have been filtered out earlier, but this is a safety check)
            else {
                this.log?.appendLine(`[TranslationOps] Skipping "${key}" - target locale already has value`);
                return;
            }
        }

        // Find any existing location to determine the workspace folder and root name
        const existingLocation = record.locations.find((loc: any) => loc.locale === sourceLocale);
        if (!existingLocation) {
            throw new Error(`No locale file found for source locale "${sourceLocale}"`);
        }

        const folder = vscode.workspace.getWorkspaceFolder(existingLocation.uri);
        if (!folder) {
            throw new Error('No workspace folder found for locale file');
        }

        // Extract root name from the source file path for consistency
        const rootName = this.extractRootNameFromPath(existingLocation.uri.fsPath);
        const isLaravelKey = record.locations.some((loc: any) => {
            const fsPath = loc.uri.fsPath.replace(/\\/g, '/');
            return fsPath.includes('/lang/') || fsPath.includes('/resources/lang/');
        });

        if (isLaravelKey) {
            await setLaravelTranslationValue(folder, targetLocale, key, sourceValue);
        } else {
            await setTranslationValue(folder, targetLocale, key, sourceValue, { rootName });
        }
        
        // Refresh diagnostics if not skipped - we need to find or create the target URI
        if (!options.skipDiagnosticsRefresh) {
            try {
                // Try to resolve the target locale file URI for diagnostics refresh
                const targetUri = await this.resolveTargetLocaleUri(folder, targetLocale, key, rootName, isLaravelKey);
                if (targetUri) {
                    await vscode.commands.executeCommand('ai-localizer.i18n.refreshFileDiagnostics', targetUri, [key]);
                }
            } catch (refreshError) {
                // Don't fail the operation if diagnostics refresh fails
                this.log?.appendLine(`[TranslationOps] Diagnostics refresh failed: ${refreshError}`);
            }
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

    /**
     * Extract root name from a locale file path
     */
    private extractRootNameFromPath(filePath: string): string {
        const fileName = path.basename(filePath, path.extname(filePath));
        
        // If the file is already named with a locale (like en.json, fr.json), return 'common'
        if (/^[a-z]{2}(-[A-Z]{2})?$/i.test(fileName)) {
            return 'common';
        }
        
        // Otherwise, use the filename as the root name (lowercased)
        return fileName.toLowerCase();
    }

    /**
     * Resolve the target locale file URI for diagnostics refresh
     */
    private async resolveTargetLocaleUri(
        folder: vscode.WorkspaceFolder,
        locale: string,
        key: string,
        rootName: string,
        isLaravelKey: boolean
    ): Promise<vscode.Uri | null> {
        try {
            if (isLaravelKey) {
                // Prefer an existing Laravel locale location if present
                const record = this.i18nIndex.getRecord(key);
                const laravelLoc = record?.locations.find((loc: any) => {
                    const fsPath = loc.uri.fsPath.replace(/\\/g, '/');
                    return loc.locale === locale && (fsPath.includes('/lang/') || fsPath.includes('/resources/lang/'));
                });
                if (laravelLoc) {
                    return laravelLoc.uri;
                }

                const segments = key.split('.').filter(Boolean);
                const group = segments[0] || 'messages';
                const bases = ['resources/lang', 'lang'];
                for (const base of bases) {
                    const candidate = path.join(folder.uri.fsPath, base, locale, `${group}.php`);
                    return vscode.Uri.file(candidate);
                }
            }

            // Use the same logic as setTranslationValue to determine the target file
            const bases = ['resources/js/i18n/auto', 'src/i18n', 'src/locales', 'locales', 'i18n'];
            
            for (const base of bases) {
                const baseUri = vscode.Uri.file(path.join(folder.uri.fsPath, base));
                try {
                    const stat = await vscode.workspace.fs.stat(baseUri);
                    if (stat.type !== vscode.FileType.Directory) {
                        continue;
                    }
                } catch {
                    continue;
                }

                // Check for directory-based locale files
                const localeDirUri = vscode.Uri.file(path.join(baseUri.fsPath, locale));
                try {
                    const dirStat = await vscode.workspace.fs.stat(localeDirUri);
                    if (dirStat.type === vscode.FileType.Directory) {
                        // Use rootName to determine the filename
                        const fileName = rootName === 'common' ? 'commons.json' : `${rootName}.json`;
                        return vscode.Uri.joinPath(localeDirUri, fileName);
                    }
                } catch {
                    // Directory doesn't exist, continue
                }

                // Check for single-file locale files
                const localeFileUri = vscode.Uri.file(path.join(baseUri.fsPath, `${locale}.json`));
                try {
                    const fileStat = await vscode.workspace.fs.stat(localeFileUri);
                    if (fileStat.type === vscode.FileType.File) {
                        return localeFileUri;
                    }
                } catch {
                    // File doesn't exist yet, but this would be where it would be created
                    return localeFileUri;
                }
            }

            // Fallback: try to create the most likely path
            const fallbackPath = path.join(folder.uri.fsPath, 'src/i18n', `${locale}.json`);
            return vscode.Uri.file(fallbackPath);
        } catch (error) {
            this.log?.appendLine(`[TranslationOps] Failed to resolve target locale URI: ${error}`);
            return null;
        }
    }
}
