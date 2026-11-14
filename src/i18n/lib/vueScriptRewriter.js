'use strict';

// Only rewrite positions whose lexical context we understand. In particular,
// Vue's instance translator is available inside Options API methods, not at
// module scope or in an arrow function used as an option.
function rewriteVueScript(source, replacer, keyMap, namespace, canTranslate, options = {}) {
  let parser;
  try { parser = require('@babel/parser'); } catch {
    console.warn('[i18n-replace] Vue script rewriting requires @babel/parser; script left unchanged.');
    return { content: source, changeCount: 0 };
  }
  let program;
  try { program = parser.parse(source, { sourceType: 'module', plugins: ['typescript', 'estree'] }).program; }
  catch { return { content: source, changeCount: 0 }; }
  const edits = [];
  const propNames = /^(title|description|message|label|placeholder|cta|text|error|heading|alt|reason)$/i;
  const varNames = /(?:title|label|message|placeholder|text|heading|description|error|reason)/i;

  function add(literal, kind, callee) {
    if (!literal || literal.type !== 'Literal' || typeof literal.value !== 'string') return;
    const value = literal.value;
    if (!canTranslate(value)) return;
    const key = replacer.lookupKey(keyMap, namespace, kind, value);
    if (key) edits.push({ start: literal.start, end: literal.end, text: `${callee}(${JSON.stringify(key)})` });
  }

  function visit(node, callee, root = false, allowReturn = false) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child, callee, false, allowReturn); return; }
    // A nested ordinary function has its own this, and any nested function can
    // shadow a module's t binding. Be conservative until scope is established.
    if (!root && /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) return;
    if (node.type === 'Property' && !node.computed && node.key?.type === 'Identifier' && propNames.test(node.key.name)) {
      add(node.value, replacer.inferKindFromProp(node.key.name), callee);
    } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && varNames.test(node.id.name)) {
      add(node.init, replacer.inferKindFromVarName(node.id.name), callee);
    } else if (allowReturn && node.type === 'ReturnStatement') {
      add(node.argument, 'text', callee);
    } else if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression' && !node.left.computed && varNames.test(node.left.property?.name || '')) {
      add(node.right, 'text', callee);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'parent' && value && typeof value === 'object') visit(value, callee, false, allowReturn);
    }
  }

  // A top-level imported t or a top-level useI18n binding is visible in the
  // top-level module statements; never infer one from comments or nested scope.
  const importedT = program.body.some(stmt => stmt.type === 'ImportDeclaration' && stmt.importKind !== 'type' &&
    stmt.specifiers.some(s => s.local?.name === 't' && s.importKind !== 'type'));
  const usedNames = new Set();
  (function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node.type === 'Identifier') usedNames.add(node.name);
    for (const value of Object.values(node)) if (value && typeof value === 'object') collect(value);
  })(program);
  const unique = base => { let name = base; let n = 2; while (usedNames.has(name)) name = `${base}${n++}`; usedNames.add(name); return name; };
  const hookNames = new Set(['useI18n']);
  for (const stmt of program.body) if (stmt.type === 'ImportDeclaration' && stmt.source?.value === 'vue-i18n' && stmt.importKind !== 'type') {
    for (const spec of stmt.specifiers) if (spec.type === 'ImportSpecifier' && spec.imported?.name === 'useI18n' && spec.importKind !== 'type') hookNames.add(spec.local.name);
  }
  const hasComposer = program.body.some(stmt => stmt.type === 'VariableDeclaration' && stmt.declarations.some(d =>
    d.init?.type === 'CallExpression' && hookNames.has(d.init.callee?.name)));
  let binding = importedT ? 't' : null;
  let deferredInjection = null;
  if (!binding && !hasComposer && options.setup && options.vueSetupTranslation === 'vue-i18n-composition') {
    const hook = unique('__localizerUseI18n');
    const name = unique('__localizerT');
    deferredInjection = `\nimport { useI18n as ${hook} } from 'vue-i18n';\nconst { t: ${name} } = ${hook}();\n`;
    binding = name;
  }
  let augmentation = null;
  for (const stmt of program.body) {
    // For const/let bindings, do not insert a call before initialization.
    if (binding && stmt.type !== 'BlockStatement') visit(stmt, binding);
    if (!options.setup || stmt.type !== 'VariableDeclaration' || binding && !deferredInjection) continue;
    for (const d of stmt.declarations) {
      if (d.init?.type !== 'CallExpression' || !hookNames.has(d.init.callee?.name)) continue;
      if (d.id?.type === 'Identifier') { binding = `${d.id.name}.t`; deferredInjection = null; break; }
      if (d.id?.type !== 'ObjectPattern') continue;
      const t = d.id.properties.find(p => !p.computed && p.key?.name === 't' &&
        (p.value?.type === 'Identifier' || (p.value?.type === 'AssignmentPattern' && p.value.left?.type === 'Identifier')));
      if (t) binding = t.value.type === 'Identifier' ? t.value.name : t.value.left.name;
      else {
        const name = unique('__localizerT');
        const rest = d.id.properties.find(p => p.type === 'RestElement');
        const insertion = rest ? rest.start : d.id.end - 1;
        const gap = d.id.properties.length ? source.slice(d.id.properties[d.id.properties.length - 1].end, insertion).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '') : '';
        const hasTrailingComma = /,\s*$/.test(gap);
        augmentation = { start: insertion, end: insertion, text: rest ? `t: ${name}, ` : `${d.id.properties.length && !hasTrailingComma ? ', ' : ' '}t: ${name}` };
        binding = name;
      }
      deferredInjection = null;
      break;
    }
  }

  let skippedUnbound = 0;
  if (options.setup && !binding) {
    const before = edits.length;
    for (const stmt of program.body) if (stmt.type !== 'BlockStatement') visit(stmt, '__localizerUnbound');
    skippedUnbound = edits.length - before;
    edits.length = before;
  }

  // Options API methods and data receive the component instance as this.
  let componentOptions = program.body.find(stmt => stmt.type === 'ExportDefaultDeclaration')?.declaration;
  if (componentOptions?.type === 'CallExpression' && componentOptions.callee?.name === 'defineComponent') componentOptions = componentOptions.arguments[0];
  if (componentOptions?.type === 'ObjectExpression') {
    for (const prop of componentOptions.properties) {
      const name = prop.key?.name || prop.key?.value;
      if (name === 'data' && prop.value?.type === 'FunctionExpression') visit(prop.value.body, 'this.$t', true);
      if (['methods', 'computed', 'watch'].includes(name) && prop.value?.type === 'ObjectExpression') {
        for (const method of prop.value.properties) {
          if (method.value?.type === 'FunctionExpression') visit(method.value.body, 'this.$t', true, varNames.test(method.key?.name || method.key?.value || ''));
        }
      }
    }
  }
  if (edits.length && augmentation) edits.push(augmentation);
  if (edits.length && deferredInjection) edits.push({ start: 0, end: 0, text: deferredInjection });
  edits.sort((a, b) => b.start - a.start);
  let content = source;
  for (const edit of edits) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  return { content, changeCount: edits.filter(edit => edit.start !== edit.end).length, skippedUnbound };
}

module.exports = { rewriteVueScript };
