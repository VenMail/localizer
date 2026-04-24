'use strict';

const { resolveProject } = require('../args');
const { runScript } = require('@ai-localizer/core');
const log = require('../log');

const HELP = `
ai-localize extract — scan source files, write base locale file(s)

Options:
  --project <dir>   target project (default: cwd)
`.trim();

async function run(parsed) {
  if (parsed.help) { console.log(HELP); return 0; }
  const projectRoot = resolveProject(parsed.flags);
  log.info('extract @ ' + projectRoot);
  await runScript('extract', { projectRoot });
  return 0;
}

module.exports = { run, HELP };
