/**
 * Shared project configuration utilities for i18n scripts
 */
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

/**
 * Get configured source root from package.json
 */
function getConfiguredSrcRoot(projectRoot) {
  try {
    const pkgPath = path.resolve(projectRoot, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== 'object') return null;
    const cfg = pkg.aiI18n;
    if (!cfg || typeof cfg !== 'object') return null;
    const rel = cfg.srcRoot;
    if (!rel || typeof rel !== 'string') return null;
    const full = path.resolve(projectRoot, rel);
    if (!existsSync(full)) return null;
    return full;
  } catch {
    return null;
  }
}

/**
 * Detect source root directory
 */
function detectSrcRoot(projectRoot) {
  const configured = getConfiguredSrcRoot(projectRoot);
  if (configured) return configured;
  
  // Prefer Laravel/Inertia-style resources/js when present, otherwise fall
  // back to src for React/Next/Vue/Nuxt-style projects
  const candidates = ['resources/js', 'src'];

  const existing = candidates
    .map((rel) => ({ rel, full: path.resolve(projectRoot, rel) }))
    .filter((c) => existsSync(c.full));

  if (existing.length === 1) {
    return existing[0].full;
  }

  if (existing.length > 1) {
    const IGNORE_DIRS = new Set([
      'node_modules', 'vendor', '.git', 'storage', 'bootstrap', 'public',
      'dist', 'build', '.nuxt', '.next', '.svelte-kit', '__pycache__',
      'bin', 'obj', 'target', '.idea', '.vscode',
    ]);

    const isSourceFile = (name) => {
      if (!name) return false;
      if (name.endsWith('.d.ts')) return false;
      return /\.(tsx|ts|jsx|js|vue|svelte|mjs|mts)$/i.test(name);
    };

    const countSourceFiles = (root, maxCount = 400) => {
      let count = 0;
      const stack = [root];
      while (stack.length && count < maxCount) {
        const dir = stack.pop();
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (count >= maxCount) break;
          const name = entry.name;
          if (entry.isDirectory()) {
            if (name.startsWith('.') || IGNORE_DIRS.has(name)) continue;
            stack.push(path.join(dir, name));
          } else if (entry.isFile()) {
            if (isSourceFile(name)) count += 1;
          }
        }
      }
      return count;
    };

    const ranked = existing
      .map((c) => ({ ...c, count: countSourceFiles(c.full) }))
      .sort((a, b) => b.count - a.count);

    if (ranked[0].count !== ranked[1].count) {
      return ranked[0].full;
    }

    // Stable fallback for backwards compatibility
    const resources = ranked.find((c) => c.rel === 'resources/js');
    if (resources) return resources.full;
    return ranked[0].full;
  }
  
  return path.resolve(projectRoot, 'resources', 'js');
}

function readPackageJson(projectRoot) {
  try {
    const pkgPath = path.resolve(projectRoot, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const raw = readFileSync(pkgPath, 'utf8');
    // Tolerate BOM — JSON.parse does not strip it.
    const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const pkg = JSON.parse(cleaned);
    if (!pkg || typeof pkg !== 'object') return null;
    return pkg;
  } catch {
    return null;
  }
}

function getAiI18nConfig(projectRoot) {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return {};
  const cfg = pkg.aiI18n;
  return cfg && typeof cfg === 'object' ? cfg : {};
}

/**
 * Get project locales from package.json
 */
function getProjectLocales(projectRoot) {
  const cfg = getAiI18nConfig(projectRoot);
  if (Array.isArray(cfg.locales)) {
    const filtered = cfg.locales.filter((l) => typeof l === 'string' && l.length > 0);
    if (filtered.length) return filtered;
  }
  return ['en'];
}

/**
 * Source locale for AI translation (the "from" language).
 * Default: first entry of `aiI18n.sourceLocale`, else `defaultLocale`, else 'en'.
 * Keeping 'en' as final fallback preserves legacy behaviour for Laravel projects.
 */
function getSourceLocale(projectRoot) {
  const cfg = getAiI18nConfig(projectRoot);
  if (typeof cfg.sourceLocale === 'string' && cfg.sourceLocale) {
    return cfg.sourceLocale;
  }
  if (typeof cfg.defaultLocale === 'string' && cfg.defaultLocale) {
    return cfg.defaultLocale;
  }
  return 'en';
}

/**
 * Detect framework kind from package.json deps. Lightweight, Node-safe twin
 * of src/frameworks/detection.ts — we can't import TS from here.
 * Returns one of: 'vue' | 'nuxt' | 'svelte' | 'react' | 'next' | 'laravel' | 'mixed' | null
 */
function detectFrameworkKind(projectRoot) {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const results = [];
  if (has('nuxt') || has('nuxt3')) results.push('nuxt');
  if (has('vue')) results.push('vue');
  if (has('svelte') || has('@sveltejs/kit')) results.push('svelte');
  if (has('next')) results.push('next');
  if (has('react')) results.push('react');
  // Laravel signalled by composer.json rather than package.json, but if
  // i18n-laravel-style toolchain present, treat accordingly.
  const hasLaravelMarker = existsSync(path.resolve(projectRoot, 'composer.json'));
  if (hasLaravelMarker) results.push('laravel');
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];
  // Prefer the most specific: nuxt > next > laravel > vue > svelte > react
  const rank = { nuxt: 0, next: 1, laravel: 2, vue: 3, svelte: 4, react: 5 };
  results.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99));
  return results[0];
}

/**
 * Resolve the directory where locale files should be written.
 * Resolution order:
 *   1. `aiI18n.localesDir` from package.json (relative to projectRoot)
 *   2. For Vue/Nuxt/Svelte/React/Next projects → `<srcRoot>/locales`
 *      when that dir exists OR when no Laravel marker is present
 *   3. Legacy fallback: `resources/js/i18n/auto` (Laravel convention)
 *
 * Returns an absolute filesystem path.
 */
function detectLocalesDir(projectRoot, srcRoot) {
  const cfg = getAiI18nConfig(projectRoot);
  if (typeof cfg.localesDir === 'string' && cfg.localesDir) {
    return path.resolve(projectRoot, cfg.localesDir);
  }

  const kind = detectFrameworkKind(projectRoot);
  const laravelStyle = kind === 'laravel';
  const srcBased = srcRoot && typeof srcRoot === 'string' ? srcRoot : detectSrcRoot(projectRoot);

  if (!laravelStyle && srcBased) {
    const candidate = path.resolve(srcBased, 'locales');
    // Prefer explicit candidate even if it doesn't exist yet — extract script
    // will create it. Only fall back to Laravel path when the project truly
    // looks like Laravel (composer.json present).
    return candidate;
  }

  return path.resolve(projectRoot, 'resources', 'js', 'i18n', 'auto');
}

/**
 * Custom call patterns (e.g. `message.error(...)`) whose first string argument
 * should be treated as user-facing text eligible for extraction.
 */
function getMessagePatterns(projectRoot) {
  const cfg = getAiI18nConfig(projectRoot);
  if (Array.isArray(cfg.messagePatterns)) {
    const filtered = cfg.messagePatterns.filter(
      (p) => typeof p === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(p),
    );
    if (filtered.length) return filtered;
  }
  return [];
}

/**
 * Property-name allowlist for TS/JS object-literal extraction in non-SFC files.
 * Only string values under these keys get extracted — guards against pulling in
 * identifier-like values (`value: 'bounceIn'`).
 */
function getTsExtractKeys(projectRoot) {
  const cfg = getAiI18nConfig(projectRoot);
  if (Array.isArray(cfg.tsExtractKeys)) {
    const filtered = cfg.tsExtractKeys.filter(
      (k) => typeof k === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k),
    );
    if (filtered.length) return filtered;
  }
  return ['label', 'name', 'title', 'text', 'placeholder', 'tooltip', 'description', 'message'];
}

/**
 * Whether to sort JSON object keys alphabetically on sync. Default: true for
 * Laravel-convention projects (legacy behaviour); false for modern projects
 * that supply an explicit `aiI18n` block, preserving insertion order.
 */
function getSortKeys(projectRoot) {
  const cfg = getAiI18nConfig(projectRoot);
  if (typeof cfg.sortKeys === 'boolean') return cfg.sortKeys;
  const pkg = readPackageJson(projectRoot);
  const hasAiBlock = !!(pkg && pkg.aiI18n && typeof pkg.aiI18n === 'object');
  return !hasAiBlock;
}

/**
 * Locale file layout:
 *  - 'single'  → one file per locale, flat keys merged: `<localesDir>/<locale>.json`
 *  - 'grouped' → one subdir per locale with per-namespace files:
 *                `<localesDir>/<locale>/<namespace>.json`
 * Default: 'grouped' for Laravel; 'single' when an `aiI18n` block is present
 * and the project is not Laravel.
 */
function getLocaleLayout(projectRoot) {
  const cfg = getAiI18nConfig(projectRoot);
  if (cfg.layout === 'single' || cfg.layout === 'grouped') {
    return cfg.layout;
  }
  const kind = detectFrameworkKind(projectRoot);
  const pkg = readPackageJson(projectRoot);
  const hasAiBlock = !!(pkg && pkg.aiI18n && typeof pkg.aiI18n === 'object');
  if (hasAiBlock && kind !== 'laravel') return 'single';
  return 'grouped';
}

module.exports = {
  getConfiguredSrcRoot,
  detectSrcRoot,
  getProjectLocales,
  getSourceLocale,
  detectLocalesDir,
  detectFrameworkKind,
  getMessagePatterns,
  getTsExtractKeys,
  getSortKeys,
  getLocaleLayout,
};
