'use strict';

const { resolveProject } = require('../args');
const { runScript } = require('@ai-localizer/core');
const log = require('../log');

const HELP = `
ai-localize replace — rewrite source files, replacing hard-coded strings with t('key') calls

Options:
  --project <dir>   target project (default: cwd)
  --backend <n>     oxc (default) | babel | blade
`.trim();

async function run(parsed) {
  if (parsed.help) { console.log(HELP); return 0; }
  const projectRoot = resolveProject(parsed.flags);
  const backend = String(parsed.flags.backend || 'main');
  const key = backend === 'oxc' ? 'replaceOxc' : backend === 'babel' ? 'replaceBabel' : backend === 'blade' ? 'replaceBlade' : 'replace';
  log.info('replace (' + backend + ') @ ' + projectRoot);
  await runScript(key, { projectRoot });
  return 0;
}

module.exports = { run, HELP };
