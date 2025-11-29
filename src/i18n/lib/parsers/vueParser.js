/**
 * Vue Parser
 * 
 * Handles Vue 2, Vue 3, Nuxt 2, Nuxt 3, and Quasar frameworks.
 * Supports: .vue files (Single File Components)
 * 
 * Features:
 * - Proper state-machine based template parsing
 * - Vue directive handling (v-if, v-for, @click, :prop, etc.)
 * - Composition API and Options API support
 * - Nuxt-specific components (NuxtLink, etc.)
 */

const { BaseParser } = require('./baseParser');
const { shouldTranslate, isTranslatableAttribute, isNonTranslatableAttribute } = require('../validators');

// Parser states
const STATE = {
  TEXT: 'TEXT',
  TAG_OPEN: 'TAG_OPEN',
  TAG_NAME: 'TAG_NAME',
  TAG_SPACE: 'TAG_SPACE',
  ATTR_NAME: 'ATTR_NAME',
  ATTR_EQUALS: 'ATTR_EQUALS',
  ATTR_VALUE_START: 'ATTR_VALUE_START',
  ATTR_VALUE: 'ATTR_VALUE',
  TAG_CLOSE: 'TAG_CLOSE',
  COMMENT: 'COMMENT',
  SCRIPT: 'SCRIPT',
  STYLE: 'STYLE',
};

class VueParser extends BaseParser {
  static getExtensions() {
    return ['vue'];
  }

  static getName() {
    return 'Vue (Vue 2/3, Nuxt 2/3, Quasar)';
  }

  /**
   * Parse Vue SFC content
   * @param {string} content
   * @param {Object} options
   * @returns {Object}
   */
  parse(content, options = {}) {
    const results = {
      items: [],
      stats: { processed: 0, extracted: 0, errors: 0 },
      errors: [],
    };

    if (!content || typeof content !== 'string') {
      return results;
    }

    results.stats.processed = 1;

    // Extract and parse template section
    const template = this.extractTemplate(content);
    if (template) {
      this.parseTemplate(template, results);
    }

    // Also extract from script section for i18n keys
    const script = this.extractScript(content);
    if (script) {
      this.parseScript(script, results);
    }

    return results;
  }

  /**
   * Extract template section from Vue SFC
   */
  extractTemplate(content) {
    const match = content.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
    return match ? match[1] : null;
  }

  /**
   * Extract script section from Vue SFC
   */
  extractScript(content) {
    const match = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    return match ? match[1] : null;
  }

  /**
   * Parse Vue template using state machine
   */
  parseTemplate(template, results) {
    let state = STATE.TEXT;
    let pos = 0;
    let textStart = 0;
    let tagName = '';
    let attrName = '';
    let attrValue = '';
    let attrQuote = '';
    let currentTag = '';
    let tagStack = [];

    const len = template.length;

    const getCurrentParentTag = () => {
      return tagStack.length > 0 ? tagStack[tagStack.length - 1] : null;
    };

    const processTextContent = (text) => {
      if (!text) return;

      // Remove Vue mustache expressions
      let cleanText = text
        .replace(/\{\{[^}]+\}\}/g, '')  // {{ expr }}
        .replace(/\s+/g, ' ')
        .trim();

      if (!cleanText) return;

      if (shouldTranslate(cleanText, { ignorePatterns: this.ignorePatterns })) {
        const kind = this.inferKindFromTag(getCurrentParentTag());
        results.items.push({
          type: 'text',
          text: cleanText,
          kind,
          parentTag: getCurrentParentTag(),
        });
        results.stats.extracted++;
      }
    };

    const processAttributeValue = (name, value, tag) => {
      if (!name || !value) return;

      // Skip Vue directives and bindings
      if (isNonTranslatableAttribute(name)) return;
      if (!isTranslatableAttribute(name)) return;

      const cleanValue = value.replace(/\s+/g, ' ').trim();
      if (!cleanValue) return;

      if (shouldTranslate(cleanValue, { ignorePatterns: this.ignorePatterns })) {
        const kind = this.inferKindFromAttr(name);
        results.items.push({
          type: 'attribute',
          text: cleanValue,
          kind,
          attributeName: name,
          parentTag: tag,
        });
        results.stats.extracted++;
      }
    };

    // Main parsing loop
    while (pos < len) {
      const char = template[pos];
      const nextChar = pos + 1 < len ? template[pos + 1] : '';

      switch (state) {
        case STATE.TEXT: {
          if (char === '<' && template.slice(pos, pos + 4) === '<!--') {
            const text = template.slice(textStart, pos);
            if (text.trim()) processTextContent(text);
            state = STATE.COMMENT;
            pos += 4;
            continue;
          }

          if (char === '<') {
            const text = template.slice(textStart, pos);
            if (text.trim()) processTextContent(text);

            if (nextChar === '/') {
              state = STATE.TAG_CLOSE;
              pos += 2;
              tagName = '';
            } else if (/[a-zA-Z]/.test(nextChar)) {
              state = STATE.TAG_NAME;
              pos += 1;
              tagName = '';
            } else {
              pos += 1;
            }
            continue;
          }

          pos += 1;
          break;
        }

        case STATE.COMMENT: {
          if (char === '-' && template.slice(pos, pos + 3) === '-->') {
            pos += 3;
            state = STATE.TEXT;
            textStart = pos;
            continue;
          }
          pos += 1;
          break;
        }

        case STATE.TAG_NAME: {
          if (/[a-zA-Z0-9_:-]/.test(char)) {
            tagName += char;
            pos += 1;
          } else if (char === '>' || char === '/') {
            currentTag = tagName;
            const lowerTag = tagName.toLowerCase();

            if (lowerTag === 'script') {
              state = STATE.SCRIPT;
            } else if (lowerTag === 'style') {
              state = STATE.STYLE;
            } else if (char === '/') {
              if (template[pos + 1] === '>') pos += 2;
              else pos += 1;
              state = STATE.TEXT;
              textStart = pos;
            } else {
              tagStack.push(tagName);
              pos += 1;
              state = STATE.TEXT;
              textStart = pos;
            }
          } else if (/\s/.test(char)) {
            currentTag = tagName;
            state = STATE.TAG_SPACE;
            pos += 1;
          } else {
            pos += 1;
          }
          break;
        }

        case STATE.TAG_SPACE: {
          if (/\s/.test(char)) {
            pos += 1;
          } else if (char === '>') {
            const lowerTag = currentTag.toLowerCase();
            if (lowerTag === 'script') {
              state = STATE.SCRIPT;
              pos += 1;
            } else if (lowerTag === 'style') {
              state = STATE.STYLE;
              pos += 1;
            } else {
              tagStack.push(currentTag);
              pos += 1;
              state = STATE.TEXT;
              textStart = pos;
            }
          } else if (char === '/') {
            if (template[pos + 1] === '>') pos += 2;
            else pos += 1;
            state = STATE.TEXT;
            textStart = pos;
          } else if (/[a-zA-Z@:#v]/.test(char)) {
            state = STATE.ATTR_NAME;
            attrName = char;
            pos += 1;
          } else {
            pos += 1;
          }
          break;
        }

        case STATE.ATTR_NAME: {
          if (/[a-zA-Z0-9_:@#.\-\[\]]/.test(char)) {
            attrName += char;
            pos += 1;
          } else if (char === '=') {
            state = STATE.ATTR_VALUE_START;
            pos += 1;
          } else if (/\s/.test(char)) {
            state = STATE.TAG_SPACE;
            pos += 1;
          } else if (char === '>' || char === '/') {
            if (char === '/') {
              if (template[pos + 1] === '>') pos += 2;
              else pos += 1;
              state = STATE.TEXT;
              textStart = pos;
            } else {
              tagStack.push(currentTag);
              pos += 1;
              state = STATE.TEXT;
              textStart = pos;
            }
          } else {
            pos += 1;
          }
          break;
        }

        case STATE.ATTR_VALUE_START: {
          if (char === '"' || char === "'") {
            attrQuote = char;
            attrValue = '';
            state = STATE.ATTR_VALUE;
            pos += 1;
          } else if (/\s/.test(char)) {
            pos += 1;
          } else {
            attrQuote = '';
            attrValue = char;
            state = STATE.ATTR_VALUE;
            pos += 1;
          }
          break;
        }

        case STATE.ATTR_VALUE: {
          if (attrQuote) {
            if (char === attrQuote) {
              processAttributeValue(attrName, attrValue, currentTag);
              state = STATE.TAG_SPACE;
              pos += 1;
            } else {
              attrValue += char;
              pos += 1;
            }
          } else {
            if (/[\s>\/]/.test(char)) {
              processAttributeValue(attrName, attrValue, currentTag);
              if (char === '>') {
                tagStack.push(currentTag);
                state = STATE.TEXT;
                textStart = pos + 1;
              } else {
                state = STATE.TAG_SPACE;
              }
              pos += 1;
            } else {
              attrValue += char;
              pos += 1;
            }
          }
          break;
        }

        case STATE.TAG_CLOSE: {
          if (char === '>') {
            const closingTag = tagName.toLowerCase();
            while (tagStack.length > 0) {
              const top = tagStack.pop();
              if (top.toLowerCase() === closingTag) break;
            }
            pos += 1;
            state = STATE.TEXT;
            textStart = pos;
            tagName = '';
          } else if (/[a-zA-Z0-9_:-]/.test(char)) {
            tagName += char;
            pos += 1;
          } else {
            pos += 1;
          }
          break;
        }

        case STATE.SCRIPT: {
          if (char === '<' && template.slice(pos, pos + 9).toLowerCase() === '</script>') {
            pos += 9;
            state = STATE.TEXT;
            textStart = pos;
            continue;
          }
          pos += 1;
          break;
        }

        case STATE.STYLE: {
          if (char === '<' && template.slice(pos, pos + 8).toLowerCase() === '</style>') {
            pos += 8;
            state = STATE.TEXT;
            textStart = pos;
            continue;
          }
          pos += 1;
          break;
        }

        default:
          pos += 1;
      }
    }

    // Process remaining text
    if (state === STATE.TEXT && textStart < len) {
      const text = template.slice(textStart);
      if (text.trim()) processTextContent(text);
    }
  }

  /**
   * Parse script section for i18n patterns
   */
  parseScript(script, results) {
    // Look for common i18n patterns in Vue scripts
    // This is a simplified extraction - the JSX parser handles full AST parsing

    // Extract strings from common patterns
    const patterns = [
      // $t('key') or t('key')
      /\$?t\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      // i18n.t('key')
      /i18n\.t\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      // useI18n().t('key')
      /useI18n\(\)\.t\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(script)) !== null) {
        // These are translation keys, not text to extract
        // But we note them for reference
      }
    }
  }

  /**
   * Override inferKindFromTag to include Vue/Nuxt specific components
   */
  inferKindFromTag(tagName) {
    if (!tagName) return 'text';
    const lower = tagName.toLowerCase();

    // Nuxt-specific
    if (lower === 'nuxt-link' || lower === 'nuxtlink') return 'link';
    if (lower === 'nuxt-page' || lower === 'nuxtpage') return 'text';

    // Vue Router
    if (lower === 'router-link' || lower === 'routerlink') return 'link';
    if (lower === 'router-view' || lower === 'routerview') return 'text';

    // Quasar components
    if (lower.startsWith('q-btn')) return 'button';
    if (lower.startsWith('q-input')) return 'placeholder';
    if (lower.startsWith('q-select')) return 'placeholder';
    if (lower.startsWith('q-dialog')) return 'heading';
    if (lower.startsWith('q-card-section')) return 'text';

    // Vuetify components
    if (lower.startsWith('v-btn')) return 'button';
    if (lower.startsWith('v-text-field')) return 'placeholder';
    if (lower.startsWith('v-select')) return 'placeholder';
    if (lower.startsWith('v-dialog')) return 'heading';
    if (lower.startsWith('v-card-title')) return 'heading';
    if (lower.startsWith('v-card-text')) return 'text';

    // Element Plus / Element UI
    if (lower === 'el-button') return 'button';
    if (lower === 'el-input') return 'placeholder';
    if (lower === 'el-select') return 'placeholder';
    if (lower === 'el-dialog') return 'heading';

    // PrimeVue
    if (lower === 'p-button' || lower === 'button') return 'button';
    if (lower === 'p-inputtext' || lower === 'inputtext') return 'placeholder';
    if (lower === 'p-dialog' || lower === 'dialog') return 'heading';

    return super.inferKindFromTag(tagName);
  }
}

module.exports = { VueParser };
