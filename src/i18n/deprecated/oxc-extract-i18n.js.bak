#!/usr/bin/env node
/**
 * i18n Extract Script - oxc-parser based
 * 
 * This script uses oxc-parser (Rust-based, ESTree-compatible) for fast AST parsing.
 * It extracts translatable strings from JS/TS/JSX/TSX/Vue files.
 * 
 * Required dependencies: oxc-parser (auto-installed by AI Localizer extension)
 */
const { readdir, readFile, writeFile, mkdir, stat } = require('node:fs/promises');
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');

// oxc-parser for fast Rust-based parsing
let parseSync;
try {
  parseSync = require('oxc-parser').parseSync;
} catch (err) {
  console.error('[i18n-extract] Warning: oxc-parser is not installed or is incompatible with this Node version.');
  console.error('[i18n-extract] Skipping extraction. No locale files were modified.');
  console.error('[i18n-extract] To enable oxc-based extraction, install a compatible oxc-parser (e.g. npm install -D oxc-parser)');
  console.error('[i18n-extract] or re-run the AI i18n "Configure Project i18n" command to switch to the Babel-based extract script.');
  process.exit(0);
}

// Import shared utilities
const { detectSrcRoot } = require('./lib/projectConfig');
const { slugifyForKey, getNamespaceFromFile, getNamespaceFromBladeFile } = require('./lib/stringUtils');
const { loadIgnorePatterns, shouldIgnoreAttribute, shouldTranslateText } = require('./lib/ignorePatterns');
const { primeTextKeyMap, getTranslation, setTranslation, ensureTranslationForKey, getNamespaceNode } = require('./lib/translationStore');

const projectRoot = path.resolve(__dirname, '..');
const MAX_FILE_SIZE_BYTES = Number(process.env.AI_I18N_MAX_FILE_SIZE || 2 * 1024 * 1024);
const CONCURRENCY = Number(process.env.AI_I18N_CONCURRENCY || 8);

const srcRoot = detectSrcRoot(projectRoot);
const outputDir = path.resolve(projectRoot, 'resources', 'js', 'i18n', 'auto');

// Load ignore patterns
const ignorePatterns = loadIgnorePatterns(projectRoot);

// Translation store
const translations = Object.create(null);
const textKeyMap = new Map();

// ============================================================================
// AST Node Type Helpers (ESTree/TS-ESTree compatible)
// ============================================================================

/**
 * Check if node is a string literal (ESTree uses Literal with string value)
 */
function isStringLiteral(node) {
  if (!node) return false;
  // oxc uses StringLiteral for string literals
  if (node.type === 'StringLiteral') return true;
  // ESTree uses Literal with typeof value === 'string'
  if (node.type === 'Literal' && typeof node.value === 'string') return true;
  return false;
}

/**
 * Get string value from a literal node
 */
function getStringValue(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/**
 * Check if node is a template literal
 */
function isTemplateLiteral(node) {
  return node && node.type === 'TemplateLiteral';
}

/**
 * Get JSX element name from opening element
 */
function getJsxElementName(node) {
  if (!node) return null;
  if (node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'JSXMemberExpression') {
    const objectName = getJsxElementName(node.object);
    const propName = getJsxElementName(node.property);
    if (objectName && propName) return `${objectName}.${propName}`;
    return propName || objectName;
  }
  return null;
}

/**
 * Infer translation kind from JSX element name
 */
function inferKindFromJsxElementName(name) {
  if (!name) return 'text';
  const lower = name.toLowerCase();
  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(lower)) return 'heading';
  if (lower === 'label') return 'label';
  if (lower === 'button' || name.endsWith('Button')) return 'button';
  if (lower === 'a' || lower === 'link') return 'link';
  if (lower === 'input' || lower === 'textarea' || lower === 'select') return 'placeholder';
  return 'text';
}

/**
 * Infer placeholder name from expression
 */
function inferPlaceholderNameFromExpression(expr, index) {
  if (!expr) return `value${index + 1}`;
  if (expr.type === 'Identifier') return expr.name;
  if (expr.type === 'MemberExpression' && !expr.computed) {
    const prop = expr.property;
    if (prop && prop.type === 'Identifier') return prop.name;
  }
  return `value${index + 1}`;
}

/**
 * Build pattern string from template literal (with placeholders)
 */
function buildPatternFromTemplateLiteral(tpl) {
  if (!tpl || !tpl.quasis) return '';
  const parts = [];
  for (let i = 0; i < tpl.quasis.length; i++) {
    const quasi = tpl.quasis[i];
    // oxc uses 'cooked' directly on quasi.value or quasi itself
    const cooked = quasi.value?.cooked ?? quasi.cooked ?? '';
    parts.push(cooked);
    if (tpl.expressions && i < tpl.expressions.length) {
      const expr = tpl.expressions[i];
      const name = inferPlaceholderNameFromExpression(expr, i);
      parts.push(`{${name}}`);
    }
  }
  return parts.join('');
}

/**
 * Get text pattern from a node (string literal or template literal)
 */
function getTextPattern(node) {
  if (!node) return null;
  if (isStringLiteral(node)) return getStringValue(node);
  if (isTemplateLiteral(node)) {
    if (!node.expressions || node.expressions.length === 0) {
      // Simple template literal without expressions
      return node.quasis.map(q => q.value?.cooked ?? q.cooked ?? '').join('');
    }
    return buildPatternFromTemplateLiteral(node);
  }
  return null;
}

// ============================================================================
// Translation Registration
// ============================================================================

function registerTranslation(namespace, kind, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !shouldTranslateText(trimmed, ignorePatterns)) {
    return null;
  }

  // Check balanced parentheses
  const openParens = (trimmed.match(/\(/g) || []).length;
  const closeParens = (trimmed.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    return null;
  }

  const keyId = `${namespace}|${kind}|${trimmed}`;
  const existingKey = textKeyMap.get(keyId);
  if (existingKey) {
    return existingKey;
  }

  const baseSlug = slugifyForKey(trimmed);
  let slug = baseSlug;
  let index = 2;

  const hasTranslation = (root, ns, k, s) => {
    const nsNode = getNamespaceNode(root, ns);
    if (!nsNode || !nsNode[k]) return false;
    return Object.prototype.hasOwnProperty.call(nsNode[k], s);
  };

  while (hasTranslation(translations, namespace, kind, slug) && 
         getTranslation(translations, namespace, kind, slug) !== trimmed) {
    slug = `${baseSlug}_${index}`;
    index += 1;
  }

  setTranslation(translations, namespace, kind, slug, trimmed);
  const fullKey = `${namespace}.${kind}.${slug}`;
  textKeyMap.set(keyId, fullKey);
  return fullKey;
}

// ============================================================================
// AST Walker
// ============================================================================

/**
 * Simple recursive AST walker
 */
function walk(node, visitors, parent = null, parentKey = null) {
  if (!node || typeof node !== 'object') return;

  // Call visitor if exists for this node type
  const visitor = visitors[node.type];
  if (visitor) {
    visitor(node, parent, parentKey);
  }

  // Walk children
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      for (let i = 0; i < child.length; i++) {
        walk(child[i], visitors, node, key);
      }
    } else if (child && typeof child === 'object' && child.type) {
      walk(child, visitors, node, key);
    }
  }
}

// ============================================================================
// File Collection
// ============================================================================

async function collectSourceFiles(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'vendor', '.git', 'storage', 'bootstrap', 'public'].includes(entry.name)) {
        continue;
      }
      await collectSourceFiles(entryPath, out);
    } else if (entry.isFile()) {
      if (/\.(tsx|ts|jsx|js)$/i.test(entry.name)) {
        out.push(entryPath);
      }
    }
  }
}

async function collectVueFiles(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'vendor', '.git', 'storage', 'bootstrap', 'public'].includes(entry.name)) {
        continue;
      }
      await collectVueFiles(entryPath, out);
    } else if (entry.isFile()) {
      if (/\.vue$/i.test(entry.name)) {
        out.push(entryPath);
      }
    }
  }
}

async function collectBladeFiles(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'vendor', '.git', 'storage', 'bootstrap', 'public'].includes(entry.name)) {
        continue;
      }
      await collectBladeFiles(entryPath, out);
    } else if (entry.isFile()) {
      if (/\.(blade\.php|php)$/i.test(entry.name)) {
        out.push(entryPath);
      }
    }
  }
}

// ============================================================================
// File Processing
// ============================================================================

async function processFile(filePath) {
  try {
    const s = await stat(filePath);
    if (s && s.size > MAX_FILE_SIZE_BYTES) {
      return;
    }
  } catch {}

  const code = await readFile(filePath, 'utf8');
  const namespace = getNamespaceFromFile(filePath, srcRoot);

  // Determine source type based on file extension
  const ext = path.extname(filePath).toLowerCase();
  const sourceFilename = path.basename(filePath);

  let result;
  try {
    result = parseSync(sourceFilename, code, {
      sourceType: 'module',
      lang: ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'ts' : ext === '.jsx' ? 'jsx' : 'js',
    });
  } catch (err) {
    console.error(`[i18n-extract] Parse error in ${filePath}:`, err.message);
    return;
  }

  if (!result || !result.program) {
    return;
  }

  const ast = result.program;

  // Track current JSX element for context
  let currentJsxElement = null;

  const visitors = {
    JSXElement(node) {
      currentJsxElement = node;
    },

    JSXText(node, parent) {
      const raw = node.value || '';
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) return;

      const jsxParent = parent && parent.type === 'JSXElement' ? parent : currentJsxElement;
      if (!jsxParent || !jsxParent.openingElement) return;

      const elementName = getJsxElementName(jsxParent.openingElement.name);
      const kind = inferKindFromJsxElementName(elementName);
      registerTranslation(namespace, kind, text);
    },

    JSXExpressionContainer(node, parent) {
      const expr = node.expression;
      if (!expr || expr.type === 'JSXEmptyExpression') return;

      const jsxParent = parent && parent.type === 'JSXElement' ? parent : currentJsxElement;
      if (!jsxParent || !jsxParent.openingElement) return;

      const elementName = getJsxElementName(jsxParent.openingElement.name);
      const kind = inferKindFromJsxElementName(elementName);

      const handleText = (text) => {
        const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
        if (cleaned) registerTranslation(namespace, kind, cleaned);
      };

      const processExpr = (e) => {
        if (!e) return;
        const pattern = getTextPattern(e);
        if (pattern) {
          handleText(pattern);
        } else if (e.type === 'ConditionalExpression') {
          processExpr(e.consequent);
          processExpr(e.alternate);
        }
      };

      processExpr(expr);
    },

    JSXAttribute(node) {
      const nameNode = node.name;
      if (!nameNode || nameNode.type !== 'JSXIdentifier') return;

      const attrName = nameNode.name;
      const valueNode = node.value;
      if (!valueNode) return;
      if (shouldIgnoreAttribute(attrName, ignorePatterns)) return;

      let kind = null;
      if (attrName === 'placeholder') kind = 'placeholder';
      else if (attrName === 'title') kind = 'title';
      else if (attrName === 'alt') kind = 'alt';
      else if (attrName === 'aria-label') kind = 'aria_label';
      else if (attrName === 'label') kind = 'label';
      if (!kind) return;

      const handleText = (text) => {
        const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
        if (cleaned) registerTranslation(namespace, kind, cleaned);
      };

      const processValue = (v) => {
        if (!v) return;
        const pattern = getTextPattern(v);
        if (pattern) {
          handleText(pattern);
        } else if (v.type === 'JSXExpressionContainer') {
          processValue(v.expression);
        } else if (v.type === 'ConditionalExpression') {
          processValue(v.consequent);
          processValue(v.alternate);
        }
      };

      processValue(valueNode);
    },

    // ESTree uses Property, Babel uses ObjectProperty
    Property(node, parent) {
      processObjectProperty(node, parent, namespace);
    },
    ObjectProperty(node, parent) {
      processObjectProperty(node, parent, namespace);
    },

    VariableDeclarator(node) {
      const id = node.id;
      const init = node.init;
      if (!id || id.type !== 'Identifier' || !init) return;

      const pattern = getTextPattern(init);
      if (!pattern) return;

      const cleaned = String(pattern).replace(/\s+/g, ' ').trim();
      if (!cleaned) return;

      const varName = id.name || '';
      let kind = 'text';
      if (/title/i.test(varName)) kind = 'heading';
      else if (/label/i.test(varName)) kind = 'label';
      else if (/placeholder/i.test(varName)) kind = 'placeholder';

      registerTranslation(namespace, kind, cleaned);
    },

    AssignmentExpression(node) {
      const left = node.left;
      const right = node.right;

      // document.title = ...
      if (left && left.type === 'MemberExpression' && !left.computed) {
        if (left.object?.type === 'Identifier' && left.object.name === 'document' &&
            left.property?.type === 'Identifier' && left.property.name === 'title') {
          const pattern = getTextPattern(right);
          if (pattern) {
            const cleaned = pattern.replace(/\s+/g, ' ').trim();
            if (cleaned) registerTranslation(namespace, 'title', cleaned);
          }
          return;
        }
      }

      // Variable assignment
      if (left && left.type === 'Identifier') {
        const pattern = getTextPattern(right);
        if (!pattern) return;

        const cleaned = String(pattern).replace(/\s+/g, ' ').trim();
        if (!cleaned) return;

        const varName = left.name || '';
        let kind = 'text';
        if (/title/i.test(varName)) kind = 'heading';
        else if (/label/i.test(varName)) kind = 'label';
        else if (/placeholder/i.test(varName)) kind = 'placeholder';

        registerTranslation(namespace, kind, cleaned);
      }
    },

    CallExpression(node) {
      const callee = node.callee;
      const args = node.arguments || [];

      // toast.xxx(...) calls
      if (callee && callee.type === 'MemberExpression' &&
          callee.object?.type === 'Identifier' && callee.object.name === 'toast') {
        if (args.length > 0) {
          const collectPatterns = (arg, out) => {
            const pattern = getTextPattern(arg);
            if (pattern) {
              out.push(pattern);
            } else if (arg.type === 'ConditionalExpression') {
              collectPatterns(arg.consequent, out);
              collectPatterns(arg.alternate, out);
            }
          };

          const patterns = [];
          collectPatterns(args[0], patterns);
          for (const p of patterns) {
            const cleaned = String(p).replace(/\s+/g, ' ').trim();
            if (cleaned) registerTranslation(namespace, 'toast', cleaned);
          }
        }
      }

      // t('key') calls - ensure translation exists
      if (callee && callee.type === 'Identifier' && callee.name === 't') {
        if (args.length > 0 && isStringLiteral(args[0])) {
          const key = getStringValue(args[0]);
          if (key) ensureTranslationForKey(translations, key);
        }
      }
    },
  };

  walk(ast, visitors);
}

function processObjectProperty(node, parent, namespace) {
  const keyNode = node.key;
  const valueNode = node.value;
  if (!valueNode) return;

  let propName = null;
  if (keyNode.type === 'Identifier') {
    propName = keyNode.name;
  } else if (isStringLiteral(keyNode)) {
    propName = getStringValue(keyNode);
  }
  if (!propName) return;

  let kind = null;
  if (propName === 'title') kind = 'heading';
  else if (propName === 'description') kind = 'text';
  else if (propName === 'cta') kind = 'button';

  // Heuristic: label property with space in value inside array
  if (!kind && propName === 'label' && isStringLiteral(valueNode)) {
    const valueText = getStringValue(valueNode) || '';
    const hasSpace = /\s/.test(valueText.trim());
    // Check if parent is in an array (simplified check)
    if (hasSpace && parent && parent.type === 'ArrayExpression') {
      kind = 'label';
    }
  }

  if (!kind) return;

  const pattern = getTextPattern(valueNode);
  if (!pattern) return;

  const cleaned = String(pattern).replace(/\s+/g, ' ').trim();
  if (cleaned) registerTranslation(namespace, kind, cleaned);
}

async function processVueFile(filePath) {
  try {
    const s = await stat(filePath);
    if (s && s.size > MAX_FILE_SIZE_BYTES) {
      return;
    }
  } catch {}

  const code = await readFile(filePath, 'utf8');
  const namespace = getNamespaceFromFile(filePath, srcRoot);
  const match = code.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
  if (!match) return;

  let template = match[1] || '';
  template = template.replace(/<!--([\s\S]*?)-->/g, ' ');

  const regex = /<([A-Za-z][A-Za-z0-9-_]*)\b[^>]*>([^<]+)</g;
  let m;
  while ((m = regex.exec(template)) !== null) {
    const tagName = m[1];
    const rawText = m[2];
    const text = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const kind = inferKindFromJsxElementName(tagName);
    registerTranslation(namespace, kind, text);
  }
}

async function processBladeFile(filePath) {
  try {
    const s = await stat(filePath);
    if (s && s.size > MAX_FILE_SIZE_BYTES) {
      return;
    }
  } catch {}

  const code = await readFile(filePath, 'utf8');
  const namespace = getNamespaceFromBladeFile(filePath, projectRoot);

  let template = code.replace(/{{--[\s\S]*?--}}/g, ' ');

  const tagRegex = /<([A-Za-z][A-Za-z0-9-_]*)\b[^>]*>([^<]+)<\/\1>/g;
  let m;
  while ((m = tagRegex.exec(template)) !== null) {
    const tagName = m[1];
    const rawText = m[2];
    if (!rawText || typeof rawText !== 'string') continue;
    if (rawText.includes("__('") || rawText.includes('__("') || 
        rawText.includes('@lang') || rawText.includes('trans(')) {
      continue;
    }
    if (rawText.includes('{{')) continue;

    const text = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const kind = inferKindFromJsxElementName(tagName);
    registerTranslation(namespace, kind, text);
  }
}

// ============================================================================
// Utilities
// ============================================================================

function sortObjectDeep(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const sortedKeys = Object.keys(input).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = sortObjectDeep(input[key]);
  }
  return result;
}

async function runConcurrent(items, worker, limit = CONCURRENCY) {
  const total = Array.isArray(items) ? items.length : 0;
  if (total === 0) return;
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, total) }, () => (async () => {
    while (true) {
      const i = index;
      index += 1;
      if (i >= total) break;
      const item = items[i];
      try {
        await worker(item);
      } catch (err) {
        console.error('[i18n-extract] Worker failed for', item, '-', err?.message || err);
      }
    }
  })());
  await Promise.all(runners);
}

// ============================================================================
// Main
// ============================================================================

(async () => {
  try {
    if (!existsSync(srcRoot)) {
      console.error(`[i18n-extract] Source root not found: ${srcRoot}`);
      process.exit(1);
    }

    // Load existing translations
    let existingTranslations = null;
    const groupedDir = path.resolve(outputDir, 'en');

    async function readJsonSafe(p) {
      try {
        const raw = await readFile(p, 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    function deepMerge(target, source) {
      if (!source || typeof source !== 'object') return target;
      for (const [k, v] of Object.entries(source)) {
        if (typeof v === 'object' && v && !Array.isArray(v)) {
          if (!target[k] || typeof target[k] !== 'object') target[k] = {};
          deepMerge(target[k], v);
        } else {
          target[k] = v;
        }
      }
      return target;
    }

    if (existsSync(groupedDir)) {
      existingTranslations = {};
      const stack = [groupedDir];
      while (stack.length) {
        const dir = stack.pop();
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile() && entry.name.endsWith('.json')) {
            const obj = await readJsonSafe(full);
            if (obj && typeof obj === 'object') deepMerge(existingTranslations, obj);
          }
        }
      }
    } else {
      const outputFile = path.resolve(outputDir, 'en.json');
      if (existsSync(outputFile)) {
        const parsed = await readJsonSafe(outputFile);
        if (parsed && typeof parsed === 'object') existingTranslations = parsed;
      }
    }

    if (existingTranslations) {
      Object.assign(translations, existingTranslations);
      primeTextKeyMap(existingTranslations, textKeyMap);
    }

    // Collect and process files
    const files = [];
    await collectSourceFiles(srcRoot, files);
    const vueFiles = [];
    await collectVueFiles(srcRoot, vueFiles);
    const bladeFiles = [];
    const viewsRoot = path.resolve(projectRoot, 'resources', 'views');
    if (existsSync(viewsRoot)) {
      await collectBladeFiles(viewsRoot, bladeFiles);
    }

    await runConcurrent(files, processFile, CONCURRENCY);
    await runConcurrent(vueFiles, processVueFile, CONCURRENCY);
    await runConcurrent(bladeFiles, processBladeFile, CONCURRENCY);

    // Write output
    const sorted = sortObjectDeep(translations);
    const localeDir = path.resolve(outputDir, 'en');
    await mkdir(localeDir, { recursive: true });

    function countLeafStrings(node) {
      let count = 0;
      function walkCount(n) {
        if (!n || typeof n !== 'object') return;
        for (const [, v] of Object.entries(n)) {
          if (typeof v === 'string') count += 1;
          else if (v && typeof v === 'object') walkCount(v);
        }
      }
      walkCount(node);
      return count;
    }

    const groups = Object.keys(sorted).sort();
    let fileCount = 0;
    for (const group of groups) {
      const subtree = sorted[group];
      if (!subtree || typeof subtree !== 'object') continue;
      const leafCount = countLeafStrings(subtree);
      if (leafCount <= 400) {
        const outPath = path.resolve(localeDir, `${group.toLowerCase()}.json`);
        const content = { [group]: subtree };
        await writeFile(outPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
        fileCount += 1;
      } else {
        const groupDir = path.resolve(localeDir, group.toLowerCase());
        await mkdir(groupDir, { recursive: true });
        const secondKeys = Object.keys(subtree).sort();
        for (const second of secondKeys) {
          const secondSub = subtree[second];
          if (!secondSub || typeof secondSub !== 'object') continue;
          const outPath = path.resolve(groupDir, `${String(second).toLowerCase()}.json`);
          const content = { [group]: { [second]: secondSub } };
          await writeFile(outPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
          fileCount += 1;
        }
      }
    }

    console.log(`[i18n-extract] Processed ${files.length} JS/TS files, ${vueFiles.length} Vue files, ${bladeFiles.length} Blade files.`);
    console.log(`[i18n-extract] Wrote ${fileCount} grouped files under ${path.relative(projectRoot, localeDir)}`);
  } catch (error) {
    console.error('[i18n-extract] Failed to extract translations.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
})();
