import * as vscode from 'vscode';
import * as path from 'path';

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

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

async function detectPackageManager(folder: vscode.WorkspaceFolder): Promise<PackageManager> {
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

export async function runI18nScript(scriptName: string): Promise<void> {
    const active = vscode.window.activeTextEditor;
    let folder = active ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined : undefined;
    if (!folder) {
        folder = await pickWorkspaceFolder();
    }
    if (!folder) {
        vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
        return;
    }

    const pm = await detectPackageManager(folder);
    let command: string;
    switch (pm) {
        case 'yarn':
            command = `yarn ${scriptName}`;
            break;
        case 'pnpm':
            command = `pnpm run ${scriptName}`;
            break;
        case 'bun':
            command = `bun run ${scriptName}`;
            break;
        case 'npm':
        default:
            command = `npm run ${scriptName}`;
            break;
    }

    const terminalName = `AI i18n (${folder.name})`;
    let terminal = vscode.window.terminals.find((t) => t.name === terminalName);
    if (!terminal) {
        terminal = vscode.window.createTerminal({ name: terminalName, cwd: folder.uri.fsPath });
    }
    terminal.show(true);
    terminal.sendText(command);
}
