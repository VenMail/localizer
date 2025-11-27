import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { isPackageInstalled, installPackages } from '../core/workspace';

/**
 * Service for file system operations related to i18n
 */
export class FileSystemService {
    private decoder = new TextDecoder('utf-8');
    private encoder = new TextEncoder();

    /**
     * Required dependencies for i18n scripts
     */
    private static readonly REQUIRED_DEPS = ['oxc-parser', 'magic-string'];

    /**
     * Copy i18n scripts to project and install required dependencies
     */
    async copyScriptsToProject(
        context: vscode.ExtensionContext,
        projectRoot: string,
    ): Promise<void> {
        const targetDir = vscode.Uri.file(path.join(projectRoot, 'scripts'));

        try {
            await vscode.workspace.fs.createDirectory(targetDir);
        } catch (err) {
            console.error('AI i18n: Failed to create scripts directory:', err);
            throw new Error('Failed to create scripts directory');
        }

        // Create scripts/package.json with "type": "commonjs" to ensure CJS compatibility
        // This makes scripts work regardless of whether the project uses ESM or CJS
        await this.createScriptsPackageJson(targetDir);

        // Use oxc-based scripts (faster, no Babel dependency)
        const scriptNames = [
            'oxc-extract-i18n.js',
            'oxc-replace-i18n.js',
            'sync-i18n.js',
            'fix-untranslated.js',
            'rewrite-i18n-blade.js',
            'cleanup-i18n-unused.js',
            'restore-i18n-invalid.js',
        ];

        // Map oxc script names to standard names in target project
        const scriptNameMap: Record<string, string> = {
            'oxc-extract-i18n.js': 'extract-i18n.js',
            'oxc-replace-i18n.js': 'replace-i18n.js',
        };

        for (const name of scriptNames) {
            const src = vscode.Uri.joinPath(context.extensionUri, 'src', 'i18n', name);
            // Use mapped name if available (oxc scripts -> standard names)
            const destName = scriptNameMap[name] || name;
            const dest = vscode.Uri.joinPath(targetDir, destName);
            
            try {
                const data = await vscode.workspace.fs.readFile(src);
                await vscode.workspace.fs.writeFile(dest, data);
            } catch (err) {
                console.error(`AI i18n: Failed to copy i18n script ${name}:`, err);
                vscode.window.showWarningMessage(
                    `AI i18n: Failed to copy script ${destName}. You may need to copy it manually.`,
                );
            }
        }

        // Copy ignore patterns file
        const ignoreSrc = vscode.Uri.joinPath(context.extensionUri, 'src', 'i18n', 'i18n-ignore-patterns.json');
        const ignoreDest = vscode.Uri.joinPath(targetDir, 'i18n-ignore-patterns.json');
        
        try {
            const data = await vscode.workspace.fs.readFile(ignoreSrc);
            await vscode.workspace.fs.writeFile(ignoreDest, data);
        } catch (err) {
            console.error('AI i18n: Failed to copy i18n-ignore-patterns.json:', err);
            vscode.window.showWarningMessage(
                'AI i18n: Failed to copy ignore patterns file. You may need to copy it manually.',
            );
        }

        // Copy lib folder with shared utilities
        const libDir = vscode.Uri.joinPath(targetDir, 'lib');
        try {
            await vscode.workspace.fs.createDirectory(libDir);
        } catch (err) {
            console.error('AI i18n: Failed to create lib directory:', err);
        }

        const libFiles = [
            'projectConfig.js',
            'stringUtils.js',
            'ignorePatterns.js',
            'translationStore.js',
            'textValidation.js',
        ];

        for (const name of libFiles) {
            const src = vscode.Uri.joinPath(context.extensionUri, 'src', 'i18n', 'lib', name);
            const dest = vscode.Uri.joinPath(libDir, name);
            
            try {
                const data = await vscode.workspace.fs.readFile(src);
                await vscode.workspace.fs.writeFile(dest, data);
            } catch (err) {
                console.error(`AI i18n: Failed to copy lib file ${name}:`, err);
                vscode.window.showWarningMessage(
                    `AI i18n: Failed to copy lib utility ${name}. You may need to copy it manually.`,
                );
            }
        }

        // Install required dependencies
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot));
        if (folder) {
            await this.ensureRequiredDependencies(folder);
        }
    }

    /**
     * Create scripts/package.json with "type": "commonjs"
     * This ensures scripts always run as CommonJS regardless of project's module type
     */
    private async createScriptsPackageJson(scriptsDir: vscode.Uri): Promise<void> {
        const scriptsPackageJson = vscode.Uri.joinPath(scriptsDir, 'package.json');
        const content = {
            "name": "ai-localizer-scripts",
            "private": true,
            "type": "commonjs",
            "description": "AI Localizer i18n scripts - this file ensures scripts run as CommonJS"
        };
        
        try {
            await this.writeJsonFile(scriptsPackageJson, content);
        } catch (err) {
            console.error('AI i18n: Failed to create scripts/package.json:', err);
        }
    }

    /**
     * Ensure required dependencies are installed in the project
     */
    async ensureRequiredDependencies(folder: vscode.WorkspaceFolder): Promise<void> {
        const missingDeps: string[] = [];

        for (const dep of FileSystemService.REQUIRED_DEPS) {
            const installed = await isPackageInstalled(folder, dep);
            if (!installed) {
                missingDeps.push(dep);
            }
        }

        if (missingDeps.length === 0) {
            return;
        }

        const choice = await vscode.window.showInformationMessage(
            `AI i18n requires the following packages: ${missingDeps.join(', ')}. Install them now?`,
            'Install',
            'Skip',
        );

        if (choice === 'Install') {
            await installPackages(folder, missingDeps, true);
            vscode.window.showInformationMessage(
                'AI i18n: Installing dependencies. Please wait for the installation to complete before running scripts.',
            );
        } else {
            vscode.window.showWarningMessage(
                `AI i18n: Scripts may not work without ${missingDeps.join(', ')}. You can install them manually.`,
            );
        }
    }

    /**
     * Check if file exists
     */
    async fileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Read JSON file
     */
    async readJsonFile<T = any>(uri: vscode.Uri): Promise<T | null> {
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const text = this.decoder.decode(data);
            return JSON.parse(text);
        } catch (err) {
            console.error(`Failed to read JSON file ${uri.fsPath}:`, err);
            return null;
        }
    }

    /**
     * Write JSON file
     */
    async writeJsonFile(uri: vscode.Uri, data: any): Promise<void> {
        const text = JSON.stringify(data, null, 2);
        await vscode.workspace.fs.writeFile(uri, this.encoder.encode(`${text}\n`));
    }

    /**
     * Copy file with content transformation
     */
    async copyFileWithTransform(
        src: vscode.Uri,
        dest: vscode.Uri,
        transform?: (content: string) => string,
    ): Promise<void> {
        const data = await vscode.workspace.fs.readFile(src);
        let text = this.decoder.decode(data);

        if (transform) {
            text = transform(text);
        }

        // Ensure parent directory exists
        const parentDir = vscode.Uri.file(path.dirname(dest.fsPath));
        await vscode.workspace.fs.createDirectory(parentDir);

        await vscode.workspace.fs.writeFile(dest, this.encoder.encode(text));
    }

    /**
     * Find files matching pattern
     */
    async findFiles(
        folder: vscode.WorkspaceFolder,
        pattern: string,
        exclude?: string,
        maxResults?: number,
    ): Promise<vscode.Uri[]> {
        const relativePattern = new vscode.RelativePattern(folder, pattern);
        return await vscode.workspace.findFiles(
            relativePattern,
            exclude || '**/node_modules/**',
            maxResults,
        );
    }

    /**
     * Suggest file path based on project structure
     */
    async suggestFilePath(
        folder: vscode.WorkspaceFolder,
        fileName: string,
        preferredDirs: string[],
    ): Promise<string> {
        for (const dir of preferredDirs) {
            const matches = await this.findFiles(folder, `${dir}/**/*.*`, undefined, 1);
            if (matches.length > 0) {
                return path.join(dir, fileName);
            }
        }
        return fileName;
    }
}
