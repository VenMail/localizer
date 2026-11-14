'use strict';

// Only rewrite positions whose lexical context we understand. In particular,
// Vue's instance translator is available inside Options API methods, not at
// module scope or in an arrow function used as an option.
function rewriteVueScript(source, replacer, keyMap, namespace, canTranslate) {
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
  const importedT = program.body.some(stmt => stmt.type === 'ImportDeclaration' && stmt.specifiers.some(s => s.local?.name === 't'));
  let bindingReady = importedT;
  for (const stmt of program.body) {
    // For const/let bindings, do not insert a call before initialization.
    if (bindingReady && stmt.type !== 'BlockStatement') visit(stmt, 't');
    if (stmt.type === 'VariableDeclaration' && stmt.declarations.some(d =>
      d.id?.type === 'ObjectPattern' && d.id.properties.some(p => p.key?.name === 't' && p.value?.name === 't') &&
      d.init?.type === 'CallExpression' && d.init.callee?.name === 'useI18n')) bindingReady = true;
  }

  // Options API methods and data receive the component instance as this.
  let options = program.body.find(stmt => stmt.type === 'ExportDefaultDeclaration')?.declaration;
  if (options?.type === 'CallExpression' && options.callee?.name === 'defineComponent') options = options.arguments[0];
  if (options?.type === 'ObjectExpression') {
    for (const prop of options.properties) {
      const name = prop.key?.name || prop.key?.value;
      if (name === 'data' && prop.value?.type === 'FunctionExpression') visit(prop.value.body, 'this.$t', true);
      if (['methods', 'computed', 'watch'].includes(name) && prop.value?.type === 'ObjectExpression') {
        for (const method of prop.value.properties) {
          if (method.value?.type === 'FunctionExpression') visit(method.value.body, 'this.$t', true, varNames.test(method.key?.name || method.key?.value || ''));
        }
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let content = source;
  for (const edit of edits) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  return { content, changeCount: edits.length };
}

module.exports = { rewriteVueScript };
