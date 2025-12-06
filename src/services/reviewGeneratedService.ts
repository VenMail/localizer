import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex } from '../core/i18nIndex';
import { setTranslationValue } from '../core/i18nFs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class ReviewGeneratedService {
    constructor(
        private i18nIndex: I18nIndex,
        private log?: vscode.OutputChannel,
    ) {}

    /**
     * Refresh diagnostics for .i18n-review-generated.json to allow navigation.
     */
    async refreshDiagnostics(
        folder: vscode.WorkspaceFolder,
        collection: vscode.DiagnosticCollection,
    ): Promise<void> {
        const reviewUri = vscode.Uri.joinPath(folder.uri, 'scripts', '.i18n-review-generated.json');
        collection.clear();

        let content: string;
        try {
            const data = await vscode.workspace.fs.readFile(reviewUri);
            content = new TextDecoder().decode(data);
        } catch {
            return;
        }

        let parsed: { files?: Array<{ file: string; issues: Array<{ key: string; value?: string; generatedValue?: string }> }> } = {};
        try {
            parsed = JSON.parse(content);
        } catch (err) {
            const diag = new vscode.Diagnostic(
                new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
                `Invalid JSON: ${(err as Error).message}`,
                vscode.DiagnosticSeverity.Error,
            );
            collection.set(reviewUri, [diag]);
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];
        const files = Array.isArray(parsed.files) ? parsed.files : [];

        // Preload index
        await this.i18nIndex.ensureInitialized();

        for (const fileEntry of files) {
            if (!fileEntry || typeof fileEntry.file !== 'string' || !Array.isArray(fileEntry.issues)) continue;
            for (const issue of fileEntry.issues) {
                if (!issue || typeof issue.key !== 'string') continue;

                const pos = this.findPosition(content, issue.key);
                const range = pos
                    ? new vscode.Range(pos, pos.translate(0, issue.key.length))
                    : new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1));

                const record = this.i18nIndex.getRecord(issue.key);
                const defaultLocale = record?.defaultLocale || 'en';
                const targetUri = record?.locations?.find(l => l.locale === defaultLocale)?.uri;

                const val = issue.value ?? issue.generatedValue ?? '';
                const message = `Review: ${issue.key} → ${val}`;
                const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
                diag.source = 'AI Localizer (review)';

                if (targetUri) {
                    diag.relatedInformation = [
                        new vscode.DiagnosticRelatedInformation(
                            new vscode.Location(targetUri, new vscode.Position(0, 0)),
                            'Open target locale file',
                        ),
                    ];
                }

                diagnostics.push(diag);
            }
        }

        collection.set(reviewUri, diagnostics);
    }

    /**
     * Apply translations from the review file into the default locale.
     */
    async applyReviewFile(folder: vscode.WorkspaceFolder, document: vscode.TextDocument): Promise<void> {
        const reviewPath = path.join(folder.uri.fsPath, 'scripts', '.i18n-review-generated.json');
        if (document.uri.fsPath !== reviewPath) return;

        let parsed: { files?: Array<{ file: string; issues: Array<{ key: string; value?: string; generatedValue?: string }> }> } = {};
        try {
            parsed = JSON.parse(document.getText());
        } catch (err) {
            vscode.window.showWarningMessage(`AI Localizer: Review file is invalid JSON: ${(err as Error).message}`);
            return;
        }

        const files = Array.isArray(parsed.files) ? parsed.files : [];
        if (!files.length) return;

        await this.i18nIndex.ensureInitialized();
        const defaultLocale =
            vscode.workspace.getConfiguration('ai-localizer').get<string>('i18n.defaultLocale') || 'en';

        for (const fileEntry of files) {
            if (!fileEntry || !Array.isArray(fileEntry.issues)) continue;
            for (const issue of fileEntry.issues) {
                const val = issue?.value ?? issue?.generatedValue;
                if (!issue || typeof issue.key !== 'string' || typeof val !== 'string') continue;
                try {
                    await setTranslationValue(folder, defaultLocale, issue.key, val);
                } catch (err) {
                    this.log?.appendLine(`[ReviewGenerated] Failed to apply ${issue.key}: ${String(err)}`);
                }
            }
        }

        this.log?.appendLine('[ReviewGenerated] Applied review translations to default locale.');
        vscode.window.showInformationMessage('AI Localizer: Applied review translations to default locale.');
    }

    /**
     * Show git history for the locale file associated with the key under cursor.
     */
    async showGitHistoryForCursor(
        folder: vscode.WorkspaceFolder,
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<void> {
        const reviewPath = path.join(folder.uri.fsPath, 'scripts', '.i18n-review-generated.json');
        if (document.uri.fsPath !== reviewPath) return;

        const key = this.getKeyAtPosition(document, position);
        if (!key) {
            vscode.window.showInformationMessage('AI Localizer: No key found at cursor.');
            return;
        }

        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(key);
        const defaultLocale = record?.defaultLocale || 'en';
        const targetUri = record?.locations?.find(l => l.locale === defaultLocale)?.uri;
        if (!targetUri) {
            vscode.window.showInformationMessage(`AI Localizer: No locale file found for ${key}.`);
            return;
        }

        const relPath = path.relative(folder.uri.fsPath, targetUri.fsPath).replace(/\\/g, '/');
        let logOutput = '';
        try {
            const { stdout } = await execFileAsync('git', ['log', '-n', '20', '--date=short', '--pretty=%H %ad %s', '--', relPath], {
                cwd: folder.uri.fsPath,
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024,
            });
            logOutput = stdout.trim();
        } catch (err) {
            vscode.window.showWarningMessage(`AI Localizer: Failed to get git history: ${String(err)}`);
            return;
        }

        if (!logOutput) {
            vscode.window.showInformationMessage('AI Localizer: No git history found for this file.');
            return;
        }

        const items = logOutput.split('\n').map((line) => {
            const [hash, ...rest] = line.split(' ');
            return { label: hash, description: rest.join(' ') };
        });

        const choice = await vscode.window.showQuickPick(items, { placeHolder: `Select commit for ${relPath}` });
        if (!choice) return;

        try {
            const { stdout } = await execFileAsync('git', ['show', `${choice.label}:${relPath}`], {
                cwd: folder.uri.fsPath,
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024,
            });
            const doc = await vscode.workspace.openTextDocument({ content: stdout, language: 'json' });
            await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err) {
            vscode.window.showWarningMessage(`AI Localizer: Failed to show file at commit: ${String(err)}`);
        }
    }

    /**
     * Enable Ctrl+Click navigation inside .i18n-review-generated.json.
     * - Clicking a "key" jumps to the default-locale translation file.
     * - Clicking a "file" path opens the referenced source file.
     */
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Definition | undefined> {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder || !this.isReviewFile(document.uri)) return undefined;

        const key = this.getKeyAtPosition(document, position);
        if (key) {
            await this.i18nIndex.ensureInitialized();
            const record = this.i18nIndex.getRecord(key);
            const target =
                record?.locations?.find((l) => l.locale === (record?.defaultLocale || 'en')) ||
                record?.locations?.[0];
            if (!target) return undefined;

            const range = await this.findKeyPositionInFile(target.uri, key);
            return new vscode.Location(target.uri, range);
        }

        const filePath = this.getFilePathAtPosition(document, position, folder);
        if (filePath) {
            return new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0));
        }

        return undefined;
    }

    provideDocumentLinks(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
    ): vscode.DocumentLink[] {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder || !this.isReviewFile(document.uri)) return [];

        const links: vscode.DocumentLink[] = [];
        const text = document.getText();
        const regex = /"file"\s*:\s*"([^"]+)"/g;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text))) {
            const rawPath = match[1];
            const matchText = match[0];
            const relativeQuote = matchText.indexOf('"', matchText.indexOf(':')) + 1;
            const valueStart = match.index + relativeQuote;
            const valueEnd = valueStart + rawPath.length;
            const range = new vscode.Range(document.positionAt(valueStart), document.positionAt(valueEnd));

            const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(folder.uri.fsPath, rawPath);
            const targetUri = vscode.Uri.file(resolved);
            links.push(new vscode.DocumentLink(range, targetUri));
        }

        return links;
    }

    // Helpers
    private async findKeyPositionInFile(uri: vscode.Uri, key: string): Promise<vscode.Range> {
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const text = document.getText();
            const lastPart = key.split('.').pop() || key;
            const escaped = lastPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`"${escaped}"\\s*:\\s*`, 'g');
            const match = pattern.exec(text);

            if (match && typeof match.index === 'number') {
                const start = document.positionAt(match.index);
                const end = document.positionAt(match.index + lastPart.length + 2);
                return new vscode.Range(start, end);
            }
        } catch (err) {
            this.log?.appendLine(`[ReviewGenerated] Failed to locate key ${key}: ${String(err)}`);
        }

        return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    }

    private findPosition(content: string, needle: string): vscode.Position | null {
        const idx = content.indexOf(`"${needle}"`);
        if (idx === -1) return null;
        const prefix = content.slice(0, idx);
        const lines = prefix.split(/\r?\n/);
        const line = lines.length - 1;
        const char = lines[lines.length - 1]?.length ?? 0;
        return new vscode.Position(line, char);
    }

    private getKeyAtPosition(document: vscode.TextDocument, position: vscode.Position): string | null {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const match = /"key"\s*:\s*"([^"]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = match.exec(text))) {
            const start = m.index;
            const end = start + m[0].length;
            if (offset >= start && offset <= end) {
                return m[1];
            }
        }
        return null;
    }

    private getFilePathAtPosition(
        document: vscode.TextDocument,
        position: vscode.Position,
        folder: vscode.WorkspaceFolder,
    ): string | null {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const regex = /"file"\s*:\s*"([^"]+)"/g;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text))) {
            const raw = match[1];
            const matchText = match[0];
            const relativeQuote = matchText.indexOf('"', matchText.indexOf(':')) + 1;
            const valueStart = match.index + relativeQuote;
            const valueEnd = valueStart + raw.length;
            if (offset >= valueStart && offset <= valueEnd) {
                return path.isAbsolute(raw) ? raw : path.join(folder.uri.fsPath, raw);
            }
        }

        return null;
    }

    private isReviewFile(uri: vscode.Uri): boolean {
        return uri.fsPath.endsWith(`${path.sep}scripts${path.sep}.i18n-review-generated.json`);
    }
}

