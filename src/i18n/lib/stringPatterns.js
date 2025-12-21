/**
 * Shared regex patterns for string detection across different frameworks
 * JavaScript version for extraction scripts
 */

const STRING_PATTERNS = {
    // JSX expression strings: {'text'} or {"text"}
    jsxExpr: /\{\s*(['"])((?:\\.|(?!\1)[\s\S])+?)\1\s*\}/g,
    
    // Object property values: "description: `some text`" or "title: 'some text'"
    property: /^\s*(?:[\w$]+|['"][^'"]+['"])\s*:\s*(['"`])([\s\S]+?)\1\s*,?\s*$/s,
    
    // Generic string literals (single and double quotes)
    generic: /(['"])((?:\\.|(?!\1)[\s\S])+?)\1/g,
    
    // Template literals (backticks)
    template: /`([^`]+)`/g,
    
    // Blade array items: 'key' => 'value'
    bladeArray: /^\s*(['"])([^'"]+)\1\s*=>\s*(['"])([\s\S]+?)\3\s*,?\s*$/s,
    
    // Alpine.js x-text string literals
    alpineText: /(['"`])([^'"`\\]*(?:\\.[^'"`\\]*)*)\1/g,
    
    // Alpine.js ternary expressions
    alpineTernary: /\?\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1\s*:\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\3/g,
    
    // Blade expressions for placeholder replacement
    bladeExpr: [
        /\{\{\s*[^}]+\s*\}\}/g,
        /\{!!\s*[^}]+\s*!!\}/g
    ],
    
    // Template literal interpolations
    interpolation: /\$\{([^}]*)\}/g,
    
    // Module import/export patterns (to skip)
    moduleSpec: [
        /^\s*import\s+[\s\S]*?from\s*['"][^'"]+['"]/,
        /^\s*import\s*\(\s*['"][^'"]+['"]\s*\)/,
        /^\s*export\s+[\s\S]*?from\s*['"][^'"]+['"]/,
        /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/
    ],
    
    // I18n patterns (to skip)
    i18nPatterns: [
        /\$?t\s*\(\s*['"][^'"]+['"]\s*\)/,
        /i18n\.t\s*\(\s*['"][^'"]+['"]\s*\)/,
        /useI18n\(\)\.t\s*\(\s*['"][^'"]+['"]\s*\)/
    ]
};

module.exports = { STRING_PATTERNS };
