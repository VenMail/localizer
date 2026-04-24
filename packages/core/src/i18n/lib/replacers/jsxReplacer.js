/**
 * JSX/TSX Replacer
 * 
 * Replaces translatable strings with t() calls in React/JS/TS files.
 * Uses the same detection patterns as JsxParser for consistency.
 */

const { BaseReplacer } = require('./baseReplacer');

// Try to load MagicString for efficient replacements
let MagicString;
try {
  MagicString = require('magic-string');
} catch (e) {
  // Fallback to string manipulation
}

class JsxReplacer extends BaseReplacer {
  static getExtensions() {
    return ['js', 'jsx', 'ts', 'tsx', 'mjs', 'mts'];
  }

  static getName() {
    return 'JSX/TSX Replacer';
  }

  static canHandle(filePath) {
    const ext = filePath.toLowerCase().split('.').pop();
    if (filePath.endsWith('.d.ts')) return false;
    return this.getExtensions().includes(ext);
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

    // 1. Object property values with known keys
    // Matches: title: "text", description: "text", message: "text", etc.
    // Skip values that are already t() calls
    const propNames = 'title|description|message|label|placeholder|cta|text|error|heading|alt|reason';
    const objPropRegex = new RegExp(
      `(\\b(?:${propNames})\\s*:\\s*)(['"\`])([^'"\`\\n]{2,200})\\2`,
      'g'
    );

    modified = modified.replace(objPropRegex, (match, prefix, quote, text) => {
      // Idempotency guard: skip if text looks like a translation key
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      if (!canTranslate(text)) return match;

      const propMatch = prefix.match(/(\w+)\s*:/);
      const propName = propMatch ? propMatch[1] : 'text';
      const kind = this.inferKindFromProp(propName);

      const fullKey = this.lookupKey(keyMap, namespace, kind, text);
      if (!fullKey) return match;

      changeCount++;
      return `${prefix}t('${fullKey}')`;
    });

    // 2. Variable declarations with descriptive names
    // Matches: const errorMessage = "text", let title = "text", etc.
    const varNamesPattern = '\\w*(?:title|label|message|placeholder|text|heading|description|error|reason)\\w*';
    const varDeclRegex = new RegExp(
      `(\\b(?:const|let|var)\\s+(${varNamesPattern})\\s*=\\s*)(['"\`])([^'"\`\\n]{2,200})\\3`,
      'gi'
    );

    modified = modified.replace(varDeclRegex, (match, prefix, varName, quote, text) => {
      // Idempotency guard: skip if text looks like a translation key
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      if (!canTranslate(text)) return match;

      const kind = this.inferKindFromVarName(varName);
      const fullKey = this.lookupKey(keyMap, namespace, kind, text);
      if (!fullKey) return match;

      changeCount++;
      return `${prefix}t('${fullKey}')`;
    });

    // 3. Toast/notification calls
    // Matches: toast.success("text"), toast.error("text"), etc.
    const toastRegex = /(toast\.(?:success|error|warning|info|show|message)\s*\(\s*)(['"`])([^'"`\n]{2,200})\2/g;

    modified = modified.replace(toastRegex, (match, prefix, quote, text) => {
      // Idempotency guard: skip if text looks like a translation key
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      if (!canTranslate(text)) return match;

      const fullKey = this.lookupKey(keyMap, namespace, 'toast', text);
      if (!fullKey) return match;

      changeCount++;
      return `${prefix}t('${fullKey}')`;
    });

    // 4. JSX text content between tags
    // Matches: <Tag>text content</Tag>
    // Skip already translated text {t('...')}
    const jsxTags = 'h[1-6]|p|span|div|label|button|a|li|td|th|strong|em|b|i|small|Link|Button|Text|Title|Heading';
    const jsxTextRegex = new RegExp(
      `(<(?:${jsxTags})(?:\\s[^>]*)?>)([^<>{}\`]+)(<\\/(?:${jsxTags})>)`,
      'gi'
    );

    modified = modified.replace(jsxTextRegex, (match, openTag, text, closeTag) => {
      const trimmed = text.trim();
      // Idempotency guard: skip if already contains t() call pattern
      if (/\{t\s*\(/.test(text)) return match;
      if (!trimmed || !canTranslate(trimmed)) return match;

      const tagMatch = openTag.match(/<(\w+)/);
      const tagName = tagMatch ? tagMatch[1] : 'div';
      const kind = this.inferKindFromTag(tagName);

      const fullKey = this.lookupKey(keyMap, namespace, kind, trimmed);
      if (!fullKey) return match;

      changeCount++;
      const leadingSpace = text.match(/^\s*/)[0];
      const trailingSpace = text.match(/\s*$/)[0];
      return `${openTag}${leadingSpace}{t('${fullKey}')}${trailingSpace}${closeTag}`;
    });

    // 5. JSX expression containers with string literals
    // Matches: {"text"} or {'text'}
    // Skip strings that are already t() arguments
    const jsxExprRegex = /(\{)(['"])([^'"}{]{2,200})\2(\})/g;

    modified = modified.replace(jsxExprRegex, (match, open, quote, text, close) => {
      // Idempotency guard: skip if text looks like a translation key
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      if (!canTranslate(text)) return match;

      const fullKey = this.lookupKey(keyMap, namespace, 'text', text);
      if (!fullKey) return match;

      changeCount++;
      return `{t('${fullKey}')}`;
    });

    // 6. JSX attributes with string values
    // Matches: placeholder="text", title="text", etc.
    // Skip attributes that already use t() via expression {t('key')}
    const attrNames = 'placeholder|title|alt|aria-label|label';
    const jsxAttrRegex = new RegExp(
      `((?:${attrNames})\\s*=\\s*)(['"])([^'"]{2,200})\\2`,
      'g'
    );

    modified = modified.replace(jsxAttrRegex, (match, prefix, quote, text) => {
      // Idempotency guard: skip if text looks like a translation key
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      if (!canTranslate(text)) return match;

      const attrMatch = prefix.match(/(\S+)\s*=/);
      const attrName = attrMatch ? attrMatch[1] : 'text';
      const kind = this.inferKindFromAttr(attrName);

      const fullKey = this.lookupKey(keyMap, namespace, kind, text);
      if (!fullKey) return match;

      changeCount++;
      return `${prefix}{t('${fullKey}')}`;
    });

    // 6b. JSX attribute expression values that contain string literals
    // Matches: title={condition ? "text1" : "text2"}
    // Only supports expressions without nested { } blocks for safety.
    const jsxAttrExprRegex = new RegExp(
      `((?:${attrNames})\\s*=\\s*)\\{([^{}]{2,400})\\}`,
      'g'
    );

    const stringLiteralRegex = /(['"\`])((?:\\.|(?!\1)[^\\\r\n])+?)\1/g;

    modified = modified.replace(jsxAttrExprRegex, (match, prefix, expr) => {
      const attrMatch = prefix.match(/(\S+)\s*=/);
      const attrName = attrMatch ? attrMatch[1] : 'text';
      const kind = this.inferKindFromAttr(attrName);

      let exprChanged = false;

      const nextExpr = expr.replace(stringLiteralRegex, (m, quote, text) => {
        // Idempotency guard: skip if text looks like a translation key
        if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return m;
        if (typeof text === 'string' && text.includes('${')) return m;
        if (!canTranslate(text)) return m;

        const fullKey = this.lookupKey(keyMap, namespace, kind, text);
        if (!fullKey) return m;

        exprChanged = true;
        changeCount++;
        return `t('${fullKey}')`;
      });

      if (!exprChanged) return match;
      return `${prefix}{${nextExpr}}`;
    });

    // 7. Return statements with string literals
    // Matches: return "text" or return 'text'
    const returnRegex = /(return\s+)(['"])([^'"]{3,200})\2(\s*[;\n])/g;

    modified = modified.replace(returnRegex, (match, prefix, quote, text, suffix) => {
      // Idempotency guard: skip if text looks like a translation key
      if (/^[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(text)) return match;
      if (!canTranslate(text)) return match;

      const fullKey = this.lookupKey(keyMap, namespace, 'text', text);
      if (!fullKey) return match;

      changeCount++;
      return `${prefix}t('${fullKey}')${suffix}`;
    });

    // Add t import if needed
    if (changeCount > 0) {
      modified = this.ensureTImport(modified);
    }

    return { content: modified, changeCount };
  }

  /**
   * Ensure t is imported from @/i18n
   */
  ensureTImport(content) {
    // Check if already imported
    if (/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"]@\/i18n['"]/.test(content)) {
      return content;
    }

    // Check if there's a t() call
    if (!/\bt\s*\(/.test(content)) {
      return content;
    }

    // Find last import statement
    const lastImportMatch = content.match(/(import\s+[^;]+;)(?![\s\S]*import\s+[^;]+;)/);
    if (lastImportMatch) {
      const insertPos = lastImportMatch.index + lastImportMatch[0].length;
      return content.slice(0, insertPos) + "\nimport { t } from '@/i18n';" + content.slice(insertPos);
    }

    // No imports, add at beginning
    return `import { t } from '@/i18n';\n\n${content}`;
  }
}

module.exports = { JsxReplacer };
