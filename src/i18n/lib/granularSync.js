/**
 * Granular sync utilities for fine-grained i18n synchronization
 * Supports key-level, file-level, and full project sync
 */
const { readFile, writeFile, readdir, mkdir } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { getProjectLocales, detectSrcRoot } = require('./projectConfig');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sortObjectDeep(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const sortedKeys = Object.keys(input).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = sortObjectDeep(input[key]);
  }
  return result;
}

async function readJson(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(filePath, data) {
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(filePath, payload, 'utf8');
}

/**
 * Get value at a key path in an object
 */
function getKeyValue(obj, keyPath) {
  if (!obj || typeof obj !== 'object') return undefined;
  const segments = String(keyPath).split('.').filter(Boolean);
  let node = obj;
  for (const segment of segments) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Set value at a key path in an object (creates intermediate objects)
 */
function setKeyValue(obj, keyPath, value) {
  const segments = String(keyPath).split('.').filter(Boolean);
  if (!segments.length) return;
  
  let node = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!node[segment] || typeof node[segment] !== 'object') {
      node[segment] = {};
    }
    node = node[segment];
  }
  node[segments[segments.length - 1]] = value;
}

/**
 * Check if key path exists in object
 */
function hasKeyPath(obj, keyPath) {
  return getKeyValue(obj, keyPath) !== undefined;
}

/**
 * Get the relative file path for a key in grouped locale structure
 * Returns the JSON file path relative to the locale directory
 */
function getFilePathForKey(keyPath, baseGroupedDir) {
  const segments = String(keyPath).split('.').filter(Boolean);
  if (segments.length < 2) {
    return 'common.json';
  }
  
  // First segment is typically the namespace/file name
  const namespace = segments[0];
  return `${namespace}.json`;
}

/**
 * Determine auto directory from project root
 */
function getAutoDir(projectRoot) {
  const srcRoot = detectSrcRoot(projectRoot);
  return path.resolve(srcRoot, 'i18n', 'auto');
}

/**
 * Sync specific keys only across all locales
 * @param {string} projectRoot - Project root directory
 * @param {string[]} keys - Array of key paths to sync
 * @param {Object} options - Optional settings
 * @returns {Promise<{updated: number, files: string[]}>}
 */
async function syncKeys(projectRoot, keys, options = {}) {
  const { baseLocale = 'en', verbose = false } = options;
  const autoDir = getAutoDir(projectRoot);
  const baseGroupedDir = path.resolve(autoDir, baseLocale);
  
  const result = { updated: 0, files: [] };
  
  if (!keys || !keys.length) {
    return result;
  }
  
  // Determine target locales
  const configuredLocales = getProjectLocales(projectRoot).filter(
    (locale) => locale && locale !== baseLocale,
  );
  
  const locales = new Set(configuredLocales);
  
  if (locales.size === 0) {
    // Fallback: scan auto directory
    if (existsSync(autoDir)) {
      const entries = await readdir(autoDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name !== baseLocale) {
          locales.add(e.name);
        } else if (e.isFile() && e.name.endsWith('.json')) {
          const name = e.name.replace(/\.json$/i, '');
          if (name !== baseLocale) locales.add(name);
        }
      }
    }
  }
  
  if (locales.size === 0) {
    return result;
  }
  
  // Check if using grouped structure
  const useGrouped = existsSync(baseGroupedDir);
  
  if (useGrouped) {
    // Group keys by their target file
    const keysByFile = new Map();
    for (const key of keys) {
      const fileName = getFilePathForKey(key, baseGroupedDir);
      if (!keysByFile.has(fileName)) {
        keysByFile.set(fileName, []);
      }
      keysByFile.get(fileName).push(key);
    }
    
    for (const locale of locales) {
      const localeDir = path.resolve(autoDir, locale);
      
      for (const [fileName, fileKeys] of keysByFile.entries()) {
        const baseFilePath = path.resolve(baseGroupedDir, fileName);
        const targetFilePath = path.resolve(localeDir, fileName);
        
        const baseData = await readJson(baseFilePath);
        if (!baseData) continue;
        
        const targetData = (await readJson(targetFilePath)) || {};
        let modified = false;
        
        for (const key of fileKeys) {
          const baseValue = getKeyValue(baseData, key);
          if (baseValue === undefined) continue;
          
          // Only set if target doesn't have this key
          if (!hasKeyPath(targetData, key)) {
            setKeyValue(targetData, key, baseValue);
            modified = true;
            if (verbose) {
              console.log(`[granular-sync] Added key "${key}" to ${locale}/${fileName}`);
            }
          }
        }
        
        if (modified) {
          await mkdir(path.dirname(targetFilePath), { recursive: true });
          await writeJson(targetFilePath, sortObjectDeep(targetData));
          result.updated++;
          result.files.push(targetFilePath);
        }
      }
    }
  } else {
    // Single-file structure
    const basePath = path.resolve(autoDir, `${baseLocale}.json`);
    const baseData = await readJson(basePath);
    if (!baseData) return result;
    
    for (const locale of locales) {
      const targetPath = path.resolve(autoDir, `${locale}.json`);
      const targetData = (await readJson(targetPath)) || {};
      let modified = false;
      
      for (const key of keys) {
        const baseValue = getKeyValue(baseData, key);
        if (baseValue === undefined) continue;
        
        if (!hasKeyPath(targetData, key)) {
          setKeyValue(targetData, key, baseValue);
          modified = true;
          if (verbose) {
            console.log(`[granular-sync] Added key "${key}" to ${locale}.json`);
          }
        }
      }
      
      if (modified) {
        await writeJson(targetPath, sortObjectDeep(targetData));
        result.updated++;
        result.files.push(targetPath);
      }
    }
  }
  
  return result;
}

/**
 * Sync all keys from a specific locale JSON file
 * @param {string} projectRoot - Project root directory
 * @param {string} filePath - Path to the source locale JSON file
 * @param {Object} options - Optional settings
 * @returns {Promise<{updated: number, files: string[]}>}
 */
async function syncFile(projectRoot, filePath, options = {}) {
  const { baseLocale = 'en', verbose = false } = options;
  const autoDir = getAutoDir(projectRoot);
  
  const result = { updated: 0, files: [] };
  
  if (!existsSync(filePath)) {
    return result;
  }
  
  // Infer locale from file path
  const normalizedPath = path.normalize(filePath);
  const autoIndex = normalizedPath.indexOf(`${path.sep}auto${path.sep}`);
  
  let sourceLocale = baseLocale;
  let relativeFilePath = '';
  
  if (autoIndex >= 0) {
    const afterAuto = normalizedPath.substring(autoIndex + 6); // length of '/auto/'
    const parts = afterAuto.split(path.sep);
    if (parts.length >= 1) {
      sourceLocale = parts[0].replace(/\.json$/i, '');
      relativeFilePath = parts.slice(1).join(path.sep);
    }
  } else {
    // Single file - extract locale from filename
    const baseName = path.basename(filePath, '.json');
    sourceLocale = baseName;
  }
  
  // Only sync from base locale
  if (sourceLocale !== baseLocale) {
    if (verbose) {
      console.log(`[granular-sync] Skipping non-base locale file: ${filePath}`);
    }
    return result;
  }
  
  const sourceData = await readJson(filePath);
  if (!sourceData) return result;
  
  // Collect all keys from source file
  const keys = [];
  function collectKeys(obj, prefix = '') {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') {
        keys.push(fullKey);
      } else if (isPlainObject(value)) {
        collectKeys(value, fullKey);
      }
    }
  }
  collectKeys(sourceData);
  
  if (keys.length === 0) return result;
  
  // Determine target locales
  const configuredLocales = getProjectLocales(projectRoot).filter(
    (locale) => locale && locale !== baseLocale,
  );
  
  const locales = new Set(configuredLocales);
  
  if (locales.size === 0 && existsSync(autoDir)) {
    const entries = await readdir(autoDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name !== baseLocale) {
        locales.add(e.name);
      } else if (e.isFile() && e.name.endsWith('.json')) {
        const name = e.name.replace(/\.json$/i, '');
        if (name !== baseLocale) locales.add(name);
      }
    }
  }
  
  if (locales.size === 0) return result;
  
  // Check if grouped or single file structure
  const baseGroupedDir = path.resolve(autoDir, baseLocale);
  const useGrouped = existsSync(baseGroupedDir) && relativeFilePath;
  
  if (useGrouped && relativeFilePath) {
    // Grouped structure - sync to corresponding file in each locale
    for (const locale of locales) {
      const targetPath = path.resolve(autoDir, locale, relativeFilePath);
      const targetData = (await readJson(targetPath)) || {};
      let modified = false;
      
      for (const key of keys) {
        const sourceValue = getKeyValue(sourceData, key);
        if (sourceValue === undefined) continue;
        
        if (!hasKeyPath(targetData, key)) {
          setKeyValue(targetData, key, sourceValue);
          modified = true;
        }
      }
      
      if (modified) {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeJson(targetPath, sortObjectDeep(targetData));
        result.updated++;
        result.files.push(targetPath);
        if (verbose) {
          console.log(`[granular-sync] Synced ${locale}/${relativeFilePath}`);
        }
      }
    }
  } else {
    // Single file structure
    for (const locale of locales) {
      const targetPath = path.resolve(autoDir, `${locale}.json`);
      const targetData = (await readJson(targetPath)) || {};
      let modified = false;
      
      for (const key of keys) {
        const sourceValue = getKeyValue(sourceData, key);
        if (sourceValue === undefined) continue;
        
        if (!hasKeyPath(targetData, key)) {
          setKeyValue(targetData, key, sourceValue);
          modified = true;
        }
      }
      
      if (modified) {
        await writeJson(targetPath, sortObjectDeep(targetData));
        result.updated++;
        result.files.push(targetPath);
        if (verbose) {
          console.log(`[granular-sync] Synced ${locale}.json`);
        }
      }
    }
  }
  
  return result;
}

/**
 * Ensure specific keys exist in all locales with base locale values as fallback
 * Unlike syncKeys, this also updates keys that exist but have empty/undefined values
 * @param {string} projectRoot - Project root directory
 * @param {string[]} keys - Array of key paths to ensure
 * @param {Object} values - Map of key to value (for base locale)
 * @param {Object} options - Optional settings
 * @returns {Promise<{updated: number, files: string[]}>}
 */
async function ensureKeys(projectRoot, keys, values = {}, options = {}) {
  const { baseLocale = 'en', verbose = false, forceUpdate = false } = options;
  const autoDir = getAutoDir(projectRoot);
  const baseGroupedDir = path.resolve(autoDir, baseLocale);
  
  const result = { updated: 0, files: [] };
  
  if (!keys || !keys.length) {
    return result;
  }
  
  // First, ensure keys exist in base locale
  const useGrouped = existsSync(baseGroupedDir);
  
  if (useGrouped) {
    // Group keys by file
    const keysByFile = new Map();
    for (const key of keys) {
      const fileName = getFilePathForKey(key, baseGroupedDir);
      if (!keysByFile.has(fileName)) {
        keysByFile.set(fileName, []);
      }
      keysByFile.get(fileName).push(key);
    }
    
    for (const [fileName, fileKeys] of keysByFile.entries()) {
      const baseFilePath = path.resolve(baseGroupedDir, fileName);
      const baseData = (await readJson(baseFilePath)) || {};
      let modified = false;
      
      for (const key of fileKeys) {
        const existingValue = getKeyValue(baseData, key);
        const providedValue = values[key];
        
        if (existingValue === undefined || (forceUpdate && providedValue !== undefined)) {
          const valueToSet = providedValue !== undefined ? providedValue : key.split('.').pop();
          setKeyValue(baseData, key, valueToSet);
          modified = true;
        }
      }
      
      if (modified) {
        await mkdir(path.dirname(baseFilePath), { recursive: true });
        await writeJson(baseFilePath, sortObjectDeep(baseData));
        result.updated++;
        result.files.push(baseFilePath);
        if (verbose) {
          console.log(`[granular-sync] Updated base locale: ${fileName}`);
        }
      }
    }
  } else {
    // Single file structure
    const basePath = path.resolve(autoDir, `${baseLocale}.json`);
    const baseData = (await readJson(basePath)) || {};
    let modified = false;
    
    for (const key of keys) {
      const existingValue = getKeyValue(baseData, key);
      const providedValue = values[key];
      
      if (existingValue === undefined || (forceUpdate && providedValue !== undefined)) {
        const valueToSet = providedValue !== undefined ? providedValue : key.split('.').pop();
        setKeyValue(baseData, key, valueToSet);
        modified = true;
      }
    }
    
    if (modified) {
      await mkdir(path.dirname(basePath), { recursive: true });
      await writeJson(basePath, sortObjectDeep(baseData));
      result.updated++;
      result.files.push(basePath);
      if (verbose) {
        console.log(`[granular-sync] Updated base locale file`);
      }
    }
  }
  
  // Now sync to other locales
  const syncResult = await syncKeys(projectRoot, keys, options);
  result.updated += syncResult.updated;
  result.files.push(...syncResult.files);
  
  return result;
}

module.exports = {
  syncKeys,
  syncFile,
  ensureKeys,
  getAutoDir,
  getKeyValue,
  setKeyValue,
  hasKeyPath,
  sortObjectDeep,
  readJson,
  writeJson,
};

