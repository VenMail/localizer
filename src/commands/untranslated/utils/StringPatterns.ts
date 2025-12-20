/**
 * Shared regex patterns for string detection across different frameworks
 * Eliminates duplication between selection commands and parsers
 */

export const STRING_PATTERNS = {
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

/**
 * Framework-specific text preprocessing
 */
export const FRAMEWORK_PREPROCESSORS = {
    vue: (text: string) => {
        // Wrap in template tags if needed for Vue parser
        if (!text.includes('<template>') && !text.includes('<script>') && !text.includes('<style>')) {
            return `<template>${text}</template>`;
        }
        return text;
    },
    jsx: (text: string) => text, // No preprocessing needed
    blade: (text: string) => text, // No preprocessing needed
    generic: (text: string) => text
};

/**
 * Check if text looks like code (should be avoided for full selection)
 */
export const CODE_PATTERNS = [
    /[:;{}<>]|=>|\bfunction\b|\breturn\b/,
    /^\s*import\s/,
    /^\s*export\s/,
    /^\s*const\s/,
    /^\s*let\s/,
    /^\s*var\s/
];

/**
 * Punctuation-only patterns to skip
 */
export const PUNCTUATION_ONLY = /^[.,;:!?'"()[\]{}<>/\\|@#$%^&*+=~`-]+$/;
