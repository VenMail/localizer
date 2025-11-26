#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const traverse = typeof traverseModule === 'function' ? traverseModule : traverseModule.default;
const generate = typeof generateModule === 'function' ? generateModule : generateModule.default;

const projectRoot = path.resolve(__dirname, '..');

function getConfiguredSrcRoot() {
  try {
    const pkgPath = path.resolve(projectRoot, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== 'object') return null;
    const cfg = pkg.aiI18n;
    if (!cfg || typeof cfg !== 'object') return null;
    const rel = cfg.srcRoot;
    if (!rel || typeof rel !== 'string') return null;
    const full = path.resolve(projectRoot, rel);
    if (!existsSync(full)) return null;
    return full;
  } catch {
    return null;
  }
}

function detectSrcRoot() {
  const configured = getConfiguredSrcRoot();
  if (configured) return configured;
  // Prefer Laravel/Inertia-style resources/js when present, otherwise fall
  // back to src for React/Next/Vue/Nuxt-style projects. If neither exists,
  // default to resources/js so the error message is consistent.
  const candidates = ['resources/js', 'src'];
  for (const rel of candidates) {
    const full = path.resolve(projectRoot, rel);
    if (existsSync(full)) return full;
  }
  return path.resolve(projectRoot, 'resources', 'js');
}

const srcRoot = detectSrcRoot();

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

function transformAst(ast, issueKeySet) {
  let changed = false;

  function isWhitespaceText(node) {
    return node && node.type === 'JSXText' && String(node.value || '').trim() === '';
  }

  traverse(ast, {
    JSXExpressionContainer(path) {
      const expr = path.node.expression;
      if (!expr || expr.type !== 'CallExpression') return;
      const callee = expr.callee;
      if (!callee || callee.type !== 'Identifier' || callee.name !== 't') return;
      const args = expr.arguments || [];
      if (!args.length || args[0].type !== 'StringLiteral') return;

      const key = args[0].value;
      if (issueKeySet && issueKeySet.size > 0 && !issueKeySet.has(key)) return;

      const parentPath = path.parentPath;
      if (!parentPath || !parentPath.isJSXElement()) return;
      const parent = parentPath.node;
      const children = parent.children;
      const idx = children.indexOf(path.node);
      if (idx === -1) return;

      let exprIdx = -1;
      for (let j = idx + 1; j < children.length; j += 1) {
        const child = children[j];
        if (isWhitespaceText(child)) continue;
        if (child.type === 'JSXExpressionContainer') {
          exprIdx = j;
          break;
        }
        return;
      }

      if (exprIdx === -1) return;

      let closingIdx = -1;
      for (let j = exprIdx + 1; j < children.length; j += 1) {
        const child = children[j];
        if (isWhitespaceText(child)) continue;
        if (child.type === 'JSXText') {
          const trimmed = String(child.value || '').replace(/\s+/g, ' ').trim();
          if (trimmed.startsWith(')')) {
            closingIdx = j;
          }
        }
        break;
      }

      if (closingIdx === -1) return;

      const openText = {
        type: 'JSXText',
        value: ' (',
      };
      const closeText = {
        type: 'JSXText',
        value: ')',
      };

      const sliceEnd = closingIdx + 1;
      const nextExpr = children[exprIdx];
      const newChildren = [path.node, openText, nextExpr, closeText];
      children.splice(idx, sliceEnd - idx, ...newChildren);
      changed = true;
      parentPath.skip();
    },
  });

  return changed;
}

async function processFile(filePath, issueKeySet) {
  const code = await readFile(filePath, 'utf8');
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  });

  const changed = transformAst(ast, issueKeySet);
  if (!changed) return false;

  const output = generate(ast, { retainLines: true, decoratorsBeforeExport: true }, code);
  await writeFile(filePath, output.code, 'utf8');
  return true;
}

async function main() {
  if (!existsSync(srcRoot)) {
    console.error('[fix-i18n-parens-in-code] Source root not found:', srcRoot);
    process.exit(1);
  }

  const issuesPath = path.resolve(projectRoot, 'scripts', '.i18n-paren-issues.json');
  let issueKeySet = null;
  if (existsSync(issuesPath)) {
    try {
      const rawIssues = await readFile(issuesPath, 'utf8');
      const issues = JSON.parse(rawIssues);
      issueKeySet = new Set((issues || []).map((i) => i.path));
    } catch (e) {
      issueKeySet = null;
    }
  }

  const files = [];
  await collectSourceFiles(srcRoot, files);

  let changedCount = 0;
  for (const file of files) {
    const changed = await processFile(file, issueKeySet);
    if (changed) {
      changedCount += 1;
      console.log('Updated', path.relative(projectRoot, file));
    }
  }

  console.log(`[fix-i18n-parens-in-code] Updated ${changedCount} files.`);
}

main().catch((err) => {
  console.error('[fix-i18n-parens-in-code] Failed:', err && err.message ? err.message : err);
  process.exit(1);
});
