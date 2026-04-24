'use strict';

const { resolveProject } = require('../args');
const { runScript } = require('@ai-localizer/core');
const log = require('../log');

const HELP = `
ai-localize cleanup — remove locale keys that no source file references

Options:
  --project <dir>   target project (default: cwd)
`.trim();

async function run(parsed) {
  if (parsed.help) { console.log(HELP); return 0; }
  const projectRoot = resolveProject(parsed.flags);
  log.info('cleanup @ ' + projectRoot);
  await runScript('cleanup', { projectRoot });
  return 0;
}

module.exports = { run, HELP };
