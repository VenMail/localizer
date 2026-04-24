'use strict';

const { resolveProject } = require('../args');
const { translatorQueue } = require('@ai-localizer/core');
const log = require('../log');

const HELP = `
ai-localize status — per-locale totals: translated / untranslated / source keys

Options:
  --project <dir>   target project (default: cwd)
`.trim();

async function run(parsed) {
  if (parsed.help) { console.log(HELP); return 0; }
  const projectRoot = resolveProject(parsed.flags);
  const report = translatorQueue.status(projectRoot);
  log.info('status @ ' + projectRoot);
  log.detail(`source locale: ${report.sourceLocale}   layout: ${report.layout}   localesDir: ${report.localesDir}`);
  log.detail(`source keys:   ${report.totalSourceKeys}`);
  for (const row of report.locales) {
    const pct = report.totalSourceKeys > 0 ? Math.round((row.translated / report.totalSourceKeys) * 100) : 0;
    log.detail(`${row.locale.padEnd(6)} ${String(row.translated).padStart(5)} translated  ${String(row.untranslated).padStart(5)} untranslated  (${pct}%)`);
  }
  return 0;
}

module.exports = { run, HELP };
