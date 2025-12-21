import * as vscode from 'vscode';
import * as path from 'path';
import * as _crypto from 'crypto';
import { TextDecoder, TextEncoder } from 'util';
import { isPackageInstalled, installPackages } from '../core/workspace';

/**
 * Service for file system operations related to i18n
 */
export class FileSystemService {
    private decoder = new TextDecoder('utf-8');
    private encoder = new TextEncoder();

    // Babel-based dependencies for i18n scripts
    private static readonly BABEL_DEPS = [
        '@babel/parser',
        '@babel/traverse',
        '@babel/generator',
        '@babel/types',
    ];

    // oxc-based dependencies for i18n scripts
    private static readonly OXC_DEPS = ['oxc-parser', 'magic-string'];

    /**
     * Calculate checksum for a file
     */
    async getFileChecksum(uri: vscode.Uri): Promise<string | null> {
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const hash = _crypto.createHash('sha256').update(data).digest('hex');
            return hash;
        } catch {
            return null;
        }
    }

    /**
     * Get checksum for extension's bundled script
     */
    async getBundledScriptChecksum(context: vscode.ExtensionContext, scriptName: string): Promise<string | null> {
        try {
            const scriptUri = vscode.Uri.joinPath(context.extensionUri, 'src', 'i18n', scriptName);
            return await this.getFileChecksum(scriptUri);
        } catch {
            return null;
        }
    }

    /**
     * Get current extension version from package.json
     */
    getCurrentExtensionVersion(_context: vscode.ExtensionContext): string {
        try {
            const packageJson = require('../../package.json');
            return packageJson.version || '0.1.8';
        } catch {
            return '0.1.8';
        }
    }

    /**
     * Get version from project script file (reads version comment)
     */
    async getProjectScriptVersion(projectRoot: string, scriptName: string): Promise<string> {
        try {
            const scriptUri = vscode.Uri.file(path.join(projectRoot, 'scripts', scriptName));
            const data = await vscode.workspace.fs.readFile(scriptUri);
            const content = this.decoder.decode(data);
            
            // Look for version comment in format: // Version: x.x.x or /* Version: x.x.x */
            const versionMatch = content.match(/\/\/\s*Version:\s*([0-9]+\.[0-9]+\.[0-9]+)/i) ||
                               content.match(/\/\*\s*Version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*\*\//i);
            
            if (versionMatch) {
                return versionMatch[1];
            }
            
            // If no version found, treat as 0.1.7 (legacy scripts)
            return '0.1.7';
        } catch {
            // If script doesn't exist or can't be read, treat as 0.1.7
            return '0.1.7';
        }
    }

    /**
     * Compare project script version with current extension version
     */
    async isScriptOutdated(
        context: vscode.ExtensionContext, 
        projectRoot: string, 
        scriptName: string
    ): Promise<boolean> {
        const currentVersion = this.getCurrentExtensionVersion(context);
        const projectVersion = await this.getProjectScriptVersion(projectRoot, scriptName);
        
        // If project script doesn't exist, it's "outdated" (needs to be created)
        try {
            const scriptUri = vscode.Uri.file(path.join(projectRoot, 'scripts', scriptName));
            await vscode.workspace.fs.stat(scriptUri);
        } catch {
            return true;
        }
        
        // Compare versions - if project version is less than current, it's outdated
        return this.compareVersions(projectVersion, currentVersion) < 0;
    }

    /**
     * Get all outdated scripts in a project
     */
    async getOutdatedScripts(context: vscode.ExtensionContext, projectRoot: string): Promise<string[]> {
        const outdatedScripts: string[] = [];
        
        // Define all scripts that should be checked
        const scriptsToCheck = [
            'extract-i18n.js',
            'replace-i18n.js', 
            'sync-i18n.js',
            'fix-untranslated.js',
            'rewrite-i18n-blade.js',
            'cleanup-i18n-unused.js',
            'restore-i18n-invalid.js',
            'babel-extract-i18n.js',
            'babel-replace-i18n.js',
            'oxc-extract-i18n.js',
            'oxc-replace-i18n.js',
            'fix-i18n-parens-in-code.js',
            'cleanup-i18n-unused.js',
            'restore-i18n-invalid.js',
            'rewrite-i18n-blade.js'
        ];
        
        for (const scriptName of scriptsToCheck) {
            const isOutdated = await this.isScriptOutdated(context, projectRoot, scriptName);
            if (isOutdated) {
                outdatedScripts.push(scriptName);
            }
        }
        
        return outdatedScripts;
    }

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
            console.error('AI Localizer: Failed to create scripts directory:', err);
            throw new Error('Failed to create scripts directory');
        }

        // Create scripts/package.json with "type": "commonjs" to ensure CJS compatibility
        // This makes scripts work regardless of whether the project uses ESM or CJS
        await this.createScriptsPackageJson(targetDir);

        // Detect project Node version to decide whether we can safely use oxc-based scripts
        const detectedNodeVersion = await this.detectProjectNodeVersion(projectRoot);
        const useOxc = detectedNodeVersion ? this.supportsOxc(detectedNodeVersion) : false;

        // Unified extract script plus stack-specific rewrite/utility scripts
        const scriptNames = [
            'extract-i18n.js',
            useOxc ? 'oxc-replace-i18n.js' : 'babel-replace-i18n.js',
            'sync-i18n.js',
            'fix-untranslated.js',
            'rewrite-i18n-blade.js',
            'cleanup-i18n-unused.js',
            'restore-i18n-invalid.js',
        ];

        // Map internal script names to standard names in target project
        const scriptNameMap: Record<string, string> = {
            'extract-i18n.js': 'extract-i18n.js',
            'oxc-replace-i18n.js': 'replace-i18n.js',
            'babel-replace-i18n.js': 'replace-i18n.js',
        };

        const currentVersion = this.getCurrentExtensionVersion(context);

        for (const name of scriptNames) {
            const src = vscode.Uri.joinPath(context.extensionUri, 'src', 'i18n', name);
            // Use mapped name if available (internal scripts -> standard names)
            const destName = scriptNameMap[name] || name;
            const dest = vscode.Uri.joinPath(targetDir, destName);
            
            try {
                const data = await vscode.workspace.fs.readFile(src);
                let content = this.decoder.decode(data);
                
                // Add version comment at the top of the script if not already present
                if (!content.match(/\/\/\s*Version:/i) && !content.match(/\/\*\s*Version:/i)) {
                    const versionComment = `// Version: ${currentVersion}\n`;
                    content = versionComment + content;
                } else {
                    // Update existing version comment
                    content = content.replace(/\/\/\s*Version:\s*[0-9]+\.[0-9]+\.[0-9]+/i, `// Version: ${currentVersion}`);
                    content = content.replace(/\/\*\s*Version:\s*[0-9]+\.[0-9]+\.[0-9]+\s*\*\//i, `/* Version: ${currentVersion} */`);
                }
                
                await vscode.workspace.fs.writeFile(dest, this.encoder.encode(content));
            } catch (err) {
                console.error(`AI Localizer: Failed to copy i18n script ${name}:`, err);
                vscode.window.showWarningMessage(
                    `AI Localizer: Failed to copy script ${destName}. You may need to copy it manually.`,
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
            console.error('AI Localizer: Failed to copy i18n-ignore-patterns.json:', err);
            vscode.window.showWarningMessage(
                'AI Localizer: Failed to copy ignore patterns file. You may need to copy it manually.',
            );
        }

        // Copy lib folder with shared utilities
        const libDir = vscode.Uri.joinPath(targetDir, 'lib');
        try {
            await vscode.workspace.fs.createDirectory(libDir);
        } catch (err) {
            console.error('AI Localizer: Failed to create lib directory:', err);
        }

        const libFiles = [
            'projectConfig.js',
            'stringUtils.js',
            'ignorePatterns.js',
            'translationStore.js',
            'textValidation.js',
            'vueTemplateParser.js',
            'localeUtils.js',
        ];

        for (const name of libFiles) {
            const src = vscode.Uri.joinPath(context.extensionUri, 'src', 'i18n', 'lib', name);
            const dest = vscode.Uri.joinPath(libDir, name);
            
            try {
                const data = await vscode.workspace.fs.readFile(src);
                await vscode.workspace.fs.writeFile(dest, data);
            } catch (err) {
                console.error(`AI Localizer: Failed to copy lib file ${name}:`, err);
                vscode.window.showWarningMessage(
                    `AI Localizer: Failed to copy lib utility ${name}. You may need to copy it manually.`,
                );
            }
        }

        // Copy parser and validator helpers used by extract-i18n.js
        const parserFiles = [
            'index.js',
            'baseParser.js',
            'jsxParser.js',
            'vueParser.js',
            'bladeParser.js',
            'svelteParser.js',
            'genericParser.js',
        ];

        const validatorsFiles = [
            'index.js',
            'cssValidator.js',
            'codeValidator.js',
            'htmlValidator.js',
            'technicalValidator.js',
        ];

        const parsersDir = vscode.Uri.joinPath(libDir, 'parsers');
        const validatorsDir = vscode.Uri.joinPath(libDir, 'validators');

        try {
            await vscode.workspace.fs.createDirectory(parsersDir);
        } catch {
            // ignore
        }

        try {
            await vscode.workspace.fs.createDirectory(validatorsDir);
        } catch {
            // ignore
        }

        for (const name of parserFiles) {
            const src = vscode.Uri.joinPath(context.extensionUri, 'src', 'i18n', 'lib', 'parsers', name);
            const dest = vscode.Uri.joinPath(parsersDir, name);

            try {
                const data = await vscode.workspace.fs.readFile(src);
                await vscode.workspace.fs.writeFile(dest, data);
            } catch (err) {
                console.error(`AI Localizer: Failed to copy parser file ${name}:`, err);
                vscode.window.showWarningMessage(
                    `AI Localizer: Failed to copy parser utility ${name}. You may need to copy it manually.`,
                );
            }
        }

        for (const name of validatorsFiles) {
            const src = vscode.Uri.joinPath(context.extensionUri, 'src', 'i18n', 'lib', 'validators', name);
            const dest = vscode.Uri.joinPath(validatorsDir, name);

            try {
                const data = await vscode.workspace.fs.readFile(src);
                await vscode.workspace.fs.writeFile(dest, data);
            } catch (err) {
                console.error(`AI Localizer: Failed to copy validator file ${name}:`, err);
                vscode.window.showWarningMessage(
                    `AI Localizer: Failed to copy validator utility ${name}. You may need to copy it manually.`,
                );
            }
        }

        // Install required dependencies based on the selected script stack
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot));
        if (folder) {
            const deps = useOxc ? FileSystemService.OXC_DEPS : FileSystemService.BABEL_DEPS;
            await this.ensureRequiredDependencies(folder, deps);
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
            console.error('AI Localizer: Failed to create scripts/package.json:', err);
        }
    }

    /**
     * Ensure required dependencies are installed in the project
     */
    async ensureRequiredDependencies(folder: vscode.WorkspaceFolder, deps: string[]): Promise<void> {
        const missingDeps: string[] = [];

        for (const dep of deps) {
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
                'AI Localizer: Installing dependencies. Please wait for the installation to complete before running scripts.',
            );
        } else {
            vscode.window.showWarningMessage(
                `AI Localizer: Scripts may not work without ${missingDeps.join(', ')}. You can install them manually.`,
            );
        }
    }

    private async detectProjectNodeVersion(projectRoot: string): Promise<string | null> {
        // Prefer explicit version files in the project root
        const versionFiles = ['.nvmrc', '.node-version'];
        for (const fileName of versionFiles) {
            const uri = vscode.Uri.file(path.join(projectRoot, fileName));
            try {
                const data = await vscode.workspace.fs.readFile(uri);
                const raw = this.decoder.decode(data).trim();
                const version = this.normalizeVersion(raw);
                if (version) {
                    return version;
                }
            } catch {
                // ignore missing/unreadable file
            }
        }

        // Fallback: derive a minimum version from package.json engines.node
        const pkgUri = vscode.Uri.file(path.join(projectRoot, 'package.json'));
        try {
            const data = await vscode.workspace.fs.readFile(pkgUri);
            const text = this.decoder.decode(data);
            const pkg = JSON.parse(text);
            const engines = pkg && typeof pkg === 'object' ? pkg.engines : undefined;
            const nodeSpec = engines && typeof engines.node === 'string' ? engines.node : null;
            if (nodeSpec) {
                const version = this.normalizeVersion(nodeSpec);
                if (version) {
                    return version;
                }
            }
        } catch {
            // ignore invalid/missing package.json
        }

        // Final fallback: use the actual running Node.js version
        const runtimeVersion = this.normalizeVersion(process.version);
        if (runtimeVersion) {
            return runtimeVersion;
        }

        return null;
    }

    private normalizeVersion(source: string): string | null {
        const match = String(source || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
        if (!match) {
            return null;
        }
        const major = parseInt(match[1], 10);
        const minor = match[2] !== undefined ? parseInt(match[2], 10) : 0;
        const patch = match[3] !== undefined ? parseInt(match[3], 10) : 0;
        if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
            return null;
        }
        return `${major}.${minor}.${patch}`;
    }

    private compareVersions(a: string, b: string): number {
        const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
        const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
        for (let i = 0; i < 3; i += 1) {
            if (pa[i] < pb[i]) return -1;
            if (pa[i] > pb[i]) return 1;
        }
        return 0;
    }

    private supportsOxc(nodeVersion: string): boolean {
        // Match oxc-parser engines: ^20.15.0 || >=22.12.0
        const atLeast20_19 =
            this.compareVersions(nodeVersion, '20.15.0') >= 0 &&
            this.compareVersions(nodeVersion, '21.0.0') < 0;
        const atLeast22_12 = this.compareVersions(nodeVersion, '22.12.0') >= 0;
        return atLeast20_19 || atLeast22_12;
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

    async suggestFilePaths(
        folder: vscode.WorkspaceFolder,
        fileName: string,
        preferredDirs: string[],
        maxSuggestions: number = 3,
    ): Promise<string[]> {
        const suggestions: string[] = [];
        for (const dir of preferredDirs) {
            const matches = await this.findFiles(folder, `${dir}/**/*.*`, undefined, 1);
            if (matches.length > 0) {
                suggestions.push(path.join(dir, fileName));
                if (suggestions.length >= maxSuggestions) {
                    break;
                }
            }
        }
        if (!suggestions.length) {
            suggestions.push(fileName);
        }
        return suggestions;
    }
}
