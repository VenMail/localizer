import * as vscode from 'vscode';
import { TranslationService } from '../services/translationService';

/**
 * Command to ask AI for help
 */
export class AskAICommand {
    private aiOutput: vscode.OutputChannel;

    constructor(
        private context: vscode.ExtensionContext,
        private translationService: TranslationService,
    ) {
        this.aiOutput = vscode.window.createOutputChannel('Localizer - Ask AI');
    }

    async execute(): Promise<void> {
        const active = vscode.window.activeTextEditor;
        const selectionText =
            active && !active.selection.isEmpty
                ? active.document.getText(active.selection).trim()
                : '';

        const userInput = await vscode.window.showInputBox({
            placeHolder: 'Ask AI for code suggestions or explanations...',
            prompt: 'Enter your question or request',
        });

        if (!userInput) {
            return;
        }

        let contextSnippet = '';
        if (selectionText) {
            contextSnippet = selectionText.slice(0, 4000);
        } else if (active) {
            const document = active.document;
            const totalText = document.getText();
            contextSnippet = totalText.slice(0, 8000);
        }

        // Try to forward to host AI chat
        const config = vscode.workspace.getConfiguration('ai-assistant');
        const forwardCommand = (config.get<string>('askAI.forwardToCommand') || '').trim();
        
        if (forwardCommand) {
            const payload = {
                question: userInput,
                selection: selectionText,
                context: contextSnippet,
                uri: active ? active.document.uri.toString() : undefined,
                languageId: active ? active.document.languageId : undefined,
            };
            
            try {
                await vscode.commands.executeCommand(forwardCommand, payload);
                return;
            } catch {
                // Fall back to built-in behavior
            }
        }

        // Use built-in OpenAI integration
        try {
            const apiKey = await this.translationService.getApiKey();
            if (!apiKey) {
                vscode.window.showInformationMessage(
                    'Localizer: Configure ai-assistant.openaiApiKey in Settings to use Ask AI.',
                );
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Ask AI (Localizer)',
                    cancellable: false,
                },
                async () => {
                    this.aiOutput.clear();
                    this.aiOutput.appendLine('# Question');
                    this.aiOutput.appendLine(userInput);
                    
                    if (contextSnippet) {
                        this.aiOutput.appendLine('');
                        this.aiOutput.appendLine('# Context (truncated)');
                        this.aiOutput.appendLine(contextSnippet);
                    }

                    const answer = await this.translationService.askQuestion(
                        userInput,
                        contextSnippet || undefined,
                    );

                    if (!answer) {
                        vscode.window.showInformationMessage('Ask AI: Empty response from model.');
                        return;
                    }

                    this.aiOutput.appendLine('');
                    this.aiOutput.appendLine('# Answer');
                    this.aiOutput.appendLine(answer);
                    this.aiOutput.show(true);
                    
                    vscode.window.showInformationMessage(
                        'Ask AI: Response is available in the "Localizer - Ask AI" output.',
                    );
                },
            );
        } catch (err) {
            console.error('Ask AI OpenAI error:', err);
            vscode.window.showErrorMessage(
                'Ask AI: Failed to contact OpenAI. Check your API key and network. See console for details.',
            );
        }
    }

    dispose(): void {
        this.aiOutput.dispose();
    }
}
