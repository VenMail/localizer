'use strict';

/**
 * Claude-in-session translation handoff.
 *
 * plan():  scan locale tree, compute untranslated keys per target locale,
 *          pre-fill from persistent cache, write .i18n-queue/<locale>.pending.json
 *          for keys the cache could not resolve.
 *
 * apply(): read .i18n-queue/<locale>.answers.json written by Claude,
 *          validate + merge into locale files, update cache, delete queue files.
 *
 * Locale layouts supported:
 *   - single  : <localesDir>/<locale>.json
 *   - grouped : <localesDir>/<locale>/*.json  (each JSON is one namespace)
 */

const fs = require('node:fs');
const path = require('node:path');

const { detectSrcRoot, detectLocalesDir, getSourceLocale, getLocaleLayout, getProjectLocales } =
  require('../i18n/lib/projectConfig');
const cache = require('./cache');

const QUEUE_DIR = '.i18n-queue';

function queuePath(projectRoot, locale, kind) {
  return path.join(projectRoot, QUEUE_DIR, `${locale}.${kind}.json`);
}

function readJson(file) {
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try { return JSON.parse(raw); } catch { return undefined; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function flatten(obj, prefix = '', out = {}) {
  if (obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, key, out);
    } else if (typeof v === 'string') {
      out[key] = v;
    }
  }
  return out;
}

function setByPath(obj, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (!cursor[seg] || typeof cursor[seg] !== 'object' || Array.isArray(cursor[seg])) {
      cursor[seg] = {};
    }
    cursor = cursor[seg];
  }
  cursor[parts[parts.length - 1]] = value;
}

function resolveLocaleEnv(projectRoot) {
  const srcRoot = detectSrcRoot(projectRoot);
  const localesDir = detectLocalesDir(projectRoot, srcRoot);
  const layout = getLocaleLayout(projectRoot);
  const sourceLocale = getSourceLocale(projectRoot);
  const locales = getProjectLocales(projectRoot) || [];
  return { srcRoot, localesDir, layout, sourceLocale, locales };
}

/**
 * Load the merged key→value tree for one locale.
 * For grouped layout, merges every <locale>/*.json under a namespace keyed by filename stem.
 * For single layout, reads <locale>.json.
 *
 * Returns { values: {...nested...}, files: [{path, namespace}], layout }
 */
function loadLocaleTree(localesDir, layout, locale) {
  if (layout === 'single') {
    const file = path.join(localesDir, `${locale}.json`);
    const values = readJson(file) || {};
    return { values, files: [{ path: file, namespace: null }], layout };
  }
  const dir = path.join(localesDir, locale);
  const values = {};
  const files = [];
  if (!fs.existsSync(dir)) return { values, files, layout };
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const ns = entry.replace(/\.json$/, '');
    const file = path.join(dir, entry);
    const loaded = readJson(file) || {};
    values[ns] = loaded;
    files.push({ path: file, namespace: ns });
  }
  return { values, files, layout };
}

function saveLocaleTree(tree) {
  if (tree.layout === 'single') {
    const file = tree.files[0];
    writeJson(file.path, tree.values);
    return;
  }
  for (const f of tree.files) {
    writeJson(f.path, tree.values[f.namespace] || {});
  }
}

/**
 * Build list of (dottedKey, sourceText) pairs where the target locale is missing
 * or equals the source value (untranslated).
 */
function computeMissingPairs(sourceFlat, targetFlat) {
  const pairs = [];
  for (const [key, src] of Object.entries(sourceFlat)) {
    if (src == null || src === '') continue;
    const cur = targetFlat[key];
    if (cur == null || cur === '' || cur === src) {
      pairs.push([key, src]);
    }
  }
  return pairs;
}

/**
 * plan: build pending JSON per locale. Cache hits are applied in-place (no Claude needed).
 * @param {string} projectRoot
 * @param {object} [opts]
 * @param {string[]} [opts.targets]   restrict to these target locales; default = all non-source
 * @param {string} [opts.instructions] instructions string written into pending files
 * @returns {object} summary
 */
function plan(projectRoot, opts = {}) {
  const env = resolveLocaleEnv(projectRoot);
  const targets = (opts.targets && opts.targets.length)
    ? opts.targets
    : env.locales.filter((l) => l !== env.sourceLocale);

  const sourceTree = loadLocaleTree(env.localesDir, env.layout, env.sourceLocale);
  const sourceFlat = flatten(sourceTree.values);

  const cacheState = cache.load(projectRoot);
  const summary = { sourceLocale: env.sourceLocale, layout: env.layout, targets: [] };

  for (const target of targets) {
    if (target === env.sourceLocale) continue;
    const targetTree = loadLocaleTree(env.localesDir, env.layout, target);
    const targetFlat = flatten(targetTree.values);

    const missing = computeMissingPairs(sourceFlat, targetFlat);
    const pending = {};
    let cacheApplied = 0;

    for (const [key, src] of missing) {
      const hit = cache.lookup(cacheState, env.sourceLocale, target, src);
      if (hit) {
        setByPath(targetTree.values, key, hit);
        cacheApplied += 1;
      } else {
        pending[key] = src;
      }
    }

    if (cacheApplied > 0) saveLocaleTree(targetTree);

    const pendingFile = queuePath(projectRoot, target, 'pending');
    const answersFile = queuePath(projectRoot, target, 'answers');
    // clean stale answers from prior runs
    if (fs.existsSync(answersFile)) fs.unlinkSync(answersFile);

    const pendingCount = Object.keys(pending).length;
    if (pendingCount === 0) {
      if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
    } else {
      writeJson(pendingFile, {
        sourceLocale: env.sourceLocale,
        targetLocale: target,
        instructions: opts.instructions ||
          'Translate each source string into the target locale. Preserve placeholders like {count}, {{name}}, %s. Match UI conventions (concise button labels, title-case for menu items). Reply with a flat JSON map {key: translation} to the answers file.',
        pairs: pending,
      });
    }

    summary.targets.push({
      locale: target,
      missing: missing.length,
      cacheApplied,
      pending: pendingCount,
      pendingFile: pendingCount > 0 ? path.relative(projectRoot, pendingFile) : null,
      answersFile: pendingCount > 0 ? path.relative(projectRoot, answersFile) : null,
    });
  }

  return summary;
}

/**
 * apply: ingest <locale>.answers.json (written by Claude), merge into locale files,
 * update persistent cache, delete queue files.
 */
function apply(projectRoot, opts = {}) {
  const env = resolveLocaleEnv(projectRoot);
  const targets = (opts.targets && opts.targets.length)
    ? opts.targets
    : env.locales.filter((l) => l !== env.sourceLocale);

  const sourceTree = loadLocaleTree(env.localesDir, env.layout, env.sourceLocale);
  const sourceFlat = flatten(sourceTree.values);
  const cacheState = cache.load(projectRoot);
  const summary = { applied: [], skipped: [] };

  for (const target of targets) {
    const answersFile = queuePath(projectRoot, target, 'answers');
    const pendingFile = queuePath(projectRoot, target, 'pending');
    if (!fs.existsSync(answersFile)) {
      summary.skipped.push({ locale: target, reason: 'no answers file' });
      continue;
    }
    const answers = readJson(answersFile);
    if (!answers || typeof answers !== 'object') {
      summary.skipped.push({ locale: target, reason: 'answers file invalid JSON' });
      continue;
    }
    const pendingDoc = readJson(pendingFile) || {};
    const expectedPairs = pendingDoc.pairs || {};
    const expectedKeys = Object.keys(expectedPairs);

    const targetTree = loadLocaleTree(env.localesDir, env.layout, target);
    let mergedCount = 0;
    const warnings = [];

    for (const [key, translation] of Object.entries(answers)) {
      if (typeof translation !== 'string' || translation.length === 0) {
        warnings.push(`empty translation for ${key}`);
        continue;
      }
      const src = expectedPairs[key] ?? sourceFlat[key];
      if (src == null) {
        warnings.push(`unknown key ${key} (not in source locale)`);
        continue;
      }
      setByPath(targetTree.values, key, translation);
      cache.set(cacheState, env.sourceLocale, target, src, translation);
      mergedCount += 1;
    }

    // flag expected keys Claude didn't answer
    const missingAnswers = expectedKeys.filter((k) => !(k in answers));

    saveLocaleTree(targetTree);
    fs.unlinkSync(answersFile);
    if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);

    summary.applied.push({
      locale: target,
      merged: mergedCount,
      expected: expectedKeys.length,
      missingAnswers: missingAnswers.length,
      warnings,
    });
  }

  cache.save(projectRoot, cacheState);

  // drop .i18n-queue dir if empty
  const qdir = path.join(projectRoot, QUEUE_DIR);
  if (fs.existsSync(qdir) && fs.readdirSync(qdir).length === 0) {
    fs.rmdirSync(qdir);
  }

  return summary;
}

function status(projectRoot) {
  const env = resolveLocaleEnv(projectRoot);
  const sourceTree = loadLocaleTree(env.localesDir, env.layout, env.sourceLocale);
  const sourceFlat = flatten(sourceTree.values);
  const report = {
    sourceLocale: env.sourceLocale,
    layout: env.layout,
    localesDir: path.relative(projectRoot, env.localesDir),
    totalSourceKeys: Object.keys(sourceFlat).length,
    locales: [],
  };
  for (const target of env.locales) {
    if (target === env.sourceLocale) continue;
    const t = loadLocaleTree(env.localesDir, env.layout, target);
    const flat = flatten(t.values);
    const missing = computeMissingPairs(sourceFlat, flat);
    report.locales.push({
      locale: target,
      translated: Object.keys(sourceFlat).length - missing.length,
      untranslated: missing.length,
    });
  }
  return report;
}

module.exports = { QUEUE_DIR, queuePath, plan, apply, status, loadLocaleTree, flatten, computeMissingPairs };
