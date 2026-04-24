'use strict';

const path = require('node:path');
const { resolveProject, parseList } = require('../args');
const { translatorQueue } = require('@ai-localizer/core');
const log = require('../log');

const HELP = `
ai-localize translate <plan|apply> — Claude-in-session translation handoff

Subcommands:
  plan    emit .i18n-queue/<locale>.pending.json for each target locale
          with missing keys (cache hits auto-merged first)
  apply   read .i18n-queue/<locale>.answers.json written by Claude,
          merge into locale files, update persistent cache, delete queue files

Options:
  --project <dir>          target project (default: cwd)
  --targets <csv>          restrict to specific target locales (default: all non-source)
  --instructions <text>    translator instructions written into pending file (plan only)
`.trim();

async function run(parsed) {
  if (parsed.help) { console.log(HELP); return 0; }
  const sub = parsed._[0];
  if (!sub || (sub !== 'plan' && sub !== 'apply')) {
    console.log(HELP);
    return 2;
  }
  const projectRoot = resolveProject(parsed.flags);
  const targets = parseList(parsed.flags.targets);

  if (sub === 'plan') {
    const summary = translatorQueue.plan(projectRoot, {
      targets,
      instructions: parsed.flags.instructions ? String(parsed.flags.instructions) : undefined,
    });
    log.info(`plan @ ${projectRoot}  (source: ${summary.sourceLocale}, layout: ${summary.layout})`);
    let totalPending = 0;
    for (const t of summary.targets) {
      totalPending += t.pending;
      const line = `${t.locale.padEnd(6)} missing ${String(t.missing).padStart(5)}  cache-hit ${String(t.cacheApplied).padStart(5)}  pending ${String(t.pending).padStart(5)}`;
      if (t.pending > 0) log.detail(line + '  → ' + t.pendingFile);
      else log.detail(line + '  (nothing to translate)');
    }
    if (totalPending === 0) {
      log.ok('all locales fully translated (or fully cache-served). Nothing for Claude to do.');
    } else {
      log.ok(`${totalPending} pairs pending across ${summary.targets.filter((t) => t.pending > 0).length} locale(s).`);
      log.detail('Next (Claude turn): read each .i18n-queue/<locale>.pending.json, write a flat {key: translation} JSON to .i18n-queue/<locale>.answers.json, then run `ai-localize translate apply`.');
    }
    return 0;
  }

  // apply
  const summary = translatorQueue.apply(projectRoot, { targets });
  log.info(`apply @ ${projectRoot}`);
  for (const a of summary.applied) {
    log.ok(`${a.locale}: merged ${a.merged}/${a.expected}` + (a.missingAnswers ? `  (${a.missingAnswers} expected keys missing from answers)` : ''));
    for (const w of a.warnings) log.warn('  ' + w);
  }
  for (const s of summary.skipped) {
    log.warn(`${s.locale}: ${s.reason}`);
  }
  return 0;
}

module.exports = { run, HELP };
