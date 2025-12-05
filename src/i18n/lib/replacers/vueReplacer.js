/**
 * Vue Replacer
 * 
 * Replaces translatable strings in Vue SFC files.
 * Uses $t() in templates and t() in scripts.
 * Mirrors VueParser detection patterns for consistency.
 */

const { BaseReplacer } = require('./baseReplacer');
const { JsxReplacer } = require('./jsxReplacer');

class VueReplacer extends BaseReplacer {
  static getExtensions() {
    return ['vue'];
  }

  static getName() {
    return 'Vue Replacer';
  }

  replace(content, keyMap, namespace, options = {}) {
    const { shouldTranslate } = require('../validators');
    const ignorePatterns = options.ignorePatterns || {};

    let modified = content;
    let changeCount = 0;

    // Helper to check if text should be translated
    const canTranslate = (text) => {
      const cleaned = this.normalizeText(text);
      if (!cleaned) return false;
      if (!/[A-Za-z]/.test(cleaned)) return false;
      return shouldTranslate(cleaned, { ignorePatterns });
    };

    // Process <template> section
    const templateMatch = content.match(/(<template[^>]*>)([\s\S]*?)(<\/template>)/i);
    if (templateMatch) {
      const [fullMatch, openTag, templateContent, closeTag] = templateMatch;
      let newTemplateContent = this.replaceInTemplate(templateContent, keyMap, namespace, canTranslate);

      if (newTemplateContent !== templateContent) {
        const templateChangeCount = this.countDifferences(templateContent, newTemplateContent);
        changeCount += templateChangeCount;
        modified = modified.replace(fullMatch, `${openTag}${newTemplateContent}${closeTag}`);
      }
    }

    // Process <script> section using JsxReplacer
    const scriptMatch = modified.match(/(<script[^>]*>)([\s\S]*?)(<\/script>)/i);
    if (scriptMatch) {
      const [fullMatch, openTag, scriptContent, closeTag] = scriptMatch;
      const jsxReplacer = new JsxReplacer();
      const result = jsxReplacer.replace(scriptContent, keyMap, namespace, options);

      if (result.changeCount > 0) {
        changeCount += result.changeCount;
        modified = modified.replace(fullMatch, `${openTag}${result.content}${closeTag}`);
      }
    }

    return { content: modified, changeCount };
  }

  /**
   * Replace strings in Vue template
   */
  replaceInTemplate(template, keyMap, namespace, canTranslate) {
    let modified = template;

    // 1. Plain text content between tags (not inside {{ }})
    // Matches: >text content<
    const textBetweenTagsRegex = /(>)([^<>{}\n]+)(<)/g;

    modified = modified.replace(textBetweenTagsRegex, (match, open, text, close) => {
      const trimmed = text.trim();
      if (!trimmed || !canTranslate(trimmed)) return match;

      const fullKey = this.lookupKey(keyMap, namespace, 'text', trimmed);
      if (!fullKey) return match;

      const leadingSpace = text.match(/^\s*/)[0];
      const trailingSpace = text.match(/\s*$/)[0];
      return `${open}${leadingSpace}{{ $t('${fullKey}') }}${trailingSpace}${close}`;
    });

    // 2. Attribute values (non-bound)
    // Matches: placeholder="text", title="text", etc.
    const attrNames = 'placeholder|title|alt|aria-label|label|error-message|helper-text';
    const attrRegex = new RegExp(
      `(\\s)(${attrNames})(\\s*=\\s*)(['"])([^'"]{2,200})\\4`,
      'gi'
    );

    modified = modified.replace(attrRegex, (match, space, attrName, eq, quote, text) => {
      if (!canTranslate(text)) return match;

      const kind = this.inferKindFromAttr(attrName);
      const fullKey = this.lookupKey(keyMap, namespace, kind, text);
      if (!fullKey) return match;

      // Convert to bound attribute with $t
      return `${space}:${attrName}="$t('${fullKey}')"`;
    });

    // 3. String literals inside {{ }} expressions
    // Matches: {{ condition ? "text1" : "text2" }}
    const mustacheRegex = /(\{\{[^}]*?)(['"])([^'"]{3,200})\2([^}]*?\}\})/g;

    modified = modified.replace(mustacheRegex, (match, before, quote, text, after) => {
      if (!canTranslate(text)) return match;

      const fullKey = this.lookupKey(keyMap, namespace, 'text', text);
      if (!fullKey) return match;

      return `${before}$t('${fullKey}')${after}`;
    });

    // 4. Bound attribute string values
    // Matches: :placeholder="'text'" or :title="'text'"
    const boundAttrRegex = new RegExp(
      `(:(?:${attrNames})\\s*=\\s*")(['"])([^'"]{2,200})\\2"`,
      'gi'
    );

    modified = modified.replace(boundAttrRegex, (match, prefix, quote, text) => {
      if (!canTranslate(text)) return match;

      const attrMatch = prefix.match(/:(\S+)\s*=/);
      const attrName = attrMatch ? attrMatch[1] : 'text';
      const kind = this.inferKindFromAttr(attrName);

      const fullKey = this.lookupKey(keyMap, namespace, kind, text);
      if (!fullKey) return match;

      return `${prefix}$t('${fullKey}')"`;
    });

    // 5. v-text and v-html with string literals
    // Matches: v-text="'text'" or v-html="'text'"
    const vTextRegex = /(v-(?:text|html)\s*=\s*")(['"])([^'"]{2,200})\2"/g;

    modified = modified.replace(vTextRegex, (match, prefix, quote, text) => {
      if (!canTranslate(text)) return match;

      const fullKey = this.lookupKey(keyMap, namespace, 'text', text);
      if (!fullKey) return match;

      return `${prefix}$t('${fullKey}')"`;
    });

    return modified;
  }

  /**
   * Count approximate number of replacements by comparing strings
   */
  countDifferences(original, modified) {
    // Count $t( occurrences as a proxy for changes
    const originalCount = (original.match(/\$t\s*\(/g) || []).length;
    const modifiedCount = (modified.match(/\$t\s*\(/g) || []).length;
    return Math.max(0, modifiedCount - originalCount);
  }
}

module.exports = { VueReplacer };
