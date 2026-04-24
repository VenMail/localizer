'use strict';

const { resolveProject } = require('../args');
const { runScript } = require('@ai-localizer/core');
const log = require('../log');

const HELP = `
ai-localize run — full deterministic pipeline: extract → replace → sync → cleanup

Skips translate (that needs a Claude turn). Run translate plan/apply separately.

Options:
  --project <dir>      target project (default: cwd)
  --skip <phases>      csv of phases to skip (extract,replace,sync,cleanup)
  --backend <n>        replace backend: main (default) | oxc | babel | blade
`.trim();

async function run(parsed) {
  if (parsed.help) { console.log(HELP); return 0; }
  const projectRoot = resolveProject(parsed.flags);
  const skip = new Set(String(parsed.flags.skip || '').split(',').map((s) => s.trim()).filter(Boolean));
  const backend = String(parsed.flags.backend || 'main');
  const replaceKey = backend === 'oxc' ? 'replaceOxc' : backend === 'babel' ? 'replaceBabel' : backend === 'blade' ? 'replaceBlade' : 'replace';

  const phases = [
    ['extract', 'extract'],
    [replaceKey, 'replace'],
    ['sync', 'sync'],
    ['cleanup', 'cleanup'],
  ];

  for (const [scriptKey, label] of phases) {
    if (skip.has(label)) { log.warn('skip ' + label); continue; }
    log.info(label + ' @ ' + projectRoot);
    await runScript(scriptKey, { projectRoot });
  }
  log.ok('deterministic pipeline complete. Next: `ai-localize translate plan`.');
  return 0;
}

module.exports = { run, HELP };
