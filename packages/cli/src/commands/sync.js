'use strict';

const { resolveProject } = require('../args');
const { runScript } = require('@ai-localizer/core');
const log = require('../log');

const HELP = `
ai-localize sync — propagate keys from source locale to all target locales (non-destructive by default)

Options:
  --project <dir>     target project (default: cwd)
  --destructive       also prune keys not present in the source locale (opt-in)
`.trim();

async function run(parsed) {
  if (parsed.help) { console.log(HELP); return 0; }
  const projectRoot = resolveProject(parsed.flags);
  const env = parsed.flags.destructive ? { AI_I18N_ALLOW_DESTRUCTIVE: '1' } : {};
  log.info('sync @ ' + projectRoot + (parsed.flags.destructive ? ' (destructive)' : ''));
  await runScript('sync', { projectRoot, env });
  return 0;
}

module.exports = { run, HELP };
