import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { workspaceLooksTypeScript } from './workspace';

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

export async function ensureReactI18nRuntime(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    switcherRelativePath: string,
): Promise<void> {
    const normalized = switcherRelativePath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length < 2) {
        return;
    }
    const baseParts = parts.slice(0, parts.length - 2);
    const baseRoot = baseParts.join('/');

    const looksTs = await workspaceLooksTypeScript(folder);
    const runtimeFileName = looksTs ? 'index.tsx' : 'index.jsx';
    const hookFileName = looksTs ? 'useTranslation.tsx' : 'useTranslation.jsx';

    const runtimeRel = baseRoot ? `${baseRoot}/i18n/${runtimeFileName}` : `i18n/${runtimeFileName}`;
    const hookRel = baseRoot ? `${baseRoot}/hooks/${hookFileName}` : `hooks/${hookFileName}`;

    const runtimeUri = vscode.Uri.file(path.join(folder.uri.fsPath, runtimeRel));
    const hookUri = vscode.Uri.file(path.join(folder.uri.fsPath, hookRel));

    const runtimeExists = await fileExists(runtimeUri);
    const hookExists = await fileExists(hookUri);

    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();

    if (!runtimeExists) {
        const srcRuntime = vscode.Uri.joinPath(
            context.extensionUri,
            'src',
            'i18n',
            'runtime',
            'react',
            looksTs ? 'i18n.tsx' : 'i18n.jsx',
        );
        try {
            const data = await vscode.workspace.fs.readFile(srcRuntime);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(runtimeUri.fsPath)));
            await vscode.workspace.fs.writeFile(runtimeUri, data);
        } catch (err) {
            console.error('Failed to copy React i18n runtime:', err);
        }
    }

    if (!hookExists) {
        const srcHook = vscode.Uri.joinPath(
            context.extensionUri,
            'src',
            'i18n',
            'runtime',
            'react',
            looksTs ? 'useTranslation.tsx' : 'useTranslation.jsx',
        );
        try {
            const data = await vscode.workspace.fs.readFile(srcHook);
            let text = decoder.decode(data);
            const runtimeImportPath = baseRoot ? '../i18n' : '../i18n';
            text = text.replace("'../i18n'", `'${runtimeImportPath}'`).replace('"../i18n"', `"${runtimeImportPath}"`);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(hookUri.fsPath)));
            await vscode.workspace.fs.writeFile(hookUri, encoder.encode(text));
        } catch (err) {
            console.error('Failed to copy useTranslation hook:', err);
        }
    }
}
