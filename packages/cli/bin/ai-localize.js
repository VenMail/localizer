#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs } = require('../src/args');
const log = require('../src/log');

const COMMANDS = {
  init: () => require('../src/commands/init'),
  extract: () => require('../src/commands/extract'),
  replace: () => require('../src/commands/replace'),
  sync: () => require('../src/commands/sync'),
  cleanup: () => require('../src/commands/cleanup'),
  status: () => require('../src/commands/status'),
  run: () => require('../src/commands/run'),
  translate: () => require('../src/commands/translate'),
};

const USAGE = `
ai-localize — i18n pipeline for Vue / React / Next / Laravel projects

Usage:  ai-localize <command> [--project <dir>] [options]

Commands:
  init        Write package.json#aiI18n config, add .gitignore entries
  extract     Scan source → write base locale file(s)
  replace     Rewrite source files: hard-coded strings → t('key') calls
  sync        Propagate keys from source locale to all target locales
  translate   Claude-in-session translation handoff (plan | apply)
  cleanup     Remove locale keys no longer referenced in source
  status      Report per-locale key counts / untranslated / unused
  run         Run extract → replace → sync → cleanup in one go (skips translate)

Global options:
  --project <dir>   target project root (default: cwd)
  -h, --help        show this help

Run 'ai-localize <command> --help' for command-specific options.
`.trim();

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  const [cmd, ...rest] = argv;
  const loader = COMMANDS[cmd];
  if (!loader) {
    log.err(`unknown command: ${cmd}`);
    console.log(USAGE);
    process.exit(2);
  }
  const parsed = parseArgs(rest);
  try {
    const mod = loader();
    const result = await mod.run(parsed);
    if (typeof result === 'number') process.exit(result);
  } catch (e) {
    log.err(e && e.message ? e.message : String(e));
    if (process.env.AI_LOCALIZE_DEBUG) console.error(e && e.stack);
    process.exit(1);
  }
}

main();
