/**
 * Shared text validation utilities for determining if text is translatable
 * Uses linguistic patterns to detect legitimate English words vs random strings
 */

/**
 * Check if a word follows basic English phonetic patterns
 * Uses consonant-vowel patterns and common English letter combinations
 */
function hasEnglishPhoneticPattern(word) {
  if (!word || typeof word !== 'string') {
    return false;
  }

  const lower = word.toLowerCase();
  
  // Very short words - check against common English words
  if (lower.length <= 2) {
    const commonShort = ['a', 'i', 'an', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we'];
    return commonShort.includes(lower);
  }

  const vowels = 'aeiouy';
  const consonants = 'bcdfghjklmnpqrstvwxz';
  
  // Count vowels and consonants
  let vowelCount = 0;
  let consonantCount = 0;
  
  for (const char of lower) {
    if (vowels.includes(char)) {
      vowelCount++;
    } else if (consonants.includes(char)) {
      consonantCount++;
    }
  }
  
  // Must have at least one vowel (except for abbreviations which we filter elsewhere)
  if (vowelCount === 0) {
    return false;
  }
  
  // Reject if too many consonants in a row (more than 3, except for common patterns)
  const consonantClusters = lower.match(/[bcdfghjklmnpqrstvwxz]{4,}/g);
  if (consonantClusters && consonantClusters.length > 0) {
    // Allow common English consonant clusters
    const validClusters = ['tch', 'sch', 'str', 'spr', 'spl', 'scr', 'thr', 'shr', 'phr'];
    const hasValidCluster = consonantClusters.some(cluster => 
      validClusters.some(valid => cluster.includes(valid))
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
  
  for (let i = 0; i < lower.length - 1; i++) {
    const curr = lower[i];
    const next = lower[i + 1];
    
    if ((vowels.includes(curr) || consonants.includes(curr)) && 
        (vowels.includes(next) || consonants.includes(next))) {
      transitions++;
      
      const currIsVowel = vowels.includes(curr);
      const nextIsVowel = vowels.includes(next);
      
      if (currIsVowel !== nextIsVowel) {
        cvTransitions++;
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
    'st', 'to', 'nt', 'ng', 'se', 'ha', 'as', 'ou', 'io', 'le'
  ];
  
  let bigramMatches = 0;
  for (let i = 0; i < lower.length - 1; i++) {
    const bigram = lower.substring(i, i + 2);
    if (commonBigrams.includes(bigram)) {
      bigramMatches++;
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
 * Applies phonetic pattern validation to each word
 */
function containsEnglishWords(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }

  const trimmed = text.trim();
  
  // Split into words (handle punctuation)
  const words = trimmed.split(/[\s,;.!?()[\]{}]+/).filter(w => w.length > 0);
  
  if (words.length === 0) {
    return false;
  }
  
  // At least 50% of words should pass phonetic validation
  let validWords = 0;
  for (const word of words) {
    // Remove leading/trailing punctuation and quotes
    const cleaned = word.replace(/^['"]+|['"]+$/g, '');
    if (hasEnglishPhoneticPattern(cleaned)) {
      validWords++;
    }
  }
  
  return validWords / words.length >= 0.5;
}

/**
 * Comprehensive check if text is translatable
 * Combines phonetic validation with other heuristics
 */
function isTranslatableText(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }

  const trimmed = text.trim();
  
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return false;
  }

  if (!/\s/.test(trimmed) && /[:\[\]]/.test(trimmed) && /^[A-Za-z0-9:._\-\[\]]+$/.test(trimmed)) {
    return false;
  }

  if (/[{};]/.test(trimmed) && /\b(const|let|var|function|return|if|else|for|while|class|async|await)\b/.test(trimmed)) {
    return false;
  }

  // Must have at least one letter
  if (!/[A-Za-z]/.test(trimmed)) {
    return false;
  }

  // Too short (less than 2 characters for single words, 3 for phrases)
  if (trimmed.length < 2) {
    return false;
  }

  // Exclude CSS class patterns (kebab-case, BEM, utility classes)
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

  // Exclude standalone query-string or fragment-like segments
  // Examples: "?duration=", "?lang=en", "foo=bar&baz=qux"
  if (!/\s/.test(trimmed)) {
    const queryLike = /^(?:[?#])?[A-Za-z0-9_.-]+(?:=[^&\s]*)?(?:&[A-Za-z0-9_.-]+(?:=[^&\s]*)?)*$/;
    if (queryLike.test(trimmed)) {
      return false;
    }
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

  // Exclude id-like tokens (mixed alnum, no spaces)
  if (!/\s/.test(trimmed)) {
    const hasLetter = /[A-Za-z]/.test(trimmed);
    const hasDigit = /\d/.test(trimmed);
    if (hasLetter && hasDigit && trimmed.length >= 6 && trimmed.length <= 64) {
      return false;
    }
  }

  // Exclude single words with underscores or dots (technical identifiers)
  if (!trimmed.includes(' ') && (trimmed.includes('_') || trimmed.includes('.'))) {
    return false;
  }

  // Exclude common non-translatable single words
  const technicalWords = [
    'div', 'span', 'input', 'form', 'select', 'option', 'textarea',
    'true', 'false', 'null', 'undefined',
    'primary', 'secondary', 'danger', 'info', 'light', 'dark',
    'sm', 'md', 'lg', 'xl', 'xs', '2xl', '3xl',
  ];
  if (!trimmed.includes(' ') && technicalWords.includes(trimmed.toLowerCase())) {
    return false;
  }

  // Normalize whitespace for subsequent heuristics
  const normalized = trimmed.replace(/\s+/g, ' ');

  // Domain + optional port and qualifier, e.g. "imap.gmail.com:993 (SSL)"
  if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:\d+)?(\s*\([A-Za-z0-9\s]+\))?$/.test(normalized)) {
    return false;
  }

  // Strings that are overwhelmingly CSS/utility classes plus placeholders
  const words = normalized.split(/\s+/);
  const nonPlaceholderWords = words.filter((w) => !/^\{[^}]+\}$/.test(w));
  if (nonPlaceholderWords.length > 0) {
    const cssishWords = nonPlaceholderWords.filter(
      (w) => /[-:]/.test(w) && /^[A-Za-z0-9:._\-\[\]]+$/.test(w),
    );

    // If almost all non-placeholder words look like CSS/utility tokens, treat as non-translatable
    if (
      cssishWords.length >= 2 &&
      cssishWords.length >= nonPlaceholderWords.length - 1
    ) {
      return false;
    }

    // Slug/utility patterns like "w-full {value1}" (single hyphenated token plus placeholders)
    if (
      nonPlaceholderWords.length === 1 &&
      cssishWords.length === 1 &&
      nonPlaceholderWords[0].includes('-')
    ) {
      return false;
    }
  }

  // Apply English phonetic pattern validation
  if (!containsEnglishWords(normalized)) {
    return false;
  }

  // Prefer strings with multiple words or sentence structure
  const wordCount = words.length;
  if (wordCount === 1) {
    // Single word: must be capitalized or have mixed case to be considered translatable
    const firstChar = trimmed[0];
    if (firstChar !== firstChar.toUpperCase()) {
      return false;
    }
  }

  // If it has spaces, ensure it's not just a list of CSS classes or technical tokens
  if (wordCount > 1) {
    // If all words contain hyphens, likely CSS classes
    if (words.every(w => w.includes('-'))) {
      return false;
    }
  }

  return true;
}

module.exports = {
  hasEnglishPhoneticPattern,
  containsEnglishWords,
  isTranslatableText,
};
