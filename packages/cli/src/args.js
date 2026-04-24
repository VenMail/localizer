'use strict';

/**
 * Tiny argv parser — no dep.
 * Supports:  --flag   --flag=value   --flag value   positional   -h / --help
 * Returns { _: string[], flags: object, help: bool }
 */
function parseArgs(argv) {
  const out = { _: [], flags: {}, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') { out.help = true; continue; }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        out.flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out.flags[key] = next;
          i++;
        } else {
          out.flags[key] = true;
        }
      }
    } else {
      out._.push(tok);
    }
  }
  return out;
}

function resolveProject(flags) {
  const cwd = process.cwd();
  const raw = flags.project || flags.cwd || cwd;
  const path = require('node:path');
  return path.resolve(cwd, String(raw));
}

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { parseArgs, resolveProject, parseList };
