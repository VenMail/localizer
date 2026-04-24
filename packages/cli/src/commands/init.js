'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveProject, parseList } = require('../args');
const log = require('../log');

const HELP = `
ai-localize init — write aiI18n config + .gitignore entries

Options:
  --project <dir>            target project (default: cwd)
  --source-locale <code>     default source language (e.g. en, zh). Default: en
  --locales <csv>            comma-separated target locales including source. Default: en,fr
  --src-root <dir>           override source root (auto-detected from src/ or resources/js)
  --locales-dir <dir>        override locales dir (default: <srcRoot>/locales)
  --layout <single|grouped>  locale file layout. Default: single for SPA, grouped for Laravel
  --force                    overwrite existing aiI18n block if present
`.trim();

function readPkg(projectRoot) {
  const file = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(file)) throw new Error(`no package.json at ${projectRoot}`);
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function detectDefaults(projectRoot, pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);
  const hasLaravel = fs.existsSync(path.join(projectRoot, 'composer.json'));
  const srcRoot = fs.existsSync(path.join(projectRoot, 'src')) ? 'src' :
                  fs.existsSync(path.join(projectRoot, 'resources/js')) ? 'resources/js' :
                  'src';
  const layout = hasLaravel ? 'grouped' : 'single';
  const localesDir = hasLaravel ? 'resources/js/i18n/auto' : `${srcRoot}/locales`;
  return { srcRoot, localesDir, layout, framework: has('vue') ? 'vue' : has('next') ? 'next' : has('react') ? 'react' : hasLaravel ? 'laravel' : 'unknown' };
}

function ensureGitignore(projectRoot) {
  const file = path.join(projectRoot, '.gitignore');
  const entries = ['.i18n-cache/', '.i18n-queue/'];
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const existing = new Set(content.split(/\r?\n/));
  const added = [];
  for (const e of entries) {
    if (!existing.has(e)) { added.push(e); content += (content.endsWith('\n') || content === '' ? '' : '\n') + e + '\n'; }
  }
  if (added.length) fs.writeFileSync(file, content, 'utf8');
  return added;
}

async function run(parsed) {
  if (parsed.help) { console.log(HELP); return 0; }
  const projectRoot = resolveProject(parsed.flags);
  const { file, data } = readPkg(projectRoot);

  const defaults = detectDefaults(projectRoot, data);
  const sourceLocale = String(parsed.flags['source-locale'] || 'en');
  const locales = parseList(parsed.flags.locales) || [];
  const finalLocales = locales.length ? locales : [sourceLocale, 'fr'];
  if (!finalLocales.includes(sourceLocale)) finalLocales.unshift(sourceLocale);

  const srcRoot = String(parsed.flags['src-root'] || defaults.srcRoot);
  const localesDir = String(parsed.flags['locales-dir'] || defaults.localesDir);
  const layout = String(parsed.flags.layout || defaults.layout);

  const newBlock = {
    sourceLocale,
    defaultLocale: sourceLocale,
    locales: finalLocales,
    srcRoot,
    localesDir,
    localeLayout: layout,
  };

  const hasExisting = data.aiI18n && typeof data.aiI18n === 'object' && Object.keys(data.aiI18n).length > 0;
  if (hasExisting && !parsed.flags.force) {
    log.warn('package.json#aiI18n already populated — pass --force to overwrite');
    log.detail('current: ' + JSON.stringify(data.aiI18n));
    return 0;
  }
  data.aiI18n = newBlock;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  log.ok(`wrote aiI18n config to ${path.relative(process.cwd(), file)}`);
  log.detail('framework: ' + defaults.framework);
  log.detail('source: ' + sourceLocale + '  targets: ' + finalLocales.filter((l) => l !== sourceLocale).join(', '));
  log.detail('srcRoot: ' + srcRoot + '  localesDir: ' + localesDir + '  layout: ' + layout);

  const gitignoreAdded = ensureGitignore(projectRoot);
  if (gitignoreAdded.length) log.ok('updated .gitignore: ' + gitignoreAdded.join(', '));

  const localesAbs = path.resolve(projectRoot, localesDir);
  if (!fs.existsSync(localesAbs)) {
    fs.mkdirSync(localesAbs, { recursive: true });
    log.detail('created ' + path.relative(projectRoot, localesAbs));
  }
  return 0;
}

module.exports = { run, HELP };
