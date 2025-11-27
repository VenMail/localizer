import * as vscode from 'vscode';
import OpenAI from 'openai';

/**
 * Service for handling AI-powered translations
 */
export class TranslationService {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Get OpenAI API key from secure storage or configuration
     */
    async getApiKey(): Promise<string> {
        const secret = (await this.context.secrets.get('openaiApiKey'))?.trim() || '';
        if (secret) {
            return secret;
        }
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const fromConfig = (cfg.get<string>('openaiApiKey') || '').trim();
        return fromConfig;
    }

    /**
     * Store OpenAI API key securely
     */
    async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store('openaiApiKey', apiKey.trim());
    }

    /**
     * Get AI translations for multiple target locales
     */
    async translateToLocales(
        text: string,
        defaultLocale: string,
        targetLocales: string[],
        context: string = 'text',
        force: boolean = false,
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        
        if (!targetLocales.length) {
            return result;
        }

        const config = vscode.workspace.getConfiguration('ai-localizer');
        const autoTranslate = config.get<boolean>('i18n.autoTranslate');

        if (!autoTranslate && !force) {
            return result;
        }

        const apiKey = await this.getApiKey();
        if (!apiKey) {
            console.warn('AI i18n: No API key configured for auto-translation');
            return result;
        }

        const model = config.get<string>('openaiModel') || 'gpt-4o-mini';
        const client = new OpenAI({ apiKey });

        const tasks = targetLocales.map(async (locale) => {
            try {
                const completion = await client.chat.completions.create({
                    model,
                    temperature: 0.2,
                    messages: [
                        {
                            role: 'system',
                            content:
                                'You are a localization assistant for application UI. Translate short UI text, preserving placeholders like {name} or {{ variable }}. Respond with only the translated text, no quotes or explanations.',
                        },
                        {
                            role: 'user',
                            content: `Source locale: ${defaultLocale}\nTarget locale: ${locale}\nContext: ${context}\nText: ${text}`,
                        },
                    ],
                });
                
                const content = completion.choices[0]?.message?.content || '';
                const translated = content.trim();
                
                if (translated) {
                    return { locale, translated };
                }
                return null;
            } catch (err) {
                console.error('AI i18n: Failed to get AI translation:', err);
                return null;
            }
        });

        const outputs = await Promise.all(tasks);
        for (const out of outputs) {
            if (out && out.translated) {
                result.set(out.locale, out.translated);
            }
        }

        return result;
    }

    /**
     * Get AI suggestions for fixing untranslated strings
     */
    async getUntranslatedFixes(
        issues: any[],
        instructions?: string,
    ): Promise<Array<{ locale: string; keyPath: string; newValue: string }>> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('OpenAI API key is not configured');
        }

        const config = vscode.workspace.getConfiguration('ai-localizer');
        const model = config.get<string>('openaiModel') || 'gpt-4o-mini';
        const client = new OpenAI({ apiKey });

        const aiInstructions =
            instructions && instructions.trim().length > 0
                ? instructions
                : 'You are given a JSON report of i18n translation issues. Propose improved translations for each issue.';

        const completion = await client.chat.completions.create({
            model,
            temperature: 0.2,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are a localization assistant for application UI. You must follow the user instructions exactly and respond with strict JSON only.',
                },
                {
                    role: 'user',
                    content: [
                        aiInstructions,
                        '',
                        'Here is the report JSON with issues:',
                        JSON.stringify({ issues }, null, 2),
                        '',
                        'Propose improved translations for every issue and respond ONLY with valid JSON of the form:',
                        '{',
                        '  "updates": [',
                        '    { "locale": "fr", "keyPath": "Namespace.button.save", "newValue": "translated string" }',
                        '  ]',
                        '}',
                    ].join('\n'),
                },
            ],
        });

        const content = completion.choices[0]?.message?.content || '';
        const parsed = JSON.parse(content);

        if (!parsed || !Array.isArray(parsed.updates)) {
            return [];
        }

        return parsed.updates.filter(
            (u: any) =>
                u &&
                typeof u.locale === 'string' &&
                typeof u.keyPath === 'string' &&
                typeof u.newValue === 'string',
        );
    }

    /**
     * Ask AI a general question with context
     */
    async askQuestion(
        question: string,
        context?: string,
    ): Promise<string> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('OpenAI API key is not configured');
        }

        const config = vscode.workspace.getConfiguration('ai-localizer');
        const model = config.get<string>('openaiModel') || 'gpt-4o-mini';
        const client = new OpenAI({ apiKey });

        const completion = await client.chat.completions.create({
            model,
            temperature: 0.2,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are an AI assistant embedded in an editor, helping with code, localization, and UI. Prefer concise, actionable answers and keep code blocks minimal but correct.',
                },
                {
                    role: 'user',
                    content: context
                        ? [
                              `Question: ${question}`,
                              '',
                              'Context (may be truncated):',
                              '```',
                              context,
                              '```',
                          ].join('\n')
                        : question,
                },
            ],
        });

        return completion.choices[0]?.message?.content?.trim() || '';
    }
}
