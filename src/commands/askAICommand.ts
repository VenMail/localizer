import * as vscode from 'vscode';
import { I18nIndex } from '../core/i18nIndex';
import { DiagnosticAnalyzer } from '../services/diagnosticAnalyzer';

/**
 * Command to ask AI for help with ai18n issues only
 * Focuses on:
 * 1. Fixing missing or untranslated strings in other locales
 * 2. Improving translations for the selection
 * 3. Analyzing for invalid translations (edge cases)
 */
export class AskAICommand {
    constructor(
        private context: vscode.ExtensionContext,
        private i18nIndex?: I18nIndex,
        private diagnosticAnalyzer?: DiagnosticAnalyzer,
    ) {}

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

    private async detectAi18nIssues(): Promise<{
        hasMissingTranslations: boolean;
        hasInvalidTranslations: boolean;
        hasStyleIssues: boolean;
        selectedKey?: string;
        selectedLocale?: string;
    }> {
        const result = {
            hasMissingTranslations: false,
            hasInvalidTranslations: false,
            hasStyleIssues: false,
        } as any;

        const active = vscode.window.activeTextEditor;
        if (!active || !this.i18nIndex || !this.diagnosticAnalyzer) {
            return result;
        }

        const document = active.document;
        const uri = document.uri;
        
        // Check for diagnostics in the current file
        const diagnostics = vscode.languages.getDiagnostics(uri);
        
        for (const diagnostic of diagnostics) {
            if (diagnostic.source === 'ai-i18n-untranslated') {
                result.hasMissingTranslations = true;
                // Try to extract key and locale from diagnostic message
                const message = diagnostic.message;
                const keyMatch = message.match(/key["'`](.+?)["'`]/i);
                const localeMatch = message.match(/locale["'`](.+?)["'`]/i);
                if (keyMatch) result.selectedKey = keyMatch[1];
                if (localeMatch) result.selectedLocale = localeMatch[1];
            }
            if (diagnostic.source === 'ai-i18n-missing-refs') {
                result.hasInvalidTranslations = true;
            }
            if (diagnostic.source === 'ai-i18n-review') {
                result.hasStyleIssues = true;
            }
        }

        // If no diagnostics in current file, check if there are any i18n issues in the project
        if (!result.hasMissingTranslations && !result.hasInvalidTranslations && !result.hasStyleIssues) {
            // Simple check - if we have an i18n index with keys and multiple locales, there might be issues
            try {
                const allKeys = this.i18nIndex.getAllKeys();
                const allLocales = this.i18nIndex.getAllLocales();
                
                // If we have keys and more than one locale, assume there might be missing translations
                if (allKeys.length > 0 && allLocales.length > 1) {
                    result.hasMissingTranslations = true; // We'll let the AI investigate
                }
            } catch (error) {
                // Ignore errors in index access
            }
        }

        return result;
    }

    private async pickAi18nTask(): Promise<string | null> {
        const templates: Array<{ label: string; description: string; value: string }> = [
            {
                label: 'Fix missing or untranslated strings in other locales',
                description: 'Identify and fill missing translations across all locales',
                value: 'Fix missing or untranslated strings in other locales',
            },
            {
                label: 'Improve translations for the selection',
                description: 'Enhance translation quality, style, and clarity',
                value: 'Improve translations for better style and clarity',
            },
            {
                label: 'Analyze for invalid translations (edge cases)',
                description: 'Find and fix translation inconsistencies, placeholders, and edge cases',
                value: 'Analyze and fix invalid translations and edge cases',
            },
        ];

        const picked = await vscode.window.showQuickPick(templates, {
            placeHolder: 'Ask AI: choose i18n task to help with',
        });
        if (!picked) {
            return null;
        }

        return picked.value;
    }

    private async generateAi18nPrompt(task: string, issues: Awaited<ReturnType<AskAICommand['detectAi18nIssues']>>): Promise<string> {
        const active = vscode.window.activeTextEditor;
        const selectionText = active && !active.selection.isEmpty
            ? active.document.getText(active.selection).trim()
            : '';

        const parts: string[] = [];
        parts.push('You are an internationalization (i18n) expert helping me fix ai18n issues in my project.');
        parts.push('');
        parts.push('## Task');
        parts.push(task);
        parts.push('');

        if (active) {
            parts.push('## File');
            parts.push(active.document.uri.toString());
            parts.push('');
            parts.push('## Language');
            parts.push(active.document.languageId);
            parts.push('');
        }

        if (selectionText) {
            parts.push('## Selected code/text');
            parts.push('```');
            parts.push(selectionText);
            parts.push('```');
            parts.push('');
        }

        if (issues.selectedKey) {
            parts.push('## Target Key');
            parts.push(issues.selectedKey);
            if (issues.selectedLocale) {
                parts.push(`Target Locale: ${issues.selectedLocale}`);
            }
            parts.push('');
        }

        parts.push('## Constraints');
        parts.push('- Focus on i18n best practices and localization issues');
        parts.push('- Provide specific, actionable suggestions for translation improvements');
        parts.push('- If suggesting code changes, provide the minimal diff');
        parts.push('- Consider cultural context and proper pluralization');
        parts.push('- Ensure placeholder consistency across translations');

        return parts.join('\n');
    }


    private async openPromptDocument(prompt: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: prompt,
        });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async tryWindsurfOpenNewChat(prompt: string): Promise<boolean> {
        try {
            // Copy the prompt to clipboard first
            await vscode.env.clipboard.writeText(prompt);
            // Try windsurf.openNewChat command first
            await vscode.commands.executeCommand('windsurf.openNewChat');
            // Wait a moment for the chat to open
            await new Promise(resolve => setTimeout(resolve, 500));
            // Try to paste the prompt
            await vscode.commands.executeCommand('workbench.action.paste');
            return true;
        } catch {
            return false;
        }
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

        // Show the 3 specific ai18n task options
        const selectedTask = await this.pickAi18nTask();
        if (!selectedTask) {
            return; // User cancelled
        }

        // Detect ai18n issues to provide context
        const issues = await this.detectAi18nIssues();
        
        // Generate specialized ai18n prompt based on selected task
        const prompt = await this.generateAi18nPrompt(selectedTask, issues);

        // Try windsurf.openNewChat first, then fallback to other methods
        if (await this.tryWindsurfOpenNewChat(prompt)) {
            return;
        }

        // Try configured forward command
        const config = vscode.workspace.getConfiguration('ai-localizer');
        const forwardCommand = (config.get<string>('askAI.forwardToCommand') || '').trim();
        
        if (forwardCommand) {
            try {
                await vscode.commands.executeCommand(forwardCommand, prompt);
                return;
            } catch {
                try {
                    await vscode.commands.executeCommand(forwardCommand, {
                        prompt,
                        question: selectedTask,
                        selection: '',
                        context: '',
                        uri: vscode.window.activeTextEditor?.document.uri.toString(),
                        languageId: vscode.window.activeTextEditor?.document.languageId,
                    });
                    return;
                } catch {
                }
            }
        } else {
            // Try standard chat commands
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
                    // For ai18n, prioritize windsurf commands
                    const windsurfCandidates = candidates.filter(c => c.toLowerCase().includes('windsurf'));
                    const picked = windsurfCandidates.length > 0 ? windsurfCandidates[0] : candidates[0];
                    await vscode.commands.executeCommand(picked, prompt);
                    return;
                }
            } catch {
            }
        }

        await this.showFallbackModal(prompt);
    }
}
