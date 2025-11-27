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

export async function ensureVueI18nRuntime(
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
    const runtimeFileName = looksTs ? 'index.ts' : 'index.js';
    const composableFileName = looksTs ? 'useTranslation.ts' : 'useTranslation.js';

    const runtimeRel = baseRoot ? `${baseRoot}/i18n/${runtimeFileName}` : `i18n/${runtimeFileName}`;
    const compRel = baseRoot ? `${baseRoot}/composables/${composableFileName}` : `composables/${composableFileName}`;

    const runtimeUri = vscode.Uri.file(path.join(folder.uri.fsPath, runtimeRel));
    const compUri = vscode.Uri.file(path.join(folder.uri.fsPath, compRel));

    const runtimeExists = await fileExists(runtimeUri);
    const compExists = await fileExists(compUri);

    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();

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
            let text = decoder.decode(data);
            const runtimeImportPath = baseRoot ? '../i18n' : '../i18n';
            text = text.replace("'../i18n'", `'${runtimeImportPath}'`).replace('"../i18n"', `"${runtimeImportPath}"`);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(compUri.fsPath)));
            await vscode.workspace.fs.writeFile(compUri, encoder.encode(text));
        } catch (err) {
            console.error('Failed to copy Vue useTranslation composable:', err);
        }
    }
}
