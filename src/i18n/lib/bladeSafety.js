'use strict';

// Recognize command-shaped examples without rejecting prose such as
// "Run npm install to continue". This is intentionally not a shell parser.
function isShellCommand(text) {
  let value = String(text || '').trim();
  if (!value) return false;
  value = value.replace(/^(?:\$\s+|#\s+)/, '');
  if (/^(?:[A-Z_][A-Z0-9_]*=(?:\S+|"[^"]*"|'[^']*')\s*)+$/.test(value)) return true;
  if (/^(?:\.\.?\/|\/usr\/bin\/|\/bin\/)\S+(?:\s|$)/.test(value)) return true;
  if (/^(?:sudo|systemctl|chmod|chown|curl|wget|kubectl|terraform|ansible|ssh|scp|rm|mkdir|export)\s+\S/.test(value)) return true;
  return /^(?:docker(?:\s+compose)?\s+(?:up|down|run|exec|build|logs|ps|pull|push)|(?:npm|pnpm|yarn)\s+(?:install|i|ci|run|add|remove|build|test)|(?:pip|pip3)\s+(?:install|uninstall)|git\s+(?:clone|pull|push|checkout|commit|status|add)|php\s+artisan|composer\s+(?:install|update|require)|python(?:3)?\s+-m)\b/.test(value);
}

module.exports = { isShellCommand };
