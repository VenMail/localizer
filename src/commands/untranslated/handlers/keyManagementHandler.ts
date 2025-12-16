import * as vscode from 'vscode';
import * as path from 'path';
import { I18nIndex, extractKeyAtPosition } from '../../../core/i18nIndex';
import {
    clearLocaleDirCache,
    setLaravelTranslationValue,
    setTranslationValue,
    setTranslationValuesBatch,
    deriveRootFromFile,
} from '../../../core/i18nFs';
import { getGranularSyncService } from '../../../services/granularSyncService';
import { TranslationService } from '../../../services/translationService';
import { pickWorkspaceFolder } from '../../../core/workspace';
import { findKeyInHistory, getFileContentAtCommit } from '../../../core/gitHistory';
import { CommitTracker } from '../../../core/commitTracker';
import {
    sharedDecoder,
    sharedEncoder,
    readJsonFile,
    writeJsonFile,
    deleteKeyPathInObject,
    getNestedValue,
    setNestedValue,
} from '../utils/jsonUtils';
import {
    computeEditDistance,
    buildLabelFromKeySegment,
    escapeRegExp,
    looksLikeUserText,
} from '../utils/textAnalysis';
import { findCommentRanges, isPositionInComment } from '../utils/commentParser';
import { GitRecoveryHandler } from './gitRecoveryHandler';
import { getBatchRecoveryHandler } from './batchRecoveryHandler';
import { clearLocaleCaches } from '../utils/localeCache';
import { operationLock, OperationType } from '../utils/operationLock';

export class KeyManagementHandler {
    private deletionGuardPending: Map<string, { key: string; value: string; timeout: NodeJS.Timeout }> = new Map();

    constructor(
        private i18nIndex: I18nIndex,
        private gitRecoveryHandler: GitRecoveryHandler,
        private translationService: TranslationService,
        private context?: vscode.ExtensionContext,
        private log?: vscode.OutputChannel,
    ) {}

    /**
     * Cleanup all pending guard timeouts. Call on extension deactivation.
     */
    dispose(): void {
        for (const [, pending] of this.deletionGuardPending) {
            clearTimeout(pending.timeout);
        }
        this.deletionGuardPending.clear();
    }

    /**
     * Check if operation can proceed, showing warning if blocked
     */
    private async canProceed(operationType: OperationType, description: string): Promise<boolean> {
        if (!operationLock.isOperationRunning()) {
            return true;
        }
        const current = operationLock.getCurrentOperation();
        if (current?.type === operationType) {
            return true;
        }
        const blockingMsg = operationLock.getBlockingOperationMessage();
        vscode.window.showWarningMessage(
            `AI Localizer: Cannot start "${description}" - ${blockingMsg}. Please wait for it to complete.`
        );
        return false;
    }

    private decodeSimpleJsStringLiteral(content: string): string {
        return String(content || '')
            .replace(/\\n/g, ' ')
            .replace(/\\r/g, ' ')
            .replace(/\\t/g, ' ')
            .replace(/\\'/g, "'")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }

    private buildCollapsedTranslationExpressionEdit(
        doc: vscode.TextDocument,
        keyRange: vscode.Range,
        originalKey: string,
        targetKey: string,
    ): { range: vscode.Range; newText: string } | null {
        const text = doc.getText();
        const keyStartOffset = doc.offsetAt(keyRange.start);
        const keyEndOffset = doc.offsetAt(keyRange.end);
        if (keyStartOffset < 0 || keyEndOffset <= keyStartOffset) return null;

        const safeKey = escapeRegExp(originalKey);

        const windowSize = 20000;
        const windowStart = Math.max(0, keyStartOffset - windowSize);
        const prefixText = text.slice(windowStart, keyStartOffset);
        const callStartCandidateRegex = /\b(\$?)t\s*\(/g;

        const candidates: Array<{ startIdx: number; hasDollar: boolean }> = [];
        for (let m = callStartCandidateRegex.exec(prefixText); m; m = callStartCandidateRegex.exec(prefixText)) {
            const absIdx = windowStart + (m.index ?? 0);
            candidates.push({ startIdx: absIdx, hasDollar: (m[1] as string) === '$' });
        }
        if (!candidates.length) return null;

        const findCloseParenFrom = (openParenIdx: number): number | null => {
            let depth = 0;
            let inString: string | null = null;
            let escape = false;

            for (let i = openParenIdx; i < text.length; i += 1) {
                const ch = text[i] as string;

                if (inString) {
                    if (escape) {
                        escape = false;
                        continue;
                    }
                    if (ch === '\\') {
                        escape = true;
                        continue;
                    }
                    if (ch === inString) {
                        inString = null;
                    }
                    continue;
                }

                if (ch === "'" || ch === '"' || ch === '`') {
                    inString = ch;
                    continue;
                }

                if (ch === '(') {
                    depth += 1;
                    continue;
                }
                if (ch === ')') {
                    depth -= 1;
                    if (depth === 0) return i;
                    continue;
                }
            }
            return null;
        };

        const findEnclosingCall = (): { startIdx: number; hasDollar: boolean; openParenIdx: number; closeParenIdx: number } | null => {
            for (let i = candidates.length - 1; i >= 0; i -= 1) {
                const c = candidates[i]!;
                const openParenIdx = text.indexOf('(', c.startIdx);
                if (openParenIdx === -1) continue;
                const closeParenIdx = findCloseParenFrom(openParenIdx);
                if (closeParenIdx == null) continue;
                if (c.startIdx <= keyStartOffset && keyEndOffset <= closeParenIdx) {
                    return { startIdx: c.startIdx, hasDollar: c.hasDollar, openParenIdx, closeParenIdx };
                }
            }
            return null;
        };

        const call = findEnclosingCall();
        if (!call) return null;

        const findFirstArgEndIdx = (): number | null => {
            const firstArgRegex = new RegExp(
                "\\b\\$?t\\s*\\(\\s*(['\"`])" + safeKey + "\\1",
                'g',
            );
            firstArgRegex.lastIndex = call.startIdx;
            const m = firstArgRegex.exec(text);
            if (!m || typeof m.index !== 'number') return null;
            const matchText = m[0] as string;
            return m.index + matchText.length;
        };

        const afterFirstArgIdx = findFirstArgEndIdx();
        if (afterFirstArgIdx == null) return null;

        const shouldCollapseCallArgs = (() => {
            let i = afterFirstArgIdx;
            while (i < text.length && /\s/.test(text[i] as string)) i += 1;
            if ((text[i] as string) !== ',') {
                return true;
            }

            i += 1;
            while (i < text.length && /\s/.test(text[i] as string)) i += 1;
            const quote = text[i] as string;
            if (quote !== "'" && quote !== '"' && quote !== '`') return false;

            i += 1;
            let escape = false;
            let sawTemplateExpr = false;
            for (; i < text.length; i += 1) {
                const ch = text[i] as string;
                if (escape) {
                    escape = false;
                    continue;
                }
                if (ch === '\\') {
                    escape = true;
                    continue;
                }
                if (quote === '`' && ch === '$' && (text[i + 1] as string) === '{') {
                    sawTemplateExpr = true;
                }
                if (ch === quote) {
                    i += 1;
                    break;
                }
            }
            if (quote === '`' && sawTemplateExpr) return false;

            while (i < text.length && /\s/.test(text[i] as string)) i += 1;
            return i === call.closeParenIdx;
        })();

        if (!shouldCollapseCallArgs) return null;

        let endIdx = call.closeParenIdx;

        const rest = text.slice(call.closeParenIdx + 1);
        const fallbackMatch = rest.match(/^\s*(\|\||\?\?)\s*(['"`])((?:\\.|(?!\2)[\s\S])*)\2/);
        if (fallbackMatch && typeof fallbackMatch[3] === 'string') {
            const quote = fallbackMatch[2] as string;
            const raw = fallbackMatch[3] as string;
            if (!(quote === '`' && raw.includes('${'))) {
                endIdx = call.closeParenIdx + fallbackMatch[0].length;
            }
        }

        const startPos = doc.positionAt(call.startIdx);
        const endPos = doc.positionAt(endIdx + 1);

        const escapedTargetKey = String(targetKey).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const newText = `${call.hasDollar ? '$' : ''}t('${escapedTargetKey}')`;

        return {
            range: new vscode.Range(startPos, endPos),
            newText,
        };
    }

    private extractInlineDefaultForKeyFromLine(line: string, key: string): string | null {
        const safeKey = escapeRegExp(key);

        const quoteGroup = "(['\"`])";
        const callWithDefaultFullRegex = new RegExp(
            "\\b\\$?t\\s*\\(\\s*(['\"])" +
                safeKey +
                "\\1\\s*,\\s*" +
                quoteGroup +
                "((?:\\\\.|(?!\\2)[\\s\\S])*)\\2",
        );
        const m1 = line.match(callWithDefaultFullRegex);
        if (m1 && typeof m1[3] === 'string') {
            const quote = m1[2] as string;
            const raw = m1[3];
            if (quote === '`' && raw.includes('${')) {
                return null;
            }
            const decoded = this.decodeSimpleJsStringLiteral(raw).replace(/\s+/g, ' ').trim();
            if (!decoded) return null;
            return looksLikeUserText(decoded) ? decoded : null;
        }

        const callThenFallbackRegex = new RegExp(
            "\\b\\$?t\\s*\\(\\s*(['\"])" +
                safeKey +
                "\\1\\s*\\)\\s*(\\|\\||\\?\\?)\\s*" +
                quoteGroup +
                "((?:\\\\.|(?!\\3)[\\s\\S])*)\\3",
        );
        const m2 = line.match(callThenFallbackRegex);
        if (m2 && typeof m2[4] === 'string') {
            const quote = m2[3] as string;
            const raw = m2[4];
            if (quote === '`' && raw.includes('${')) {
                return null;
            }
            const decoded = this.decodeSimpleJsStringLiteral(raw).replace(/\s+/g, ' ').trim();
            if (!decoded) return null;
            return looksLikeUserText(decoded) ? decoded : null;
        }

        return null;
    }

    private buildNormalizedMissingReferenceKey(
        folder: vscode.WorkspaceFolder,
        documentUri: vscode.Uri,
        key: string,
    ): string | null {
        const rel = path
            .relative(folder.uri.fsPath, documentUri.fsPath)
            .replace(/\\/g, '/');
        const parts = rel.split('/').filter(Boolean);

        let componentName: string | null = null;
        for (let i = 0; i < parts.length; i += 1) {
            if (String(parts[i]).toLowerCase() === 'components' && i + 1 < parts.length) {
                componentName = parts[i + 1];
                break;
            }
        }

        if (componentName) {
            componentName = String(componentName).replace(/\.(tsx|ts|jsx|js|vue|svelte)$/i, '');
        }

        const keyParts = String(key).split('.').filter(Boolean);
        if (keyParts.length === 0) return null;

        const normalizedParts: string[] = [];

        if (componentName) {
            normalizedParts.push('components');
            normalizedParts.push(String(componentName));
        }

        let remaining = [...keyParts];
        if (componentName && remaining.length > 0) {
            if (remaining[0] && remaining[0].toLowerCase() === String(componentName).toLowerCase()) {
                remaining = remaining.slice(1);
            }
            if (remaining[0] && remaining[0].toLowerCase() === 'app') {
                remaining = remaining.slice(1);
            }
        }

        const cleaned = remaining.map((seg, idx) => {
            let s = String(seg || '');
            if (idx === remaining.length - 1) {
                s = s.replace(/(_text|_label|_title|_message|_placeholder)$/i, '');
            }
            s = s
                .replace(/[^A-Za-z0-9]+/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '')
                .toLowerCase();
            return s;
        });

        for (const seg of cleaned) {
            if (seg) normalizedParts.push(seg);
        }

        if (normalizedParts.length < 2) {
            return null;
        }

        return normalizedParts.join('.');
    }

    /**
     * Fix missing key reference
     */
    async fixMissingKeyReference(
        documentUri: vscode.Uri,
        position: { line: number; character: number },
        key: string,
    ): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(documentUri);

        const languageId = doc.languageId;

        let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';
        const rootName = deriveRootFromFile(folder, documentUri);
        const isLaravelSource = languageId === 'php' || languageId === 'blade';
        const keyParts = String(key).split('.').filter(Boolean);
        const keyLeaf = keyParts[keyParts.length - 1] || '';
        const keyPrefix = keyParts.slice(0, -1).join('.');

        const syncService = getGranularSyncService(this.context);
        await syncService.syncKeys(folder, [key]);

        await this.i18nIndex.ensureInitialized();
        const allKeys = this.i18nIndex.getAllKeys();

        const vsPosition = new vscode.Position(position.line, position.character);
        const keyInfo = extractKeyAtPosition(doc, vsPosition);
        const canReplaceReference = !!keyInfo && keyInfo.key === key;
        const inlineDefault =
            !isLaravelSource && canReplaceReference
                ? this.extractInlineDefaultForKeyFromLine(doc.lineAt(keyInfo.range.start.line).text, key)
                : null;
        const normalizedKey =
            !isLaravelSource && canReplaceReference
                ? this.buildNormalizedMissingReferenceKey(folder, documentUri, key)
                : null;
        const targetKey = normalizedKey || key;

        if (canReplaceReference && targetKey !== key) {
            const record = this.i18nIndex.getRecord(targetKey);
            if (record) {
                const edit = new vscode.WorkspaceEdit();
                const collapsed = this.buildCollapsedTranslationExpressionEdit(
                    doc,
                    keyInfo.range,
                    key,
                    targetKey,
                );
                if (collapsed) {
                    edit.replace(documentUri, collapsed.range, collapsed.newText);
                } else {
                    edit.replace(documentUri, keyInfo.range, targetKey);
                }
                const applied = await vscode.workspace.applyEdit(edit);
                if (applied) {
                    await doc.save();
                    vscode.window.showInformationMessage(
                        `AI Localizer: Auto-fixed "${key}" → "${targetKey}"`,
                    );
                    return;
                }
            }
        }

        if (inlineDefault && inlineDefault.trim()) {
            const value = inlineDefault.trim();

            if (isLaravelSource) {
                await setLaravelTranslationValue(folder, defaultLocale, targetKey, value);
            } else {
                await setTranslationValue(folder, defaultLocale, targetKey, value, { rootName });
            }

            if (canReplaceReference) {
                const edit = new vscode.WorkspaceEdit();
                const collapsed = this.buildCollapsedTranslationExpressionEdit(
                    doc,
                    keyInfo.range,
                    key,
                    targetKey,
                );
                if (collapsed) {
                    edit.replace(documentUri, collapsed.range, collapsed.newText);
                } else if (targetKey !== key) {
                    edit.replace(documentUri, keyInfo.range, targetKey);
                }
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            }

            try {
                await syncService.syncKeys(folder, [targetKey]);
            } catch {
            }

            vscode.window.showInformationMessage(
                `AI Localizer: Created "${targetKey}" = "${value.slice(0, 50)}${value.length > 50 ? '...' : ''}" in locale ${defaultLocale}.`,
            );
            return;
        }

        // STEP 1: Try to find the best matching existing key (typo fix)
        let bestKey: string | null = null;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const candidate of allKeys) {
            if (!candidate) continue;
            const parts = candidate.split('.').filter(Boolean);
            if (!parts.length) continue;
            const prefix = parts.slice(0, -1).join('.');
            if (prefix !== keyPrefix) continue;
            const leaf = parts[parts.length - 1] || '';
            const score = computeEditDistance(keyLeaf, leaf);
            if (score < bestScore) {
                bestScore = score;
                bestKey = candidate;
            }
        }

        // Check if the best key is a good enough match
        if (bestKey) {
            const bestParts = bestKey.split('.').filter(Boolean);
            const bestLeaf = bestParts[bestParts.length - 1] || '';
            const maxLen = Math.max(bestLeaf.length, keyLeaf.length);
            if (maxLen > 0 && bestScore <= Math.max(2, Math.floor(maxLen / 4))) {
                // Auto-fix: Replace with similar key
                const vsPosition = new vscode.Position(position.line, position.character);
                const keyInfo = extractKeyAtPosition(doc, vsPosition);
                if (keyInfo && keyInfo.key === key) {
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(documentUri, keyInfo.range, bestKey);
                    const applied = await vscode.workspace.applyEdit(edit);
                    if (applied) {
                        await doc.save();
                        vscode.window.showInformationMessage(
                            `AI Localizer: Auto-fixed "${key}" → "${bestKey}"`,
                        );
                        return;
                    }
                }
            }
        }

        // STEP 2: Try to recover value from git history
        this.log?.appendLine(`[MissingRefFix] Attempting git recovery for "${key}" from source file: ${documentUri.fsPath}`);
        
        // Try source file history first (most likely to have the original text)
        const sourceFileRecovery = await this.gitRecoveryHandler.recoverFromSourceFileHistory(
            folder,
            documentUri.fsPath,
            key,
            defaultLocale,
            365,
            '[MissingRefFix]'
        );
        
        if (sourceFileRecovery) {
            if (isLaravelSource) {
                await setLaravelTranslationValue(folder, defaultLocale, targetKey, sourceFileRecovery.value);
            } else {
                await setTranslationValue(folder, defaultLocale, targetKey, sourceFileRecovery.value, { rootName });
            }

            if (canReplaceReference) {
                const edit = new vscode.WorkspaceEdit();
                const collapsed = this.buildCollapsedTranslationExpressionEdit(
                    doc,
                    keyInfo!.range,
                    key,
                    targetKey,
                );
                if (collapsed) {
                    edit.replace(documentUri, collapsed.range, collapsed.newText);
                } else if (targetKey !== key) {
                    edit.replace(documentUri, keyInfo!.range, targetKey);
                }
                const applied = await vscode.workspace.applyEdit(edit);
                if (applied) {
                    await doc.save();
                }
            }

            vscode.window.showInformationMessage(
                `AI Localizer: Restored "${targetKey}" = "${sourceFileRecovery.value.slice(0, 50)}${sourceFileRecovery.value.length > 50 ? '...' : ''}" from ${sourceFileRecovery.source}.`,
            );
            return;
        }
        
        // Fallback to locale file history
        const localeUris = await this.gitRecoveryHandler.getLocaleFileUris(folder, defaultLocale, this.i18nIndex);
        const recovery = await this.gitRecoveryHandler.recoverKeyFromGit(folder, localeUris, key, defaultLocale, {
            daysBack: 365,
            maxCommits: 100,
            perDayCommitLimit: 5,
            logPrefix: '[MissingRefFix]',
        });

        if (recovery) {
            if (isLaravelSource) {
                await setLaravelTranslationValue(folder, defaultLocale, targetKey, recovery.value);
            } else {
                await setTranslationValue(folder, defaultLocale, targetKey, recovery.value, { rootName });
            }

            if (canReplaceReference) {
                const edit = new vscode.WorkspaceEdit();
                const collapsed = this.buildCollapsedTranslationExpressionEdit(
                    doc,
                    keyInfo!.range,
                    key,
                    targetKey,
                );
                if (collapsed) {
                    edit.replace(documentUri, collapsed.range, collapsed.newText);
                } else if (targetKey !== key) {
                    edit.replace(documentUri, keyInfo!.range, targetKey);
                }
                const applied = await vscode.workspace.applyEdit(edit);
                if (applied) {
                    await doc.save();
                }
            }
            vscode.window.showInformationMessage(
                `AI Localizer: Restored "${targetKey}" from ${recovery.source}.`,
            );
            return;
        }
        this.log?.appendLine(`[MissingRefFix] Git recovery failed for "${key}".`);

        // STEP 3: Show options (only as fallback)
        const items: vscode.QuickPickItem[] = [];

        if (bestKey && bestKey !== key) {
            const bestParts = bestKey.split('.').filter(Boolean);
            const bestLeaf = bestParts[bestParts.length - 1] || '';
            const maxLen = Math.max(bestLeaf.length, keyLeaf.length);
            if (maxLen > 0 && bestScore <= Math.max(3, Math.floor(maxLen / 2))) {
                items.push({
                    label: `$(replace) Replace with: ${bestKey}`,
                    description: `Similar key found (edit distance: ${bestScore})`,
                    detail: 'Use closest matching translation key in the same namespace',
                });
            }
        }

        const suggestedLabel = buildLabelFromKeySegment(keyLeaf) || key;

        items.push({
            label: `$(add) Create new key with value: "${suggestedLabel}"`,
            description: 'Create a new locale entry using this key',
            detail: `Key: ${targetKey}`,
        });

        items.push({
            label: '$(edit) Create new key with custom value...',
            description: 'Enter a custom translation value',
        });

        const choice = await vscode.window.showQuickPick(items, {
            placeHolder: `AI Localizer: Fix missing "${key}" (no git history found)`,
        });
        if (!choice) return;

        if (choice.label.startsWith('$(replace)') && bestKey) {
            const vsPosition = new vscode.Position(position.line, position.character);
            const keyInfo = extractKeyAtPosition(doc, vsPosition);
            if (!keyInfo || keyInfo.key !== key) {
                vscode.window.showInformationMessage(
                    `AI Localizer: Could not locate "${key}" at this position.`,
                );
                return;
            }

            const edit = new vscode.WorkspaceEdit();
            edit.replace(documentUri, keyInfo.range, bestKey);
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                vscode.window.showErrorMessage(
                    'AI Localizer: Failed to apply reference fix to source file.',
                );
                return;
            }
            await doc.save();
            vscode.window.showInformationMessage(
                `AI Localizer: Replaced "${key}" with "${bestKey}".`,
            );
            return;
        }

        if (choice.label.includes('custom value')) {
            const customValue = await vscode.window.showInputBox({
                prompt: `Enter translation value for "${targetKey}"`,
                value: suggestedLabel,
                placeHolder: 'Translation value...',
            });
            if (!customValue) return;
            if (isLaravelSource) {
                await setLaravelTranslationValue(folder, defaultLocale, targetKey, customValue);
            } else {
                await setTranslationValue(folder, defaultLocale, targetKey, customValue, { rootName });
            }

            if (canReplaceReference) {
                const edit = new vscode.WorkspaceEdit();
                const collapsed = this.buildCollapsedTranslationExpressionEdit(
                    doc,
                    keyInfo!.range,
                    key,
                    targetKey,
                );
                if (collapsed) {
                    edit.replace(documentUri, collapsed.range, collapsed.newText);
                } else if (targetKey !== key) {
                    edit.replace(documentUri, keyInfo!.range, targetKey);
                }
                const applied = await vscode.workspace.applyEdit(edit);
                if (applied) {
                    await doc.save();
                }
            }
            vscode.window.showInformationMessage(
                `AI Localizer: Created "${targetKey}" = "${customValue}" in locale ${defaultLocale}.`,
            );
            return;
        }

        // Default: create with suggested label
        if (isLaravelSource) {
            await setLaravelTranslationValue(folder, defaultLocale, targetKey, suggestedLabel);
        } else {
            await setTranslationValue(folder, defaultLocale, targetKey, suggestedLabel, { rootName });
        }

        if (canReplaceReference) {
            const edit = new vscode.WorkspaceEdit();
            const collapsed = this.buildCollapsedTranslationExpressionEdit(
                doc,
                keyInfo!.range,
                key,
                targetKey,
            );
            if (collapsed) {
                edit.replace(documentUri, collapsed.range, collapsed.newText);
            } else if (targetKey !== key) {
                edit.replace(documentUri, keyInfo!.range, targetKey);
            }
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
            }
        }
        vscode.window.showInformationMessage(
            `AI Localizer: Created "${targetKey}" = "${suggestedLabel}" in locale ${defaultLocale}.`,
        );
    }

    /**
     * Add a key's default value to the auto-ignore list
     */
    async addKeyToIgnoreList(folderUri: vscode.Uri, key: string): Promise<void> {
        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(key);
        if (!record) {
            vscode.window.showInformationMessage(
                `AI Localizer: No translation record found for key ${key}.`,
            );
            return;
        }

        const defaultValue = record.locales.get(record.defaultLocale);
        if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
            vscode.window.showInformationMessage(
                `AI Localizer: No default value found for key ${key}.`,
            );
            return;
        }

        const scriptsDir = vscode.Uri.joinPath(folderUri, 'scripts');
        const ignoreUri = vscode.Uri.joinPath(scriptsDir, '.i18n-auto-ignore.json');
        let ignoreData: { exact?: string[]; exactInsensitive?: string[]; contains?: string[] } = {
            exact: [],
            exactInsensitive: [],
            contains: [],
        };

        try {
            const data = await vscode.workspace.fs.readFile(ignoreUri);
            const raw = sharedDecoder.decode(data);
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                ignoreData = {
                    exact: Array.isArray(parsed.exact) ? parsed.exact : [],
                    exactInsensitive: Array.isArray(parsed.exactInsensitive) ? parsed.exactInsensitive : [],
                    contains: Array.isArray(parsed.contains) ? parsed.contains : [],
                };
            }
        } catch {
            // File doesn't exist, use defaults
        }

        const normalizedValue = defaultValue.replace(/\s+/g, ' ').trim();
        if (!ignoreData.exact!.includes(normalizedValue)) {
            ignoreData.exact!.push(normalizedValue);
        }

        const payload = JSON.stringify(ignoreData, null, 2) + '\n';
        await vscode.workspace.fs.writeFile(ignoreUri, sharedEncoder.encode(payload));

        await vscode.commands.executeCommand('ai-localizer.i18n.rescan');

        vscode.window.showInformationMessage(
            `AI Localizer: Added "${normalizedValue}" to ignore list. Diagnostics will be refreshed.`,
        );
    }

    /**
     * Bulk fix missing translation key references in a ts/tsx file
     * Optimized version using batch recovery with parallel processing
     */
    async bulkFixMissingKeyReferences(documentUri: vscode.Uri): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(documentUri);
        const languageId = doc.languageId;

        const supportedLanguages = [
            'typescript', 'typescriptreact',
            'javascript', 'javascriptreact',
            'vue',
            'php', 'blade',
        ];

        if (!supportedLanguages.includes(languageId)) {
            vscode.window.showWarningMessage(
                'AI Localizer: Bulk fix is available for JS/TS/JSX/TSX/Vue/PHP/Blade files.',
            );
            return;
        }

        const isLaravelSource = languageId === 'php' || languageId === 'blade';

        // Check if another operation is blocking
        if (!(await this.canProceed('key-management', 'Bulk Fix Missing References'))) {
            return;
        }

        let folder = vscode.workspace.getWorkspaceFolder(documentUri) ?? undefined;
        if (!folder) {
            folder = await pickWorkspaceFolder();
        }
        if (!folder) {
            vscode.window.showInformationMessage('AI Localizer: No workspace folder available.');
            return;
        }

        this.log?.appendLine(
            `[BulkFixMissingRefs] Starting for ${documentUri.fsPath} (lang=${languageId})`,
        );

        // Extract all translation keys from the file
        const text = doc.getText();
        const commentRanges = findCommentRanges(text);
        const keyMatches: Array<{ key: string; range: vscode.Range; hasVariables: boolean }> = [];

        if (isLaravelSource) {
            const patterns: Array<{ regex: RegExp; keyGroupIndex: number }> = [
                {
                    regex: /\b__\s*\(\s*(['"])([A-Za-z0-9_\.\-]+)\1\s*(?:,|\))/g,
                    keyGroupIndex: 2,
                },
                {
                    regex: /\btrans\s*\(\s*(['"])([A-Za-z0-9_\.\-]+)\1\s*(?:,|\))/g,
                    keyGroupIndex: 2,
                },
                {
                    regex: /@lang\s*\(\s*(['"])([A-Za-z0-9_\.\-]+)\1\s*(?:,|\))/g,
                    keyGroupIndex: 2,
                },
            ];

            for (const { regex, keyGroupIndex } of patterns) {
                regex.lastIndex = 0;
                let match;
                // eslint-disable-next-line no-cond-assign
                while ((match = regex.exec(text)) !== null) {
                    const matchIndex = match.index;

                    if (isPositionInComment(matchIndex, commentRanges)) {
                        continue;
                    }

                    const key = match[keyGroupIndex] as string;
                    if (!key) {
                        continue;
                    }

                    const quoteChar = match[1] as string;
                    const fullMatch = match[0] as string;
                    const quotePosInMatch = fullMatch.indexOf(quoteChar);
                    if (quotePosInMatch === -1) {
                        continue;
                    }
                    const keyStartPosition = matchIndex + quotePosInMatch + 1;

                    const startPos = doc.positionAt(keyStartPosition);
                    const endPos = doc.positionAt(keyStartPosition + key.length);
                    const range = new vscode.Range(startPos, endPos);
                    keyMatches.push({ key, range, hasVariables: false });
                }
            }
        } else {
            const tCallRegex = /\b(\$?)t\s*\(\s*(['"])([A-Za-z0-9_\.\-]+)\2\s*([,)])/g;
            let match;
            // eslint-disable-next-line no-cond-assign
            while ((match = tCallRegex.exec(text)) !== null) {
                const dollarSignLength = match[1] ? 1 : 0;
                const tCallStart = match.index + dollarSignLength;

                if (isPositionInComment(tCallStart, commentRanges)) {
                    continue;
                }

                const key = match[3];
                const afterKey = match[4];
                const hasVariables = afterKey === ',';

                const quoteChar = match[2];
                const searchStart = dollarSignLength + 2;
                const quotePosInMatch = match[0].indexOf(quoteChar, searchStart);
                const keyStartPosition = match.index + quotePosInMatch + 1;

                const startPos = doc.positionAt(keyStartPosition);
                const endPos = doc.positionAt(keyStartPosition + key.length);
                const range = new vscode.Range(startPos, endPos);
                keyMatches.push({ key, range, hasVariables });
            }
        }

        if (keyMatches.length === 0) {
            vscode.window.showInformationMessage(
                'AI Localizer: No translation key references found in this file.',
            );
            return;
        }

        await this.i18nIndex.ensureInitialized();
        const allKeys = this.i18nIndex.getAllKeys();
        const validKeysSet = new Set<string>();

        if (isLaravelSource) {
            for (const key of allKeys) {
                if (!key) continue;
                const record = this.i18nIndex.getRecord(key);
                if (!record) continue;
                const hasLaravelLocation = record.locations.some((loc) => {
                    const fsPath = loc.uri.fsPath.replace(/\\/g, '/');
                    return fsPath.includes('/lang/') || fsPath.includes('/resources/lang/');
                });
                if (hasLaravelLocation) {
                    validKeysSet.add(key);
                }
            }
        } else {
            for (const key of allKeys) {
                if (!key) continue;
                validKeysSet.add(key);
            }
        }
        const missingKeys: Array<{ key: string; range: vscode.Range; hasVariables: boolean }> = [];

        for (const { key, range, hasVariables } of keyMatches) {
            if (!validKeysSet.has(key)) {
                missingKeys.push({ key, range, hasVariables });
            }
        }

        if (missingKeys.length === 0) {
            vscode.window.showInformationMessage(
                'AI Localizer: All translation keys in this file are valid.',
            );
            return;
        }

        const progressMessage = `Found ${missingKeys.length} missing translation key(s). Fixing...`;
        
        let finalFixedKeys: string[] = [];

        // Acquire lock for bulk key management
        await operationLock.withGlobalLock(
            'key-management',
            'Bulk Fix Missing References',
            async () => {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'AI Localizer: Bulk Fix Missing References',
                        cancellable: false,
                    },
                    async (progress) => {
                        progress.report({ message: progressMessage });

                        const startTime = Date.now();
                        const edit = new vscode.WorkspaceEdit();
                        const cfg = vscode.workspace.getConfiguration('ai-localizer');
                        const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';
                        const rootName = deriveRootFromFile(folder!, documentUri);
                        const batchUpdates = new Map<string, { value: string; rootName?: string }>();

                        let fixedCount = 0;
                        let createdCount = 0;

                        // Clear old caches for fresh batch operation
                        clearLocaleCaches();

                        // Build prefix index for faster typo-fix candidate lookup
                        const keysByPrefix = new Map<string, Array<{ key: string; leaf: string }>>();
                        for (const candidate of allKeys) {
                            if (!candidate) continue;
                            const parts = candidate.split('.').filter(Boolean);
                            if (!parts.length) continue;
                            const prefix = parts.slice(0, -1).join('.');
                            const leaf = parts[parts.length - 1] || '';
                            if (!keysByPrefix.has(prefix)) {
                                keysByPrefix.set(prefix, []);
                            }
                            keysByPrefix.get(prefix)!.push({ key: candidate, leaf });
                        }

                        // PHASE 1: Try to fix typos first (fast, no git needed)
                        const keysNeedingRecovery: Array<{ key: string; range: vscode.Range; hasVariables: boolean; targetKey: string }> = [];
                        
                        for (const { key, range, hasVariables } of missingKeys) {
                            const keyParts = key.split('.').filter(Boolean);
                            const keyPrefix = keyParts.slice(0, -1).join('.');
                            const keyLeaf = keyParts[keyParts.length - 1] || '';

                            let bestKey: string | null = null;
                            let bestScore = Number.POSITIVE_INFINITY;

                            const candidates = keysByPrefix.get(keyPrefix) || [];
                            for (const { key: candidateKey, leaf } of candidates) {
                                const score = computeEditDistance(keyLeaf, leaf);
                                if (score < bestScore) {
                                    bestScore = score;
                                    bestKey = candidateKey;
                                }
                            }

                            if (bestKey) {
                                const bestParts = bestKey.split('.').filter(Boolean);
                                const bestLeaf = bestParts[bestParts.length - 1] || '';
                                const maxLen = Math.max(bestLeaf.length, keyLeaf.length);
                                if (maxLen > 0 && bestScore <= Math.max(2, Math.floor(maxLen / 4))) {
                                    edit.replace(documentUri, range, bestKey);
                                    fixedCount++;
                                    continue;
                                }
                            }

                            const normalizedKey = !isLaravelSource
                                ? this.buildNormalizedMissingReferenceKey(folder!, documentUri, key)
                                : null;
                            const targetKey = normalizedKey || key;

                            if (targetKey !== key && validKeysSet.has(targetKey)) {
                                const collapsed = this.buildCollapsedTranslationExpressionEdit(
                                    doc,
                                    range,
                                    key,
                                    targetKey,
                                );
                                if (collapsed) {
                                    edit.replace(documentUri, collapsed.range, collapsed.newText);
                                } else {
                                    edit.replace(documentUri, range, targetKey);
                                }
                                fixedCount++;
                                continue;
                            }

                            const lineText = doc.lineAt(range.start.line).text;
                            const inlineDefault = !isLaravelSource
                                ? this.extractInlineDefaultForKeyFromLine(lineText, key)
                                : null;

                            if (inlineDefault && inlineDefault.trim()) {
                                const value = inlineDefault.trim();
                                const collapsed = this.buildCollapsedTranslationExpressionEdit(
                                    doc,
                                    range,
                                    key,
                                    targetKey,
                                );
                                if (collapsed) {
                                    edit.replace(documentUri, collapsed.range, collapsed.newText);
                                } else if (targetKey !== key) {
                                    edit.replace(documentUri, range, targetKey);
                                }
                                batchUpdates.set(targetKey, { value, rootName });
                                createdCount++;
                                continue;
                            }
                            
                            // Key needs recovery from git
                            keysNeedingRecovery.push({ key, range, hasVariables, targetKey });
                        }

                        const keysNeedingReview: Array<{ key: string; generatedValue: string }> = [];
                        let recoveredCount = 0;

                        if (keysNeedingRecovery.length > 0) {
                            progress.report({
                                message: `Recovering ${keysNeedingRecovery.length} key(s) from git history...`,
                            });

                            const batchRecovery = getBatchRecoveryHandler(this.context, this.log);
                            const extractRef = batchRecovery.getExtractCommitRef(folder!);

                            const keysToRecover = keysNeedingRecovery.map((k) => k.key);
                            const recoveryResults = await batchRecovery.recoverKeysBatch(
                                folder!,
                                keysToRecover,
                                defaultLocale,
                                {
                                    daysBack: 365,
                                    maxCommitsPerFile: 100,
                                    extractRef,
                                },
                            );

                            const unresolvedKeys: string[] = [];

                            for (const { key, range, targetKey } of keysNeedingRecovery) {
                                const result = recoveryResults.get(key);

                                if (result && result.value) {
                                    const collapsed = this.buildCollapsedTranslationExpressionEdit(
                                        doc,
                                        range,
                                        key,
                                        targetKey,
                                    );
                                    if (collapsed) {
                                        edit.replace(documentUri, collapsed.range, collapsed.newText);
                                    } else if (targetKey !== key) {
                                        edit.replace(documentUri, range, targetKey);
                                    }
                                    batchUpdates.set(targetKey, { value: result.value, rootName });
                                    createdCount++;
                                    recoveredCount++;
                                    continue;
                                }

                                let sourceRecovery: { value: string } | null = null;
                                try {
                                    sourceRecovery = await this.gitRecoveryHandler.recoverFromSourceFileHistory(
                                        folder!,
                                        documentUri.fsPath,
                                        key,
                                        defaultLocale,
                                        365,
                                        '[BulkMissingRef]',
                                    );
                                } catch {
                                    sourceRecovery = null;
                                }

                                if (sourceRecovery && sourceRecovery.value) {
                                    const collapsed = this.buildCollapsedTranslationExpressionEdit(
                                        doc,
                                        range,
                                        key,
                                        targetKey,
                                    );
                                    if (collapsed) {
                                        edit.replace(documentUri, collapsed.range, collapsed.newText);
                                    } else if (targetKey !== key) {
                                        edit.replace(documentUri, range, targetKey);
                                    }
                                    batchUpdates.set(targetKey, { value: sourceRecovery.value, rootName });
                                    createdCount++;
                                    recoveredCount++;
                                    continue;
                                }

                                unresolvedKeys.push(key);
                            }

                            let aiDefaults = new Map<string, string>();
                            if (unresolvedKeys.length > 0) {
                                try {
                                    aiDefaults = await this.inferDefaultValuesForMissingKeysWithAI(
                                        text,
                                        unresolvedKeys,
                                    );
                                } catch {
                                    aiDefaults = new Map<string, string>();
                                }
                            }

                            for (const key of unresolvedKeys) {
                                const aiValue = aiDefaults.get(key);
                                if (aiValue && aiValue.trim()) {
                                    const entry = keysNeedingRecovery.find((k) => k.key === key);
                                    const targetKey = entry?.targetKey || key;
                                    if (entry && entry.targetKey !== key) {
                                        edit.replace(documentUri, entry.range, entry.targetKey);
                                    }
                                    batchUpdates.set(targetKey, { value: aiValue.trim(), rootName });
                                    createdCount++;
                                    continue;
                                }

                                const keyParts = key.split('.').filter(Boolean);
                                const lastSegment = keyParts[keyParts.length - 1] || '';
                                let label = buildLabelFromKeySegment(lastSegment) || key;

                                if (/last[_\s]+(\d+)\b/i.test(lastSegment) && !/\bdays?\b/i.test(label)) {
                                    const replaced = label.replace(/last\s+(\d+)\b/i, 'last $1 days');
                                    label = replaced !== label ? replaced : `${label} days`;
                                }

                                const entry = keysNeedingRecovery.find((k) => k.key === key);
                                const targetKey = entry?.targetKey || key;
                                if (entry && entry.targetKey !== key) {
                                    edit.replace(documentUri, entry.range, entry.targetKey);
                                }
                                batchUpdates.set(targetKey, { value: label, rootName });
                                createdCount++;
                                keysNeedingReview.push({ key: targetKey, generatedValue: label });
                            }
                        }

                        // PHASE 3: Apply edits and write batch updates
                        if (edit.size > 0) {
                            const applied = await vscode.workspace.applyEdit(edit);
                            if (applied) {
                                await doc.save();
                            }
                        }

                        if (batchUpdates.size > 0) {
                            try {
                                if (isLaravelSource) {
                                    for (const [key, { value }] of batchUpdates.entries()) {
                                        await setLaravelTranslationValue(folder!, defaultLocale, key, value);
                                    }
                                } else {
                                    await setTranslationValuesBatch(folder!, defaultLocale, batchUpdates);
                                }
                            } catch (applyErr) {
                                this.log?.appendLine(
                                    `[BulkFixMissingRefs] Failed to write ${batchUpdates.size} batch update(s): ${String(applyErr)}`,
                                );
                                throw applyErr;
                            }
                        }

                        // PHASE 4: Sync keys to other locales
                        if (batchUpdates.size > 0) {
                            progress.report({ message: 'Syncing to other locales...' });
                            try {
                                const syncService = getGranularSyncService(this.context);
                                const keysToSync = Array.from(batchUpdates.keys());
                                await syncService.syncKeys(folder!, keysToSync, { verbose: false });
                                this.log?.appendLine(`[BulkFixMissingRefs] Synced ${keysToSync.length} keys to other locales`);
                            } catch (syncErr) {
                                this.log?.appendLine(`[BulkFixMissingRefs] Locale sync warning: ${String(syncErr)}`);
                            }
                        }

                        if (keysNeedingReview.length > 0) {
                            await this.generateReviewReport(folder!, documentUri, keysNeedingReview);
                        }

                        finalFixedKeys = Array.from(batchUpdates.keys());

                        const elapsed = Date.now() - startTime;
                        const recoveryRate = keysNeedingRecovery.length > 0 
                            ? Math.round((recoveredCount / keysNeedingRecovery.length) * 100) 
                            : 100;
                        
                        let message = `Fixed ${fixedCount} typo(s), created ${createdCount} key(s) (${recoveryRate}% recovered from git) in ${elapsed}ms.`;
                        if (keysNeedingReview.length > 0) {
                            message += ` ${keysNeedingReview.length} key(s) need review.`;
                        }
                        
                        this.log?.appendLine(`[BulkFixMissingRefs] ${message}`);
                        vscode.window.showInformationMessage(`AI Localizer: ${message}`);
                    },
                );
            }
        );

        // Refresh diagnostics outside the key-management lock to avoid thrashing
        if (finalFixedKeys.length > 0) {
            try {
                // Invalidate stale report entries
                await vscode.commands.executeCommand(
                    'ai-localizer.i18n.invalidateReportKeys',
                    finalFixedKeys,
                );

                // Trigger rescan to refresh diagnostics
                await vscode.commands.executeCommand('ai-localizer.i18n.rescan');

                // Also refresh diagnostics for the current file
                await vscode.commands.executeCommand(
                    'ai-localizer.i18n.refreshFileDiagnostics',
                    documentUri,
                    finalFixedKeys,
                );
            } catch (refreshErr) {
                this.log?.appendLine(
                    `[BulkFixMissingRefs] Diagnostics refresh warning: ${String(refreshErr)}`,
                );
            }
        }
    }

    private async inferDefaultValuesForMissingKeysWithAI(
        fileText: string,
        keys: string[],
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        if (!this.translationService || !keys.length) {
            return result;
        }

        let apiKey = '';
        try {
            apiKey = await this.translationService.getApiKey();
        } catch {
            apiKey = '';
        }

        if (!apiKey) {
            return result;
        }

        const uniqueKeys = Array.from(new Set(keys.filter((k) => typeof k === 'string' && k.trim())));
        if (!uniqueKeys.length) {
            return result;
        }

        const snippetLimit = 12000;
        let context = fileText || '';
        if (context.length > snippetLimit) {
            context = context.slice(0, snippetLimit);
        }

        const keyList = uniqueKeys.join('\n');
        const questionLines = [
            'We have an i18n system using t("keyPath") calls in a React/TypeScript codebase.',
            'For each key below, guess a concise, natural-sounding English UI text suitable for the default locale (en).',
            'Respond with one key per line in this exact format:',
            '<key>\t<value>',
            'Do not include any other commentary or explanation.',
            '',
            'Keys:',
            keyList,
        ];
        const question = questionLines.join('\n');

        let answer: string;
        try {
            answer = await this.translationService.askQuestion(question, context);
        } catch {
            return result;
        }

        if (!answer) {
            return result;
        }

        const wanted = new Set(uniqueKeys);
        const lines = answer.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
            const idx = line.indexOf('\t');
            if (idx <= 0) {
                continue;
            }
            const key = line.slice(0, idx).trim();
            const value = line.slice(idx + 1).trim();
            if (!key || !value || !wanted.has(key)) {
                continue;
            }
            result.set(key, value);
        }

        return result;
    }

    /**
     * Generate a JSON report for keys that couldn't be recovered from git
     */
    private async generateReviewReport(
        folder: vscode.WorkspaceFolder,
        sourceUri: vscode.Uri,
        keysNeedingReview: Array<{ key: string; generatedValue: string }>,
    ): Promise<void> {
        if (keysNeedingReview.length === 0) return;

        const scriptsDir = vscode.Uri.joinPath(folder.uri, 'scripts');
        const reportUri = vscode.Uri.joinPath(scriptsDir, '.i18n-review-generated.json');

        try {
            // Ensure scripts directory exists
            try {
                await vscode.workspace.fs.createDirectory(scriptsDir);
            } catch {
                // Directory might already exist
            }

            // Load existing report if any
            let existingReport: any = { files: [] };
            try {
                const data = await vscode.workspace.fs.readFile(reportUri);
                existingReport = JSON.parse(sharedDecoder.decode(data));
            } catch {
                // No existing report
            }

            const relativePath = path.relative(folder.uri.fsPath, sourceUri.fsPath).replace(/\\/g, '/');
            const timestamp = new Date().toISOString();

            // Find or create file entry
            let fileEntry = existingReport.files?.find((f: any) => f.file === relativePath);
            if (!fileEntry) {
                fileEntry = { file: relativePath, issues: [] };
                if (!existingReport.files) {
                    existingReport.files = [];
                }
                existingReport.files.push(fileEntry);
            }

            // Add new issues (avoid duplicates) and keep compact fields
            fileEntry.issues = Array.isArray(fileEntry.issues) ? fileEntry.issues : [];
            const existingKeys = new Set(fileEntry.issues.map((i: any) => i.key));
            for (const { key, generatedValue } of keysNeedingReview) {
                if (existingKeys.has(key)) continue;
                fileEntry.issues.push({
                    key,
                    value: generatedValue,
                });
            }

            // Rewrite in compact form: only file and key/value pairs
            const compact = {
                files: existingReport.files.map((f: any) => ({
                    file: f.file,
                    issues: Array.isArray(f.issues)
                        ? f.issues.map((i: any) => ({ key: i.key, value: i.value ?? i.generatedValue ?? '' }))
                        : [],
                })),
            };

            const payload = JSON.stringify(compact, null, 2) + '\n';
            await vscode.workspace.fs.writeFile(reportUri, sharedEncoder.encode(payload));

            this.log?.appendLine(
                `[BulkFixMissingRefs] Generated review report (compact): ${keysNeedingReview.length} keys added to ${reportUri.fsPath}`,
            );
        } catch (err) {
            this.log?.appendLine(`[BulkFixMissingRefs] Failed to generate review report: ${String(err)}`);
        }
    }

    /**
     * Delete a key from multiple locale files with guard
     */
    async deleteKeyFromLocaleFiles(
        keyPath: string,
        uris: vscode.Uri[],
        defaultValue?: string,
    ): Promise<number> {
        if (!uris.length) return 0;

        const changedUris: vscode.Uri[] = [];

        for (const uri of uris) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') {
                    continue;
                }

                let root: any = await readJsonFile(uri) || {};
                if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

                const currentValue = getNestedValue(root, keyPath);
                const valueToRestore = defaultValue || (typeof currentValue === 'string' ? currentValue : '');

                if (valueToRestore) {
                    const allowed = await this.guardDeleteDefaultLocaleKey(uri, keyPath, valueToRestore);
                    if (!allowed) continue;
                }

                if (!deleteKeyPathInObject(root, keyPath)) {
                    continue;
                }

                await writeJsonFile(uri, root);
                changedUris.push(uri);
            } catch {
                // Ignore failures for individual locale files
            }
        }

        for (const uri of changedUris) {
            try {
                await this.i18nIndex.updateFile(uri);
                await vscode.commands.executeCommand(
                    'ai-localizer.i18n.refreshFileDiagnostics',
                    uri,
                    [keyPath],
                );
            } catch {
                // Ignore failures during diagnostics refresh
            }
        }

        return changedUris.length;
    }

    /**
     * Guard: Prevent deletion of default locale keys that are used in components
     */
    async guardDeleteDefaultLocaleKey(
        localeUri: vscode.Uri,
        keyPath: string,
        defaultValue: string,
    ): Promise<boolean> {
        const folder = vscode.workspace.getWorkspaceFolder(localeUri);
        if (!folder) return true;

        const cfg = vscode.workspace.getConfiguration('ai-localizer');
        const defaultLocale = cfg.get<string>('i18n.defaultLocale') || 'en';

        const localePath = localeUri.fsPath.toLowerCase();
        const isDefaultLocale = localePath.includes(`/${defaultLocale}/`) ||
            localePath.includes(`/${defaultLocale}.json`);

        if (!isDefaultLocale) return true;

        await this.i18nIndex.ensureInitialized();
        const record = this.i18nIndex.getRecord(keyPath);
        const isUsed = record && record.locations.length > 0;

        if (!isUsed) return true;

        const message = `Key "${keyPath}" is used in ${record.locations.length} component(s). Deleting it will cause missing translations.`;
        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            'Delete Anyway',
            'Cancel',
        );

        if (choice !== 'Delete Anyway') return false;

        // Show restore option after 5 seconds
        const guardKey = `${localeUri.toString()}:${keyPath}`;
        const timeout = setTimeout(async () => {
            this.deletionGuardPending.delete(guardKey);
            const restoreChoice = await vscode.window.showInformationMessage(
                `Key "${keyPath}" was deleted. You can restore it from git history.`,
                'Restore from Git History',
                'Dismiss',
            );
            if (restoreChoice === 'Restore from Git History') {
                await this.restoreDeletedKey(localeUri, keyPath, defaultValue, folder);
            }
        }, 5000);

        this.deletionGuardPending.set(guardKey, {
            key: keyPath,
            value: defaultValue,
            timeout,
        });

        return true;
    }

    /**
     * Restore a deleted key, trying git history first if value is not provided
     */
    private async restoreDeletedKey(
        localeUri: vscode.Uri,
        keyPath: string,
        value: string,
        folder: vscode.WorkspaceFolder,
    ): Promise<void> {
        try {
            let restoreValue = value;

            if (!restoreValue || !restoreValue.trim()) {
                const historyResult = await findKeyInHistory(folder, localeUri.fsPath, keyPath, 30);
                if (historyResult && historyResult.value) {
                    restoreValue = historyResult.value;
                } else if (this.context) {
                    const extractRef = CommitTracker.getExtractCommitRef(this.context, folder);
                    if (extractRef) {
                        const content = await getFileContentAtCommit(
                            folder,
                            localeUri.fsPath,
                            extractRef.commitHash,
                        );
                        if (content) {
                            try {
                                const json = JSON.parse(content);
                                const recovered = getNestedValue(json, keyPath);
                                if (recovered && typeof recovered === 'string') {
                                    restoreValue = recovered;
                                }
                            } catch {
                                // Invalid JSON
                            }
                        }
                    }
                }
            }

            if (!restoreValue || !restoreValue.trim()) {
                vscode.window.showWarningMessage(
                    `AI Localizer: Could not recover value for key "${keyPath}" from git history.`,
                );
                return;
            }

            let root: any = await readJsonFile(localeUri) || {};

            setNestedValue(root, keyPath, restoreValue);
            await writeJsonFile(localeUri, root);

            await this.i18nIndex.updateFile(localeUri);
            vscode.window.showInformationMessage(`AI Localizer: Restored key "${keyPath}".`);
        } catch (err) {
            console.error('AI Localizer: Failed to restore deleted key:', err);
            vscode.window.showErrorMessage('AI Localizer: Failed to restore deleted key.');
        }
    }
}



