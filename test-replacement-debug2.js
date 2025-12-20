const { VueReplacer } = require('./src/i18n/lib/replacers/vueReplacer');

// Create proper Map format for keyMap
const keyMap = new Map([
  ['test|text|Allow external applications to submit data to this {{ type }}', 'api.allow_external_apps'],
]);

const replacer = new VueReplacer();

// Test with exact text as it appears in the template
const templateWithSpaces = `>Allow external applications to submit data to this {{ type }}<`;
console.log('Testing with template text including > and <:');
console.log('Input:', JSON.stringify(templateWithSpaces));

// Test the regex pattern directly
const textBetweenTagsRegex = /(>)([^<>\n]+)(<)/g;
const match = textBetweenTagsRegex.exec(templateWithSpaces);
console.log('Regex match:', match);

if (match) {
  const [fullMatch, open, text, close] = match;
  console.log('Extracted text:', JSON.stringify(text));
  console.log('Trimmed text:', JSON.stringify(text.trim()));
  
  // Test lookup
  const lookupResult = replacer.lookupKey(keyMap, 'test', 'text', text.trim());
  console.log('Lookup result:', lookupResult);
}

// Test the canTranslate function
const { shouldTranslate } = require('./src/i18n/lib/validators');
const canTranslate = shouldTranslate(match[2].trim(), {});
console.log('Can translate:', canTranslate);
