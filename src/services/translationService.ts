import * as vscode from 'vscode';
import OpenAI from 'openai';

const DEFAULT_MAX_BATCH_ITEMS = Number(process.env.AI_I18N_MAX_BATCH_ITEMS || 50);
const DEFAULT_MAX_BATCH_CHARS = Number(process.env.AI_I18N_MAX_BATCH_CHARS || 2000);

/**
 * Service for handling AI-powered translations
 */
export class TranslationService {

    private context: vscode.ExtensionContext;
    private shortTextCache = new Map<string, string>();
    private log: vscode.OutputChannel | null;
    private static batchRunCounter = 0;

    constructor(context: vscode.ExtensionContext, log?: vscode.OutputChannel) {
        this.context = context;
        this.log = log || null;
    }

    private getOpenAiModel(config?: vscode.WorkspaceConfiguration): string {
        const cfg = config || vscode.workspace.getConfiguration('ai-localizer');
        const raw = (cfg.get<string>('openaiModel') || '').trim();

        if (!raw || raw.toLowerCase() === 'auto') {
            // Default to gpt-5-nano when not explicitly specified
            return 'gpt-4o-mini';
        }

        return raw;
    }

    private getBatchLimits(config?: vscode.WorkspaceConfiguration): {
        maxItems: number;
        maxChars: number;
    } {
        const cfg = config || vscode.workspace.getConfiguration('ai-localizer');

        const userMaxItems = cfg.get<number>('openaiMaxBatchItems');
        const userMaxChars = cfg.get<number>('openaiMaxBatchChars');

        let maxItems = DEFAULT_MAX_BATCH_ITEMS;
        let maxChars = DEFAULT_MAX_BATCH_CHARS;

        if (Number.isFinite(userMaxItems) && (userMaxItems as number) > 0) {
            maxItems = userMaxItems as number;
        }

        if (Number.isFinite(userMaxChars) && (userMaxChars as number) > 0) {
            maxChars = userMaxChars as number;
        }

        if (!Number.isFinite(maxChars) || maxChars <= 0) {
            maxChars = DEFAULT_MAX_BATCH_CHARS;
        }

        return { maxItems, maxChars };
    }

    private getBatchOutputMode(): 'json' | 'lines' {
        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const settingRaw = (cfg.get<string>('openaiBatchOutputMode') || '').trim().toLowerCase();

        if (settingRaw === 'json') {
            return 'json';
        }
        if (settingRaw === 'lines') {
            return 'lines';
        }

        const stored = this.context.globalState.get<string>('ai-i18n.batchOutputMode');
        return stored === 'lines' ? 'lines' : 'json';
    }

    private async setBatchOutputMode(mode: 'json' | 'lines'): Promise<void> {
        try {
            const cfg = vscode.workspace.getConfiguration('ai-localizer');
            const settingRaw = (cfg.get<string>('openaiBatchOutputMode') || '').trim().toLowerCase();
            if (settingRaw === 'json' || settingRaw === 'lines') {
                return;
            }
            await this.context.globalState.update('ai-i18n.batchOutputMode', mode);
        } catch (err) {
            console.error('AI Localizer: Failed to persist batch output mode preference:', err);
        }
    }

    private isCacheableShortText(text: string): boolean {
        const trimmed = (text || '').trim();
        if (!trimmed) {
            return false;
        }
        const words = trimmed.split(/\s+/);
        if (words.length > 3) {
            return false;
        }
        if (trimmed.length > 40) {
            return false;
        }
        return true;
    }

    private makeShortTextCacheKey(
        text: string,
        defaultLocale: string,
        targetLocale: string,
    ): string {
        const normalized = (text || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');
        return `${defaultLocale}::${targetLocale}::${normalized}`;
    }

    /**
     * Strip markdown code fences from AI response content.
     * GPT sometimes wraps JSON in ```json ... ``` even when asked for raw JSON.
     */
    private stripMarkdownFences(content: string): string {
        let trimmed = (content || '').trim();
        if (!trimmed.startsWith('```')) {
            return trimmed;
        }
        const lines = trimmed.split('\n');
        if (lines.length < 2) {
            return trimmed;
        }
        // Remove first line (```json or ```)
        if (lines[0].trim().startsWith('```')) {
            lines.shift();
        }
        // Remove last line if it's just ```
        if (lines.length > 0 && lines[lines.length - 1].trim() === '```') {
            lines.pop();
        }
        return lines.join('\n').trim();
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
            console.warn('AI Localizer: No API key configured for auto-translation');
            return result;
        }

        const model = this.getOpenAiModel(config);
        const client = new OpenAI({ apiKey });

        const cacheable = this.isCacheableShortText(text);
        const localesToTranslate: string[] = [];

        for (const locale of targetLocales) {
            if (cacheable) {
                const cacheKey = this.makeShortTextCacheKey(text, defaultLocale, locale);
                const cached = this.shortTextCache.get(cacheKey);
                if (cached) {
                    result.set(locale, cached);
                    continue;
                }
            }
            localesToTranslate.push(locale);
        }

        if (!localesToTranslate.length) {
            return result;
        }

        const tasks = localesToTranslate.map(async (locale) => {
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
                    if (cacheable) {
                        const cacheKey = this.makeShortTextCacheKey(text, defaultLocale, locale);
                        this.shortTextCache.set(cacheKey, translated);
                    }
                    return { locale, translated };
                }
                return null;
            } catch (err) {
                console.error('AI Localizer: Failed to get AI translation:', err);
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

    async translateBatchToLocale(
        items: { id: string; text: string; defaultLocale: string }[],
        targetLocale: string,
        context: string = 'text',
        force: boolean = false,
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        if (!items.length || !targetLocale) {
            return result;
        }

        const runId = ++TranslationService.batchRunCounter;

        const config = vscode.workspace.getConfiguration('ai-localizer');
        const autoTranslate = config.get<boolean>('i18n.autoTranslate');
        if (!autoTranslate && !force) {
            return result;
        }

        const apiKey = await this.getApiKey();
        if (!apiKey) {
            console.warn('AI Localizer: No API key configured for auto-translation');
            return result;
        }

        const model = this.getOpenAiModel(config);
        const client = new OpenAI({ apiKey });

        const { maxItems, maxChars } = this.getBatchLimits(config);

        const filteredItems: { id: string; text: string; defaultLocale: string }[] = [];
        let cachedCount = 0;
        for (const item of items) {
            const text = item.text || '';
            if (this.isCacheableShortText(text)) {
                const cacheKey = this.makeShortTextCacheKey(text, item.defaultLocale, targetLocale);
                const cached = this.shortTextCache.get(cacheKey);
                if (cached) {
                    result.set(item.id, cached);
                    cachedCount += 1;
                    continue;
                }
            }
            filteredItems.push(item);
        }

        // Within this bulk run, avoid sending identical phrases multiple times.
        // We deduplicate by normalized (defaultLocale, targetLocale, text) and
        // later fan out the canonical translation to all duplicate key IDs.
        const duplicateIdToCanonicalId = new Map<string, string>();
        const workItems: { id: string; text: string; defaultLocale: string }[] = [];
        const dedupGroups = new Map<
            string,
            {
                canonical: { id: string; text: string; defaultLocale: string };
                duplicates: { id: string; text: string; defaultLocale: string }[];
            }
        >();

        for (const item of filteredItems) {
            const text = item.text || '';
            const trimmed = text.trim();
            if (!trimmed) {
                workItems.push(item);
                continue;
            }

            const normKey = this.makeShortTextCacheKey(text, item.defaultLocale, targetLocale);
            const existing = dedupGroups.get(normKey);
            if (!existing) {
                dedupGroups.set(normKey, { canonical: item, duplicates: [] });
                workItems.push(item);
            } else {
                existing.duplicates.push(item);
                duplicateIdToCanonicalId.set(item.id, existing.canonical.id);
            }
        }

        const batches: { id: string; text: string; defaultLocale: string }[][] = [];
        let currentBatch: { id: string; text: string; defaultLocale: string }[] = [];
        let currentChars = 0;

        for (const item of workItems) {
            const text = item.text || '';
            const length = text.length;
            if (
                currentBatch.length >= maxItems ||
                (currentBatch.length > 0 && currentChars + length > maxChars)
            ) {
                batches.push(currentBatch);
                currentBatch = [];
                currentChars = 0;
            }
            currentBatch.push(item);
            currentChars += length;
        }
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        this.log?.appendLine(
            `[TranslateBatch #${runId}] target=${targetLocale}, items=${items.length}, cached=${cachedCount}, toTranslate=${workItems.length}, batches=${batches.length}, maxItems=${maxItems}, maxChars=${maxChars}`,
        );

        const preferredMode = this.getBatchOutputMode();

        const classifyError = (err: any): 'rate_limit' | 'too_large' | 'other' => {
            const anyErr: any = err;
            const status =
                anyErr && typeof anyErr.status === 'number' ? (anyErr.status as number) : undefined;
            const code =
                anyErr && typeof anyErr.code === 'string'
                    ? (anyErr.code as string).toLowerCase()
                    : '';
            const type =
                anyErr && anyErr.error && typeof anyErr.error.type === 'string'
                    ? (anyErr.error.type as string).toLowerCase()
                    : '';
            const message =
                (anyErr && typeof anyErr.message === 'string'
                    ? (anyErr.message as string)
                    : String(anyErr || '')
                ).toLowerCase();

            if (
                status === 429 ||
                code === 'rate_limit_exceeded' ||
                type === 'rate_limit_exceeded' ||
                message.includes('rate limit') ||
                message.includes('too many requests')
            ) {
                return 'rate_limit';
            }

            if (
                status === 400 ||
                type.includes('context_length') ||
                type.includes('max_tokens') ||
                message.includes('context length') ||
                message.includes('maximum context length') ||
                message.includes('too many tokens') ||
                message.includes('request too large') ||
                message.includes('token limit')
            ) {
                return 'too_large';
            }

            return 'other';
        };

        const sleep = (ms: number): Promise<void> =>
            new Promise((resolve) => {
                setTimeout(resolve, ms);
            });

        type BatchRunResult = 'ok' | 'none' | 'too_large';

        const runJsonMode = async (
            batch: { id: string; text: string; defaultLocale: string }[],
        ): Promise<BatchRunResult> => {
            const maxAttempts = 3;
            let attempt = 0;
            while (attempt < maxAttempts) {
                attempt += 1;
                try {
                    const payload = {
                        targetLocale,
                        context,
                        items: batch.map((it) => ({
                            id: it.id,
                            text: it.text,
                            defaultLocale: it.defaultLocale,
                        })),
                    };

                    const userContent = [
                        'Translate the following items from their defaultLocale to the target locale.',
                        `Target locale: ${targetLocale}`,
                        `Context: ${context}`,
                        '',
                        'Return ONLY valid JSON with this shape:',
                        '{ "translations": [ { "id": "string", "translated": "string" } ] }',
                        '',
                        'Items:',
                        JSON.stringify(payload, null, 2),
                    ].join('\n');

                    const completion = await client.chat.completions.create({
                        model,
                        temperature: 0.2,
                        messages: [
                            {
                                role: 'system',
                                content:
                                    'You are a localization assistant for application UI. Translate short UI text, preserving placeholders like {name} or {{ variable }}. Respond with strict JSON only.',
                            },
                            {
                                role: 'user',
                                content: userContent,
                            },
                        ],
                    });

                    let content = completion.choices[0]?.message?.content || '';
                    
                    // Strip markdown code fences if present
                    content = this.stripMarkdownFences(content);
                    
                    let parsed: any;
                    try {
                        parsed = JSON.parse(content);
                    } catch (err) {
                        console.error(
                            'AI Localizer: Failed to parse batch translation JSON response (JSON mode):',
                            err,
                        );
                        const details = err instanceof Error ? err.message : String(err);
                        this.log?.appendLine(
                            `[TranslateBatch #${runId}] Failed to parse JSON batch response for target=${targetLocale}, batchSize=${batch.length}: ${details}`,
                        );
                        return 'none';
                    }

                    const translations = Array.isArray(parsed?.translations)
                        ? parsed.translations
                        : [];
                    let added = false;
                    for (const entry of translations) {
                        if (!entry) {
                            continue;
                        }
                        const id = typeof entry.id === 'string' ? entry.id : '';
                        const translatedRaw =
                            typeof entry.translated === 'string' ? entry.translated : '';
                        const translated = translatedRaw.trim();
                        if (id && translated) {
                            result.set(id, translated);
                            const original = batch.find((it) => it.id === id);
                            if (original && this.isCacheableShortText(original.text)) {
                                const cacheKey = this.makeShortTextCacheKey(
                                    original.text,
                                    original.defaultLocale,
                                    targetLocale,
                                );
                                this.shortTextCache.set(cacheKey, translated);
                            }
                            added = true;
                        }
                    }
                    return added ? 'ok' : 'none';
                } catch (err) {
                    console.error(
                        'AI Localizer: Failed to get batch AI translations (JSON mode):',
                        err,
                    );
                    const details = err instanceof Error ? err.message : String(err);
                    this.log?.appendLine(
                        `[TranslateBatch #${runId}] Error in JSON mode for target=${targetLocale}, batchSize=${batch.length}: ${details}`,
                    );
                    const category = classifyError(err);
                    if (category === 'rate_limit' && attempt < maxAttempts) {
                        const delayMs = 1000 * Math.pow(2, attempt - 1);
                        this.log?.appendLine(
                            `[TranslateBatch #${runId}] JSON mode hit rate limit; retrying in ${delayMs} ms.`,
                        );
                        await sleep(delayMs);
                        continue;
                    }
                    if (category === 'too_large') {
                        return 'too_large';
                    }
                    return 'none';
                }
            }
            return 'none';
        };

        const runLineMode = async (
            batch: { id: string; text: string; defaultLocale: string }[],
        ): Promise<BatchRunResult> => {
            const maxAttempts = 3;
            let attempt = 0;
            while (attempt < maxAttempts) {
                attempt += 1;
                try {
                    const payload = {
                        targetLocale,
                        context,
                        items: batch.map((it) => ({
                            id: it.id,
                            text: it.text,
                            defaultLocale: it.defaultLocale,
                        })),
                    };

                    const userContent = [
                        'Translate the following items from their defaultLocale to the target locale.',
                        `Target locale: ${targetLocale}`,
                        `Context: ${context}`,
                        '',
                        'Return one line per item in this exact format:',
                        '<id>\t<translated text>',
                        'Do not include a header line or any extra commentary.',
                        '',
                        'Items:',
                        JSON.stringify(payload, null, 2),
                    ].join('\n');

                    const completion = await client.chat.completions.create({
                        model,
                        temperature: 0.2,
                        messages: [
                            {
                                role: 'system',
                                content:
                                    'You are a localization assistant for application UI. Translate short UI text, preserving placeholders like {name} or {{ variable }}. Respond with plain lines only, no JSON or code fences.',
                            },
                            {
                                role: 'user',
                                content: userContent,
                            },
                        ],
                    });

                    const content = completion.choices[0]?.message?.content || '';
                    const lines = content
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter((l) => l && !l.startsWith('```'));

                    let added = false;
                    for (const line of lines) {
                        const idx = line.indexOf('\t');
                        if (idx <= 0) {
                            continue;
                        }
                        const id = line.slice(0, idx).trim();
                        const translated = line.slice(idx + 1).trim();
                        if (id && translated) {
                            result.set(id, translated);
                            const original = batch.find((it) => it.id === id);
                            if (original && this.isCacheableShortText(original.text)) {
                                const cacheKey = this.makeShortTextCacheKey(
                                    original.text,
                                    original.defaultLocale,
                                    targetLocale,
                                );
                                this.shortTextCache.set(cacheKey, translated);
                            }
                            added = true;
                        }
                    }
                    return added ? 'ok' : 'none';
                } catch (err) {
                    console.error(
                        'AI Localizer: Failed to get batch AI translations (line mode):',
                        err,
                    );
                    const details = err instanceof Error ? err.message : String(err);
                    this.log?.appendLine(
                        `[TranslateBatch #${runId}] Error in line mode for target=${targetLocale}, batchSize=${batch.length}: ${details}`,
                    );
                    const category = classifyError(err);
                    if (category === 'rate_limit' && attempt < maxAttempts) {
                        const delayMs = 1000 * Math.pow(2, attempt - 1);
                        this.log?.appendLine(
                            `[TranslateBatch #${runId}] Line mode hit rate limit; retrying in ${delayMs} ms.`,
                        );
                        await sleep(delayMs);
                        continue;
                    }
                    if (category === 'too_large') {
                        return 'too_large';
                    }
                    return 'none';
                }
            }
            return 'none';
        };

        const processBatch = async (
            batch: { id: string; text: string; defaultLocale: string }[],
            index: number,
            total: number,
        ): Promise<void> => {
            const batchLabel = `${index + 1}/${total}`;

            const runWithPreferredMode = async (
                currentBatch: { id: string; text: string; defaultLocale: string }[],
            ): Promise<BatchRunResult> => {
                if (preferredMode === 'lines') {
                    this.log?.appendLine(
                        `[TranslateBatch #${runId}] Batch ${batchLabel}: trying line mode (items=${currentBatch.length}).`,
                    );
                    const lineResult = await runLineMode(currentBatch);
                    if (lineResult === 'ok') {
                        return 'ok';
                    }
                    if (lineResult === 'too_large') {
                        return 'too_large';
                    }
                    this.log?.appendLine(
                        `[TranslateBatch #${runId}] Batch ${batchLabel}: line mode produced no usable translations; falling back to JSON mode.`,
                    );
                    const jsonResult = await runJsonMode(currentBatch);
                    if (jsonResult === 'ok') {
                        this.log?.appendLine(
                            `[TranslateBatch #${runId}] Batch ${batchLabel}: JSON mode succeeded; switching preferred batch output mode to 'json'.`,
                        );
                        await this.setBatchOutputMode('json');
                        return 'ok';
                    }
                    if (jsonResult === 'too_large') {
                        return 'too_large';
                    }
                    this.log?.appendLine(
                        `[TranslateBatch #${runId}] Batch ${batchLabel}: JSON mode also produced no usable translations.`,
                    );
                    return 'none';
                }

                this.log?.appendLine(
                    `[TranslateBatch #${runId}] Batch ${batchLabel}: trying JSON mode (items=${currentBatch.length}).`,
                );
                const jsonResult = await runJsonMode(currentBatch);
                if (jsonResult === 'ok') {
                    return 'ok';
                }
                if (jsonResult === 'too_large') {
                    return 'too_large';
                }
                this.log?.appendLine(
                    `[TranslateBatch #${runId}] Batch ${batchLabel}: JSON mode produced no usable translations; falling back to line mode.`,
                );
                const lineResult = await runLineMode(currentBatch);
                if (lineResult === 'ok') {
                    this.log?.appendLine(
                        `[TranslateBatch #${runId}] Batch ${batchLabel}: line mode succeeded; switching preferred batch output mode to 'lines'.`,
                    );
                    await this.setBatchOutputMode('lines');
                    return 'ok';
                }
                if (lineResult === 'too_large') {
                    return 'too_large';
                }
                this.log?.appendLine(
                    `[TranslateBatch #${runId}] Batch ${batchLabel}: line mode also produced no usable translations.`,
                );
                return 'none';
            };

            const resultMode = await runWithPreferredMode(batch);
            if (resultMode === 'too_large') {
                if (batch.length <= 1) {
                    this.log?.appendLine(
                        `[TranslateBatch #${runId}] Batch ${batchLabel}: request too large even for a single item; skipping and relying on per-item fallback.`,
                    );
                    return;
                }
                const mid = Math.floor(batch.length / 2) || 1;
                const left = batch.slice(0, mid);
                const right = batch.slice(mid);
                this.log?.appendLine(
                    `[TranslateBatch #${runId}] Batch ${batchLabel}: request too large, splitting into ${left.length} + ${right.length} item(s).`,
                );
                await processBatch(left, index, total);
                await processBatch(right, index, total);
            }
        };

        const totalBatches = batches.length;
        if (totalBatches > 0) {
            const concurrencySetting = config.get<number>('openaiMaxBatchConcurrency');
            let maxConcurrency = 4;
            if (Number.isFinite(concurrencySetting) && (concurrencySetting as number) > 0) {
                maxConcurrency = Math.max(1, Math.floor(concurrencySetting as number));
            }
            const effectiveConcurrency = Math.min(maxConcurrency, totalBatches);

            let nextIndex = 0;

            const runWorker = async (): Promise<void> => {
                while (true) {
                    if (nextIndex >= totalBatches) {
                        return;
                    }
                    const currentIndex = nextIndex;
                    nextIndex += 1;
                    const batch = batches[currentIndex];
                    await processBatch(batch, currentIndex, totalBatches);
                }
            };

            const workers: Promise<void>[] = [];
            for (let i = 0; i < effectiveConcurrency; i += 1) {
                workers.push(runWorker());
            }

            await Promise.all(workers);
        }

        // Propagate translations from canonical IDs to duplicate IDs that share
        // the same normalized (defaultLocale, targetLocale, text).
        if (duplicateIdToCanonicalId.size > 0) {
            for (const [dupId, canonicalId] of duplicateIdToCanonicalId.entries()) {
                if (result.has(dupId)) {
                    continue;
                }
                const v = result.get(canonicalId);
                if (v && v.trim()) {
                    result.set(dupId, v.trim());
                }
            }
        }

        const remaining = items.filter((item) => !result.has(item.id));
        if (remaining.length) {
            this.log?.appendLine(
                `[TranslateBatch #${runId}] ${remaining.length} item(s) still missing after batched calls; falling back to per-item translations.`,
            );
            for (const item of remaining) {
                try {
                    const single = await this.translateToLocales(
                        item.text,
                        item.defaultLocale,
                        [targetLocale],
                        context,
                        force,
                    );
                    const v = single.get(targetLocale);
                    if (v && v.trim()) {
                        result.set(item.id, v.trim());
                    }
                } catch (err) {
                    console.error(`AI Localizer: Fallback translation failed for key ${item.id}:`, err);
                    const details = err instanceof Error ? err.message : String(err);
                    this.log?.appendLine(
                        `[TranslateBatch #${runId}] Per-item fallback failed for key ${item.id}: ${details}`,
                    );
                }
            }
        }

        this.log?.appendLine(
            `[TranslateBatch #${runId}] Completed. Translated ${result.size} key(s) for target=${targetLocale}.`,
        );

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
        const model = this.getOpenAiModel(config);
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

        let content = completion.choices[0]?.message?.content || '';
        
        // Strip markdown code fences if present
        content = this.stripMarkdownFences(content);

        let parsed: any;
        try {
            parsed = JSON.parse(content);
        } catch (err) {
            console.error('AI Localizer: Failed to parse AI response as JSON:', err);
            this.log?.appendLine(`[getUntranslatedFixes] Failed to parse AI response: ${content.slice(0, 500)}`);
            return [];
        }

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
        const model = this.getOpenAiModel(config);
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
