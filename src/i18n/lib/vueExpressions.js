'use strict';

// Only literals in display-result positions are safe to translate. Literals
// in conditions, function calls, and property lookups may be stored IDs.
function displayLiterals(expression) {
  let ast;
  try {
    ast = require('@babel/parser').parseExpression(expression, { plugins: ['typescript', 'estree'] });
  } catch { return []; }
  const result = [];
  function visit(node) {
    if (!node) return;
    if (node.type === 'Literal' && typeof node.value === 'string') result.push(node);
    else if (node.type === 'ConditionalExpression') { visit(node.consequent); visit(node.alternate); }
    else if (node.type === 'LogicalExpression' && (node.operator === '||' || node.operator === '??')) visit(node.right);
    else if (node.type === 'ParenthesizedExpression') visit(node.expression);
  }
  visit(ast);
  return result;
}
module.exports = { displayLiterals };
