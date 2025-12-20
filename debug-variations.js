const { VueParser } = require('./src/i18n/lib/parsers/vueParser');
const fs = require('fs');

const content = fs.readFileSync('./IntegrationDialog.vue', 'utf8');
const parser = new VueParser();
const results = parser.parse(content);

console.log('=== CHECKING FOR VARIATIONS ===');

// Test various possible variations that might be missed
const variations = [
  'Keep this secure. Anyone',
  'Keep this key secure. Anyone',
  'Keep this key secure',
  'Anyone with this key',
  'Anyone with this key can submit',
  'can submit data to your {{ type }}',
  'submit data to your {{ type }}'
];

variations.forEach((variation, index) => {
  const found = results.items.some(item => item.text && item.text.includes(variation));
  console.log(`${index + 1}. "${variation}" - Found: ${found}`);
  
  if (found) {
    const matchingItems = results.items.filter(item => item.text && item.text.includes(variation));
    matchingItems.forEach(item => {
      console.log(`   -> ${item.text}`);
    });
  }
});

// Also check the template directly for any strings that might contain "secure" but weren't extracted
console.log('\n=== TEMPLATE ANALYSIS FOR POTENTIAL MISSED STRINGS ===');
const templateMatch = content.match(/(<template[^>]*>)([\s\S]*?)(<\/template>)/i);
if (templateMatch) {
  const templateContent = templateMatch[2];
  
  // Look for text nodes that contain "secure" but might not be extracted
  const secureMatches = templateContent.match(/[^>]*secure[^<]*/gi);
  if (secureMatches) {
    secureMatches.forEach((match, index) => {
      console.log(`${index + 1}. Template match: ${match.trim()}`);
      
      // Check if this was extracted
      const extracted = results.items.some(item => item.text && match.includes(item.text));
      console.log(`   Extracted: ${extracted}`);
    });
  }
}
