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

export async function ensureVueI18nRuntime(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    switcherRelativePath: string,
): Promise<void> {
    const env = await getProjectEnv(folder);
    const looksTs = env.isTypeScript;
    const runtimeFileName = looksTs ? 'index.ts' : 'index.js';
    const composableFileName = looksTs ? 'useTranslation.ts' : 'useTranslation.js';

    const runtimeRel = `${env.runtimeRoot}/${runtimeFileName}`;
    const composablesBase = env.composablesRoot || env.runtimeRoot.replace(/\/i18n$/, '/composables');
    const compRel = `${composablesBase}/${composableFileName}`;

    const runtimeUri = vscode.Uri.file(path.join(folder.uri.fsPath, runtimeRel));
    const compUri = vscode.Uri.file(path.join(folder.uri.fsPath, compRel));

    const runtimeExists = await fileExists(runtimeUri);
    const compExists = await fileExists(compUri);

    if (!runtimeExists) {
        const srcRuntime = vscode.Uri.joinPath(
            context.extensionUri,
            'src',
            'i18n',
            'runtime',
            'vue',
            looksTs ? 'i18n.ts' : 'i18n.js',
        );
        try {
            const data = await vscode.workspace.fs.readFile(srcRuntime);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(runtimeUri.fsPath)));
            await vscode.workspace.fs.writeFile(runtimeUri, data);
        } catch (err) {
            console.error('Failed to copy Vue i18n runtime:', err);
        }
    }

    if (!compExists) {
        const srcComp = vscode.Uri.joinPath(
            context.extensionUri,
            'src',
            'i18n',
            'runtime',
            'vue',
            looksTs ? 'useTranslation.ts' : 'useTranslation.js',
        );
        try {
            const data = await vscode.workspace.fs.readFile(srcComp);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(compUri.fsPath)));
            await vscode.workspace.fs.writeFile(compUri, data);
        } catch (err) {
            console.error('Failed to copy Vue useTranslation composable:', err);
        }
    }
}
