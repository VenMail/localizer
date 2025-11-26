#!/usr/bin/env node
const { readdir, readFile, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { parse } = require('@babel/parser');
const traverseModule = require('@babel/traverse');
const generateModule = require('@babel/generator');
const t = require('@babel/types');

const traverse = typeof traverseModule === 'function' ? traverseModule : traverseModule.default;
const generate = typeof generateModule === 'function' ? generateModule : generateModule.default;

// Import shared utilities
const { detectSrcRoot } = require('./lib/projectConfig');
const { getNamespaceFromFile } = require('./lib/stringUtils');
const { getIgnorePatterns, shouldIgnoreAttribute } = require('./lib/ignorePatterns');

const projectRoot = path.resolve(__dirname, '..');

const srcRoot = detectSrcRoot(projectRoot);
const translationsPath = path.resolve(projectRoot, 'resources', 'js', 'i18n', 'auto', 'en.json');

// Initialize ignore patterns from shared utility
getIgnorePatterns(projectRoot);

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

function isTCallExpression(node) {
  return (
    node &&
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 't'
  );
}

function insertExplicitSpacesInJsxChildren(children) {
  let changed = false;

  for (let i = 0; i < children.length; i += 1) {
    const first = children[i];
    if (!first || first.type !== 'JSXExpressionContainer') continue;

    const expr1 = first.expression;
    if (!expr1) continue;

    // If the first expression is already an explicit space ({" "}) skip it to
    // avoid patterns like {count}{" "}{" "}{t(...)} when code already uses
    // an explicit JSX space.
    if (expr1.type === 'StringLiteral' && expr1.value === ' ') {
      continue;
    }

    // Skip if the first expression is itself a t() call.
    if (isTCallExpression(expr1)) continue;

    let j = i + 1;
    const whitespaceIndexes = [];

    // Collect any pure-whitespace JSXText nodes immediately after the first expression.
    while (j < children.length && children[j].type === 'JSXText') {
      const textNode = children[j];
      if (textNode.value.trim() === '') {
        whitespaceIndexes.push(j);
        j += 1;
      } else {
        break;
      }
    }

    if (j >= children.length) continue;

    const second = children[j];
    if (!second || second.type !== 'JSXExpressionContainer') continue;
    const expr2 = second.expression;
    if (!expr2) continue;

    // Only adjust when the second expression is a t() call.
    if (!isTCallExpression(expr2)) continue;

    // Check if there is already an explicit JSXExpressionContainer with a single
    // space between.
    let hasExplicitSpace = false;
    for (const idx of whitespaceIndexes) {
      const node = children[idx];
      if (
        node.type === 'JSXExpressionContainer' &&
        node.expression &&
        node.expression.type === 'StringLiteral' &&
        node.expression.value === ' '
      ) {
        hasExplicitSpace = true;
        break;
      }
    }

    if (hasExplicitSpace) {
      continue;
    }

    const spaceExpr = t.jsxExpressionContainer(t.stringLiteral(' '));

    if (whitespaceIndexes.length > 0) {
      // Replace the first whitespace node with {" "} and remove any additional
      // whitespace nodes.
      const start = whitespaceIndexes[0];
      const deleteCount = whitespaceIndexes.length;
      children.splice(start, deleteCount, spaceExpr);
    } else {
      // Insert {" "} between the two expression containers.
      children.splice(i + 1, 0, spaceExpr);
    }

    changed = true;
    // Skip past the newly inserted space expression to avoid re-processing.
    i += 1;
  }

  return changed;
}

function getStringFromNode(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked || '').join('');
  }
  return null;
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isNonTranslatableExample(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/\s+/g, ' ');
  const ignore = getIgnorePatterns();
  if (ignore && Array.isArray(ignore.exact) && ignore.exact.includes(normalized)) {
    return true;
  }
  if (ignore && Array.isArray(ignore.exactInsensitive)) {
    const lowerNorm = normalized.toLowerCase();
    for (const v of ignore.exactInsensitive) {
      if (String(v).toLowerCase() === lowerNorm) {
        return true;
      }
    }
  }
  if (ignore && Array.isArray(ignore.contains)) {
    for (const part of ignore.contains) {
      if (part && normalized.includes(String(part))) {
        return true;
      }
    }
  }
  const alphaNum = normalized.replace(/[^A-Za-z0-9]/g, '');
  if (alphaNum && alphaNum.length <= 4 && alphaNum.toUpperCase() === alphaNum) {
    return true;
  }
  if (/\d{2,}/.test(normalized)) {
    const lower = normalized.toLowerCase();
    if (lower.includes('main street') && lower.includes('city') && lower.includes('state')) {
      return true;
    }
  }
  return false;
}

function shouldTranslateText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false;
  if (isNonTranslatableExample(trimmed)) return false;
  return true;
}

function inferPlaceholderNameFromExpression(expr, index) {
  if (!expr) return `value${index + 1}`;
  if (expr.type === 'Identifier') return expr.name;
  if (expr.type === 'MemberExpression' && !expr.computed && expr.property.type === 'Identifier') {
    return expr.property.name;
  }
  return `value${index + 1}`;
}

function buildPatternAndPlaceholdersFromTemplate(tpl) {
  const parts = [];
  const placeholders = [];
  for (let i = 0; i < tpl.quasis.length; i += 1) {
    const quasi = tpl.quasis[i];
    parts.push(quasi.value.cooked || '');
    if (i < tpl.expressions.length) {
      const expr = tpl.expressions[i];
      const name = inferPlaceholderNameFromExpression(expr, i);
      placeholders.push({ name, expression: expr });
      parts.push(`{${name}}`);
    }
  }
  return { pattern: parts.join(''), placeholders };
}

function getToastMessageInfo(arg) {
  if (!arg) return null;
  if (arg.type === 'StringLiteral') {
    return { pattern: arg.value, placeholders: [] };
  }
  if (arg.type === 'TemplateLiteral') {
    if (arg.expressions.length === 0) {
      return { pattern: arg.quasis.map((q) => q.value.cooked || '').join(''), placeholders: [] };
    }
    return buildPatternAndPlaceholdersFromTemplate(arg);
  }
  return null;
}

function buildKeyMapFromTranslations(translations) {
  const map = new Map();

  function walk(node, pathSegments) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const nextPath = [...pathSegments, key];
      if (typeof value === 'string') {
        if (!shouldTranslateText(value)) continue;
        if (nextPath.length < 3) continue;
        const slug = nextPath[nextPath.length - 1];
        const kind = nextPath[nextPath.length - 2];
        const nsSegments = nextPath.slice(0, -2);
        const namespace = nsSegments.join('.');
        const text = value;
        const keyId = `${namespace}|${kind}|${text}`;
        const fullKey = nextPath.join('.');
        if (!map.has(keyId)) {
          map.set(keyId, fullKey);
        }
      } else {
        walk(value, nextPath);
      }
    }
  }

  walk(translations, []);
  return map;
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

function ensureI18nImport(ast) {
  const body = ast.program.body;
  let hasI18nImport = false;
  let hasTImportConflict = false;

  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source.value;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.local.name === 't') {
        if (source === '@/i18n') {
          hasI18nImport = true;
        } else {
          hasTImportConflict = true;
        }
      }
    }
  }

  if (hasTImportConflict) {
    return { hasI18nImport: false, hasTImportConflict: true };
  }

  if (!hasI18nImport) {
    const importDecl = t.importDeclaration(
      [t.importSpecifier(t.identifier('t'), t.identifier('t'))],
      t.stringLiteral('@/i18n'),
    );

    let lastImportIndex = -1;
    for (let i = 0; i < body.length; i += 1) {
      if (body[i].type === 'ImportDeclaration') {
        lastImportIndex = i;
      }
    }

    if (lastImportIndex >= 0) {
      body.splice(lastImportIndex + 1, 0, importDecl);
    } else {
      body.unshift(importDecl);
    }
  }

  return { hasI18nImport: true, hasTImportConflict: false };
}

async function processFile(filePath, keyMap) {
  const code = await readFile(filePath, 'utf8');
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  });

  const namespace = getNamespaceFromFile(filePath, srcRoot);

  let hasLocalTConflict = false;
  let changed = false;

  traverse(ast, {
    CallExpression(path) {
      if (hasLocalTConflict) return;
      const callee = path.node.callee;

      // Check if this is a call to 't'
      if (callee.type === 'Identifier' && callee.name === 't') {
        const binding = path.scope.getBinding('t');
        if (!binding) return;

        // Only flag as conflict if 't' is bound to something other than our i18n import
        if (
          !binding.path.isImportSpecifier() ||
          !binding.path.parent ||
          binding.path.parent.type !== 'ImportDeclaration' ||
          binding.path.parent.source.value !== '@/i18n'
        ) {
          hasLocalTConflict = true;
          path.stop();
        }
      }
    },
  });

  // Second pass: ensure explicit spaces between expressions and following t() calls
  // in JSX so patterns like `{count}{t("...")}` become `{count}{" "}{t("...")}`.
  traverse(ast, {
    JSXElement(pathNode) {
      const didChange = insertExplicitSpacesInJsxChildren(pathNode.node.children);
      if (didChange) changed = true;
    },
    JSXFragment(pathNode) {
      const didChange = insertExplicitSpacesInJsxChildren(pathNode.node.children);
      if (didChange) changed = true;
    },
  });

  if (hasLocalTConflict) {
    return { changed: false, skippedDueToConflict: true };
  }
  traverse(ast, {
    JSXExpressionContainer(pathNode) {
      const expr = pathNode.node.expression;
      if (!expr) return;

      const parent = pathNode.parent && pathNode.parent.type === 'JSXElement' ? pathNode.parent : null;
      if (!parent || !parent.openingElement) return;
      const elementName = getJsxElementName(parent.openingElement.name);
      const kind = inferKindFromJsxElementName(elementName);

      // If 't' is shadowed in this scope (e.g. map((t) => ...)),
      // do NOT insert calls to t(), since they'd bind to the local variable
      // instead of the i18n import.
      const tBinding = pathNode.scope.getBinding('t');
      if (
        tBinding && (
          !tBinding.path.isImportSpecifier() ||
          !tBinding.path.parent ||
          tBinding.path.parent.type !== 'ImportDeclaration' ||
          tBinding.path.parent.source.value !== '@/i18n'
        )
      ) {
        return;
      }

      function buildCallFromString(text) {
        const cleaned = normalizeText(text);
        if (!shouldTranslateText(cleaned)) return null;
        const keyId = `${namespace}|${kind}|${cleaned}`;
        const fullKey = keyMap.get(keyId);
        if (!fullKey) return null;
        return t.callExpression(t.identifier('t'), [t.stringLiteral(fullKey)]);
      }

      function buildCallFromTemplate(tpl) {
        const { pattern, placeholders } = buildPatternAndPlaceholdersFromTemplate(tpl);
        const cleaned = normalizeText(pattern);
        if (!shouldTranslateText(cleaned)) return null;
        const keyId = `${namespace}|${kind}|${cleaned}`;
        const fullKey = keyMap.get(keyId);
        if (!fullKey) return null;
        const props = placeholders.map(({ name, expression }) => t.objectProperty(t.identifier(name), expression));
        const paramsObject = props.length ? t.objectExpression(props) : null;
        const args = paramsObject ? [t.stringLiteral(fullKey), paramsObject] : [t.stringLiteral(fullKey)];
        return t.callExpression(t.identifier('t'), args);
      }

      if (expr.type === 'StringLiteral') {
        const call = buildCallFromString(expr.value);
        if (call) {
          pathNode.node.expression = call;
          changed = true;
        }
        return;
      }

      if (expr.type === 'TemplateLiteral') {
        const call = buildCallFromTemplate(expr);
        if (call) {
          pathNode.node.expression = call;
          changed = true;
        }
        return;
      }

      if (expr.type === 'ConditionalExpression') {
        let modified = false;
        const { test, consequent, alternate } = expr;
        let newConsequent = consequent;
        let newAlternate = alternate;

        // Recursively process nested conditionals
        const processConditionalNode = (node) => {
          if (node.type === 'StringLiteral') {
            const call = buildCallFromString(node.value);
            return call || node;
          } else if (node.type === 'TemplateLiteral') {
            const call = buildCallFromTemplate(node);
            return call || node;
          } else if (node.type === 'ConditionalExpression') {
            const processedConsequent = processConditionalNode(node.consequent);
            const processedAlternate = processConditionalNode(node.alternate);
            const wasModified = processedConsequent !== node.consequent || processedAlternate !== node.alternate;
            if (wasModified) {
              return t.conditionalExpression(node.test, processedConsequent, processedAlternate);
            }
            return node;
          }
          return node;
        };

        newConsequent = processConditionalNode(consequent);
        newAlternate = processConditionalNode(alternate);

        if (newConsequent !== consequent || newAlternate !== alternate) {
          pathNode.node.expression = t.conditionalExpression(test, newConsequent, newAlternate);
          changed = true;
        }
      }
    },
    JSXText(pathNode) {
      const raw = pathNode.node.value;
      const hasLeadingSpace = /^\s/.test(raw);
      const hasTrailingSpace = /\s$/.test(raw);
      const text = normalizeText(raw);
      if (!shouldTranslateText(text)) return;
      const parent = pathNode.parent && pathNode.parent.type === 'JSXElement' ? pathNode.parent : null;
      if (!parent || !parent.openingElement) return;
      const elementName = getJsxElementName(parent.openingElement.name);
      const kind = inferKindFromJsxElementName(elementName);
      const tBinding = pathNode.scope.getBinding('t');
      if (
        tBinding && (
          !tBinding.path.isImportSpecifier() ||
          !tBinding.path.parent ||
          tBinding.path.parent.type !== 'ImportDeclaration' ||
          tBinding.path.parent.source.value !== '@/i18n'
        )
      ) {
        return;
      }
      const keyId = `${namespace}|${kind}|${text}`;
      const fullKey = keyMap.get(keyId);
      if (!fullKey) return;
      const callExpr = t.callExpression(t.identifier('t'), [t.stringLiteral(fullKey)]);
      const exprContainer = t.jsxExpressionContainer(callExpr);

      const nodes = [];
      if (hasLeadingSpace) {
        nodes.push(t.jsxText(' '));
      }
      nodes.push(exprContainer);
      if (hasTrailingSpace) {
        nodes.push(t.jsxText(' '));
      }

      if (nodes.length === 1) {
        pathNode.replaceWith(exprContainer);
      } else {
        pathNode.replaceWithMultiple(nodes);
      }
      changed = true;
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
      const tBinding = pathNode.scope.getBinding('t');
      if (
        tBinding && (
          !tBinding.path.isImportSpecifier() ||
          !tBinding.path.parent ||
          tBinding.path.parent.type !== 'ImportDeclaration' ||
          tBinding.path.parent.source.value !== '@/i18n'
        )
      ) {
        return;
      }
      const makeCallFromString = (s) => {
        const cleaned = normalizeText(s);
        if (!shouldTranslateText(cleaned)) return null;
        const keyId = `${namespace}|${kind}|${cleaned}`;
        const fullKey = keyMap.get(keyId);
        if (!fullKey) return null;
        return t.callExpression(t.identifier('t'), [t.stringLiteral(fullKey)]);
      };
      const makeCallFromTemplate = (tpl) => {
        const { pattern, placeholders } = buildPatternAndPlaceholdersFromTemplate(tpl);
        const cleaned = normalizeText(pattern);
        if (!shouldTranslateText(cleaned)) return null;
        const keyId = `${namespace}|${kind}|${cleaned}`;
        const fullKey = keyMap.get(keyId);
        if (!fullKey) return null;
        const props = placeholders.map(({ name, expression }) => t.objectProperty(t.identifier(name), expression));
        const paramsObject = props.length ? t.objectExpression(props) : null;
        const args = paramsObject ? [t.stringLiteral(fullKey), paramsObject] : [t.stringLiteral(fullKey)];
        return t.callExpression(t.identifier('t'), args);
      };

      if (valueNode.type === 'StringLiteral') {
        const call = makeCallFromString(valueNode.value);
        if (!call) return;
        pathNode.node.value = t.jsxExpressionContainer(call);
        changed = true;
        return;
      }

      if (valueNode.type === 'JSXExpressionContainer') {
        const expr = valueNode.expression;
        if (!expr) return;
        if (expr.type === 'StringLiteral') {
          const call = makeCallFromString(expr.value);
          if (!call) return;
          pathNode.node.value = t.jsxExpressionContainer(call);
          changed = true;
          return;
        }
        if (expr.type === 'TemplateLiteral') {
          const call = makeCallFromTemplate(expr);
          if (!call) return;
          pathNode.node.value = t.jsxExpressionContainer(call);
          changed = true;
          return;
        }
        if (expr.type === 'ConditionalExpression') {
          const transformBranch = (node) => {
            if (node.type === 'StringLiteral') return makeCallFromString(node.value) || node;
            if (node.type === 'TemplateLiteral') return makeCallFromTemplate(node) || node;
            if (node.type === 'ConditionalExpression') {
              const a = transformBranch(node.consequent);
              const b = transformBranch(node.alternate);
              if (a !== node.consequent || b !== node.alternate) {
                return t.conditionalExpression(node.test, a, b);
              }
              return node;
            }
            return node;
          };
          const newConsequent = transformBranch(expr.consequent);
          const newAlternate = transformBranch(expr.alternate);
          if (newConsequent !== expr.consequent || newAlternate !== expr.alternate) {
            pathNode.node.value = t.jsxExpressionContainer(
              t.conditionalExpression(expr.test, newConsequent, newAlternate),
            );
            changed = true;
          }
        }
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
      // human-facing labels (e.g. "Company signature"). Only when the value
      // has a space and the object is inside an ArrayExpression. This
      // heuristic only applies to simple string literal values.
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
      // label text based on the variable name.
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

      const tBinding = pathNode.scope.getBinding('t');
      if (
        tBinding && (
          !tBinding.path.isImportSpecifier() ||
          !tBinding.path.parent ||
          tBinding.path.parent.type !== 'ImportDeclaration' ||
          tBinding.path.parent.source.value !== '@/i18n'
        )
      ) {
        return;
      }

      // Support both simple string values and template literals with
      // interpolations (e.g. `${count} items selected`). Template literals
      // are converted into a pattern with placeholders so that extract and
      // replace stay in sync.
      if (valueNode.type === 'StringLiteral') {
        const cleaned = normalizeText(valueNode.value);
        if (!shouldTranslateText(cleaned)) return;

        const keyId = `${namespace}|${kind}|${cleaned}`;
        const fullKey = keyMap.get(keyId);
        if (!fullKey) return;

        const callExpr = t.callExpression(t.identifier('t'), [t.stringLiteral(fullKey)]);
        pathNode.node.value = callExpr;
        changed = true;
      } else if (valueNode.type === 'TemplateLiteral') {
        const { pattern, placeholders } = buildPatternAndPlaceholdersFromTemplate(valueNode);
        const cleaned = normalizeText(pattern);
        if (!shouldTranslateText(cleaned)) return;

        const keyId = `${namespace}|${kind}|${cleaned}`;
        const fullKey = keyMap.get(keyId);
        if (!fullKey) return;

        const argsForCall = [t.stringLiteral(fullKey)];
        if (placeholders.length > 0) {
          const props = placeholders.map(({ name, expression }) =>
            t.objectProperty(t.identifier(name), expression),
          );
          const paramsObject = t.objectExpression(props);
          argsForCall.push(paramsObject);
        }

        const callExpr = t.callExpression(t.identifier('t'), argsForCall);
        pathNode.node.value = callExpr;
        changed = true;
      }
    },
    VariableDeclarator(pathNode) {
      const id = pathNode.node.id;
      const init = pathNode.node.init;
      if (!id || id.type !== 'Identifier' || !init) return;
      const tBinding = pathNode.scope.getBinding('t');
      if (
        tBinding && (
          !tBinding.path.isImportSpecifier() ||
          !tBinding.path.parent ||
          tBinding.path.parent.type !== 'ImportDeclaration' ||
          tBinding.path.parent.source.value !== '@/i18n'
        )
      ) {
        return;
      }
      let pattern = null;
      let placeholders = [];
      if (init.type === 'StringLiteral') {
        pattern = init.value;
      } else if (init.type === 'TemplateLiteral') {
        const built = buildPatternAndPlaceholdersFromTemplate(init);
        pattern = built.pattern;
        placeholders = built.placeholders;
      } else {
        return;
      }
      const cleaned = normalizeText(pattern);
      if (!shouldTranslateText(cleaned)) return;
      const varName = id.name || '';
      let kind = 'text';
      if (/title/i.test(varName)) kind = 'heading';
      else if (/label/i.test(varName)) kind = 'label';
      else if (/placeholder/i.test(varName)) kind = 'placeholder';
      const keyId = `${namespace}|${kind}|${cleaned}`;
      const fullKey = keyMap.get(keyId);
      if (!fullKey) return;
      const args = [t.stringLiteral(fullKey)];
      if (placeholders.length) {
        const props = placeholders.map(({ name, expression }) =>
          t.objectProperty(t.identifier(name), expression),
        );
        args.push(t.objectExpression(props));
      }
      pathNode.node.init = t.callExpression(t.identifier('t'), args);
      changed = true;
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
        const info = getToastMessageInfo(right);
        if (!info) return;
        const cleaned = normalizeText(info.pattern);
        if (!shouldTranslateText(cleaned)) return;
        const keyId = `${namespace}|title|${cleaned}`;
        const fullKey = keyMap.get(keyId);
        if (!fullKey) return;
        const argsForCall = [t.stringLiteral(fullKey)];
        if (info.placeholders.length > 0) {
          const props = info.placeholders.map(({ name, expression }) =>
            t.objectProperty(t.identifier(name), expression),
          );
          const paramsObject = t.objectExpression(props);
          argsForCall.push(paramsObject);
        }
        pathNode.node.right = t.callExpression(t.identifier('t'), argsForCall);
        changed = true;
        return;
      }

      // identifierVar = 'text' or template
      if (left && left.type === 'Identifier') {
        const tBinding = pathNode.scope.getBinding('t');
        if (
          tBinding && (
            !tBinding.path.isImportSpecifier() ||
            !tBinding.path.parent ||
            tBinding.path.parent.type !== 'ImportDeclaration' ||
            tBinding.path.parent.source.value !== '@/i18n'
          )
        ) {
          return;
        }
        let pattern = null;
        let placeholders = [];
        if (right.type === 'StringLiteral') {
          pattern = right.value;
        } else if (right.type === 'TemplateLiteral') {
          const built = buildPatternAndPlaceholdersFromTemplate(right);
          pattern = built.pattern;
          placeholders = built.placeholders;
        } else {
          return;
        }
        const cleaned = normalizeText(pattern);
        if (!shouldTranslateText(cleaned)) return;
        const varName = left.name || '';
        let kind = 'text';
        if (/title/i.test(varName)) kind = 'heading';
        else if (/label/i.test(varName)) kind = 'label';
        else if (/placeholder/i.test(varName)) kind = 'placeholder';
        const keyId = `${namespace}|${kind}|${cleaned}`;
        const fullKey = keyMap.get(keyId);
        if (!fullKey) return;
        const args = [t.stringLiteral(fullKey)];
        if (placeholders.length) {
          const props = placeholders.map(({ name, expression }) =>
            t.objectProperty(t.identifier(name), expression),
          );
          args.push(t.objectExpression(props));
        }
        pathNode.node.right = t.callExpression(t.identifier('t'), args);
        changed = true;
      }
    },
    CallExpression(pathNode) {
      const callee = pathNode.node.callee;
      if (callee && callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'toast') {
        const args = pathNode.node.arguments || [];
        if (args.length === 0) return;
        const first = args[0];

        if (first.type === 'ConditionalExpression') {
          const wrapBranch = (branchNode) => {
            const info = getToastMessageInfo(branchNode);
            if (!info) return null;
            const cleaned = normalizeText(info.pattern);
            if (!shouldTranslateText(cleaned)) return null;
            const keyId = `${namespace}|toast|${cleaned}`;
            const fullKey = keyMap.get(keyId);
            if (!fullKey) return null;
            const argsForCall = [t.stringLiteral(fullKey)];
            if (info.placeholders.length > 0) {
              const props = info.placeholders.map(({ name, expression }) =>
                t.objectProperty(t.identifier(name), expression),
              );
              const paramsObject = t.objectExpression(props);
              argsForCall.push(paramsObject);
            }
            return t.callExpression(t.identifier('t'), argsForCall);
          };

          const newConsequent = wrapBranch(first.consequent);
          const newAlternate = wrapBranch(first.alternate);
          if (!newConsequent || !newAlternate) {
            return;
          }

          const newConditional = t.conditionalExpression(first.test, newConsequent, newAlternate);
          pathNode.node.arguments[0] = newConditional;
          changed = true;
          return;
        }

        const info = getToastMessageInfo(first);
        if (!info) return;
        const cleaned = normalizeText(info.pattern);
        if (!shouldTranslateText(cleaned)) return;
        const keyId = `${namespace}|toast|${cleaned}`;
        const fullKey = keyMap.get(keyId);
        if (!fullKey) return;
        const argsForCall = [t.stringLiteral(fullKey)];
        if (info.placeholders.length > 0) {
          const props = info.placeholders.map(({ name, expression }) =>
            t.objectProperty(t.identifier(name), expression),
          );
          const paramsObject = t.objectExpression(props);
          argsForCall.push(paramsObject);
        }
        const callExpr = t.callExpression(t.identifier('t'), argsForCall);
        pathNode.node.arguments[0] = callExpr;
        changed = true;
      }
    },
  });

  if (!changed) {
    return { changed: false, skippedDueToConflict: false };
  }

  const { hasTImportConflict } = ensureI18nImport(ast);
  if (hasTImportConflict) {
    return { changed: false, skippedDueToConflict: true };
  }

  const output = generate(ast, { retainLines: true, decoratorsBeforeExport: true }, code);
  await writeFile(filePath, output.code, 'utf8');
  return { changed: true, skippedDueToConflict: false };
}

async function processVueFile(filePath, keyMap) {
  let code = await readFile(filePath, 'utf8');
  const namespace = getNamespaceFromFile(filePath, srcRoot);

  const templateMatch = code.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
  if (!templateMatch) {
    return { changed: false };
  }

  const fullTemplate = templateMatch[0];
  let inner = templateMatch[1] || '';

  // Strip HTML comments to avoid grabbing commented-out text.
  inner = inner.replace(/<!--([\s\S]*?)-->/g, ' ');

  const tagRegex = /<([A-Za-z][A-Za-z0-9-_]*)\b([^>]*)>([^<]+)<\/\1>/g;
  let changed = false;

  inner = inner.replace(tagRegex, (whole, tagName, attrs, rawText) => {
    if (!rawText || typeof rawText !== 'string') return whole;
    // Skip if this snippet already contains a translation call.
    if (rawText.includes('$t(') || rawText.includes('{{$t')) return whole;

    const cleaned = String(rawText).replace(/\s+/g, ' ').trim();
    if (!cleaned) return whole;

    const kind = inferKindFromJsxElementName(tagName);
    const keyId = `${namespace}|${kind}|${cleaned}`;
    const fullKey = keyMap.get(keyId);
    if (!fullKey) return whole;

    changed = true;

    const leadingSpaceMatch = rawText.match(/^\s*/);
    const trailingSpaceMatch = rawText.match(/\s*$/);
    const leadingSpace = leadingSpaceMatch ? leadingSpaceMatch[0] : '';
    const trailingSpace = trailingSpaceMatch ? trailingSpaceMatch[0] : '';

    const escapedKey = String(fullKey).replace(/'/g, "\\'");
    const wrapped = `${leadingSpace}{{$t('${escapedKey}')}}${trailingSpace}`;
    return `<${tagName}${attrs}>${wrapped}</${tagName}>`;
  });

  if (!changed) {
    return { changed: false };
  }

  const newTemplate = fullTemplate.replace(templateMatch[1], inner);
  code = code.replace(fullTemplate, newTemplate);
  await writeFile(filePath, code, 'utf8');
  return { changed: true };
}

(async () => {
  try {
    function deepMerge(target, source) {
      if (!source || typeof source !== 'object') return target;
      for (const [k, v] of Object.entries(source)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          if (!target[k] || typeof target[k] !== 'object') target[k] = {};
          deepMerge(target[k], v);
        } else {
          target[k] = v;
        }
      }
      return target;
    }

    async function readJsonSafe(p) {
      try {
        const raw = await readFile(p, 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    // Load grouped auto/en/**/*.json if available
    const groupedDir = path.resolve(projectRoot, 'resources', 'js', 'i18n', 'auto', 'en');
    let translations = {};
    if (existsSync(groupedDir)) {
      const fsSync = await import('node:fs');
      const stack = [groupedDir];
      while (stack.length) {
        const dir = stack.pop();
        const entries = fsSync.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile() && entry.name.endsWith('.json')) {
            const obj = await readJsonSafe(full);
            if (obj && typeof obj === 'object') deepMerge(translations, obj);
          }
        }
      }
    } else if (existsSync(translationsPath)) {
      const parsed = await readJsonSafe(translationsPath);
      if (parsed && typeof parsed === 'object') translations = parsed;
    } else {
      console.error(`[i18n-rewrite] No translations found at ${translationsPath} or ${groupedDir}`);
      process.exit(1);
    }
    const keyMap = buildKeyMapFromTranslations(translations);

    if (!existsSync(srcRoot)) {
      console.error(`[i18n-rewrite] Source root not found: ${srcRoot}`);
      process.exit(1);
    }

    const files = [];
    await collectSourceFiles(srcRoot, files);
    const vueFiles = [];
    await collectVueFiles(srcRoot, vueFiles);

    let changedCount = 0;
    let conflictCount = 0;

    for (const file of files) {
      const rel = path.relative(projectRoot, file);
      const { changed, skippedDueToConflict } = await processFile(file, keyMap);
      if (changed) {
        changedCount += 1;
        console.log(`[i18n-rewrite] Updated ${rel}`);
      } else if (skippedDueToConflict) {
        conflictCount += 1;
        console.warn(`[i18n-rewrite] Skipped ${rel} due to existing 't' import conflict.`);
      }
    }

    for (const file of vueFiles) {
      const rel = path.relative(projectRoot, file);
      const { changed } = await processVueFile(file, keyMap);
      if (changed) {
        changedCount += 1;
        console.log(`[i18n-rewrite] Updated Vue template ${rel}`);
      }
    }

    console.log(`[i18n-rewrite] Completed. Updated ${changedCount} files. Skipped ${conflictCount} files due to conflicts.`);
  } catch (error) {
    console.error('[i18n-rewrite] Failed to rewrite source files with translations.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
})();
