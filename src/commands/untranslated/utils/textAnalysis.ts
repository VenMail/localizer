/**
 * Compute Levenshtein edit distance between two strings
 * Optimized with single-row DP array
 */
export function computeEditDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp: number[] = [];
    for (let j = 0; j <= n; j += 1) dp[j] = j;
    for (let i = 1; i <= m; i += 1) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j += 1) {
            const temp = dp[j];
            if (a[i - 1] === b[j - 1]) {
                dp[j] = prev;
            } else {
                const add = dp[j - 1] + 1;
                const del = dp[j] + 1;
                const sub = prev + 1;
                dp[j] = add < del ? (add < sub ? add : sub) : del < sub ? del : sub;
            }
            prev = temp;
        }
    }
    return dp[n];
}

/**
 * Build a human-readable label from a key segment
 * e.g., "user_profile" -> "User profile"
 */
export function buildLabelFromKeySegment(segment: string): string {
    if (!segment) return '';
    const replaced = segment.replace(/[_\-]+/g, ' ');
    const parts = replaced.split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    return parts
        .map((p, index) => {
            const lower = p.toLowerCase();
            if (index === 0) {
                return lower.charAt(0).toUpperCase() + lower.slice(1);
            }
            return lower;
        })
        .join(' ');
}

/**
 * Check if a string looks like CSS classes (Tailwind, etc.)
 */
export function looksLikeCssClasses(str: string): boolean {
    const trimmed = str.trim();
    if (!trimmed) return false;

    const cssPatterns = [
        /^[a-z]+-[a-z0-9-]+(\s+[a-z]+-[a-z0-9-]+)*$/i,
        /\b(flex|grid|block|inline|hidden|absolute|relative|fixed)\b/,
        /\b(w-|h-|p-|m-|px-|py-|mx-|my-|pt-|pb-|pl-|pr-|mt-|mb-|ml-|mr-)/,
        /\b(text-|bg-|border-|rounded|shadow|overflow|cursor|opacity)/,
        /\b(sm:|md:|lg:|xl:|2xl:|hover:|focus:|active:|dark:)/,
        /\b(justify-|items-|self-|gap-|space-)/,
        /\b(font-|leading-|tracking-)/,
        /\b(z-\d|top-|bottom-|left-|right-)/,
        /^[a-z][a-z0-9]*(-[a-z0-9]+)+(\s|$)/,
    ];

    for (const pattern of cssPatterns) {
        if (pattern.test(trimmed)) {
            return true;
        }
    }

    const tokens = trimmed.split(/\s+/);
    if (tokens.length >= 2) {
        const cssLikeTokens = tokens.filter(t =>
            /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/i.test(t) ||
            /^(sm|md|lg|xl|2xl|hover|focus|dark):/.test(t)
        );
        if (cssLikeTokens.length / tokens.length >= 0.5) {
            return true;
        }
    }

    return false;
}

/**
 * Check if a string looks like a code identifier or technical pattern
 */
export function looksLikeCodePattern(str: string): boolean {
    const trimmed = str.trim();
    
    // Identifiers with underscores or alphanumerics (case-insensitive)
    // Covers snake_case, CONSTANT_CASE, and mixed-case with underscores (e.g., Error_Message)
    if (/^[a-z_][a-z0-9_]*$/i.test(trimmed) && !trimmed.includes(' ')) return true;
    if (/^[A-Z_][A-Z0-9_]*$/i.test(trimmed) && !trimmed.includes(' ')) return true;
    
    // camelCase or PascalCase identifiers (without spaces)
    if (/^[a-z][a-zA-Z0-9]*$/.test(trimmed) && !trimmed.includes(' ')) return true;
    
    // File paths and URLs
    if (/^(https?:|mailto:|tel:|\/\/|www\.)/.test(trimmed)) return true;
    if (/^[./\\]/.test(trimmed)) return true;
    if (/\.(ts|tsx|js|jsx|vue|json|css|scss|html|php|blade\.php)$/i.test(trimmed)) return true;
    
    // Template expressions
    if (/^\$\{.*\}$/.test(trimmed)) return true;
    if (/^\{\{.*\}\}$/.test(trimmed)) return true;
    
    // Intent/scheme patterns (Android) — anchor each alternative
    if (/^(intent:|scheme=|#Intent)/.test(trimmed)) return true;
    
    // Event names
    if (/^on[A-Z][a-zA-Z]*$/.test(trimmed)) return true;
    
    // HTML/JSX element names
    if (/^[a-z]+-[a-z-]+$/.test(trimmed)) return true;
    
    // Pure numbers or hex colors
    if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return true;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return true;
    
    // JSON/object keys
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*:$/.test(trimmed)) return true;
    
    // Import/export paths
    if (/^@\/|^\.\.?\/|^~\//.test(trimmed)) return true;
    
    return false;
}

/**
 * Check if a string looks like actual user-facing text
 */
export function looksLikeUserText(str: string): boolean {
    const trimmed = str.trim();
    if (!trimmed || trimmed.length < 2) return false;

    // Must contain at least one letter
    if (!/[a-zA-Z]/.test(trimmed)) return false;
    
    // Reject CSS classes
    if (looksLikeCssClasses(trimmed)) return false;
    
    // Reject code patterns
    if (looksLikeCodePattern(trimmed)) return false;

    // Positive indicators
    const hasSpaces = trimmed.includes(' ');
    const startsWithCapital = /^[A-Z]/.test(trimmed);
    const hasSentencePunctuation = /[.!?:]$/.test(trimmed);
    const hasCommonWords = /\b(the|and|or|to|is|are|was|has|have|this|that|your|our|please|click|tap|select|add|save|cancel|delete|edit|view|open|close|enter|submit|confirm|error|success|warning|loading|welcome|hello|hi|thanks|sorry|oops|done|next|back|continue|finish|start|stop|pause|play|search|find|filter|sort|show|hide|enable|disable|on|off|yes|no|ok|failed|try|again)\b/i.test(trimmed);
    const hasPlaceholder = /\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(trimmed);
    const hasUserTextPattern = /[A-Z][a-z]+(\s+[a-z]+)+/.test(trimmed);
    
    // Multi-word phrases are likely user text
    const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount >= 2) return true;
    
    return startsWithCapital || hasSentencePunctuation || hasCommonWords || hasPlaceholder || hasUserTextPattern;
}

/**
 * Calculate text relevance score based on hint words
 */
export function calculateTextRelevanceScore(text: string, hintWords: string[]): number {
    let score = 0;
    const textLower = text.toLowerCase();

    for (const hint of hintWords) {
        if (textLower.includes(hint)) {
            score += 10;
        }
    }

    if (/^[A-Z]/.test(text)) score += 2;
    if (/[.!?]$/.test(text)) score += 2;
    if (text.includes(' ')) score += 1;
    if (text.length >= 5 && text.length <= 100) score += 2;

    return score;
}

/**
 * Extract all user-facing text from source content with relevance scoring
 */
export function extractAllUserTextFromContent(
    content: string,
    hintWords: string[],
): Array<{ text: string; score: number }> {
    const candidates: Array<{ text: string; score: number }> = [];
    const seenTexts = new Set<string>();

    const addCandidate = (text: string, bonusScore: number = 0) => {
        const trimmed = text.trim();
        if (!trimmed || seenTexts.has(trimmed)) return;
        if (!looksLikeUserText(trimmed)) return;
        
        seenTexts.add(trimmed);
        const score = calculateTextRelevanceScore(trimmed, hintWords) + bonusScore;
        candidates.push({ text: trimmed, score });
    };

    // 1. JSX text content between tags
    const jsxTextPattern = />([^<>{]+)</g;
    let match;
    while ((match = jsxTextPattern.exec(content)) !== null) {
        addCandidate(match[1], 2);
    }

    // 2. JSX text props with high priority
    const propPatterns = [
        /\b(title|placeholder|alt|label|message|description|header|tooltip)\s*=\s*["']([^"']+)["']/gi,
        /\b(aria-label|aria-description)\s*=\s*["']([^"']+)["']/gi,
        /\b(buttonText|submitText|cancelText|confirmText|errorText|helperText)\s*=\s*["']([^"']+)["']/gi,
    ];
    for (const pattern of propPatterns) {
        pattern.lastIndex = 0;
        while ((match = pattern.exec(content)) !== null) {
            addCandidate(match[2], 5);
        }
    }

    // 3. Vue template interpolations (non-expression)
    const vueInterpolation = /\{\{\s*['"]([^'"{}]+)['"]\s*\}\}/g;
    while ((match = vueInterpolation.exec(content)) !== null) {
        addCandidate(match[1], 4);
    }

    // 4. Template literals with text (not pure expressions)
    const templateLiteralPattern = /`([^`$]+)`/g;
    while ((match = templateLiteralPattern.exec(content)) !== null) {
        addCandidate(match[1], 1);
    }

    // 5. String literals (excluding className and style assignments)
    const stringContexts = content.split('\n');
    for (const line of stringContexts) {
        // Skip className/style lines
        if (/className\s*=|style\s*=|styles\.|classes\./.test(line)) continue;
        
        // Extract double-quoted strings
        const doubleQuoted = /"([^"\\]|\\.){3,}"/g;
        while ((match = doubleQuoted.exec(line)) !== null) {
            const text = match[0].slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, ' ');
            addCandidate(text, 0);
        }
        
        // Extract single-quoted strings
        const singleQuoted = /'([^'\\]|\\.){3,}'/g;
        while ((match = singleQuoted.exec(line)) !== null) {
            const text = match[0].slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, ' ');
            addCandidate(text, 0);
        }
    }

    // 6. Object property values that look like labels
    const objectPropPattern = /(?:text|label|title|message|description|placeholder|content|header|tooltip|buttonText|errorMessage|successMessage):\s*["']([^"']+)["']/gi;
    while ((match = objectPropPattern.exec(content)) !== null) {
        addCandidate(match[1], 4);
    }

    // 7. Function call arguments that look like user text
    const funcCallPattern = /(?:showMessage|showError|showSuccess|toast|alert|confirm|notify|setError|setMessage|setTitle)\s*\(\s*["']([^"']+)["']/gi;
    while ((match = funcCallPattern.exec(content)) !== null) {
        addCandidate(match[1], 6);
    }

    return candidates;
}

/**
 * Extract hardcoded string from a line of source code
 */
export function extractHardcodedStringFromLine(line: string, key: string): string | null {
    const keyParts = key.split('.').filter(Boolean);
    const keyHint = keyParts[keyParts.length - 1]?.toLowerCase() || '';

    const hintWords = keyHint
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);

    // Skip lines that are className/style assignments
    if (/className\s*=|style\s*=|styles\[|classes\[/.test(line)) {
        return null;
    }

    const candidates: Array<{ text: string; score: number }> = [];

    // Extract double-quoted strings
    const doubleQuotePattern = /"((?:[^"\\]|\\.)*)"/g;
    let match;
    while ((match = doubleQuotePattern.exec(line)) !== null) {
        const str = match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
        processCandidate(str, hintWords, candidates);
    }

    // Extract single-quoted strings
    const singleQuotePattern = /'((?:[^'\\]|\\.)*)'/g;
    while ((match = singleQuotePattern.exec(line)) !== null) {
        const str = match[1].replace(/\\'/g, "'").replace(/\\n/g, ' ').trim();
        processCandidate(str, hintWords, candidates);
    }

    // Extract JSX text content (between > and <)
    const jsxTextPattern = />([^<>{]+)</g;
    while ((match = jsxTextPattern.exec(line)) !== null) {
        const str = match[1].trim();
        if (str) {
            processCandidate(str, hintWords, candidates, 3); // Bonus for JSX text
        }
    }

    // Extract template literal static parts
    const templatePattern = /`([^`$]+)`/g;
    while ((match = templatePattern.exec(line)) !== null) {
        const str = match[1].trim();
        processCandidate(str, hintWords, candidates);
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.text.length - a.text.length;
    });

    const best = candidates[0];
    // Lower threshold but require at least some positive signal
    if (best.score >= 3 || (candidates.length === 1 && looksLikeUserText(best.text))) {
        return best.text;
    }

    return null;
}

/**
 * Process a candidate string and add to candidates list if valid
 */
function processCandidate(
    str: string,
    hintWords: string[],
    candidates: Array<{ text: string; score: number }>,
    bonusScore: number = 0,
): void {
    if (!str || str.length < 2) return;
    if (!looksLikeUserText(str)) return;

    let score = bonusScore;
    const strLower = str.toLowerCase();

    // Score based on hint word matches
    for (const hintWord of hintWords) {
        if (strLower.includes(hintWord)) {
            score += 10;
        }
    }

    // Bonus for sentence-like structure
    if (/^[A-Z]/.test(str)) score += 2;
    if (/[.!?:]$/.test(str)) score += 2;
    if (str.includes(' ')) score += 2;
    
    // Bonus for appropriate length
    if (str.length >= 5 && str.length <= 150) score += 2;
    
    // Bonus for word count (multi-word phrases are more likely user text)
    const wordCount = str.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount >= 2) score += 3;
    if (wordCount >= 3) score += 2;
    
    // Bonus for containing common UI words
    if (/\b(please|click|tap|select|enter|submit|cancel|save|delete|edit|view|loading|error|success|warning)\b/i.test(str)) {
        score += 3;
    }

    // Penalty for looking like code
    if (/^\w+\(/.test(str) || /^[a-z][a-zA-Z0-9]*$/.test(str)) {
        score -= 5;
    }

    candidates.push({ text: str, score });
}

/**
 * Generate key path variations for searching
 */
export function getKeyPathVariations(key: string): string[] {
    const variations: string[] = [key];
    const parts = key.split('.').filter(Boolean);

    if (parts.length > 1) {
        variations.push(parts.slice(1).join('.'));
        if (parts.length > 2) {
            variations.push(parts.slice(2).join('.'));
        }
        variations.push(parts[parts.length - 1]);
        if (parts.length > 2) {
            variations.push(parts.slice(-2).join('.'));
        }
    }

    return variations;
}

/**
 * Escape special regex characters in a string
 */
export function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract hint words from a key for semantic matching
 */
export function extractHintWords(key: string): string[] {
    const keyParts = key.split('.').filter(Boolean);
    const lastPart = keyParts[keyParts.length - 1] || '';
    return lastPart
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);
}

