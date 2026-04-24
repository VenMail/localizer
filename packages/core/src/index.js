'use strict';

/**
 * @ai-localizer/core — pure-Node i18n pipeline.
 *
 * Public surface exposes:
 *   - scriptPaths:  absolute paths to the phase scripts (spawn with AI_I18N_PROJECT_ROOT env var)
 *   - runScript:    spawn a phase script against a target project, waits for completion
 *   - projectConfig, validators, parsers, stringUtils, localeUtils — lib modules
 *   - translatorQueue, translatorCache — Claude-in-session handoff helpers
 *
 * Phase scripts are IIFEs that auto-execute on require. We spawn them as subprocesses
 * to keep module state isolated across runs and to honor the AI_I18N_PROJECT_ROOT env var.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const I18N_DIR = path.resolve(__dirname, 'i18n');

const scriptPaths = {
  extract: path.join(I18N_DIR, 'extract-i18n.js'),
  replace: path.join(I18N_DIR, 'replace-i18n.js'),
  replaceOxc: path.join(I18N_DIR, 'oxc-replace-i18n.js'),
  replaceBabel: path.join(I18N_DIR, 'babel-replace-i18n.js'),
  replaceBlade: path.join(I18N_DIR, 'rewrite-i18n-blade.js'),
  sync: path.join(I18N_DIR, 'sync-i18n.js'),
  cleanup: path.join(I18N_DIR, 'cleanup-i18n-unused.js'),
  fixUntranslated: path.join(I18N_DIR, 'fix-untranslated.js'),
  restoreInvalid: path.join(I18N_DIR, 'restore-i18n-invalid.js'),
  applyReportFixes: path.join(I18N_DIR, 'apply-i18n-report-fixes.js'),
};

/**
 * Spawn a phase script against a target project.
 * Resolves once the script exits. Rejects on non-zero exit.
 *
 * @param {string} scriptKey  key in scriptPaths
 * @param {object} opts
 * @param {string} opts.projectRoot  absolute path of the target project
 * @param {string[]} [opts.args]     extra argv passed to the script
 * @param {object} [opts.env]        extra env (merged over process.env)
 * @param {'inherit'|'pipe'} [opts.stdio]  default 'inherit'
 * @returns {Promise<{code:number}>}
 */
function runScript(scriptKey, opts) {
  const scriptPath = scriptPaths[scriptKey];
  if (!scriptPath) throw new Error(`[core] unknown script: ${scriptKey}`);
  if (!opts || !opts.projectRoot) throw new Error('[core] projectRoot required');

  const env = {
    ...process.env,
    AI_I18N_PROJECT_ROOT: path.resolve(opts.projectRoot),
    ...(opts.env || {}),
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...(opts.args || [])], {
      cwd: opts.projectRoot,
      env,
      stdio: opts.stdio || 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ code });
      else reject(new Error(`[core] ${scriptKey} exited with code ${code}`));
    });
  });
}

const projectConfig = require('./i18n/lib/projectConfig');
const stringUtils = require('./i18n/lib/stringUtils');
const localeUtils = require('./i18n/lib/localeUtils');
const validators = require('./i18n/lib/validators');
const parsers = require('./i18n/lib/parsers');

const translatorQueue = require('./translator/queue');
const translatorCache = require('./translator/cache');

module.exports = {
  scriptPaths,
  runScript,
  projectConfig,
  stringUtils,
  localeUtils,
  validators,
  parsers,
  translatorQueue,
  translatorCache,
};
