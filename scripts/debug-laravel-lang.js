// Debug script for Laravel lang PHP files
// Usage: node debug-laravel-lang.js path\\to\\lang\\en\\Errors.php

const fs = require('fs');
const path = require('path');

function inferRoot(filePath) {
  const parts = filePath.split(path.sep).filter(Boolean);
  const langIndex = parts.lastIndexOf('lang');
  if (langIndex < 0 || langIndex + 2 >= parts.length) {
    return null;
  }
  const afterLocale = parts.slice(langIndex + 2);
  if (afterLocale.length === 0) {
    return null;
  }
  const fileName = afterLocale[afterLocale.length - 1];
  const baseName = path.basename(fileName, '.php');
  const prefixParts = afterLocale.slice(0, afterLocale.length - 1);
  prefixParts.push(baseName);
  const root = prefixParts.join('.');
  return root;
}

function decodeWithHeuristics(buf) {
  // Try UTF-8 first
  let textUtf8 = buf.toString('utf8');
  const hasNullUtf8 = textUtf8.includes('\u0000');

  if (!hasNullUtf8) {
    return { encoding: 'utf8', text: textUtf8 };
  }

  // Try UTF-16LE as fallback
  let textUtf16 = buf.toString('utf16le');
  const hasNullUtf16 = textUtf16.includes('\u0000');

  if (!hasNullUtf16) {
    return { encoding: 'utf16le', text: textUtf16 };
  }

  // Fall back to UTF-8 if both look odd
  return { encoding: 'utf8', text: textUtf8 };
}

function parseLaravelLangPhp(text, rootPrefix) {
  const length = text.length;
  const returnMatch = /return\s*(\[|array\s*\()/i.exec(text);
  if (!returnMatch) {
    console.log('No `return [` or `return array(` found in file.');
    return [];
  }

  let index = returnMatch.index + returnMatch[0].length;

  function skipWhitespaceAndComments(start) {
    let pos = start;
    while (pos < length) {
      const ch = text[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        pos += 1;
        continue;
      }
      if (ch === '/' && pos + 1 < length) {
        const next = text[pos + 1];
        if (next === '/') {
          pos += 2;
          while (pos < length && text[pos] !== '\n') pos += 1;
          continue;
        }
        if (next === '*') {
          pos += 2;
          while (pos + 1 < length && !(text[pos] === '*' && text[pos + 1] === '/')) pos += 1;
          if (pos + 1 < length) pos += 2;
          continue;
        }
      }
      break;
    }
    return pos;
  }

  function parseString(start) {
    const quote = text[start];
    if (quote !== '\'' && quote !== '"') {
      return null;
    }
    let pos = start + 1;
    let result = '';
    while (pos < length) {
      const ch = text[pos];
      if (ch === '\\') {
        if (pos + 1 < length) {
          const nextCh = text[pos + 1];
          result += nextCh;
          pos += 2;
          continue;
        }
        pos += 1;
        continue;
      }
      if (ch === quote) {
        return { value: result, next: pos + 1 };
      }
      result += ch;
      pos += 1;
    }
    return null;
  }

  const keys = [];

  function parseArray(startIndex, prefix) {
    let pos = startIndex;
    const open = text[pos];
    const close = open === '[' ? ']' : ')';
    pos += 1;

    while (pos < length) {
      pos = skipWhitespaceAndComments(pos);
      if (pos >= length) break;
      const ch = text[pos];
      if (ch === close) {
        return pos + 1;
      }
      if (ch === ',') {
        pos += 1;
        continue;
      }

      const keyLit = parseString(pos);
      if (!keyLit) {
        // Unsupported key form (e.g. numeric key); skip this entry
        while (pos < length && text[pos] !== ',' && text[pos] !== close) pos += 1;
        continue;
      }
      const key = keyLit.value;
      pos = skipWhitespaceAndComments(keyLit.next);

      if (text.slice(pos, pos + 2) !== '=>') {
        while (pos < length && text[pos] !== ',' && text[pos] !== close) pos += 1;
        continue;
      }

      pos += 2;
      pos = skipWhitespaceAndComments(pos);
      if (pos >= length) break;

      const valueChar = text[pos];
      const currentPrefix = prefix ? `${prefix}.${key}` : key;

      if (valueChar === '\'' || valueChar === '"') {
        const valueLit = parseString(pos);
        if (valueLit) {
          const fullKey = rootPrefix ? `${rootPrefix}.${currentPrefix}` : currentPrefix;
          keys.push({ key: fullKey, value: valueLit.value });
          pos = valueLit.next;
        }
      } else if (valueChar === '[') {
        pos = parseArray(pos, currentPrefix);
      } else if (
        (valueChar === 'a' || valueChar === 'A') &&
        text.slice(pos, pos + 5).toLowerCase() === 'array'
      ) {
        let j = pos + 5;
        j = skipWhitespaceAndComments(j);
        if (text[j] === '(') {
          pos = parseArray(j, currentPrefix);
        } else {
          pos = j;
        }
      } else {
        while (pos < length && text[pos] !== ',' && text[pos] !== close) pos += 1;
      }
    }

    return pos;
  }

  while (index < length && text[index] !== '[' && text[index] !== '(') {
    index += 1;
  }
  if (index >= length) {
    console.log('Found `return` but not an array start.');
    return [];
  }

  parseArray(index, '');
  return keys;
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node debug-laravel-lang.js path\\to\\lang\\en\\Errors.php');
    process.exit(1);
  }

  const buf = fs.readFileSync(filePath);
  const root = inferRoot(filePath);
  console.log('File:', filePath);
  console.log('Inferred root:', root);

  const { encoding, text } = decodeWithHeuristics(buf);
  console.log('Guessed encoding:', encoding);
  console.log('First 3 non-empty lines:');
  text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 3)
    .forEach((l, idx) => console.log(`  [${idx}] ${l}`));

  const keys = parseLaravelLangPhp(text, root || '');
  console.log(`Parsed ${keys.length} key(s):`);
  for (const k of keys) {
    console.log(' -', k.key);
  }
}

main();
