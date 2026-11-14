/**
 * Vue Replacer
 * 
 * Replaces translatable strings in Vue SFC files.
 * Uses $t() in templates and t() in scripts.
 * Mirrors VueParser detection patterns for consistency.
 */

const { BaseReplacer } = require('./baseReplacer');
const { findSfcBlocks } = require('../sfcBlocks');
const { VueParser } = require('../parsers/vueParser');
const { rewriteVueScript } = require('../vueScriptRewriter');
const { displayLiterals } = require('../vueExpressions');

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
      
      // For text with mustache expressions, create a validation version with placeholders
      let validationText = cleaned;
      const mustacheMatches = cleaned.match(/\{\{[^}]+\}\}/g);
      if (mustacheMatches) {
        validationText = cleaned.replace(/\{\{[^}]+\}\}/g, '{placeholder}');
        validationText = validationText.replace(/\s+/g, ' ').trim();
      }
      
      return shouldTranslate(validationText, { ignorePatterns });
    };

    // Rewrite full sections in reverse offset order so nested slot templates
    // cannot truncate the SFC, and edits do not invalidate later positions.
    for (const block of findSfcBlocks(modified, 'template').reverse()) {
      const before = modified.slice(block.innerStart, block.innerEnd);
      const protectedRegions = /<!--[\s\S]*?-->|<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
      let after = '';
      let offset = 0;
      let match;
      while ((match = protectedRegions.exec(before)) !== null) {
        after += this.replaceInTemplate(before.slice(offset, match.index), keyMap, namespace, canTranslate) + match[0];
        offset = protectedRegions.lastIndex;
      }
      after += this.replaceInTemplate(before.slice(offset), keyMap, namespace, canTranslate);
      if (before !== after) {
        changeCount += this.countDifferences(before, after);
        modified = modified.slice(0, block.innerStart) + after + modified.slice(block.innerEnd);
      }
    }

    // Vue permits both <script setup> and a normal <script>; handle each,
    // including the Options-API block, rather than only the first one.
    for (const block of findSfcBlocks(modified, 'script').reverse()) {
      const before = modified.slice(block.innerStart, block.innerEnd);
      const result = rewriteVueScript(before, this, keyMap, namespace, canTranslate);
      if (result.content !== before) {
        changeCount += result.changeCount;
        modified = modified.slice(0, block.innerStart) + result.content + modified.slice(block.innerEnd);
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
    const textBetweenTagsRegex = /(>)([^<]*)(?=<)/g;

    modified = modified.replace(textBetweenTagsRegex, (match, open, text, offset, source) => {
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

      const preceding = source.slice(0, offset + 1);
      const tag = preceding.match(/<([\w-]+)\b[^<>]*>$/);
      const kind = this.inferKindFromTag(tag && tag[1]);
      const fullKey = this.lookupKey(keyMap, namespace, kind, trimmed);
      if (!fullKey) return match;

      const leadingSpace = text.match(/^\s*/)[0];
      const trailingSpace = text.match(/\s*$/)[0];
      
      // Preserve the original text with mustache expressions in the replacement
      const args = mustacheMatches ? `, {${this.extractVariables(trimmed)}}` : '';
      return `${open}${leadingSpace}{{ $t('${fullKey}'${args}) }}${trailingSpace}`;
    });

    // 2. Attribute values (non-bound)
    // Matches: placeholder="text", title="text", etc.
    // Skip already bound attributes (prefixed with : or v-bind:)
    const attrNames = 'placeholder|title|alt|aria-label|label|error-message|helper-text|[a-z][\\w-]*caption';
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

    // 3. Independently rewrite every literal in each mustache expression.
    // Processing in reverse preserves ranges, even with nested JS object braces.
    const ranges = new VueParser().getMustacheRanges(modified);
    for (const { start, end } of ranges.reverse()) {
      const expression = modified.slice(start + 2, end - 2);
      let next = expression;
      for (const literal of displayLiterals(expression).reverse()) {
        const text = literal.value;
        if (!canTranslate(text)) continue;
        const fullKey = this.lookupKey(keyMap, namespace, 'text', text);
        if (!fullKey) continue;
        next = next.slice(0, literal.start) + `$t(${JSON.stringify(fullKey)})` + next.slice(literal.end);
      }
      if (next !== expression) {
        modified = modified.slice(0, start + 2) + next + modified.slice(end - 2);
      }
    }

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
