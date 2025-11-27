#!/usr/bin/env node
const { readdir, readFile, writeFile, mkdir, stat } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { parse } = require('@babel/parser');
const traverseModule = require('@babel/traverse');
// Handle ESM/CJS interop for @babel/traverse so that we always get a callable function
const traverse = typeof traverseModule === 'function' ? traverseModule : traverseModule.default;

// Import shared utilities
const { detectSrcRoot, getProjectLocales } = require('./lib/projectConfig');
const { toPascalCase, slugifyForKey, getNamespaceFromFile, getNamespaceFromBladeFile } = require('./lib/stringUtils');
const { getIgnorePatterns, shouldIgnoreAttribute, shouldIgnoreText } = require('./lib/ignorePatterns');
const { primeTextKeyMap, getTranslation, setTranslation, ensureTranslation, getNamespaceNode, ensureContainer } = require('./lib/translationStore');

const projectRoot = path.resolve(__dirname, '..');
const MAX_FILE_SIZE_BYTES = Number(process.env.AI_I18N_MAX_FILE_SIZE || 2 * 1024 * 1024);
const CONCURRENCY = Number(process.env.AI_I18N_CONCURRENCY || 8);

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

const srcRoot = detectSrcRoot(projectRoot);
const outputDir = path.resolve(projectRoot, 'resources', 'js', 'i18n', 'auto');
const outputFile = path.resolve(outputDir, 'en.json');

// Initialize ignore patterns from shared utility
getIgnorePatterns(projectRoot);

// Translation store now managed by lib/translationStore.js
const translations = Object.create(null);
const textKeyMap = new Map();

// Removed duplicate utility functions - now using:
// - lib/translationStore.js: getNamespaceNode, ensureContainer, hasTranslation, getTranslation, setTranslation, primeTextKeyMap, ensureTranslation
// - lib/ignorePatterns.js: shouldIgnoreText
// - lib/stringUtils.js: slugifyForKey

function registerTranslation(namespace, kind, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || shouldIgnoreText(trimmed)) {
    return null;
  }

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
  const hasTranslation = (root, namespace, kind, slug) => {
    const nsNode = getNamespaceNode(root, namespace);
    if (!nsNode || !nsNode[kind]) return false;
    return Object.prototype.hasOwnProperty.call(nsNode[kind], slug);
  };
  while (hasTranslation(translations, namespace, kind, slug) && getTranslation(translations, namespace, kind, slug) !== trimmed) {
    slug = `${baseSlug}_${index}`;
    index += 1;
  }
  setTranslation(translations, namespace, kind, slug, trimmed);
  const fullKey = `${namespace}.${kind}.${slug}`;
  textKeyMap.set(keyId, fullKey);
  return fullKey;
}

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

function getJsxElementName(node) {
  if (!node) return null;
  if (node.type === 'JSXIdentifier') {
    return node.name;
  }
  if (node.type === 'JSXMemberExpression') {
    const objectName = getJsxElementName(node.object);
    const propName = getJsxElementName(node.property);
    if (objectName && propName) return `${objectName}.${propName}`;
    return propName || objectName;
  }
  return null;
}

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

function getStringFromNode(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked || '').join('');
  }
  return null;
}

function inferPlaceholderNameFromExpression(expr, index) {
  if (!expr) return `value${index + 1}`;
  if (expr.type === 'Identifier') return expr.name;
  if (expr.type === 'MemberExpression' && !expr.computed && expr.property.type === 'Identifier') {
    return expr.property.name;
  }
  return `value${index + 1}`;
}

function buildPatternFromTemplateLiteral(tpl) {
  const parts = [];
  for (let i = 0; i < tpl.quasis.length; i += 1) {
    const quasi = tpl.quasis[i];
    parts.push(quasi.value.cooked || '');
    if (i < tpl.expressions.length) {
      const expr = tpl.expressions[i];
      const name = inferPlaceholderNameFromExpression(expr, i);
      parts.push(`{${name}}`);
    }
  }
  return parts.join('');
}

function getToastPatternFromArgument(arg) {
  if (!arg) return null;
  if (arg.type === 'StringLiteral') return arg.value;
  if (arg.type === 'TemplateLiteral') {
    if (arg.expressions.length === 0) {
      return arg.quasis.map((q) => q.value.cooked || '').join('');
    }
    return buildPatternFromTemplateLiteral(arg);
  }
  return null;
}

function collectToastPatternsFromArgument(arg, out) {
  if (!arg) return;

  if (arg.type === 'StringLiteral' || arg.type === 'TemplateLiteral') {
    const pattern = getToastPatternFromArgument(arg);
    if (pattern) {
      out.push(pattern);
    }
    return;
  }

  if (arg.type === 'ConditionalExpression') {
    collectToastPatternsFromArgument(arg.consequent, out);
    collectToastPatternsFromArgument(arg.alternate, out);
  }
}

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
        console.error('[i18n-extract] Worker failed for', item, '-', err && err.message ? err.message : err);
      }
    }
  })());
  await Promise.all(runners);
}

async function processFile(filePath) {
  try {
    const s = await stat(filePath);
    if (s && s.size > MAX_FILE_SIZE_BYTES) {
      return;
    }
  } catch {}
  const code = await readFile(filePath, 'utf8');
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  });
  const namespace = getNamespaceFromFile(filePath, srcRoot);

  traverse(ast, {
    JSXExpressionContainer(pathNode) {
      const expr = pathNode.node.expression;
      if (!expr) return;
      const parent = pathNode.parent && pathNode.parent.type === 'JSXElement' ? pathNode.parent : null;
      if (!parent || !parent.openingElement) return;
      const elementName = getJsxElementName(parent.openingElement.name);
      const kind = inferKindFromJsxElementName(elementName);

      const handleText = (text) => {
        const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return;
        registerTranslation(namespace, kind, cleaned);
      };

      if (expr.type === 'StringLiteral') {
        handleText(expr.value);
      } else if (expr.type === 'TemplateLiteral') {
        handleText(buildPatternFromTemplateLiteral(expr));
      } else if (expr.type === 'ConditionalExpression') {
        const { consequent, alternate } = expr;
        // Extract consequent branch
        if (consequent.type === 'StringLiteral') {
          handleText(consequent.value);
        } else if (consequent.type === 'TemplateLiteral') {
          handleText(buildPatternFromTemplateLiteral(consequent));
        } else if (consequent.type === 'ConditionalExpression') {
          // Recursively handle nested ternaries in consequent
          const handleConditional = (node) => {
            if (node.type === 'StringLiteral') {
              handleText(node.value);
            } else if (node.type === 'TemplateLiteral') {
              handleText(buildPatternFromTemplateLiteral(node));
            } else if (node.type === 'ConditionalExpression') {
              handleConditional(node.consequent);
              handleConditional(node.alternate);
            }
          };
          handleConditional(consequent);
        }
        // Extract alternate branch
        if (alternate.type === 'StringLiteral') {
          handleText(alternate.value);
        } else if (alternate.type === 'TemplateLiteral') {
          handleText(buildPatternFromTemplateLiteral(alternate));
        } else if (alternate.type === 'ConditionalExpression') {
          // Recursively handle nested ternaries in alternate
          const handleConditional = (node) => {
            if (node.type === 'StringLiteral') {
              handleText(node.value);
            } else if (node.type === 'TemplateLiteral') {
              handleText(buildPatternFromTemplateLiteral(node));
            } else if (node.type === 'ConditionalExpression') {
              handleConditional(node.consequent);
              handleConditional(node.alternate);
            }
          };
          handleConditional(alternate);
        }
      }
    },
    JSXText(pathNode) {
      const raw = pathNode.node.value;
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const parent = pathNode.parent && pathNode.parent.type === 'JSXElement' ? pathNode.parent : null;
      if (!parent || !parent.openingElement) return;
      const elementName = getJsxElementName(parent.openingElement.name);
      const kind = inferKindFromJsxElementName(elementName);

      let effectiveText = text;

      if (text.endsWith('(') && Array.isArray(parent.children)) {
        const children = parent.children;
        const idx = children.indexOf(pathNode.node);
        if (idx >= 0 && idx + 2 < children.length) {
          const next = children[idx + 1];
          const next2 = children[idx + 2];
          if (
            next && next.type === 'JSXExpressionContainer' &&
            next2 && next2.type === 'JSXText'
          ) {
            const closingText = String(next2.value || '').replace(/\s+/g, ' ').trim();
            if (closingText.startsWith(')')) {
              effectiveText = text.replace(/\(\s*$/, '').trimEnd();
            }
          }
        }
      }

      registerTranslation(namespace, kind, effectiveText);
    },
    JSXAttribute(pathNode) {
      const nameNode = pathNode.node.name;
      if (!nameNode || nameNode.type !== 'JSXIdentifier') return;
      const attrName = nameNode.name;
      const valueNode = pathNode.node.value;
      if (!valueNode) return;
      if (shouldIgnoreAttribute(attrName)) return;
      let kind = null;
      if (attrName === 'placeholder') kind = 'placeholder';
      else if (attrName === 'title') kind = 'title';
      else if (attrName === 'alt') kind = 'alt';
      else if (attrName === 'aria-label') kind = 'aria_label';
      else if (attrName === 'label') kind = 'label';
      if (!kind) return;

      const handleText = (text) => {
        const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return;
        registerTranslation(namespace, kind, cleaned);
      };

      const handleExpr = (node) => {
        if (!node) return;
        if (node.type === 'StringLiteral') {
          handleText(node.value);
        } else if (node.type === 'TemplateLiteral') {
          handleText(buildPatternFromTemplateLiteral(node));
        } else if (node.type === 'ConditionalExpression') {
          handleExpr(node.consequent);
          handleExpr(node.alternate);
        }
      };

      if (valueNode.type === 'StringLiteral') {
        handleText(valueNode.value);
      } else if (valueNode.type === 'JSXExpressionContainer') {
        handleExpr(valueNode.expression);
      }
    },
    ObjectProperty(pathNode) {
      const keyNode = pathNode.node.key;
      const valueNode = pathNode.node.value;
      if (!valueNode) return;

      let propName = null;
      if (keyNode.type === 'Identifier') {
        propName = keyNode.name;
      } else if (keyNode.type === 'StringLiteral') {
        propName = keyNode.value;
      }
      if (!propName) return;

      let kind = null;
      if (propName === 'title') kind = 'heading';
      else if (propName === 'description') kind = 'text';
      else if (propName === 'cta') kind = 'button';

      // Heuristic 1: plain `label` property on array items that look like
      // human-facing labels (e.g. "Company signature"). We only enable this
      // when the value contains a space and the object lives inside an
      // ArrayExpression to avoid touching label-like values that might be
      // used as keys/indexes. This heuristic only applies to simple
      // string literals.
      if (!kind && propName === 'label' && valueNode.type === 'StringLiteral') {
        const parent = pathNode.parent;
        const parentPath = pathNode.parentPath;
        const grand = parentPath && parentPath.parentPath ? parentPath.parentPath.node : null;
        const valueText = String(valueNode.value || '');
        const hasSpace = /\s/.test(valueText.trim());
        const isInArray = grand && grand.type === 'ArrayExpression';
        if (hasSpace && isInArray) {
          kind = 'label';
        }
      }

      // Heuristic 2: treat label-mapping objects like `quickActionLabel` as
      // label text based on the variable name, even if the property name isn't
      // literally `label`.
      if (!kind) {
        const parent = pathNode.parent;
        if (parent && parent.type === 'ObjectExpression') {
          const parentPath = pathNode.parentPath;
          if (parentPath && parentPath.parentPath) {
            const container = parentPath.parentPath.node;
            if (container && container.type === 'VariableDeclarator' && container.id && container.id.type === 'Identifier') {
              const varName = container.id.name;
              if (varName && /label/i.test(varName)) {
                kind = 'label';
              }
            }
          }
        }
      }

      if (!kind) return;

      // Support both simple string values and template literals with
      // interpolations (e.g. `${count} items selected`). Template literals
      // are converted into a pattern using placeholders so that extract and
      // replace stay in sync.
      let pattern = null;
      if (valueNode.type === 'StringLiteral') {
        pattern = String(valueNode.value || '');
      } else if (valueNode.type === 'TemplateLiteral') {
        pattern = buildPatternFromTemplateLiteral(valueNode);
      } else {
        return;
      }

      const cleaned = String(pattern).replace(/\s+/g, ' ').trim();
      if (!cleaned) return;

      registerTranslation(namespace, kind, cleaned);
    },
    AssignmentExpression(pathNode) {
      const left = pathNode.node.left;
      const right = pathNode.node.right;

      // document.title = ...
      if (
        left &&
        left.type === 'MemberExpression' &&
        !left.computed &&
        left.object.type === 'Identifier' &&
        left.object.name === 'document' &&
        left.property.type === 'Identifier' &&
        left.property.name === 'title'
      ) {
        let pattern = null;
        if (right.type === 'StringLiteral') {
          pattern = right.value;
        } else if (right.type === 'TemplateLiteral') {
          pattern = right.expressions.length === 0
            ? right.quasis.map((q) => q.value.cooked || '').join('')
            : buildPatternFromTemplateLiteral(right);
        }
        if (!pattern) return;
        const cleaned = pattern.replace(/\s+/g, ' ').trim();
        if (!cleaned) return;
        registerTranslation(namespace, 'title', cleaned);
        return;
      }

      // Heuristic: assignments to identifier variables likely used for UI messages
      if (left && left.type === 'Identifier') {
        let pattern = null;
        if (right.type === 'StringLiteral') {
          pattern = right.value;
        } else if (right.type === 'TemplateLiteral') {
          pattern = buildPatternFromTemplateLiteral(right);
        }
        if (!pattern) return;
        const cleaned = String(pattern).replace(/\s+/g, ' ').trim();
        if (!cleaned) return;
        // Derive kind from variable name when possible
        const varName = left.name || '';
        let kind = 'text';
        if (/title/i.test(varName)) kind = 'heading';
        else if (/label/i.test(varName)) kind = 'label';
        else if (/placeholder/i.test(varName)) kind = 'placeholder';
        registerTranslation(namespace, kind, cleaned);
      }
    },
    VariableDeclarator(pathNode) {
      const id = pathNode.node.id;
      const init = pathNode.node.init;
      if (!id || id.type !== 'Identifier' || !init) return;
      let pattern = null;
      if (init.type === 'StringLiteral') {
        pattern = init.value;
      } else if (init.type === 'TemplateLiteral') {
        pattern = buildPatternFromTemplateLiteral(init);
      }
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
    CallExpression(pathNode) {
      const callee = pathNode.node.callee;
      if (callee && callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'toast') {
        const args = pathNode.node.arguments || [];
        if (args.length === 0) return;
        const first = args[0];
        const patterns = [];
        collectToastPatternsFromArgument(first, patterns);
        if (!patterns.length) return;
        for (const pattern of patterns) {
          const cleaned = String(pattern).replace(/\s+/g, ' ').trim();
          if (!cleaned) continue;
          registerTranslation(namespace, 'toast', cleaned);
        }
      }

      if (callee && callee.type === 'Identifier' && callee.name === 't') {
        const args = pathNode.node.arguments || [];
        if (args.length === 0) return;
        const first = args[0];
        if (!first || first.type !== 'StringLiteral') return;
        const key = first.value;
        if (!key) return;
        ensureTranslation(translations, key);
      }
    },
  });
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
    if (rawText.includes("__('") || rawText.includes('__("') || rawText.includes('@lang') || rawText.includes('trans(')) {
      continue;
    }
    if (rawText.includes('{{')) {
      continue;
    }
    const text = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const kind = inferKindFromJsxElementName(tagName);
    registerTranslation(namespace, kind, text);
  }
}

(async () => {
  try {
    if (!existsSync(srcRoot)) {
      console.error(`[i18n-extract] Source root not found: ${srcRoot}`);
      process.exit(1);
    }

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
      const fsSync = await import('node:fs');
      while (stack.length) {
        const dir = stack.pop();
        const entries = fsSync.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile() && entry.name.endsWith('.json')) {
            const obj = await readJsonSafe(full);
            if (obj && typeof obj === 'object') deepMerge(existingTranslations, obj);
          }
        }
      }
    } else if (existsSync(outputFile)) {
      const parsed = await readJsonSafe(outputFile);
      if (parsed && typeof parsed === 'object') existingTranslations = parsed;
    }

    if (existingTranslations) {
      Object.assign(translations, existingTranslations);
      primeTextKeyMap(existingTranslations, textKeyMap);
    }

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
    const sorted = sortObjectDeep(translations);
    const localeDir = path.resolve(outputDir, 'en');
    await mkdir(localeDir, { recursive: true });

    function countLeafStrings(node) {
      let count = 0;
      function walk(n) {
        if (!n || typeof n !== 'object') return;
        for (const [k, v] of Object.entries(n)) {
          if (typeof v === 'string') count += 1;
          else if (v && typeof v === 'object') walk(v);
        }
      }
      walk(node);
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

    console.log(`[i18n-extract] Processed ${files.length} files.`);
    console.log(`[i18n-extract] Wrote ${fileCount} grouped files under ${path.relative(projectRoot, localeDir)}`);
  } catch (error) {
    console.error('[i18n-extract] Failed to extract translations.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
})();
