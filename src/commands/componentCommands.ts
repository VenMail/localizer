import * as vscode from 'vscode';
import * as path from 'path';
import { FileSystemService } from '../services/fileSystemService';
import { pickWorkspaceFolder, workspaceLooksTypeScript } from '../core/workspace';
import { ensureReactI18nRuntime } from '../core/reactRuntime';
import { detectFrameworkProfile } from '../frameworks/detection';

/**
 * Commands for managing i18n components
 */
export class ComponentCommands {
    constructor(
        private context: vscode.ExtensionContext,
        private fileSystemService: FileSystemService,
    ) {}

    async openRootApp(): Promise<void> {
        const active = vscode.window.activeTextEditor;
        let folder = active
            ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
            : undefined;
        
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }

        if (!folder) {
            vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
            return;
        }

        const profile = await detectFrameworkProfile(folder);
        const patterns = profile?.entryPatterns || [
            'resources/js/app.tsx',
            'resources/js/app.jsx',
            'src/main.tsx',
            'src/main.jsx',
            'src/index.tsx',
            'src/index.jsx',
        ];

        const found: vscode.Uri[] = [];
        for (const rel of patterns) {
            const matches = await this.fileSystemService.findFiles(folder, rel, undefined, 1);
            if (matches.length > 0) {
                found.push(matches[0]);
            }
        }

        if (found.length === 0) {
            vscode.window.showInformationMessage(
                'AI i18n: Could not find an entry file in this workspace.',
            );
            return;
        }

        let target = found[0];
        if (found.length > 1) {
            const ws = folder as vscode.WorkspaceFolder;
            const items = found.map((uri) => ({
                label: path.relative(ws.uri.fsPath, uri.fsPath),
                uri,
            }));
            const selection = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select the root entry file to open',
            });
            if (!selection) {
                return;
            }
            target = selection.uri;
        }

        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    async copyLanguageSwitcher(): Promise<void> {
        const active = vscode.window.activeTextEditor;
        let folder = active
            ? vscode.workspace.getWorkspaceFolder(active.document.uri) ?? undefined
            : undefined;
        
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }

        if (!folder) {
            vscode.window.showInformationMessage('AI i18n: No workspace folder available.');
            return;
        }

        const looksTs = await workspaceLooksTypeScript(folder);
        const ext = looksTs ? 'tsx' : 'jsx';
        
        const suggested = await this.fileSystemService.suggestFilePath(
            folder,
            `LanguageSwitcher.${ext}`,
            ['resources/js/components', 'src/components'],
        );

        const input = await vscode.window.showInputBox({
            value: suggested,
            prompt: 'Enter relative path for the LanguageSwitcher component',
        });

        if (!input) {
            return;
        }

        const relativePath = input.replace(/^[\\/]+/, '');
        const targetUri = vscode.Uri.file(path.join(folder.uri.fsPath, relativePath));
        
        const exists = await this.fileSystemService.fileExists(targetUri);
        if (exists) {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: 'Overwrite', description: `Replace existing ${relativePath}` },
                    { label: 'Cancel', description: 'Keep existing file' },
                ],
                { placeHolder: `File ${relativePath} already exists` },
            );
            if (!choice || choice.label !== 'Overwrite') {
                return;
            }
        }

        const useTsx = relativePath.toLowerCase().endsWith('.tsx') || (!relativePath.toLowerCase().endsWith('.jsx') && looksTs);
        const templateFileName = useTsx ? 'LanguageSwitcher.tsx' : 'LanguageSwitcher.jsx';
        
        const src = vscode.Uri.joinPath(
            this.context.extensionUri,
            'src',
            'i18n',
            'components',
            'react',
            templateFileName,
        );

        await this.fileSystemService.copyFileWithTransform(src, targetUri, (text) => {
            // Replace import paths
            return text
                .replace(/'@\/i18n'/g, "'../i18n'")
                .replace(/"@\/i18n"/g, '"../i18n"')
                .replace(/'@\/hooks\/useTranslation'/g, "'../hooks/useTranslation'")
                .replace(/"@\/hooks\/useTranslation"/g, '"../hooks/useTranslation"');
        });

        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc, { preview: false });

        // Ensure runtime files and hook are present (preserves original behavior)
        await ensureReactI18nRuntime(this.context, folder, relativePath);

        vscode.window.showInformationMessage(
            `AI i18n: LanguageSwitcher component created at ${relativePath}.`,
        );
    }
}
