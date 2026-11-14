'use strict';
// Run from repository root: node --test tests/ReportedIssues.regression.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { VueParser } = require('../packages/core/src/i18n/lib/parsers/vueParser');
const { VueReplacer } = require('../packages/core/src/i18n/lib/replacers/vueReplacer');
const { BladeParser } = require('../packages/core/src/i18n/lib/parsers/bladeParser');
const { getLocaleLayout } = require('../packages/core/src/i18n/lib/projectConfig');

function srcTexts(source) {
  return new Set(new VueParser().parse(source).items.map(item => item.text));
}
function vueReplaced(source, pairs) {
  const keyMap = new Map(pairs.map(([kind, text, key]) => [
    `${text.length <= 24 && text.split(/\s+/).length <= 2 && !/[.!?]/.test(text) ? 'Commons' : 'Pages.Form'}|${kind}|${text}`,
    key,
  ]));
  return new VueReplacer().replace(source, keyMap, 'Pages.Form');
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localizer-regression-'));
  fs.mkdirSync(path.join(dir, 'resources', 'js', 'i18n', 'auto'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'resources', 'views', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({aiI18n: {
    srcRoot: 'resources/js', localesDir: 'resources/js/i18n/auto', layout: 'single', sourceLocale: 'en', locales: ['en','fr']
  }}));
  return dir;
}
function runCoreScript(dir, file, args = []) {
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'packages', 'core', 'src', 'i18n', file), ...args], {
    env: { ...process.env, AI_I18N_PROJECT_ROOT: dir }, encoding: 'utf8'
  });
  assert.equal(run.status, 0, `${file} failed: ${run.stderr}\n${run.stdout}`);
  return run;
}

test('#2 nested template slots do not terminate Vue replacement', () => {
  const input = `<template><div><template #header><h1>Full Title</h1></template><button>Delete</button></div></template>`;
  const r = vueReplaced(input, [
    ['heading', 'Full Title', 'Pages.Form.heading.full_title'],
    ['button','Delete','Commons.button.delete'],
  ]);
  assert.match(r.content, /\$t\('Pages.Form.heading.full_title'\)/);
  assert.match(r.content, /\$t\('Commons.button.delete'\)/);
});

test('SFC section discovery ignores comments and tag-like strings in scripts', () => {
  const { findSfcBlocks } = require('../packages/core/src/i18n/lib/sfcBlocks');
  const source = `<!-- <template> -->\n<script>const example = '<template>'; const s = '<script>';</script>\n<template><template #slot>Hi</template><p>Hello</p></template>`;
  assert.equal(findSfcBlocks(source, 'template').length, 1);
  assert.equal(findSfcBlocks(source, 'script').length, 1);
});

test('#9 ternary mustache processes every literal independently and is idempotent', () => {
  const input = `<template><button>{{ confirming ? 'Confirm Delete — cannot be undone' : 'Delete' }}</button></template>`;
  const pairs = [
    ['text','Confirm Delete — cannot be undone','Pages.Form.text.confirm'],
    ['text','Delete','Commons.text.delete'],
  ];
  const first = vueReplaced(input, pairs);
  assert.match(first.content, /\$t\('Pages.Form.text.confirm'\)/);
  assert.match(first.content, /\$t\('Commons.text.delete'\)/);
  assert.equal(vueReplaced(first.content,pairs).content,first.content);
  const extracted = srcTexts(input);
  assert(extracted.has('Confirm Delete — cannot be undone'));
  assert(extracted.has('Delete'));
});

test('#9 both Required and None are extracted from a mustache ternary', () => {
  const extracted = srcTexts(`<template><span>{{ record.requires_approval ? 'Required' : 'None' }}</span></template>`);
  assert(extracted.has('Required'));
  assert(extracted.has('None'));
});

test('#11 ignores comment text, without ignoring real UI literals', () => {
  const items = srcTexts(`<script setup>\n// We use the \"Any Day\" pattern\n/* fallback to \"no override\" */\nconst errorMessage = 'Could not save record';\n</script>`);
  assert(!items.has('Any Day'));
  assert(!items.has('no override'));
  assert(items.has('Could not save record'));
});

test('#7/#10 protect persisted select values and RBAC role constants', () => {
  const items = srcTexts(`<script setup>\nconst STAFF_ROLE_NAMES = ['Administrator', 'Sorting and Inventory', 'Office'];\nconst typeOptions = [{value: 'other', label: 'Other'},{value: 'weight', label: 'Weight'}];\n</script>`);
  for(const text of ['Administrator','Sorting and Inventory','Office','other','weight']) {
    assert(!items.has(text), `technical string unexpectedly registered: ${text}`);
  }
  assert(items.has('Other'));
  assert(items.has('Weight'));
});

test('#12 scans both setup script and Options-API script', () => {
  const input = `<script setup>\nconst { t } = useI18n();\nconst titleMessage = 'Submit your request';\n</script>\n<script>\nimport { t } from './i18n';\nexport default {data(){return {description: 'Cannot perform this operation'}}};\n</script>`;
  const items = srcTexts(input);
  assert(items.has('Submit your request'));
  assert(items.has('Cannot perform this operation'));
  const replaced = vueReplaced(input, [
    ['text','Submit your request','Pages.Form.text.submit'],
    ['text','Cannot perform this operation','Pages.Form.text.cannot_perform'],
  ]).content;
  assert.match(replaced, /t\('Pages.Form.text.cannot_perform'\)/);
  assert.match(replaced, /t\('Pages.Form.text.submit'\)/);
});

test('Vue script replacement never introduces an unbound t call', () => {
  const input = `<script>export default { data(){return {description: 'Cannot perform this operation'}} }</script>`;
  const result = vueReplaced(input, [['text','Cannot perform this operation','Pages.Form.text.cannot_perform']]);
  assert.equal(result.content, input);
});

test('Vue mustache comparison literals remain program values', () => {
  const input = `<template><p>{{ status === 'Pending' ? 'Pending' : 'Completed' }}</p></template>`;
  const result = vueReplaced(input, [['text','Pending','Commons.text.pending'], ['text','Completed','Commons.text.completed']]);
  assert.match(result.content, /status === 'Pending'/);
  assert.match(result.content, /\? \$t\('Commons.text.pending'\)/);
});

test('#5 Blade extractor rejects pre/code content and inline fragments', () => {
  const source = `<main><h1>This page isn't set up yet</h1><pre>docker compose up -d</pre>`+
    `<p>First <code>APP_DEBUG=true</code> then run: </p></main>`;
  const texts = new Set(new BladeParser().parse(source).items.map(i=>i.text));
  assert(texts.has("This page isn't set up yet"));
  assert(!texts.has('docker compose up -d'));
  assert(!texts.has('then run:'));
  assert(!texts.has('First'));
});

test('#3/#4/#5 Blade rewrite uses Commons + text fallback and preserves protected content', () => {
  const dir = fixture();
  try {
    const locales = path.join(dir,'resources','js','i18n','auto');
    const base = {
      Commons: { text: { pallet_report: 'Pallet Report' } },
      Errors: { TurnstileMisconfigured: { text: { this_page_isn_t: "This page isn't set up yet" } } },
    };
    fs.writeFileSync(path.join(locales,'en.json'), JSON.stringify(base));
    const p1 = path.join(dir,'resources','views','reports','pallet.blade.php');
    const p2 = path.join(dir,'resources','views','errors','turnstile_misconfigured.blade.php');
    fs.mkdirSync(path.dirname(p2),{recursive:true});
    fs.writeFileSync(p1,'<title>Pallet Report</title>');
    fs.writeFileSync(p2, `{{-- Never remove this comment --}}\n<h1>This page isn't set up yet</h1>\n<pre>docker compose up -d</pre>`);
    runCoreScript(dir,'rewrite-i18n-blade.js');
    assert.match(fs.readFileSync(p1,'utf8'),/Commons.text.pallet_report/);
    assert.match(fs.readFileSync(p2,'utf8'),/Errors.TurnstileMisconfigured.text.this_page_isn_t/);
    assert.match(fs.readFileSync(p2,'utf8'),/Never remove this comment/);
    assert.match(fs.readFileSync(p2,'utf8'),/<pre>docker compose up -d<\/pre>/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('#6 accepts canonical layout and legacy localeLayout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'localizer-layout-'));
  try {
    const pkg = path.join(dir,'package.json');
    fs.writeFileSync(pkg,JSON.stringify({aiI18n:{localeLayout:'grouped'}}));
    assert.equal(getLocaleLayout(dir),'grouped');
    fs.writeFileSync(pkg,JSON.stringify({aiI18n:{layout:'single',localeLayout:'grouped'}}));
    assert.equal(getLocaleLayout(dir),'single');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('#8 cleanup --apply preserves keys used in Blade and removes unused keys from both locales', () => {
  const dir=fixture();
  try {
    const locales=path.join(dir,'resources','js','i18n','auto');
    const data={Errors:{TurnstileMisconfigured:{text:{this_page_isn_t:"This page isn't set up yet",unused_text:'Unused string text'}}}};
    for (const loc of ['en','fr'])fs.writeFileSync(path.join(locales,loc+'.json'),JSON.stringify(data));
    const view=path.join(dir,'resources','views','reports','pallet.blade.php');
    fs.writeFileSync(view,`<h1>{{ __('Errors.TurnstileMisconfigured.text.this_page_isn_t') }}</h1>`);
    runCoreScript(dir,'cleanup-i18n-unused.js',['--apply']);
    for (const loc of ['en','fr']) {
      const obj=JSON.parse(fs.readFileSync(path.join(locales,loc+'.json'),'utf8'));
      const keys=obj.Errors.TurnstileMisconfigured.text;
      assert.equal(keys.this_page_isn_t,"This page isn't set up yet");
      assert.equal(keys.unused_text,undefined);
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
