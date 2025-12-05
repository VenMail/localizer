/**
 * Replacer Registry
 * 
 * Central registry for all framework-specific replacers.
 * Mirrors the parser system but for replacing strings with t() calls.
 */

const { JsxReplacer } = require('./jsxReplacer');
const { VueReplacer } = require('./vueReplacer');

// Registered replacers in priority order
const REPLACERS = [
  VueReplacer,
  JsxReplacer,  // Handles JS/TS/JSX/TSX
];

/**
 * Get the appropriate replacer for a file
 */
function getReplacerForFile(filePath) {
  if (!filePath) return null;

  for (const ReplacerClass of REPLACERS) {
    if (ReplacerClass.canHandle(filePath)) {
      return new ReplacerClass();
    }
  }

  return null;
}

/**
 * Check if a file type is supported
 */
function isSupported(filePath) {
  return getReplacerForFile(filePath) !== null;
}

/**
 * Replace strings in a file
 */
function replaceInFile(content, filePath, keyMap, namespace, options = {}) {
  const replacer = getReplacerForFile(filePath);
  if (!replacer) {
    return { content, changeCount: 0, error: `No replacer for: ${filePath}` };
  }

  return replacer.replace(content, keyMap, namespace, options);
}

module.exports = {
  JsxReplacer,
  VueReplacer,
  getReplacerForFile,
  isSupported,
  replaceInFile,
};
