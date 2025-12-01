import * as vscode from 'vscode';
import * as path from 'path';
import { getProjectEnv } from './projectEnv';

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
    const env = await getProjectEnv(folder);
    const looksTs = env.isTypeScript;
    const runtimeFileName = looksTs ? 'index.tsx' : 'index.jsx';
    const hookFileName = looksTs ? 'useTranslation.tsx' : 'useTranslation.jsx';

    const runtimeRel = `${env.runtimeRoot}/${runtimeFileName}`;
    const hooksBase = env.composablesRoot || env.runtimeRoot.replace(/\/i18n$/, '/hooks');
    const hookRel = `${hooksBase}/${hookFileName}`;

    const runtimeUri = vscode.Uri.file(path.join(folder.uri.fsPath, runtimeRel));
    const hookUri = vscode.Uri.file(path.join(folder.uri.fsPath, hookRel));

    const runtimeExists = await fileExists(runtimeUri);
    const hookExists = await fileExists(hookUri);

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
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(hookUri.fsPath)));
            await vscode.workspace.fs.writeFile(hookUri, data);
        } catch (err) {
            console.error('Failed to copy useTranslation hook:', err);
        }
    }
}
