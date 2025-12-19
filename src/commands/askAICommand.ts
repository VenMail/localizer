import * as vscode from 'vscode';

/**
 * Command to ask AI for help
 */
export class AskAICommand {
    constructor(private context: vscode.ExtensionContext) {}

    private async isEnabled(): Promise<boolean> {
        try {
            const cfg = vscode.workspace.getConfiguration('ai-localizer');
            const autoTranslate = cfg.get<boolean>('i18n.autoTranslate') ?? false;
            const secret = (await this.context.secrets.get('openaiApiKey'))?.trim() || '';
            const fromConfig = (cfg.get<string>('openaiApiKey') || '').trim();
            const hasKey = !!(secret || fromConfig);
            return !(autoTranslate && hasKey);
        } catch {
            return true;
        }
    }

    private async pickRequest(hasSelection: boolean): Promise<string | null> {
        const templates: Array<{ label: string; description: string; value: string }> = [
            {
                label: hasSelection ? 'Explain this selection' : 'Explain this file',
                description: 'High-level explanation + key details',
                value: hasSelection
                    ? 'Explain what this selected code does. Summarize behavior, data flow, and key risks.'
                    : 'Explain what this file does. Summarize responsibilities, data flow, and key risks.',
            },
            {
                label: hasSelection ? 'Find bugs in selection' : 'Find bugs in file',
                description: 'Potential bugs + edge cases',
                value: hasSelection
                    ? 'Review this selected code for bugs, edge cases, and incorrect assumptions. Propose minimal fixes.'
                    : 'Review this file for bugs, edge cases, and incorrect assumptions. Propose minimal fixes.',
            },
            {
                label: hasSelection ? 'Refactor selection' : 'Refactor file',
                description: 'Make it clearer/simpler without changing behavior',
                value: hasSelection
                    ? 'Refactor this selected code to be simpler and clearer without changing behavior. Provide a minimal diff.'
                    : 'Refactor this file to be simpler and clearer without changing behavior. Provide a minimal diff.',
            },
            {
                label: hasSelection ? 'Write tests for selection' : 'Write tests for file',
                description: 'Suggested test cases + example tests',
                value: hasSelection
                    ? 'Write tests for this selected behavior. Suggest test cases and provide example test code.'
                    : 'Write tests for this file. Suggest test cases and provide example test code.',
            },
            {
                label: 'Custom request…',
                description: 'Type your own question/request',
                value: '__custom__',
            },
        ];

        const picked = await vscode.window.showQuickPick(templates, {
            placeHolder: 'Ask AI: choose what you want help with',
        });
        if (!picked) {
            return null;
        }

        if (picked.value !== '__custom__') {
            return picked.value;
        }

        const userInput = await vscode.window.showInputBox({
            placeHolder: 'Describe what you want the AI to do…',
            prompt: 'Ask AI for code suggestions or explanations',
        });
        return userInput?.trim() ? userInput.trim() : null;
    }

    private buildPrompt(args: {
        userInput: string;
        selectionText: string;
        contextSnippet: string;
        uri?: string;
        languageId?: string;
    }): string {
        const parts: string[] = [];
        parts.push('You are a senior software engineer helping me in my IDE.');
        parts.push('');
        parts.push('## Task');
        parts.push(args.userInput.trim());
        parts.push('');

        if (args.uri) {
            parts.push('## File');
            parts.push(args.uri);
            parts.push('');
        }
        if (args.languageId) {
            parts.push('## Language');
            parts.push(args.languageId);
            parts.push('');
        }

        if (args.selectionText) {
            parts.push('## Selected code/text');
            parts.push('```');
            parts.push(args.selectionText);
            parts.push('```');
            parts.push('');
        }

        if (args.contextSnippet && args.contextSnippet !== args.selectionText) {
            parts.push('## Additional context (truncated)');
            parts.push('```');
            parts.push(args.contextSnippet);
            parts.push('```');
            parts.push('');
        }

        parts.push('## Constraints');
        parts.push('- Be concise but complete.');
        parts.push('- If you propose code changes, provide the minimal diff and explain why.');
        parts.push('- If something is ambiguous, ask clarifying questions.');

        return parts.join('\n');
    }

    private async openPromptDocument(prompt: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: prompt,
        });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async showFallbackModal(prompt: string): Promise<void> {
        const choice = await vscode.window.showInformationMessage(
            'AI Localizer: Could not inject the prompt into an AI chat window. The prompt can be copied or opened for manual paste.',
            { modal: true },
            'Copy prompt',
            'Open prompt',
            'Cancel',
        );

        if (choice === 'Copy prompt') {
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage('AI Localizer: Prompt copied to clipboard.');
            return;
        }

        if (choice === 'Open prompt') {
            await this.openPromptDocument(prompt);
        }
    }

    async execute(): Promise<void> {
        const enabled = await this.isEnabled();
        if (!enabled) {
            vscode.window.showInformationMessage(
                'AI Localizer: Ask AI is disabled because OpenAI translations are enabled. Disable ai-localizer.i18n.autoTranslate or remove the OpenAI API key to use Ask AI prompt injection.',
            );
            return;
        }

        const active = vscode.window.activeTextEditor;
        const selectionText =
            active && !active.selection.isEmpty
                ? active.document.getText(active.selection).trim()
                : '';

        const userInput = await this.pickRequest(!!selectionText);
        if (!userInput) return;

        let contextSnippet = '';
        if (selectionText) {
            contextSnippet = selectionText.slice(0, 4000);
        } else if (active) {
            const document = active.document;
            const totalText = document.getText();
            contextSnippet = totalText.slice(0, 8000);
        }

        // Try to forward to host AI chat
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const forwardCommand = (config.get<string>('askAI.forwardToCommand') || '').trim();
        const uri = active ? active.document.uri.toString() : undefined;
        const languageId = active ? active.document.languageId : undefined;
        const prompt = this.buildPrompt({ userInput, selectionText, contextSnippet, uri, languageId });

        if (forwardCommand) {
            try {
                await vscode.commands.executeCommand(forwardCommand, prompt);
                return;
            } catch {
                try {
                    await vscode.commands.executeCommand(forwardCommand, {
                        prompt,
                        question: userInput,
                        selection: selectionText,
                        context: contextSnippet,
                        uri,
                        languageId,
                    });
                    return;
                } catch {
                }
            }
        } else {
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open', prompt);
                return;
            } catch {
            }

            try {
                const all = await vscode.commands.getCommands(true);
                const candidates = all
                    .filter((c) => {
                        const lower = c.toLowerCase();
                        if (!lower.includes('chat') && !lower.includes('ask')) {
                            return false;
                        }
                        return (
                            lower.includes('windsurf') ||
                            lower.includes('codeium') ||
                            lower.includes('cursor') ||
                            lower.includes('copilot') ||
                            lower.includes('composer')
                        );
                    })
                    .slice(0, 20);

                if (candidates.length === 1) {
                    await vscode.commands.executeCommand(candidates[0], prompt);
                    return;
                }

                if (candidates.length > 1) {
                    const picked = await vscode.window.showQuickPick(candidates, {
                        placeHolder: 'Select a chat command to inject the generated prompt into',
                    });
                    if (picked) {
                        await vscode.commands.executeCommand(picked, prompt);
                        return;
                    }
                }
            } catch {
            }
        }

        await this.showFallbackModal(prompt);
    }
}
