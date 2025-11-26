#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const autoDir = path.resolve(projectRoot, 'resources', 'js', 'i18n', 'auto');
const reportPath = path.resolve(projectRoot, 'scripts', '.i18n-untranslated-report.json');

async function readJsonSafe(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[apply-i18n-report-fixes] Failed to read JSON', filePath, '-', err && err.message ? err.message : err);
    return null;
  }
}

function applyIssueToJson(json, issue) {
  if (!json || typeof json !== 'object') return false;
  if (!issue || !issue.keyPath || !issue.suggested) return false;

  const segments = String(issue.keyPath).split('.');
  if (segments.length === 0) return false;

  let ctx = json;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (!ctx || typeof ctx !== 'object') {
      return false;
    }
    ctx = ctx[seg];
  }

  const last = segments[segments.length - 1];
  if (!ctx || typeof ctx !== 'object' || !Object.prototype.hasOwnProperty.call(ctx, last)) {
    return false;
  }

  const prev = ctx[last];
  if (typeof prev !== 'string') {
    return false;
  }

  // If the translation has changed since the report was generated, skip it.
  if (issue.current && prev !== issue.current) {
    return false;
  }

  if (prev === issue.suggested) {
    return false;
  }

  ctx[last] = issue.suggested;
  return true;
}

async function main() {
  if (!existsSync(reportPath)) {
    console.error('[apply-i18n-report-fixes] Report not found:', reportPath);
    process.exit(1);
  }

  if (!existsSync(autoDir)) {
    console.error('[apply-i18n-report-fixes] i18n auto directory not found:', autoDir);
    process.exit(1);
  }

  const report = await readJsonSafe(reportPath);
  if (!report || !Array.isArray(report.issues)) {
    console.error('[apply-i18n-report-fixes] Invalid report format – expected { issues: [...] }');
    process.exit(1);
  }

  // Group issues with suggestions by locale file
  const issuesByFile = new Map();
  for (const issue of report.issues) {
    if (!issue) continue;
    if (!issue.suggested) continue;
    if (!issue.localeFile) continue;

    const fullPath = path.resolve(autoDir, issue.localeFile);
    const arr = issuesByFile.get(fullPath) || [];
    arr.push(issue);
    issuesByFile.set(fullPath, arr);
  }

  if (issuesByFile.size === 0) {
    console.log('[apply-i18n-report-fixes] No issues with suggestions found in report. Nothing to apply.');
    process.exit(0);
  }

  let totalUpdated = 0;

  for (const [filePath, fileIssues] of issuesByFile.entries()) {
    if (!existsSync(filePath)) {
      console.warn('[apply-i18n-report-fixes] Locale file not found, skipping:', path.relative(projectRoot, filePath));
      continue;
    }

    const json = await readJsonSafe(filePath);
    if (!json) {
      continue;
    }

    let updatedForFile = 0;

    for (const issue of fileIssues) {
      const changed = applyIssueToJson(json, issue);
      if (changed) {
        updatedForFile += 1;
      }
    }

    if (updatedForFile > 0) {
      await writeFile(filePath, JSON.stringify(json, null, 2) + '\n', 'utf8');
      totalUpdated += updatedForFile;
      console.log(
        `[apply-i18n-report-fixes] Updated ${updatedForFile} entr${updatedForFile === 1 ? 'y' : 'ies'} in`,
        path.relative(projectRoot, filePath),
      );
    }
  }

  if (totalUpdated === 0) {
    console.log('[apply-i18n-report-fixes] No changes were applied. Either everything is already updated or keys were missing.');
  } else {
    console.log(`[apply-i18n-report-fixes] Done. Total entries updated: ${totalUpdated}.`);
  }
}

main().catch((err) => {
  console.error('[apply-i18n-report-fixes] Failed:', err && err.message ? err.message : err);
  process.exit(1);
});
