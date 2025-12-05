/**
 * Base Replacer Interface
 * 
 * All framework-specific replacers should extend this class.
 * Provides common utilities for replacing strings with t() calls.
 */

class BaseReplacer {
  static getExtensions() {
    throw new Error('Subclass must implement getExtensions()');
  }

  static getName() {
    throw new Error('Subclass must implement getName()');
  }

  static canHandle(filePath) {
    const ext = filePath.toLowerCase().split('.').pop();
    return this.getExtensions().includes(ext);
  }

  /**
   * Replace translatable strings in content
   * @param {string} content - File content
   * @param {Map} keyMap - Map of (namespace|kind|text) -> fullKey
   * @param {string} namespace - File namespace
   * @param {Object} options - Replacer options
   * @returns {{ content: string, changeCount: number }}
   */
  replace(content, keyMap, namespace, options = {}) {
    throw new Error('Subclass must implement replace()');
  }

  /**
   * Check if text is a common short text that uses Commons namespace
   */
  isCommonShortText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    const cleaned = trimmed.replace(/\s+/g, ' ').trim();
    if (/[.!?]/.test(cleaned)) return false;
    const words = cleaned.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 2) return false;
    if (cleaned.length > 24) return false;
    if (/[\/_]/.test(cleaned)) return false;
    return true;
  }

  /**
   * Normalize text for key lookup
   */
  normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Look up translation key
   */
  lookupKey(keyMap, namespace, kind, text) {
    const cleaned = this.normalizeText(text);
    if (!cleaned) return null;

    const effectiveNs = this.isCommonShortText(cleaned) ? 'Commons' : namespace;

    // Try exact match
    let keyId = `${effectiveNs}|${kind}|${cleaned}`;
    let fullKey = keyMap.get(keyId);
    if (fullKey) return fullKey;

    // Try 'text' kind fallback
    if (kind !== 'text') {
      keyId = `${effectiveNs}|text|${cleaned}`;
      fullKey = keyMap.get(keyId);
      if (fullKey) return fullKey;
    }

    // Try original namespace if we used Commons
    if (effectiveNs === 'Commons') {
      keyId = `${namespace}|${kind}|${cleaned}`;
      fullKey = keyMap.get(keyId);
      if (fullKey) return fullKey;

      if (kind !== 'text') {
        keyId = `${namespace}|text|${cleaned}`;
        fullKey = keyMap.get(keyId);
        if (fullKey) return fullKey;
      }
    }

    return null;
  }

  /**
   * Infer kind from tag name
   */
  inferKindFromTag(tagName) {
    if (!tagName) return 'text';
    const lower = tagName.toLowerCase();

    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(lower)) return 'heading';
    if (lower === 'label') return 'label';
    if (lower === 'button' || lower.endsWith('button') || lower.endsWith('btn')) return 'button';
    if (lower === 'a' || lower === 'link' || lower.includes('link')) return 'link';
    if (['input', 'textarea', 'select'].includes(lower)) return 'placeholder';

    return 'text';
  }

  /**
   * Infer kind from attribute name
   */
  inferKindFromAttr(attrName) {
    const lower = String(attrName || '').toLowerCase();
    if (lower === 'placeholder') return 'placeholder';
    if (lower === 'title') return 'title';
    if (lower === 'alt') return 'alt';
    if (lower === 'aria-label') return 'aria_label';
    if (lower === 'label') return 'label';
    return 'text';
  }

  /**
   * Infer kind from property name
   */
  inferKindFromProp(propName) {
    const lower = String(propName || '').toLowerCase();
    if (lower === 'title' || lower === 'heading') return 'heading';
    if (lower === 'description' || lower === 'message' || lower === 'text') return 'text';
    if (lower === 'label') return 'label';
    if (lower === 'placeholder') return 'placeholder';
    if (lower === 'cta') return 'button';
    if (lower === 'alt') return 'alt';
    return 'text';
  }

  /**
   * Infer kind from variable name
   */
  inferKindFromVarName(varName) {
    const lower = String(varName || '').toLowerCase();
    if (/title/i.test(lower)) return 'heading';
    if (/label/i.test(lower)) return 'label';
    if (/placeholder/i.test(lower)) return 'placeholder';
    if (/message/i.test(lower)) return 'text';
    return 'text';
  }
}

module.exports = { BaseReplacer };
