#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function walk(obj, onString) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = onString(val, key);
    } else if (val && typeof val === 'object') {
      walk(val, onString);
    }
  }
}

function collectIssues(obj, pathSegments, issues, locale) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const nextPath = pathSegments.concat(key);
    if (typeof val === 'string') {
      const trimmed = String(val);
      const open = (trimmed.match(/\(/g) || []).length;
      const close = (trimmed.match(/\)/g) || []).length;
      if (open !== close) {
        issues.push({
          locale,
          path: nextPath.join('.'),
          value: trimmed,
        });
      }
    } else if (val && typeof val === 'object') {
      collectIssues(val, nextPath, issues, locale);
    }
  }
}

function fixParens(value) {
  const trimmed = String(value);
  const open = (trimmed.match(/\(/g) || []).length;
  const close = (trimmed.match(/\)/g) || []).length;
  if (open === close) return value;

  let next = trimmed;

  if (open === 1 && close === 0) {
    if (/\(\s*$/.test(next)) {
      next = next.replace(/\(\s*$/, '').trimEnd();
    } else if (/^\(\s*/.test(next)) {
      next = next.replace(/^\(\s*/, '');
    }
  } else if (open === 0 && close === 1) {
    if (/^\)\s*/.test(next)) {
      next = next.replace(/^\)\s*/, '');
    } else if (/\s*\)$/.test(next)) {
      next = next.replace(/\s*\)$/, '');
    }
  }

  return next;
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const i18nDir = path.resolve(projectRoot, 'resources', 'js', 'i18n', 'auto');
  if (!fs.existsSync(i18nDir)) {
    console.error('i18n auto directory not found at', i18nDir);
    process.exit(1);
  }

  function listJsonFiles(dir) {
    const out = [];
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      const entries = fs.readdirSync(cur, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
      }
    }
    return out;
  }

  const files = listJsonFiles(i18nDir);
  if (files.length === 0) {
    console.error('No locale JSON files found in', i18nDir);
    process.exit(1);
  }

  const apply = process.argv.includes('--apply');
  const allIssues = [];

  for (const fullPath of files) {
    const raw = fs.readFileSync(fullPath, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error('Failed to parse', fullPath + ':', e.message);
      continue;
    }

    const issues = [];
    collectIssues(data, [], issues, path.basename(fullPath));
    allIssues.push(...issues);

    if (apply) {
      walk(data, (val, key) => fixParens(val, key));
      fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      console.log('Updated', fullPath);
    }
  }

  if (allIssues.length) {
    console.log('Found strings with unbalanced parentheses:');
    for (const issue of allIssues) {
      console.log(`- [${issue.locale}] ${issue.path}: ${issue.value}`);
    }
    const issuesPath = path.resolve(projectRoot, 'scripts', '.i18n-paren-issues.json');
    fs.writeFileSync(issuesPath, JSON.stringify(allIssues, null, 2) + '\n', 'utf8');
  } else {
    console.log('No strings with unbalanced parentheses found.');
  }
}

main();
