/**
 * Shared text validation utilities for determining if text is translatable
 * TypeScript version used by the VS Code extension runtime.
 */

/**
 * Check if a word follows basic English phonetic patterns.
 */
export function hasEnglishPhoneticPattern(word: string): boolean {
    if (!word || typeof word !== 'string') {
        return false;
    }

    const lower = word.toLowerCase();

    // Very short words - check against common English words
    if (lower.length <= 2) {
        const commonShort = [
            'a',
            'i',
            'an',
            'at',
            'be',
            'by',
            'do',
            'go',
            'he',
            'if',
            'in',
            'is',
            'it',
            'me',
            'my',
            'no',
            'of',
            'on',
            'or',
            'so',
            'to',
            'up',
            'us',
            'we',
        ];
        return commonShort.includes(lower);
    }

    const vowels = 'aeiouy';
    const consonants = 'bcdfghjklmnpqrstvwxz';

    // Count vowels and consonants
    let vowelCount = 0;
    let consonantCount = 0;

    for (const char of lower) {
        if (vowels.includes(char)) {
            vowelCount += 1;
        }
        else if (consonants.includes(char)) {
            consonantCount += 1;
        }
    }

    // Must have at least one vowel (except for abbreviations which we filter elsewhere)
    if (vowelCount === 0) {
        return false;
    }

    // Reject if too many consonants in a row (more than 3, except for common patterns)
    const consonantClusters = lower.match(/[bcdfghjklmnpqrstvwxz]{4,}/g);
    if (consonantClusters && consonantClusters.length > 0) {
        const validClusters = ['tch', 'sch', 'str', 'spr', 'spl', 'scr', 'thr', 'shr', 'phr'];
        const hasValidCluster = consonantClusters.some((cluster) =>
            validClusters.some((valid) => cluster.includes(valid)),
        );
        if (!hasValidCluster) {
            return false;
        }
    }

    // Reject if too many vowels in a row (more than 3, rare in English)
    if (/[aeiouy]{4,}/.test(lower)) {
        return false;
    }

    // Check for alternating consonant-vowel pattern (common in English)
    // At least 30% of transitions should be consonant-vowel or vowel-consonant
    let transitions = 0;
    let cvTransitions = 0;

    for (let i = 0; i < lower.length - 1; i += 1) {
        const curr = lower[i];
        const next = lower[i + 1];

        if ((vowels.includes(curr) || consonants.includes(curr)) &&
            (vowels.includes(next) || consonants.includes(next))) {
            transitions += 1;

            const currIsVowel = vowels.includes(curr);
            const nextIsVowel = vowels.includes(next);

            if (currIsVowel !== nextIsVowel) {
                cvTransitions += 1;
            }
        }
    }

    if (transitions > 0 && cvTransitions / transitions < 0.3) {
        return false;
    }

    // Check for common English letter combinations
    const commonBigrams = [
        'th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd',
        'ti', 'es', 'or', 'te', 'of', 'ed', 'is', 'it', 'al', 'ar',
        'st', 'to', 'nt', 'ng', 'se', 'ha', 'as', 'ou', 'io', 'le',
    ];

    let bigramMatches = 0;
    for (let i = 0; i < lower.length - 1; i += 1) {
        const bigram = lower.substring(i, i + 2);
        if (commonBigrams.includes(bigram)) {
            bigramMatches += 1;
        }
    }

    // For words longer than 4 chars, expect at least one common bigram
    if (lower.length > 4 && bigramMatches === 0) {
        return false;
    }

    return true;
}

/**
 * Check if text contains legitimate English words
 */
export function containsEnglishWords(text: string): boolean {
    if (!text || typeof text !== 'string') {
        return false;
    }

    const trimmed = text.trim();

    const words = trimmed
        .split(/[\s,;.!?()\[\]{}]+/)
        .filter((w) => w.length > 0);

    if (words.length === 0) {
        return false;
    }

    let validWords = 0;
    for (const word of words) {
        const cleaned = word.replace(/^['"]+|['"]+$/g, '');
        if (hasEnglishPhoneticPattern(cleaned)) {
            validWords += 1;
        }
    }

    return validWords / words.length >= 0.5;
}

/**
 * Comprehensive check if text is translatable
 */
export function isTranslatableText(text: string): boolean {
    if (!text || typeof text !== 'string') {
        return false;
    }

    const trimmed = text.trim();

    // Must have at least one letter
    if (!/[A-Za-z]/.test(trimmed)) {
        return false;
    }

    // Too short (less than 2 characters)
    if (trimmed.length < 2) {
        return false;
    }

    // Exclude CSS class patterns (kebab-case, utility classes)
    if (/^[a-z0-9-]+(?:\s+[a-z0-9-]+)*$/i.test(trimmed)) {
        if (trimmed.includes('-') || trimmed.split(/\s+/).length > 3) {
            return false;
        }
    }

    // Exclude camelCase/PascalCase identifiers without spaces
    if (/^[a-z][a-zA-Z0-9]*$/.test(trimmed) || /^[A-Z][a-zA-Z0-9]*$/.test(trimmed)) {
        return false;
    }

    // Exclude technical codes and abbreviations (all caps, 2-5 chars)
    if (/^[A-Z]{2,5}$/.test(trimmed)) {
        return false;
    }

    // Exclude URL-like strings
    if (/^(https?:\/\/|www\.|\/)/.test(trimmed)) {
        return false;
    }

    // Exclude file paths and extensions
    if (/\.(js|ts|tsx|jsx|vue|css|scss|json|png|jpg|svg|html|xml)$/i.test(trimmed)) {
        return false;
    }

    // Exclude hex colors
    if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
        return false;
    }

    // Exclude numbers-only or mostly numbers
    if (/^\d+$/.test(trimmed) || /^\d[\d\s.,-]*\d$/.test(trimmed)) {
        return false;
    }

    // Exclude single words with underscores or dots (technical identifiers)
    if (!trimmed.includes(' ') && (trimmed.includes('_') || trimmed.includes('.'))) {
        return false;
    }

    // Exclude common non-translatable single words
    const technicalWords = [
        'div',
        'span',
        'input',
        'form',
        'select',
        'option',
        'textarea',
        'true',
        'false',
        'null',
        'undefined',
        'primary',
        'secondary',
        'danger',
        'info',
        'light',
        'dark',
        'sm',
        'md',
        'lg',
        'xl',
        'xs',
        '2xl',
        '3xl',
    ];
    if (!trimmed.includes(' ') && technicalWords.includes(trimmed.toLowerCase())) {
        return false;
    }

    // Apply English phonetic pattern validation
    if (!containsEnglishWords(trimmed)) {
        return false;
    }

    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount === 1) {
        const firstChar = trimmed[0];
        if (firstChar !== firstChar.toUpperCase()) {
            return false;
        }
    }

    if (wordCount > 1) {
        const words = trimmed.split(/\s+/);
        if (words.every((w) => w.includes('-'))) {
            return false;
        }
    }

    return true;
}
