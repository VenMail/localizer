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
function vueReplaced(source, pairs, options = {}) {
  const keyMap = new Map(pairs.map(([kind, text, key]) => [
    `${text.length <= 24 && text.split(/\s+/).length <= 2 && !/[.!?]/.test(text) ? 'Commons' : 'Pages.Form'}|${kind}|${text}`,
    key,
  ]));
  return new VueReplacer().replace(source, keyMap, 'Pages.Form', options);
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

test('#2 extracts and replaces component caption attributes in later slots', () => {
  const input = `<template><Form><template #one>First</template><template #two><Form newrecordcaption="Add Category" /></template></Form></template>`;
  assert(srcTexts(input).has('Add Category'));
  const result = vueReplaced(input, [['text','Add Category','Commons.text.add_category']]).content;
  assert.match(result, /:newrecordcaption="\$t\('Commons.text.add_category'\)"/);
});

test('#9 ternary mustache processes every literal independently and is idempotent', () => {
  const input = `<template><button>{{ confirming ? 'Confirm Delete — cannot be undone' : 'Delete' }}</button></template>`;
  const pairs = [
    ['text','Confirm Delete — cannot be undone','Pages.Form.text.confirm'],
    ['text','Delete','Commons.text.delete'],
  ];
  const first = vueReplaced(input, pairs);
  assert.match(first.content, /\$t\("Pages.Form.text.confirm"\)/);
  assert.match(first.content, /\$t\("Commons.text.delete"\)/);
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
  assert.match(replaced, /this\.\$t\("Pages.Form.text.cannot_perform"\)/);
  assert.match(replaced, /t\("Pages.Form.text.submit"\)/);
});

test('Vue Options API uses the component translator without an unbound t call', () => {
  const input = `<script>export default { data(){return {description: 'Cannot perform this operation'}} }</script>`;
  const result = vueReplaced(input, [['text','Cannot perform this operation','Pages.Form.text.cannot_perform']]);
  assert.match(result.content, /this\.\$t\("Pages.Form.text.cannot_perform"\)/);
  const vm = require('node:vm');
  const script = result.content.replace(/^<script>/, '').replace(/<\/script>$/, '').replace('export default', 'module.exports =');
  const context = { module: {exports:{}} };
  vm.runInNewContext(script, context);
  const state = context.module.exports.data.call({$t: key => `translated:${key}`});
  assert.equal(state.description, 'translated:Pages.Form.text.cannot_perform');
  assert.equal(vueReplaced(result.content, [['text','Cannot perform this operation','Pages.Form.text.cannot_perform']]).content, result.content);
});

test('Vue script rewriting respects comments, module scope and function this', () => {
  const input = `<script>\n// title: 'Save the file'\nconst title = 'Save the file';\nexport default { methods: { errorMessage() { const nested = function(){ return 'Save the file' }; return 'Save the file'; }, roleName() { return 'Save the file'; }, bad: () => ({title:'Save the file'}) } };\n</script>`;
  const result = vueReplaced(input, [['text', 'Save the file', 'Pages.Form.text.save']]).content;
  assert.match(result, /\/\/ title: 'Save the file'/);
  assert.match(result, /const title = 'Save the file'/);
  assert.match(result, /function\(\)\{ return 'Save the file' \}/);
  assert.match(result, /return this\.\$t\("Pages.Form.text.save"\)/);
  assert.match(result, /roleName\(\) \{ return 'Save the file'; \}/);
  assert.match(result, /bad: \(\) => \(\{title:'Save the file'\}\)/);
});

test('Vue setup does not use a translation binding before initialization', () => {
  const input = `<script setup>const titleBefore = 'Save the file'; const { t } = useI18n(); const titleAfter = 'Save the file';</script>`;
  const result = vueReplaced(input, [['text','Save the file','Pages.Form.text.save']]).content;
  assert.match(result, /titleBefore = 'Save the file'/);
  assert.match(result, /titleAfter = t\("Pages.Form.text.save"\)/);
});

test('Vue type-only imports do not count as runtime translation bindings', () => {
  const input = `<script setup lang="ts">import type { t } from './types'; const title = 'Save the file';</script>`;
  const result = vueReplaced(input, [['text','Save the file','Pages.Form.text.save']]);
  assert.equal(result.content, input);
});

test('Vue setup reuses an existing composer, including aliased hooks and bindings', () => {
  const pairs = [['text','Save the file','Pages.Form.text.save']];
  for (const [setup, expected] of [
    ["import { useI18n as useLocale } from 'vue-i18n'; const composer = useLocale();", /title = composer\.t\(/],
    ["const { t: translate } = useI18n();", /title = translate\(/],
    ["const { locale, } = useI18n();", /title = __localizerT\(/],
    ["const { locale, /* comment */ } = useI18n();", /title = __localizerT\(/],
    ["const { t: translate = fallback } = useI18n();", /title = translate\(/],
    ["const { locale, ...rest } = useI18n();", /title = __localizerT\(/],
  ]) {
    const input = `<script setup>${setup} const title = 'Save the file';</script>`;
    const output = vueReplaced(input,pairs).content;
    assert.match(output,expected);
    require('@babel/parser').parse(output.slice('<script setup>'.length, -'</script>'.length), {sourceType:'module',plugins:['typescript']});
    assert.equal(vueReplaced(output,pairs).content,output);
  }
});

test('Vue setup can opt into composition binding without identifier collisions', () => {
  const input = `<script setup lang="ts">const __localizerT = 'existing'; const __localizerUseI18n = 1; const title = 'Save the file';</script>`;
  const pairs = [['text','Save the file','Pages.Form.text.save']];
  const options = {vueSetupTranslation:'vue-i18n-composition'};
  const output = vueReplaced(input,pairs,options).content;
  assert.match(output, /import \{ useI18n as __localizerUseI18n2 \} from 'vue-i18n'/);
  assert.match(output, /const \{ t: __localizerT2 \} = __localizerUseI18n2\(\)/);
  assert.match(output, /title = __localizerT2\("Pages.Form.text.save"\)/);
  require('@babel/parser').parse(output.slice(output.indexOf('>')+1,output.indexOf('</script>')), {sourceType:'module',plugins:['typescript']});
  assert.equal(vueReplaced(output,pairs,options).content,output);
  assert.equal(vueReplaced(input,pairs).content,input);
  assert.equal(vueReplaced(input,[],options).content,input);
});

test('default replace backend honors the Vue composition setup option', () => {
  const dir=fixture();
  try {
    const pkgPath=path.join(dir,'package.json');
    const pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8'));
    pkg.aiI18n.vueSetupTranslation='vue-i18n-composition';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    const file=path.join(dir,'resources','js','Form.vue');
    fs.writeFileSync(file, `<script setup>const title = 'Save the file';</script>`);
    const locale=path.join(dir,'resources','js','i18n','auto','en.json');
    fs.writeFileSync(locale,JSON.stringify({Common:{text:{save:'Save the file'}}}));
    runCoreScript(dir,'replace-i18n.js');
    const out=fs.readFileSync(file,'utf8');
    assert.match(out, /import \{ useI18n as __localizerUseI18n \} from 'vue-i18n'/);
    assert.match(out, /title = __localizerT\("Common.text.save"\)/);
    runCoreScript(dir,'replace-i18n.js');
    assert.equal(fs.readFileSync(file,'utf8'),out);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('Vue mustache comparison literals remain program values', () => {
  const input = `<template><p>{{ status === 'Pending' ? 'Pending' : 'Completed' }}</p></template>`;
  const result = vueReplaced(input, [['text','Pending','Commons.text.pending'], ['text','Completed','Commons.text.completed']]);
  assert.match(result.content, /status === 'Pending'/);
  assert.match(result.content, /\? \$t\("Commons.text.pending"\)/);
});

test('Vue mustache extraction and rewriting do not change comparison operands', () => {
  const input = `<template><p>{{ status === prefix + 'Pending' ? 'Pending' : 'Completed' }}</p></template>`;
  const pairs = [['text','Pending','Commons.text.pending'], ['text','Completed','Commons.text.completed']];
  const output = vueReplaced(input, pairs).content;
  assert.match(output, /prefix \+ 'Pending'/);
  assert.match(output, /\? \$t\("Commons.text.pending"\)/);
  assert.equal((output.match(/Commons.text.pending/g) || []).length, 1);
});

test('Vue replacement leaves comments and nested code examples intact', () => {
  const input = `<template><!-- <p>Save the file</p> --><pre><span>Save the file</span></pre><p>Save the file</p></template>`;
  const result = vueReplaced(input, [['text', 'Save the file', 'Pages.Form.text.save']]).content;
  assert.match(result, /<!-- <p>Save the file<\/p> -->/);
  assert.match(result, /<pre><span>Save the file<\/span><\/pre>/);
  assert.match(result, /<p>\{\{ \$t\('Pages.Form.text.save'\) \}\}<\/p>/);
});

test('Vue replacement does not treat attribute-like text as a tag attribute', () => {
  const input = `<template><p>See title="Save the file" in the instructions</p><span title="Save the file">Help</span></template>`;
  const result = vueReplaced(input, [['title', 'Save the file', 'Pages.Form.title.save']]).content;
  assert.match(result, /See title="Save the file" in the instructions/);
  assert.match(result, /<span :title="\$t\('Pages.Form.title.save'\)">/);
});

test('Vue replacement does not emit invalid parameters for mixed interpolation', () => {
  const input = `<template><p>Welcome {{ user.name }}</p></template>`;
  const result = vueReplaced(input, [['text', 'Welcome {{ user.name }}', 'Pages.Form.text.welcome']]);
  assert.equal(result.content, input);
});

test('Vue replacement respects > characters in quoted attributes', () => {
  const input = `<template><p title="Score > Save the file">Save the file</p></template>`;
  const result = vueReplaced(input, [['text', 'Save the file', 'Pages.Form.text.save']]).content;
  assert.match(result, /title="Score > Save the file"/);
  assert.match(result, /">\{\{ \$t\('Pages.Form.text.save'\) \}\}<\/p>/);
});

test('Vue template replacement safely quotes translation keys in attributes', () => {
  const key = `Pages.Form.text.s'ave"quoted`;
  const input = `<template><p title="Save the file">Help</p></template>`;
  const output = vueReplaced(input, [['title', 'Save the file', key]]).content;
  const expression = output.match(/:title="([^"]+)"/)[1];
  const ast = require('@babel/parser').parseExpression(expression, {plugins:['estree']});
  assert.equal(ast.arguments[0].value, key);
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

test('Blade extraction ignores nested content in protected blocks and HTML comments', () => {
  const source = `<pre><span>Example command text</span></pre><!-- <p>Hidden comment text</p> --><p>Visible message</p>`;
  const texts = new Set(new BladeParser().parse(source).items.map(i => i.text));
  assert(!texts.has('Example command text'));
  assert(!texts.has('Hidden comment text'));
  assert(texts.has('Visible message'));
});

test('Blade command filtering applies outside pre and preserves ordinary instructions', () => {
  const source = `<p>docker compose up -d</p><p>npm install package</p><p>APP_DEBUG=true</p><p>Run npm install to continue.</p><p>Install the package now.</p>`;
  const texts = new Set(new BladeParser().parse(source).items.map(i=>i.text));
  for (const command of ['docker compose up -d','npm install package','APP_DEBUG=true']) assert(!texts.has(command));
  assert(texts.has('Run npm install to continue.'));
  assert(texts.has('Install the package now.'));
});

test('Blade rewrite preserves command-shaped text even if a locale key already exists', () => {
  const dir=fixture();
  try {
    const locales=path.join(dir,'resources','js','i18n','auto');
    fs.writeFileSync(path.join(locales,'en.json'), JSON.stringify({Reports:{Pallet:{text:{command:'docker compose up -d', instruction:'Run npm install to continue.'}}}}));
    const view=path.join(dir,'resources','views','reports','pallet.blade.php');
    fs.writeFileSync(view,'<p>docker compose up -d</p><p>Run npm install to continue.</p>');
    runCoreScript(dir,'rewrite-i18n-blade.js');
    const out=fs.readFileSync(view,'utf8');
    assert.match(out, /<p>docker compose up -d<\/p>/);
    assert.match(out, /Reports.Pallet.text.instruction/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('Blade rewrite honors configured source locale and locale directory', () => {
  const dir = fixture();
  try {
    const localeDir = path.join(dir, 'translations');
    fs.mkdirSync(localeDir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({aiI18n:{srcRoot:'resources/js',localesDir:'translations',sourceLocale:'pt',locales:['pt','en']}}));
    fs.writeFileSync(path.join(localeDir, 'pt.json'), JSON.stringify({Commons:{text:{report:'Relatório geral'}}}));
    const view = path.join(dir,'resources','views','reports','pallet.blade.php');
    fs.writeFileSync(view, '<title>Relatório geral</title>');
    runCoreScript(dir,'rewrite-i18n-blade.js');
    assert.match(fs.readFileSync(view,'utf8'), /Commons.text.report/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
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

test('cleanup refuses deletion when translation keys are computed dynamically', () => {
  const dir = fixture();
  try {
    const locales = path.join(dir, 'resources', 'js', 'i18n', 'auto');
    const data = { Messages: { text: { pending: 'Pending', unused: 'Unused' } } };
    fs.writeFileSync(path.join(locales, 'en.json'), JSON.stringify(data));
    fs.writeFileSync(path.join(dir, 'resources', 'js', 'app.js'), "const msg = t('Messages.text.' + status);");
    const run = spawnSync(process.execPath, [path.join(__dirname,'..','packages','core','src','i18n','cleanup-i18n-unused.js'), '--apply'], {
      env:{...process.env, AI_I18N_PROJECT_ROOT:dir},encoding:'utf8'
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /dynamic translation calls/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(locales,'en.json'),'utf8')),data);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('cleanup preserves children of referenced structured translation keys', () => {
  const dir = fixture();
  try {
    const locales = path.join(dir, 'resources', 'js', 'i18n', 'auto');
    const data = { menu: { first: 'First item', second: 'Second item' }, unused: 'Unused text' };
    fs.writeFileSync(path.join(locales,'en.json'), JSON.stringify(data));
    fs.writeFileSync(path.join(dir,'resources','js','app.js'), "const menu = t('menu', {returnObjects: true});");
    runCoreScript(dir,'cleanup-i18n-unused.js',['--apply']);
    const after = JSON.parse(fs.readFileSync(path.join(locales,'en.json'),'utf8'));
    assert.deepEqual(after.menu, data.menu);
    assert.equal(after.unused, undefined);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('extract and replace work together on Vue slots and both script blocks', () => {
  const dir = fixture();
  try {
    const sourceDir = path.join(dir, 'resources', 'js', 'Pages');
    fs.mkdirSync(sourceDir, {recursive:true});
    const file = path.join(sourceDir, 'Form.vue');
    fs.writeFileSync(file, `<template><section><template #heading><h1>Order overview</h1></template><template #actions><button>{{ pending ? 'Required' : 'None' }}</button></template></section></template>\n<script setup>\nconst { t } = useI18n();\nconst titleMessage = 'Submit your request';\n</script>\n<script>\nexport default { data(){return {description:'Cannot perform this operation'}} };\n</script>`);
    runCoreScript(dir, 'extract-i18n.js');
    runCoreScript(dir, 'replace-i18n.js');
    const result = fs.readFileSync(file, 'utf8');
    assert.match(result, /\$t\([^)]*order_overview/);
    assert.match(result, /\$t\([^)]*required/);
    assert.match(result, /\$t\([^)]*none/);
    assert.match(result, /titleMessage = t\(/);
    assert.match(result, /description:this\.\$t\(/);
    const first = result;
    runCoreScript(dir, 'replace-i18n.js');
    assert.equal(fs.readFileSync(file, 'utf8'), first);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
