/**
 * Check if a character is escaped (has odd number of backslashes before it)
 */
export function isEscaped(text: string, position: number): boolean {
    let backslashCount = 0;
    let i = position - 1;
    while (i >= 0 && text[i] === '\\') {
        backslashCount++;
        i--;
    }
    return backslashCount % 2 === 1;
}

/**
 * Find all comment ranges in the text (single-line and multi-line)
 * Returns an array of { start: number, end: number } ranges
 */
export function findCommentRanges(text: string): Array<{ start: number; end: number }> {
    const commentRanges: Array<{ start: number; end: number }> = [];
    const len = text.length;
    let i = 0;
    let inString: 'single' | 'double' | 'template' | null = null;
    let templateDepth = 0;

    while (i < len) {
        const char = text[i];
        const nextChar = i + 1 < len ? text[i + 1] : '';

        if (inString === null) {
            if (char === "'" && !isEscaped(text, i)) {
                inString = 'single';
            } else if (char === '"' && !isEscaped(text, i)) {
                inString = 'double';
            } else if (char === '`' && !isEscaped(text, i)) {
                inString = 'template';
                templateDepth = 1;
            }
        } else {
            if (inString === 'single' && char === "'" && !isEscaped(text, i)) {
                inString = null;
            } else if (inString === 'double' && char === '"' && !isEscaped(text, i)) {
                inString = null;
            } else if (inString === 'template') {
                if (char === '`' && !isEscaped(text, i)) {
                    templateDepth--;
                    if (templateDepth === 0) {
                        inString = null;
                    }
                } else if (char === '$' && nextChar === '{' && !isEscaped(text, i)) {
                    templateDepth++;
                } else if (char === '}' && !isEscaped(text, i) && templateDepth > 1) {
                    templateDepth--;
                }
            }
        }

        if (inString === null) {
            if (char === '/' && nextChar === '/') {
                const commentStart = i;
                let commentEnd = i + 2;
                while (commentEnd < len && text[commentEnd] !== '\n' && text[commentEnd] !== '\r') {
                    commentEnd++;
                }
                commentRanges.push({ start: commentStart, end: commentEnd });
                i = commentEnd;
                continue;
            }

            if (char === '/' && nextChar === '*') {
                const commentStart = i;
                let commentEnd = i + 2;
                while (commentEnd < len - 1) {
                    if (text[commentEnd] === '*' && text[commentEnd + 1] === '/') {
                        commentEnd += 2;
                        break;
                    }
                    commentEnd++;
                }
                commentRanges.push({ start: commentStart, end: commentEnd });
                i = commentEnd;
                continue;
            }
        }

        i++;
    }

    return commentRanges;
}

/**
 * Check if a position (byte offset) is inside any comment range
 */
export function isPositionInComment(position: number, commentRanges: Array<{ start: number; end: number }>): boolean {
    return commentRanges.some(range => position >= range.start && position < range.end);
}

