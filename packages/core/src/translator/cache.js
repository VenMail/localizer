'use strict';

/**
 * Persistent on-disk translation cache.
 *
 * File: <projectRoot>/.i18n-cache/cache.json
 * Format: { "sourceLocale::targetLocale::sourceText": "translation", ... }
 * FIFO cap at MAX_ENTRIES — oldest keys dropped first.
 *
 * Intentionally simple — plain JSON, no LRU eviction timing, no compression.
 * Re-reads and re-writes the whole file each call; fine for <10k entries.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 10_000;
const CACHE_DIR = '.i18n-cache';
const CACHE_FILE = 'cache.json';

function cachePath(projectRoot) {
  return path.join(projectRoot, CACHE_DIR, CACHE_FILE);
}

function makeKey(sourceLocale, targetLocale, sourceText) {
  return `${sourceLocale}::${targetLocale}::${sourceText}`;
}

function load(projectRoot) {
  const file = cachePath(projectRoot);
  if (!fs.existsSync(file)) return { entries: {}, order: [] };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.entries) {
      return { entries: parsed.entries, order: parsed.order || Object.keys(parsed.entries) };
    }
    // legacy flat map
    return { entries: parsed, order: Object.keys(parsed) };
  } catch {
    return { entries: {}, order: [] };
  }
}

function save(projectRoot, cache) {
  const file = cachePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ entries: cache.entries, order: cache.order }, null, 2), 'utf8');
}

function lookup(cache, sourceLocale, targetLocale, sourceText) {
  const key = makeKey(sourceLocale, targetLocale, sourceText);
  return Object.prototype.hasOwnProperty.call(cache.entries, key) ? cache.entries[key] : undefined;
}

function set(cache, sourceLocale, targetLocale, sourceText, translation) {
  const key = makeKey(sourceLocale, targetLocale, sourceText);
  if (Object.prototype.hasOwnProperty.call(cache.entries, key)) {
    cache.entries[key] = translation;
    return;
  }
  cache.entries[key] = translation;
  cache.order.push(key);
  while (cache.order.length > MAX_ENTRIES) {
    const dropped = cache.order.shift();
    delete cache.entries[dropped];
  }
}

module.exports = { MAX_ENTRIES, CACHE_DIR, CACHE_FILE, cachePath, makeKey, load, save, lookup, set };
