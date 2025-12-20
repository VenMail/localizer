import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { findPackageJson } from '../core/workspace';

export interface ProjectConfig {
    locales: string[];
    srcRoot?: string;
    scripts: Record<string, string>;
}

/**
 * Service for managing project i18n configuration
 */
export class ProjectConfigService {
    private decoder = new TextDecoder('utf-8');
    private encoder = new TextEncoder();
    private configCache = new Map<string, ProjectConfig | null>();

    /**
     * Read project configuration from package.json
     */
    async readConfig(folder: vscode.WorkspaceFolder): Promise<ProjectConfig | null> {
        const cacheKey = folder.uri.fsPath;
        if (this.configCache.has(cacheKey)) {
            return this.configCache.get(cacheKey) || null;
        }

        const pkgUri = await findPackageJson(folder);
        if (!pkgUri) {
            this.configCache.set(cacheKey, null);
            return null;
        }

        try {
            const data = await vscode.workspace.fs.readFile(pkgUri);
            const raw = this.decoder.decode(data);
            const pkg = JSON.parse(raw);

            const locales: string[] =
                pkg?.aiI18n?.locales && Array.isArray(pkg.aiI18n.locales)
                    ? pkg.aiI18n.locales.map((v: any) => String(v)).filter((v: string) => v.length > 0)
                    : ['en'];

            const srcRoot: string | undefined =
                pkg?.aiI18n?.srcRoot && typeof pkg.aiI18n.srcRoot === 'string'
                    ? pkg.aiI18n.srcRoot
                    : undefined;

            const scripts: Record<string, string> = pkg?.scripts || {};

            const result: ProjectConfig = { locales, srcRoot, scripts };
            this.configCache.set(cacheKey, result);
            return result;
        } catch (err) {
            console.error('Failed to read project config:', err);
            this.configCache.set(cacheKey, null);
            return null;
        }
    }

    /**
     * Update project configuration in package.json
     */
    async updateConfig(
        folder: vscode.WorkspaceFolder,
        updates: Partial<ProjectConfig>,
    ): Promise<void> {
        const cacheKey = folder.uri.fsPath;
        this.configCache.delete(cacheKey);
        const pkgUri = await findPackageJson(folder);
        if (!pkgUri) {
            throw new Error('No package.json found');
        }

        const data = await vscode.workspace.fs.readFile(pkgUri);
        const raw = this.decoder.decode(data);
        const pkg = JSON.parse(raw);

        // Update aiI18n section
        if (!pkg.aiI18n || typeof pkg.aiI18n !== 'object') {
            pkg.aiI18n = {};
        }

        if (updates.locales) {
            pkg.aiI18n.locales = updates.locales;
        }

        if (updates.srcRoot !== undefined) {
            pkg.aiI18n.srcRoot = updates.srcRoot;
        }

        // Update scripts section
        if (updates.scripts) {
            if (!pkg.scripts || typeof pkg.scripts !== 'object') {
                pkg.scripts = {};
            }
            Object.assign(pkg.scripts, updates.scripts);
        }

        const updated = JSON.stringify(pkg, null, 2);
        await vscode.workspace.fs.writeFile(pkgUri, this.encoder.encode(`${updated}\n`));
    }

    /**
     * Check if i18n scripts are configured
     */
    async hasI18nScripts(folder: vscode.WorkspaceFolder): Promise<boolean> {
        const config = await this.readConfig(folder);
        if (!config) {
            return false;
        }

        return !!(config.scripts['i18n:extract'] || config.scripts['i18n:rewrite']);
    }

    /**
     * Configure project with default i18n scripts
     */
    async configureDefaultScripts(folder: vscode.WorkspaceFolder): Promise<void> {
        const scripts: Record<string, string> = {
            'i18n:extract': 'node ./scripts/extract-i18n.js',
            'i18n:rewrite': 'node ./scripts/replace-i18n.js',
            'i18n:sync': 'node ./scripts/sync-i18n.js',
            'i18n:fix-untranslated': 'node ./scripts/fix-untranslated.js',
            'i18n:rewrite-blade': 'node ./scripts/rewrite-i18n-blade.js',
            'i18n:cleanup-unused': 'node ./scripts/cleanup-i18n-unused.js',
            'i18n:restore-invalid': 'node ./scripts/restore-i18n-invalid.js',
        };

        await this.updateConfig(folder, { scripts });
    }

    /**
     * Prompt user for locale configuration
     */
    async promptForLocales(defaultValue = 'en,fr,zh'): Promise<string[] | null> {
        const input = await vscode.window.showInputBox({
            value: defaultValue,
            prompt: 'Enter comma-separated locale codes for this project',
            placeHolder: 'en,fr,zh',
        });

        if (!input) {
            return null;
        }

        return input
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v.length > 0);
    }

    /**
     * Prompt user for source root configuration
     */
    async promptForSrcRoot(folder: vscode.WorkspaceFolder): Promise<string | null> {
        const projectRootFs = folder.uri.fsPath;
        const candidates: { label: string; rel: string }[] = [];

        // Check for common source roots
        const possibleRoots = ['resources/js', 'src'];
        for (const rel of possibleRoots) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(path.join(projectRootFs, rel)));
                candidates.push({ label: rel, rel });
            } catch {
                // Directory doesn't exist
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        const pickItems = candidates.map((c) => ({
            label: c.rel,
            description: 'Use this as the source root for i18n scripts',
        }));

        pickItems.push({
            label: 'Skip',
            description: 'Do not set srcRoot override',
        });

        const picked = await vscode.window.showQuickPick(pickItems, {
            placeHolder: 'Optionally set aiI18n.srcRoot for i18n scripts',
        });

        if (!picked || picked.label === 'Skip') {
            return null;
        }

        return picked.label;
    }
}
