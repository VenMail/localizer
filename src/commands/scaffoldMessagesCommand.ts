import * as vscode from 'vscode';
import * as path from 'path';
import { TextEncoder } from 'util';
import { pickWorkspaceFolder } from '../core/workspace';
import { getProjectEnv } from '../core/projectEnv';

export class ScaffoldMessagesCommand {
    constructor(private context: vscode.ExtensionContext) {}

    private async fileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    private buildTypeScriptSource(): string {
        const lines: string[] = [];
        lines.push("type Messages = Record<string, string>;");
        lines.push("type MessagesByLocale = Record<string, Messages>;");
        lines.push("");
        lines.push("const modules = import.meta.glob('./auto/**/*.json', {");
        lines.push("  query: '?raw',");
        lines.push("  import: 'default',");
        lines.push("  eager: true,");
        lines.push("});");
        lines.push("");
        lines.push("export const messagesByLocale: MessagesByLocale = {};");
        lines.push("");
        lines.push("for (const [filePath, raw] of Object.entries(modules)) {");
        lines.push("  if (typeof raw !== 'string') continue;");
        lines.push("  try {");
        lines.push("    const data = JSON.parse(raw) as Record<string, string>;");
        lines.push("    const parts = filePath.split('/');");
        lines.push("    const idx = parts.lastIndexOf('auto');");
        lines.push("    const segment = idx >= 0 && idx + 1 < parts.length ? parts[idx + 1] : parts[parts.length - 1];");
        lines.push("    const locale = segment.replace(/\\.json$/i, '') || 'en';");
        lines.push("    const existing = messagesByLocale[locale] || {};");
        lines.push("    messagesByLocale[locale] = { ...existing, ...data };");
        lines.push("  } catch {");
        lines.push("  }");
        lines.push("}");
        lines.push("");
        lines.push("export function getMessagesByLocale(): MessagesByLocale {");
        lines.push("  return messagesByLocale;");
        lines.push("}");
        lines.push("");
        return lines.join('\n') + '\n';
    }

    private buildJavaScriptSource(): string {
        const lines: string[] = [];
        lines.push("const modules = import.meta.glob('./auto/**/*.json', {");
        lines.push("  query: '?raw',");
        lines.push("  import: 'default',");
        lines.push("  eager: true,");
        lines.push("});");
        lines.push("");
        lines.push("export const messagesByLocale = {};");
        lines.push("");
        lines.push("for (const [filePath, raw] of Object.entries(modules)) {");
        lines.push("  if (typeof raw !== 'string') continue;");
        lines.push("  try {");
        lines.push("    const data = JSON.parse(raw);");
        lines.push("    const parts = filePath.split('/');");
        lines.push("    const idx = parts.lastIndexOf('auto');");
        lines.push("    const segment = idx >= 0 && idx + 1 < parts.length ? parts[idx + 1] : parts[parts.length - 1];");
        lines.push("    const locale = segment.replace(/\\.json$/i, '') || 'en';");
        lines.push("    const existing = messagesByLocale[locale] || {};");
        lines.push("    messagesByLocale[locale] = { ...existing, ...data };");
        lines.push("  } catch {");
        lines.push("  }");
        lines.push("}");
        lines.push("");
        lines.push("export function getMessagesByLocale() {");
        lines.push("  return messagesByLocale;");
        lines.push("}");
        lines.push("");
        return lines.join('\n') + '\n';
    }

    async execute(): Promise<void> {
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

        let env;
        try {
            env = await getProjectEnv(folder);
        } catch (err) {
            vscode.window.showErrorMessage('AI Localizer: Failed to detect project environment.');
            return;
        }

        if (env.bundler !== 'vite') {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: 'Continue', description: 'Generate Vite-style messages loader anyway' },
                    { label: 'Cancel', description: 'Do not generate loader' },
                ],
                { placeHolder: 'Vite was not detected in this project. Generate a Vite-style messages loader?' },
            );
            if (!choice || choice.label !== 'Continue') {
                return;
            }
        }

        const runtimeRootAbs = path.join(folder.uri.fsPath, env.runtimeRoot);
        const fileName = env.isTypeScript ? 'messages.ts' : 'messages.js';
        const targetUri = vscode.Uri.file(path.join(runtimeRootAbs, fileName));

        const exists = await this.fileExists(targetUri);
        if (exists) {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: 'Overwrite', description: `Replace existing ${env.runtimeRoot}/${fileName}` },
                    { label: 'Cancel', description: 'Keep existing file' },
                ],
                { placeHolder: `File ${env.runtimeRoot}/${fileName} already exists` },
            );
            if (!choice || choice.label !== 'Overwrite') {
                return;
            }
        }

        const encoder = new TextEncoder();
        const source = env.isTypeScript
            ? this.buildTypeScriptSource()
            : this.buildJavaScriptSource();

        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(runtimeRootAbs));
            await vscode.workspace.fs.writeFile(targetUri, encoder.encode(source));
            vscode.window.showInformationMessage(
                `AI Localizer: Vite messages loader created at ${env.runtimeRoot}/${fileName}.`,
            );
        } catch (err) {
            vscode.window.showErrorMessage('AI Localizer: Failed to write messages loader file.');
        }
    }
}
