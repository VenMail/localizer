'use strict';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

const cyan = c('36');
const green = c('32');
const yellow = c('33');
const red = c('31');
const dim = c('2');

function info(msg) { console.log(cyan('›') + ' ' + msg); }
function ok(msg) { console.log(green('✓') + ' ' + msg); }
function warn(msg) { console.warn(yellow('!') + ' ' + msg); }
function err(msg) { console.error(red('✗') + ' ' + msg); }
function detail(msg) { console.log('  ' + dim(msg)); }

module.exports = { info, ok, warn, err, detail, cyan, green, yellow, red, dim };
