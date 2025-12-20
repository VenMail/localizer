import * as vscode from 'vscode';
import * as path from 'path';
import { FileSystemService } from '../services/fileSystemService';
import { pickWorkspaceFolder, workspaceLooksTypeScript } from '../core/workspace';
import { ensureReactI18nRuntime } from '../core/reactRuntime';
import { ensureVueI18nRuntime } from '../core/vueRuntime';
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
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
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
                'AI Localizer: Could not find an entry file in this workspace.',
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
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        const looksTs = await workspaceLooksTypeScript(folder);
        const profile = await detectFrameworkProfile(folder);

        let isVue = profile?.kind === 'vue' || profile?.kind === 'nuxt';

        if (profile?.kind === 'laravel') {
            const pick = await vscode.window.showQuickPick(
                [
                    { label: 'React', description: 'Inertia React or React SPA' },
                    { label: 'Vue', description: 'Inertia Vue or Vue SPA' },
                ],
                { placeHolder: 'Laravel detected. Generate a React or Vue LanguageSwitcher?' },
            );
            if (!pick) return;
            isVue = pick.label === 'Vue';
        }

        const targetFileName = isVue ? 'LanguageSwitcher.vue' : `LanguageSwitcher.${looksTs ? 'tsx' : 'jsx'}`;
        const preferredDirs = isVue && profile?.kind === 'nuxt'
            ? ['components', 'src/components']
            : ['resources/js/components', 'src/components'];
        const suggestions = await this.fileSystemService.suggestFilePaths(
            folder,
            targetFileName,
            preferredDirs,
            3,
        );

        let relativePathInput: string | undefined;

        if (suggestions.length === 1) {
            const input = await vscode.window.showInputBox({
                value: suggestions[0],
                prompt: 'Enter relative path for the LanguageSwitcher component',
            });
            if (!input) {
                return;
            }
            relativePathInput = input;
        } else {
            const items = suggestions.map((p) => ({
                label: p,
                description: 'Suggested location',
                value: p,
            } as vscode.QuickPickItem & { value: string }));
            items.push({
                label: 'Custom location...',
                description: 'Enter a custom component path',
                value: '',
            } as vscode.QuickPickItem & { value: string });

            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select target path for the LanguageSwitcher component',
            });
            if (!pick) {
                return;
            }
            if ((pick as any).value) {
                relativePathInput = (pick as any).value as string;
            } else {
                const input = await vscode.window.showInputBox({
                    value: suggestions[0],
                    prompt: 'Enter relative path for the LanguageSwitcher component',
                });
                if (!input) {
                    return;
                }
                relativePathInput = input;
            }
        }

        const relativePath = relativePathInput.replace(/^[\\/]+/, '');
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

        if (isVue) {
            const templateFileName = 'LanguageSwitcher.vue.txt';
            const src = vscode.Uri.joinPath(
                this.context.extensionUri,
                'src',
                'i18n',
                'components',
                'vue',
                templateFileName,
            );
            await this.fileSystemService.copyFileWithTransform(src, targetUri, (text) => {
                const wsRoot = folder!.uri.fsPath;
                const compDirAbs = path.dirname(targetUri.fsPath);
                // Determine base root for Vue projects
                let vueBaseRoot: string;
                if (profile?.kind === 'laravel') {
                    vueBaseRoot = path.join(wsRoot, 'resources', 'js');
                } else if (profile?.kind === 'nuxt') {
                    // Nuxt composables are typically at project root
                    vueBaseRoot = wsRoot;
                } else {
                    vueBaseRoot = path.join(wsRoot, (profile?.rootDir || 'src'));
                }
                const relI18n = path.relative(compDirAbs, path.join(vueBaseRoot, 'i18n')).replace(/\\/g, '/');
                const relComposable = path.relative(compDirAbs, path.join(vueBaseRoot, 'composables', 'useTranslation')).replace(/\\/g, '/');
                return text
                    .replace(/'@\/i18n'/g, `'${relI18n}'`)
                    .replace(/"@\/i18n"/g, `"${relI18n}"`)
                    .replace(/'@\/composables\/useTranslation'/g, `'${relComposable}'`)
                    .replace(/"@\/composables\/useTranslation"/g, `"${relComposable}"`);
            });

            const doc = await vscode.workspace.openTextDocument(targetUri);
            await vscode.window.showTextDocument(doc, { preview: false });

            await ensureVueI18nRuntime(this.context, folder, relativePath);
        } else {
            const useTsx = relativePath.toLowerCase().endsWith('.tsx') || (!relativePath.toLowerCase().endsWith('.jsx') && looksTs);
            const templateFileName = useTsx ? 'LanguageSwitcher.tsx.txt' : 'LanguageSwitcher.jsx.txt';
            const src = vscode.Uri.joinPath(
                this.context.extensionUri,
                'src',
                'i18n',
                'components',
                'react',
                templateFileName,
            );
            await this.fileSystemService.copyFileWithTransform(src, targetUri, (text) => {
                const wsRoot = folder!.uri.fsPath;
                const compDirAbs = path.dirname(targetUri.fsPath);
                let reactBaseRoot: string;
                if (profile?.kind === 'react' && profile?.flavor === 'inertia-react') {
                    reactBaseRoot = path.join(wsRoot, 'resources', 'js');
                } else if (profile?.kind === 'laravel') {
                    // User chose React in a Laravel app
                    reactBaseRoot = path.join(wsRoot, 'resources', 'js');
                } else {
                    reactBaseRoot = path.join(wsRoot, (profile?.rootDir || 'src'));
                }
                const relI18n = path.relative(compDirAbs, path.join(reactBaseRoot, 'i18n')).replace(/\\/g, '/');
                const relHook = path.relative(compDirAbs, path.join(reactBaseRoot, 'hooks', 'useTranslation')).replace(/\\/g, '/');
                return text
                    .replace(/'@\/i18n'/g, `'${relI18n}'`)
                    .replace(/"@\/i18n"/g, `"${relI18n}"`)
                    .replace(/'@\/hooks\/useTranslation'/g, `'${relHook}'`)
                    .replace(/"@\/hooks\/useTranslation"/g, `"${relHook}"`);
            });

            const doc = await vscode.workspace.openTextDocument(targetUri);
            await vscode.window.showTextDocument(doc, { preview: false });

            await ensureReactI18nRuntime(this.context, folder, relativePath);
        }

        vscode.window.showInformationMessage(
            `AI Localizer: LanguageSwitcher component created at ${relativePath}.`,
        );
    }
}
