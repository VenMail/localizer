import * as vscode from 'vscode';
import { getParserForFile, getFrameworkInfo, ExtractedItem, ParseResult, Parser } from '../i18n/lib/parsers';
import { FRAMEWORK_PREPROCESSORS } from './untranslated/utils/StringPatterns';

export class ExtractSelectionCommand {
    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('AI Localizer: No active editor found.');
            return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showInformationMessage('AI Localizer: Please select text to extract translatable strings from.');
            return;
        }

        const document = editor.document;
        const selectedText = document.getText(selection);
        
        if (!selectedText.trim()) {
            vscode.window.showInformationMessage('AI Localizer: Selected text is empty.');
            return;
        }

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'AI Localizer: Extracting translatable strings from selection',
                    cancellable: false,
                },
                async (progress) => {
                    progress.report({ message: 'Analyzing selected text...' });
                    
                    // Get the appropriate parser for the file type
                    const parser = getParserForFile(document.fileName);
                    if (!parser) {
                        vscode.window.showErrorMessage(`AI Localizer: No parser available for ${document.fileName}`);
                        return;
                    }

                    progress.report({ message: 'Extracting strings...' });
                    
                    // Parse the selected text with framework-aware preprocessing
                    const frameworkInfo = getFrameworkInfo(document.fileName);
                    const frameworkName = frameworkInfo?.name || 'generic';
                    const preprocessor = FRAMEWORK_PREPROCESSORS[frameworkName as keyof typeof FRAMEWORK_PREPROCESSORS] || FRAMEWORK_PREPROCESSORS.generic;
                    let parseText = preprocessor(selectedText);
                    
                    const results = parser.parse(parseText);
                    
                    if (results.stats.extracted === 0) {
                        vscode.window.showInformationMessage('AI Localizer: No translatable strings found in selection.');
                        return;
                    }

                    // Show the extracted strings to the user
                    const extractedStrings = results.items
                        .filter((item: ExtractedItem) => item.type === 'text' || item.type === 'string')
                        .map((item: ExtractedItem) => item.text);

                    const message = `Found ${results.stats.extracted} translatable string(s) in selection:\n\n${extractedStrings.map((s: string, i: number) => `${i + 1}. "${s}"`).join('\n')}`;
                    
                    const choice = await vscode.window.showInformationMessage(
                        `AI Localizer: Extracted ${results.stats.extracted} translatable string(s) from selection.`,
                        'View Results',
                        'Copy to Clipboard',
                        'OK'
                    );

                    if (choice === 'View Results') {
                        // Create a new document to show the results
                        const resultDocument = await vscode.workspace.openTextDocument({
                            content: `# Extracted Translatable Strings\n\n${extractedStrings.map((s: string, i: number) => `${i + 1}. "${s}"`).join('\n')}`,
                            language: 'markdown'
                        });
                        await vscode.window.showTextDocument(resultDocument);
                    } else if (choice === 'Copy to Clipboard') {
                        await vscode.env.clipboard.writeText(extractedStrings.join('\n'));
                        vscode.window.showInformationMessage('AI Localizer: Extracted strings copied to clipboard.');
                    }
                }
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`AI Localizer: Failed to extract from selection. ${message}`);
        }
    }
}
