/**
 * String detection utility for selection-based commands
 * Extracted from ConvertSelectionCommand to reduce size and improve reusability
 */

import * as vscode from 'vscode';
import { STRING_PATTERNS, CODE_PATTERNS } from './StringPatterns';
import { isTranslatableText as isTranslatableTextShared } from '../../../core/textValidation';

export interface StringCandidate {
    range: vscode.Range;
    text: string;
}

export class SelectionStringDetector {
    private document: vscode.TextDocument;
    private selection: vscode.Range;
    private langId: string;
    private baseOffset: number;
    private selectionText: string;

    constructor(document: vscode.TextDocument, selection: vscode.Range) {
        this.document = document;
        this.selection = selection;
        this.langId = document.languageId;
        this.baseOffset = document.offsetAt(selection.start);
        this.selectionText = document.getText(selection);
    }

    /**
     * Find candidate string segments within the current selection
     */
    findCandidates(): StringCandidate[] {
        const candidates: StringCandidate[] = [];

        const isJsLike = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'vue'].includes(this.langId);
        const isBladeLike = this.langId === 'blade' || this.langId === 'php';

        if (isJsLike) {
            candidates.push(...this.findJsxCandidates());
            if (candidates.length === 0) {
                candidates.push(...this.findPropertyCandidates());
            }
            if (candidates.length === 0) {
                candidates.push(...this.findGenericStringCandidates());
            }
            if (candidates.length === 0) {
                candidates.push(...this.findTemplateCandidates());
            }
        }

        if (isBladeLike) {
            candidates.push(...this.findBladeCandidates());
        }

        // Fallback: treat full selection as candidate if it passes validation
        if (candidates.length === 0) {
            candidates.push(...this.findFallbackCandidate());
        }

        return candidates;
    }

    /**
     * Find JSX expression strings: {'text'} or {"text"}
     */
    private findJsxCandidates(): StringCandidate[] {
        const candidates: StringCandidate[] = [];
        const jsxExprStringRegex = STRING_PATTERNS.jsxExpr;
        let jsxMatch: RegExpExecArray | null;

        while ((jsxMatch = jsxExprStringRegex.exec(this.selectionText)) !== null) {
            const quote = jsxMatch[1];
            const inner = jsxMatch[2];

            if (!this.isTranslatableText(inner)) {
                continue;
            }

            const matchText = jsxMatch[0];
            const quotePosInMatch = matchText.indexOf(quote);
            if (quotePosInMatch === -1) {
                continue;
            }

            const startOffset = this.baseOffset + jsxMatch.index + quotePosInMatch;
            const endOffset = startOffset + 1 + inner.length + 1;
            const startPos = this.document.positionAt(startOffset);
            const endPos = this.document.positionAt(endOffset);
            candidates.push({ range: new vscode.Range(startPos, endPos), text: inner.trim() });
        }

        return candidates;
    }

    /**
     * Find object property values: "description: `some text`"
     */
    private findPropertyCandidates(): StringCandidate[] {
        const candidates: StringCandidate[] = [];
        const propertyValueMatch = this.selectionText.match(STRING_PATTERNS.property);
        
        if (propertyValueMatch) {
            const quote = propertyValueMatch[1];
            const value = propertyValueMatch[2];
            
            // Find the position of the string value (not the whole property)
            const quoteIndex = this.selectionText.indexOf(quote, this.selectionText.indexOf(':'));
            if (quoteIndex !== -1) {
                const valueStartOffset = this.baseOffset + quoteIndex;
                const valueEndOffset = valueStartOffset + quote.length + value.length + quote.length;
                const startPos = this.document.positionAt(valueStartOffset);
                const endPos = this.document.positionAt(valueEndOffset);
                const range = new vscode.Range(startPos, endPos);

                if (quote === '`') {
                    const staticParts = this.extractStaticPartsFromTemplate(value);
                    const combined = staticParts.map(p => p.text).join(' ');
                    if (this.isTranslatableText(combined)) {
                        candidates.push({ range, text: combined.trim() });
                    }
                } else if (this.isTranslatableText(value)) {
                    candidates.push({ range, text: value.trim() });
                }
            }
        }

        return candidates;
    }

    /**
     * Find generic string literals (single and double quotes)
     */
    private findGenericStringCandidates(): StringCandidate[] {
        const candidates: StringCandidate[] = [];
        const stringRegex = STRING_PATTERNS.generic;
        let match: RegExpExecArray | null;

        while ((match = stringRegex.exec(this.selectionText)) !== null) {
            const full = match[0];
            const inner = match[2];
            
            if (!this.isTranslatableText(inner)) {
                continue;
            }

            const startOffset = this.baseOffset + match.index;
            const endOffset = startOffset + full.length;
            const startPos = this.document.positionAt(startOffset);
            const endPos = this.document.positionAt(endOffset);
            candidates.push({ range: new vscode.Range(startPos, endPos), text: inner.trim() });
        }

        return candidates;
    }

    /**
     * Find template literals (backticks)
     */
    private findTemplateCandidates(): StringCandidate[] {
        const candidates: StringCandidate[] = [];
        const templateRegex = STRING_PATTERNS.template;
        let match: RegExpExecArray | null;

        while ((match = templateRegex.exec(this.selectionText)) !== null) {
            const full = match[0];
            const inner = match[1];

            const staticParts = this.extractStaticPartsFromTemplate(inner);
            const combined = staticParts.map(p => p.text).join(' ');
            if (!this.isTranslatableText(combined)) {
                continue;
            }

            const startOffset = this.baseOffset + match.index;
            const endOffset = startOffset + full.length;
            const startPos = this.document.positionAt(startOffset);
            const endPos = this.document.positionAt(endOffset);
            candidates.push({ range: new vscode.Range(startPos, endPos), text: combined.trim() });
        }

        return candidates;
    }

    /**
     * Find Blade-specific string candidates
     */
    private findBladeCandidates(): StringCandidate[] {
        const candidates: StringCandidate[] = [];
        const arrayItemMatch = this.selectionText.match(STRING_PATTERNS.bladeArray);
        
        if (arrayItemMatch) {
            const valueQuote = arrayItemMatch[3];
            const value = arrayItemMatch[4];

            const arrowIndex = this.selectionText.indexOf('=>');
            const valueQuoteIndex = arrowIndex >= 0 ? this.selectionText.indexOf(valueQuote, arrowIndex) : -1;
            if (valueQuoteIndex !== -1) {
                const valueStartOffset = this.baseOffset + valueQuoteIndex;
                const valueEndOffset = valueStartOffset + valueQuote.length + value.length + valueQuote.length;
                const startPos = this.document.positionAt(valueStartOffset);
                const endPos = this.document.positionAt(valueEndOffset);
                const range = new vscode.Range(startPos, endPos);

                if (this.isTranslatableText(value)) {
                    candidates.push({ range, text: value.trim() });
                }
            }
        }

        if (candidates.length === 0) {
            const bladeStringRegex = STRING_PATTERNS.generic;
            let match: RegExpExecArray | null;
            
            while ((match = bladeStringRegex.exec(this.selectionText)) !== null) {
                const full = match[0];
                const inner = match[2];

                if (!this.isTranslatableText(inner)) {
                    continue;
                }

                const startOffset = this.baseOffset + match.index;
                const endOffset = startOffset + full.length;
                const startPos = this.document.positionAt(startOffset);
                const endPos = this.document.positionAt(endOffset);
                candidates.push({ range: new vscode.Range(startPos, endPos), text: inner.trim() });
            }
        }

        return candidates;
    }

    /**
     * Fallback: treat full selection as candidate if it passes validation
     */
    private findFallbackCandidate(): StringCandidate[] {
        const candidates: StringCandidate[] = [];
        const trimmed = this.selectionText.trim();

        // For JS-like languages, avoid using the entire selection when it looks like code
        const isJsLike = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'vue'].includes(this.langId);
        const looksLikeJsCode = isJsLike && CODE_PATTERNS.some(pattern => pattern.test(trimmed));

        if (!looksLikeJsCode && trimmed && this.isTranslatableText(trimmed)) {
            candidates.push({ range: this.selection, text: trimmed });
        }

        return candidates;
    }

    /**
     * Extract static parts from template literal
     */
    private extractStaticPartsFromTemplate(template: string): Array<{ text: string; offset: number }> {
        const parts: Array<{ text: string; offset: number }> = [];
        
        // Split by ${...} interpolations
        const segments = template.split(/\$\{[^}]*\}/);
        let currentOffset = 0;
        
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (segment.trim().length > 0) {
                parts.push({ text: segment, offset: currentOffset });
            }
            
            // Move offset forward by segment length + interpolation length
            currentOffset += segment.length;
            if (i < segments.length - 1) {
                // Find the interpolation that was removed
                const remainingTemplate = template.substring(currentOffset);
                const interpolationMatch = remainingTemplate.match(/^\$\{[^}]*\}/);
                if (interpolationMatch) {
                    currentOffset += interpolationMatch[0].length;
                }
            }
        }
        
        return parts;
    }

    /**
     * Check if text is translatable using shared validation logic
     */
    private isTranslatableText(text: string): boolean {
        return isTranslatableTextShared(text);
    }
}
