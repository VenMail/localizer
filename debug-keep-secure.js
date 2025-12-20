const { VueParser } = require('./src/i18n/lib/parsers/vueParser');
const fs = require('fs');

const content = fs.readFileSync('./IntegrationDialog.vue', 'utf8');
const parser = new VueParser();
const results = parser.parse(content);

console.log('=== EXTRACTION RESULTS ===');
console.log(`Total extracted: ${results.stats.extracted}`);

// Look for the specific string
const targetString = 'Keep this key secure. Anyone with this key can submit data to your {{ type }}.';
console.log(`\nLooking for: "${targetString}"`);

const found = results.items.some(item => item.text === targetString);
console.log(`Found in extraction: ${found}`);

if (!found) {
  console.log('\n=== DEBUGGING MISSING STRING ===');
  
  // Check if it exists in the template
  const templateMatch = content.match(/(<template[^>]*>)([\s\S]*?)(<\/template>)/i);
  if (templateMatch) {
    const templateContent = templateMatch[2];
    const existsInTemplate = templateContent.includes(targetString);
    console.log(`Exists in template: ${existsInTemplate}`);
    
    if (existsInTemplate) {
      // Find the exact context
      const lines = templateContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(targetString)) {
          console.log(`\nFound at line ${i + 1}:`);
          console.log(`Line: ${lines[i]}`);
          
          // Show surrounding context
          console.log('\nContext:');
          for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
            const marker = j === i ? '>>> ' : '    ';
            console.log(`${marker}${j + 1}: ${lines[j]}`);
          }
          break;
        }
      }
      
      // Test validation on this specific string
      const { validateText } = require('./src/i18n/lib/validators');
      const detailedResult = validateText(targetString);
      console.log(`\nValidation result:`, detailedResult);
    }
  }
} else {
  console.log('\n=== FOUND IN EXTRACTION ===');
  const extractedItem = results.items.find(item => item.text === targetString);
  console.log(`Item: [Type: ${extractedItem.type}] [Kind: ${extractedItem.kind}] ${extractedItem.text}`);
}
