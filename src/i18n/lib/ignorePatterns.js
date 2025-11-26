/**
 * Shared ignore patterns utilities for i18n scripts
 */
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { isTranslatableText } = require('./textValidation');

let cachedPatterns = null;
let cachedPatternsPath = null;

/**
 * Load ignore patterns from file
 */
function loadIgnorePatterns(projectRoot) {
  const patternsPath = path.resolve(projectRoot, 'scripts', 'i18n-ignore-patterns.json');
  
  // Return cached if same path
  if (cachedPatterns !== null && cachedPatternsPath === patternsPath) {
    return cachedPatterns;
  }

  try {
    if (!existsSync(patternsPath)) {
      cachedPatterns = {};
      cachedPatternsPath = patternsPath;
      return cachedPatterns;
    }
    
    const raw = readFileSync(patternsPath, 'utf8');
    const parsed = JSON.parse(raw);
    cachedPatterns = parsed && typeof parsed === 'object' ? parsed : {};
    cachedPatternsPath = patternsPath;
    return cachedPatterns;
  } catch {
    cachedPatterns = {};
    cachedPatternsPath = patternsPath;
    return cachedPatterns;
  }
}

/**
 * Check if attribute should be ignored
 */
function shouldIgnoreAttribute(attrName, patterns) {
  if (!patterns || !Array.isArray(patterns.ignoreAttributes)) {
    return false;
  }
  const lower = String(attrName || '').toLowerCase();
  return patterns.ignoreAttributes.some((name) => String(name || '').toLowerCase() === lower);
}

/**
 * Check if text is non-translatable
 * Combines pattern-based ignores with linguistic validation
 */
function isNonTranslatableText(text, patterns) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  
  const normalized = trimmed.replace(/\s+/g, ' ');

  // Check exact matches
  if (patterns && Array.isArray(patterns.exact) && patterns.exact.includes(normalized)) {
    return true;
  }

  // Check case-insensitive exact matches
  if (patterns && Array.isArray(patterns.exactInsensitive)) {
    const lowerNorm = normalized.toLowerCase();
    for (const v of patterns.exactInsensitive) {
      if (String(v).toLowerCase() === lowerNorm) {
        return true;
      }
    }
  }

  // Check contains patterns
  if (patterns && Array.isArray(patterns.contains)) {
    for (const part of patterns.contains) {
      if (part && normalized.includes(String(part))) {
        return true;
      }
    }
  }

  // Apply comprehensive linguistic validation (includes phonetic patterns)
  if (!isTranslatableText(normalized)) {
    return true;
  }

  return false;
}

/**
 * Check if text should be translated
 */
function shouldTranslateText(text, patterns) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false;
  if (isNonTranslatableText(trimmed, patterns)) return false;
  
  // Check for unbalanced parentheses
  const openParens = (trimmed.match(/\(/g) || []).length;
  const closeParens = (trimmed.match(/\)/g) || []).length;
  if (openParens !== closeParens) return false;
  
  return true;
}

module.exports = {
  loadIgnorePatterns,
  shouldIgnoreAttribute,
  isNonTranslatableText,
  shouldTranslateText,
};
