const { VueParser } = require('./src/i18n/lib/parsers/vueParser');
const fs = require('fs');

const content = fs.readFileSync('./IntegrationDialog.vue', 'utf8');
const parser = new VueParser();
const results = parser.parse(content);

console.log('=== ALL EXTRACTED ITEMS ===');
results.items.forEach((item, index) => {
  console.log(`${index + 1}. [Type: ${item.type}] [Kind: ${item.kind}] ${item.text}`);
});

// Look for all strings containing "secure"
console.log('\n=== STRINGS CONTAINING "secure" ===');
const secureStrings = results.items.filter(item => 
  item.text && item.text.toLowerCase().includes('secure')
);

if (secureStrings.length > 0) {
  secureStrings.forEach((item, index) => {
    console.log(`${index + 1}. ${item.text}`);
  });
} else {
  console.log('No strings containing "secure" found in extraction!');
}

// Check the template directly for all "secure" strings
console.log('\n=== ALL "secure" STRINGS IN TEMPLATE ===');
const templateMatch = content.match(/(<template[^>]*>)([\s\S]*?)(<\/template>)/i);
if (templateMatch) {
  const templateContent = templateMatch[2];
  const lines = templateContent.split('\n');
  
  lines.forEach((line, index) => {
    if (line.toLowerCase().includes('secure')) {
      console.log(`Line ${index + 1}: ${line.trim()}`);
    }
  });
}
