#!/usr/bin/env node
/**
 * i18n Replace Script - Unified Replacement Engine
 * 
 * This script mirrors the extraction script's parser system to ensure
 * consistent detection of translatable strings across all frameworks.
 * 
 * It uses the same patterns as extract-i18n.js but instead of extracting,
 * it replaces strings with t('key') or $t('key') calls.
 * 
 * Supported Frameworks:
 * - React, Next.js, Gatsby, Remix (JSX/TSX) → t('key')
 * - Vue 2/3, Nuxt 2/3, Quasar (Vue SFC) → $t('key') in template, t('key') in script
 * - Svelte, SvelteKit (Svelte) → t('key')
 * - Plain JS/TS → t('key')
 */

const { readdir, readFile, writeFile, stat } = require('node:fs/promises');
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');

// Import shared utilities
const { detectSrcRoot } = require('./lib/projectConfig');
const { getNamespaceFromFile } = require('./lib/stringUtils');
const { loadIgnorePatterns } = require('./lib/ignorePatterns');

// Import replacer system
const { replaceInFile, isSupported } = require('./lib/replacers');

const projectRoot = path.resolve(__dirname, '..');
const srcRoot = detectSrcRoot(projectRoot);
const outputDir = path.resolve(projectRoot, 'resources', 'js', 'i18n', 'auto');

const ignorePatterns = loadIgnorePatterns(projectRoot);

// Statistics
const stats = {
  filesProcessed: 0,
  filesModified: 0,
  stringsReplaced: 0,
  stringsSkipped: 0,
};

// ============================================================================
// Translation Key Map
// ============================================================================

/**
 * Build a map from (namespace|kind|text) -> fullKey
 * This mirrors exactly how extract-i18n.js registers translations
 */
function buildKeyMap(translations) {
  const map = new Map();

  function isCommonShortText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    const cleaned = trimmed.replace(/\s+/g, ' ').trim();
    if (/[.!?]/.test(cleaned)) return false;
    const words = cleaned.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 2) return false;
    if (cleaned.length > 24) return false;
    if (/[\/_]/.test(cleaned)) return false;
    return true;
  }

  function walk(node, pathSegments) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;

    for (const [key, value] of Object.entries(node)) {
      const nextPath = [...pathSegments, key];
      if (typeof value === 'string') {
        if (nextPath.length < 3) continue;

        const kind = nextPath[nextPath.length - 2];
        const nsSegments = nextPath.slice(0, -2);
        const namespace = nsSegments.join('.');
        const text = value;
        const fullKey = nextPath.join('.');

        // Primary key: namespace|kind|text
        const keyId = `${namespace}|${kind}|${text}`;
        if (!map.has(keyId)) {
          map.set(keyId, fullKey);
        }

        // Also register with 'text' kind as fallback
        if (kind !== 'text') {
          const textAliasId = `${namespace}|text|${text}`;
          if (!map.has(textAliasId)) {
            map.set(textAliasId, fullKey);
          }
        }

        // Register Commons alias for short texts
        if (isCommonShortText(text) && namespace !== 'Commons') {
          const commonsKeyId = `Commons|${kind}|${text}`;
          if (!map.has(commonsKeyId)) {
            map.set(commonsKeyId, fullKey);
          }
        }
      } else {
        walk(value, nextPath);
      }
    }
  }

  walk(translations, []);
  return map;
}

// ============================================================================
// File Collection
// ============================================================================

const IGNORE_DIRS = new Set([
  'node_modules', 'vendor', '.git', 'storage', 'bootstrap', 'public',
  'dist', 'build', '.nuxt', '.next', '.svelte-kit', '__pycache__',
  'bin', 'obj', 'target', '.idea', '.vscode',
]);

const SUPPORTED_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'mts', 'vue', 'svelte',
]);

async function collectFiles(dir, out) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        await collectFiles(entryPath, out);
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop().toLowerCase();
        // Skip .d.ts files
        if (entry.name.endsWith('.d.ts')) continue;
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          out.push(entryPath);
        }
      }
    }
  } catch (err) {
    console.error(`[i18n-replace] Error reading directory ${dir}:`, err.message);
  }
}


// ============================================================================
// File Processing
// ============================================================================

async function processFile(filePath, keyMap) {
  const content = await readFile(filePath, 'utf8');
  const namespace = getNamespaceFromFile(filePath, srcRoot);

  const result = replaceInFile(content, filePath, keyMap, namespace, { ignorePatterns });

  if (result.changeCount > 0) {
    await writeFile(filePath, result.content, 'utf8');
    stats.filesModified++;
    stats.stringsReplaced += result.changeCount;
    return true;
  }

  return false;
}

// ============================================================================
// Main
// ============================================================================

(async () => {
  try {
    console.log('[i18n-replace] Starting replacement...');
    console.log(`[i18n-replace] Source root: ${srcRoot}`);

    // Load translations
    async function readJsonSafe(p) {
      try {
        const raw = await readFile(p, 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    function deepMerge(target, source) {
      if (!source || typeof source !== 'object') return target;
      for (const [k, v] of Object.entries(source)) {
        if (typeof v === 'object' && v && !Array.isArray(v)) {
          if (!target[k] || typeof target[k] !== 'object') target[k] = {};
          deepMerge(target[k], v);
        } else {
          target[k] = v;
        }
      }
      return target;
    }

    const groupedDir = path.resolve(outputDir, 'en');
    let translations = {};

    if (existsSync(groupedDir)) {
      const stack = [groupedDir];
      while (stack.length) {
        const dir = stack.pop();
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile() && entry.name.endsWith('.json')) {
            const obj = await readJsonSafe(full);
            if (obj && typeof obj === 'object') deepMerge(translations, obj);
          }
        }
      }
    } else {
      const singleFile = path.resolve(outputDir, 'en.json');
      if (existsSync(singleFile)) {
        const parsed = await readJsonSafe(singleFile);
        if (parsed && typeof parsed === 'object') translations = parsed;
      } else {
        console.error(`[i18n-replace] No translations found at ${singleFile} or ${groupedDir}`);
        process.exit(1);
      }
    }

    const keyMap = buildKeyMap(translations);
    console.log(`[i18n-replace] Loaded ${keyMap.size} translation keys`);

    if (!existsSync(srcRoot)) {
      console.error(`[i18n-replace] Source root not found: ${srcRoot}`);
      process.exit(1);
    }

    // Collect files
    const files = [];
    await collectFiles(srcRoot, files);
    console.log(`[i18n-replace] Found ${files.length} files to process`);

    // Process files
    for (const file of files) {
      stats.filesProcessed++;
      try {
        const modified = await processFile(file, keyMap);
        if (modified) {
          const rel = path.relative(projectRoot, file);
          console.log(`[i18n-replace] Updated: ${rel}`);
        }
      } catch (err) {
        console.error(`[i18n-replace] Error processing ${file}:`, err.message);
      }
    }

    // Print statistics
    console.log('\n[i18n-replace] Replacement complete!');
    console.log(`  Files processed: ${stats.filesProcessed}`);
    console.log(`  Files modified: ${stats.filesModified}`);
    console.log(`  Strings replaced: ${stats.stringsReplaced}`);

  } catch (error) {
    console.error('[i18n-replace] Failed to replace translations.');
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  }
})();
