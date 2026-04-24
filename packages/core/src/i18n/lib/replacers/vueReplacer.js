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
      
      // For text with mustache expressions, create a validation version with placeholders
      let validationText = cleaned;
      const mustacheMatches = cleaned.match(/\{\{[^}]+\}\}/g);
      if (mustacheMatches) {
        validationText = cleaned.replace(/\{\{[^}]+\}\}/g, '{placeholder}');
        validationText = validationText.replace(/\s+/g, ' ').trim();
      }
      
      return shouldTranslate(validationText, { ignorePatterns });
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

    // 1. Plain text content between tags (including those with {{ }})
    // Matches text content within HTML elements, handling indentation and whitespace
    // Skip content that already has {{ $t(...) }} or {{ t(...) }} wrapper
    const textBetweenTagsRegex = /(>)([^<]*)(<)/g;

    modified = modified.replace(textBetweenTagsRegex, (match, open, text, close) => {
      const trimmed = text.trim();
      // Skip if already contains $t() or t() calls
      if (/\{\{\s*\$?t\s*\(/.test(text)) return match;
      if (!trimmed || !canTranslate(trimmed)) return match;

      // For text with mustache expressions, create a normalized version for key lookup
      let lookupText = trimmed;
      const mustacheMatches = trimmed.match(/\{\{[^}]+\}\}/g);
      if (mustacheMatches) {
        // Replace mustache expressions with placeholders for key lookup
        lookupText = trimmed.replace(/\{\{[^}]+\}\}/g, '{placeholder}');
        lookupText = lookupText.replace(/\s+/g, ' ').trim();
      }

      const fullKey = this.lookupKey(keyMap, namespace, 'text', trimmed);
      if (!fullKey) return match;

      const leadingSpace = text.match(/^\s*/)[0];
      const trailingSpace = text.match(/\s*$/)[0];
      
      // Preserve the original text with mustache expressions in the replacement
      return `${open}${leadingSpace}{{ $t('${fullKey}', {${mustacheMatches ? this.extractVariables(trimmed) : ''}}) }}${trailingSpace}${close}`;
    });

    // 2. Attribute values (non-bound)
    // Matches: placeholder="text", title="text", etc.
    // Skip already bound attributes (prefixed with : or v-bind:)
    const attrNames = 'placeholder|title|alt|aria-label|label|error-message|helper-text';
    const attrRegex = new RegExp(
      `(\\s)(?![:v])(${attrNames})(\\s*=\\s*)(['"])([^'"]{2,200})\\4`,
      'gi'
    );

    modified = modified.replace(attrRegex, (match, space, attrName, eq, quote, text) => {
      // Skip if text looks like a translation key (idempotency guard)
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      
      if (!canTranslate(text)) return match;

      const kind = this.inferKindFromAttr(attrName);
      const fullKey = this.lookupKey(keyMap, namespace, kind, text);
      if (!fullKey) return match;

      // Convert to bound attribute with $t
      return `${space}:${attrName}="$t('${fullKey}')"`;
    });

    // 3. String literals inside {{ }} expressions
    // Matches: {{ condition ? "text1" : "text2" }}
    // Skip strings that are already inside $t() or t() calls
    const mustacheRegex = /(\{\{[^}]*?)(['"])([^'"]{3,200})\2([^}]*?\}\})/g;

    modified = modified.replace(mustacheRegex, (match, before, quote, text, after) => {
      // Skip if already inside a $t() or t() call (idempotency guard)
      if (/\$?t\s*\(\s*$/.test(before)) return match;
      // Skip if text looks like a translation key (dot-separated path)
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      
      if (!canTranslate(text)) return match;

      const fullKey = this.lookupKey(keyMap, namespace, 'text', text);
      if (!fullKey) return match;

      return `${before}$t('${fullKey}')${after}`;
    });

    // 4. Bound attribute string values
    // Matches: :placeholder="'text'" or :title="'text'"
    // Skip if already using $t()
    const boundAttrRegex = new RegExp(
      `(:(?:${attrNames})\\s*=\\s*")(['"])([^'"]{2,200})\\2"`,
      'gi'
    );

    modified = modified.replace(boundAttrRegex, (match, prefix, quote, text) => {
      // Skip if text looks like a translation key (idempotency guard)
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      
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
    // Skip if already using $t()
    const vTextRegex = /(v-(?:text|html)\s*=\s*")(['"])([^'"]{2,200})\2"/g;

    modified = modified.replace(vTextRegex, (match, prefix, quote, text) => {
      // Skip if text looks like a translation key (idempotency guard)
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      
      if (!canTranslate(text)) return match;

      const fullKey = this.lookupKey(keyMap, namespace, 'text', text);
      if (!fullKey) return match;

      return `${prefix}$t('${fullKey}')"`;
    });

    return modified;
  }

  /**
   * Extract variable names from mustache expressions for translation parameters
   * Example: "Allow external applications to submit data to this {{ type }}" -> "type: type"
   */
  extractVariables(text) {
    const mustacheMatches = text.match(/\{\{([^}]+)\}\}/g);
    if (!mustacheMatches) return '';
    
    const variables = [];
    for (const match of mustacheMatches) {
      // Extract the content inside {{ }}
      const content = match.slice(2, -2).trim();
      
      // Handle simple variable names (e.g., "type", "user.name")
      if (/^[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(content)) {
        variables.push(`${content}: ${content}`);
      }
      // Handle expressions (e.g., "user.type", "item.name")
      else if (content.includes('.')) {
        const parts = content.split('.');
        if (parts.length === 2) {
          variables.push(`${parts[1]}: ${content}`);
        }
      }
      // For complex expressions, create a generic parameter
      else {
        // Sanitize the expression to create a valid parameter name
        const paramName = content
          .replace(/[^a-zA-Z0-9]/g, '_')
          .replace(/^_+|_+$/g, '')
          .toLowerCase();
        if (paramName) {
          variables.push(`${paramName}: ${content}`);
        }
      }
    }
    
    return variables.join(', ');
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
