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
    let patterns = {};
    if (existsSync(patternsPath)) {
      const raw = readFileSync(patternsPath, 'utf8');
      const parsed = JSON.parse(raw);
      patterns = parsed && typeof parsed === 'object' ? parsed : {};
    }

    const autoPath = path.resolve(projectRoot, 'scripts', '.i18n-auto-ignore.json');
    if (existsSync(autoPath)) {
      try {
        const rawAuto = readFileSync(autoPath, 'utf8');
        const parsedAuto = JSON.parse(rawAuto);
        if (parsedAuto && typeof parsedAuto === 'object') {
          if (Array.isArray(parsedAuto.exact)) {
            patterns.exact = (Array.isArray(patterns.exact) ? patterns.exact : []).concat(
              parsedAuto.exact,
            );
          }
          if (Array.isArray(parsedAuto.exactInsensitive)) {
            patterns.exactInsensitive = (
              Array.isArray(patterns.exactInsensitive) ? patterns.exactInsensitive : []
            ).concat(parsedAuto.exactInsensitive);
          }
          if (Array.isArray(parsedAuto.contains)) {
            patterns.contains = (Array.isArray(patterns.contains) ? patterns.contains : []).concat(
              parsedAuto.contains,
            );
          }
        }
      } catch {
      }
    }

    cachedPatterns = patterns;
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

function isPlaceholderOnlyText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  let stripped = trimmed
    .replace(/\{\{\s*[^}]+\s*\}\}/g, ' ')
    .replace(/\{[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}/g, ' ');
  stripped = stripped.replace(/[\(\)\[\]\{\},.:;'"!?!\-_]/g, ' ');
  stripped = stripped.replace(/\s+/g, ' ').trim();
  if (!stripped) return true;
  if (!/[A-Za-z]/.test(stripped)) return true;
  return false;
}

/**
 * Check if text is non-translatable
 * Combines pattern-based ignores with linguistic validation
 */
function isNonTranslatableText(text, patterns) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  
  const normalized = trimmed.replace(/\s+/g, ' ');

  if (isPlaceholderOnlyText(normalized)) {
    return true;
  }

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
