import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex } from '../core/i18nIndex';
import { setTranslationValue } from '../core/i18nFs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface ReviewIssue {
    key: string;
    generatedValue: string;
    needsReview?: boolean;
    file?: string;
    offset?: number;
}

interface ReviewFileEntry {
    file: string;
    issues: ReviewIssue[];
}

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

        let parsed: { files?: ReviewFileEntry[] } = {};
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

                const message = `Review: ${issue.key} → ${issue.generatedValue ?? ''}`;
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

        let parsed: { files?: ReviewFileEntry[] } = {};
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
                if (!issue || typeof issue.key !== 'string' || typeof issue.generatedValue !== 'string') continue;
                try {
                    await setTranslationValue(folder, defaultLocale, issue.key, issue.generatedValue);
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

    // Helpers
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
}

