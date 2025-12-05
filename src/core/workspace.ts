import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { CommitTracker } from './commitTracker';

export async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    const items = folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        folder,
    }));
    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select workspace folder for AI i18n configuration',
    });
    return selection?.folder;
}

export async function findPackageJson(folder: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
    const pattern = new vscode.RelativePattern(folder, 'package.json');
    const matches = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 20);
    if (matches.length === 0) {
        return undefined;
    }
    if (matches.length === 1) {
        return matches[0];
    }
    const items = matches
        .sort((a, b) => a.fsPath.length - b.fsPath.length)
        .map((uri) => ({
            label: path.relative(folder.uri.fsPath, uri.fsPath) || 'package.json',
            description: uri.fsPath,
            uri,
        }));
    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select package.json to configure for AI i18n',
    });
    return selection?.uri;
}

async function hasWorkspaceFile(folder: vscode.WorkspaceFolder, relativePath: string): Promise<boolean> {
    const uri = vscode.Uri.joinPath(folder.uri, relativePath);
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

export async function workspaceLooksTypeScript(folder: vscode.WorkspaceFolder): Promise<boolean> {
    if (await hasWorkspaceFile(folder, 'tsconfig.json')) {
        return true;
    }
    try {
        const tsPattern = new vscode.RelativePattern(folder, '**/*.ts');
        const tsMatches = await vscode.workspace.findFiles(tsPattern, '**/node_modules/**', 1);
        if (tsMatches.length > 0) {
            return true;
        }
        const tsxPattern = new vscode.RelativePattern(folder, '**/*.tsx');
        const tsxMatches = await vscode.workspace.findFiles(tsxPattern, '**/node_modules/**', 1);
        return tsxMatches.length > 0;
    } catch {
        return false;
    }
}

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export async function detectPackageManager(folder: vscode.WorkspaceFolder): Promise<PackageManager> {
    if (await hasWorkspaceFile(folder, 'yarn.lock')) {
        return 'yarn';
    }
    if (await hasWorkspaceFile(folder, 'pnpm-lock.yaml')) {
        return 'pnpm';
    }
    if (await hasWorkspaceFile(folder, 'bun.lockb')) {
        return 'bun';
    }
    if (await hasWorkspaceFile(folder, 'package-lock.json')) {
        return 'npm';
    }
    return 'npm';
}

/**
 * Get the install command for a package manager
 */
export function getInstallCommand(pm: PackageManager, packages: string[], dev = true): string {
    const devFlag = dev ? '-D' : '';
    const pkgList = packages.join(' ');
    switch (pm) {
        case 'yarn':
            return `yarn add ${devFlag} ${pkgList}`.trim();
        case 'pnpm':
            return `pnpm add ${devFlag} ${pkgList}`.trim();
        case 'bun':
            return `bun add ${devFlag} ${pkgList}`.trim();
        case 'npm':
        default:
            return `npm install ${dev ? '--save-dev' : ''} ${pkgList}`.trim();
    }
}

/**
 * Check if a package is installed in the project
 */
export async function isPackageInstalled(
    folder: vscode.WorkspaceFolder,
    packageName: string,
): Promise<boolean> {
    const pkgJsonUri = await findPackageJson(folder);
    if (!pkgJsonUri) {
        return false;
    }
    try {
        const data = await vscode.workspace.fs.readFile(pkgJsonUri);
        const pkg = JSON.parse(new TextDecoder().decode(data));
        const deps = pkg.dependencies || {};
        const devDeps = pkg.devDependencies || {};
        return packageName in deps || packageName in devDeps;
    } catch {
        return false;
    }
}

/**
 * Detect if project uses ESM (has "type": "module" in package.json)
 */
export async function isProjectESM(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const pkgJsonUri = await findPackageJson(folder);
    if (!pkgJsonUri) {
        return false;
    }
    try {
        const data = await vscode.workspace.fs.readFile(pkgJsonUri);
        const pkg = JSON.parse(new TextDecoder().decode(data));
        return pkg.type === 'module';
    } catch {
        return false;
    }
}

/**
 * Install packages using the detected package manager
 * Returns true if installation was initiated successfully
 */
export async function installPackages(
    folder: vscode.WorkspaceFolder,
    packages: string[],
    dev = true,
): Promise<boolean> {
    const pm = await detectPackageManager(folder);
    const command = getInstallCommand(pm, packages, dev);

    const terminalName = `AI i18n Setup (${folder.name})`;
    let terminal = vscode.window.terminals.find((t) => t.name === terminalName);
    if (!terminal) {
        terminal = vscode.window.createTerminal({ name: terminalName, cwd: folder.uri.fsPath });
    }
    terminal.show(true);
    terminal.sendText(command);
    return true;
}

export interface RunI18nScriptOptions {
    folder?: vscode.WorkspaceFolder;
    extraArgs?: string[];
    context?: vscode.ExtensionContext;
}

let scriptsOutputChannel: vscode.OutputChannel | undefined;

function getScriptsOutputChannel(): vscode.OutputChannel {
    if (!scriptsOutputChannel) {
        scriptsOutputChannel = vscode.window.createOutputChannel('AI i18n Scripts');
    }
    return scriptsOutputChannel;
}

export async function runI18nScript(
    scriptName: string,
    options?: RunI18nScriptOptions,
): Promise<void> {
    let folder = options?.folder;

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
        vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
        return;
    }

    // Track commit ref before running extract/replace scripts
    const context = options?.context;
    if (context && (scriptName === 'i18n:extract' || scriptName === 'i18n:rewrite' || scriptName === 'i18n:replace')) {
        await CommitTracker.saveCommitRef(context, folder, scriptName);
    }

    const pm = await detectPackageManager(folder);
    const args = options?.extraArgs && options.extraArgs.length
        ? ` -- ${options.extraArgs.join(' ')}`
        : '';

    let command: string;
    switch (pm) {
        case 'yarn':
            command = `yarn ${scriptName}${args}`;
            break;
        case 'pnpm':
            command = `pnpm run ${scriptName}${args}`;
            break;
        case 'bun':
            command = `bun run ${scriptName}${args}`;
            break;
        case 'npm':
        default:
            command = `npm run ${scriptName}${args}`;
            break;
    }

    const output = getScriptsOutputChannel();
    output.show(true);
    output.appendLine(`> (${folder.name}) ${command}`);

    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, {
            cwd: folder!.uri.fsPath,
            shell: true,
        });

        if (child.stdout) {
            child.stdout.on('data', (data: Buffer) => {
                output.append(data.toString());
            });
        }

        if (child.stderr) {
            child.stderr.on('data', (data: Buffer) => {
                output.append(data.toString());
            });
        }

        child.on('error', (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            output.appendLine(`\n[ai-i18n] Failed to start script ${scriptName}: ${msg}`);
            reject(err);
        });

        child.on('close', (code) => {
            if (code === 0) {
                output.appendLine(`[ai-i18n] Script ${scriptName} completed successfully.`);
                resolve();
            } else {
                const message = `[ai-i18n] Script ${scriptName} exited with code ${code}.`;
                output.appendLine(message);
                vscode.window.showErrorMessage(`AI Localizer: ${message}`);
                reject(new Error(message));
            }
        });
    });
}
