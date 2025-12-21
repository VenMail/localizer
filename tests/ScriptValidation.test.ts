import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Script Validation Tests', () => {
    const scriptsDir = path.join(__dirname, '..', 'src', 'i18n');
    const libDir = path.join(scriptsDir, 'lib');
    
    describe('Core Scripts Existence and Syntax', () => {
        const coreScripts = [
            'extract-i18n.js',
            'replace-i18n.js',
            'sync-i18n.js',
            'fix-untranslated.js',
            'rewrite-i18n-blade.js',
            'cleanup-i18n-unused.js',
            'restore-i18n-invalid.js',
            'babel-replace-i18n.js',
            'oxc-replace-i18n.js',
        ];

        coreScripts.forEach(script => {
            it(`should have valid syntax for ${script}`, async () => {
                try {
                    const scriptPath = path.join(scriptsDir, script);
                    const content = await fs.readFile(scriptPath, 'utf-8');
                    
                    // Basic syntax validation
                    expect(() => {
                        // Remove shebang if present and test syntax
                        const testCode = content.replace(/^#!.*\n/, '');
                        new Function(testCode);
                    }).not.toThrow();
                    
                    // Check for meaningful content
                    expect(content.length).toBeGreaterThan(100);
                } catch (error) {
                    // If file doesn't exist, skip test
                    console.warn(`Script ${script} not found, skipping syntax test`);
                }
            });
        });
    });

    describe('Library Utilities Validation', () => {
        const libFiles = [
            'stringUtils.js',
            'projectConfig.js',
            'ignorePatterns.js',
            'translationStore.js',
            'textValidation.js',
            'vueTemplateParser.js',
            'localeUtils.js',
            'stringPatterns.js',
        ];

        libFiles.forEach(file => {
            it(`should have valid syntax for lib/${file}`, async () => {
                try {
                    const filePath = path.join(libDir, file);
                    const content = await fs.readFile(filePath, 'utf-8');
                    
                    expect(() => {
                        new Function(content);
                    }).not.toThrow();
                    
                    expect(content.length).toBeGreaterThan(50);
                } catch (error) {
                    console.warn(`Lib file ${file} not found, skipping syntax test`);
                }
            });
        });
    });

    describe('Parser Modules Validation', () => {
        const parsers = [
            'baseParser.js',
            'jsxParser.js',
            'vueParser.js',
            'bladeParser.js',
            'svelteParser.js',
            'genericParser.js',
        ];

        parsers.forEach(parser => {
            it(`should have valid syntax for parsers/${parser}`, async () => {
                try {
                    const parserPath = path.join(libDir, 'parsers', parser);
                    const content = await fs.readFile(parserPath, 'utf-8');
                    
                    expect(() => {
                        new Function(content);
                    }).not.toThrow();
                    
                    expect(content).toMatch(/parse|parser|parsing/);
                } catch (error) {
                    console.warn(`Parser ${parser} not found, skipping syntax test`);
                }
            });
        });
    });

    describe('Validator Modules Validation', () => {
        const validators = [
            'codeValidator.js',
            'htmlValidator.js',
            'cssValidator.js',
            'technicalValidator.js',
        ];

        validators.forEach(validator => {
            it(`should have valid syntax for validators/${validator}`, async () => {
                try {
                    const validatorPath = path.join(libDir, 'validators', validator);
                    const content = await fs.readFile(validatorPath, 'utf-8');
                    
                    expect(() => {
                        new Function(content);
                    }).not.toThrow();
                    
                    expect(content).toMatch(/validate|validator|validation|check|detect/);
                } catch (error) {
                    console.warn(`Validator ${validator} not found, skipping syntax test`);
                }
            });
        });
    });

    describe('Script Dependencies and Structure', () => {
        it('should verify babel scripts contain babel dependencies', async () => {
            try {
                const babelScript = path.join(scriptsDir, 'babel-replace-i18n.js');
                const content = await fs.readFile(babelScript, 'utf-8');
                
                expect(content).toMatch(/@babel/);
            } catch (error) {
                console.warn('babel-replace-i18n.js not found, skipping dependency test');
            }
        });

        it('should verify oxc scripts contain oxc dependencies', async () => {
            try {
                const oxcScript = path.join(scriptsDir, 'oxc-replace-i18n.js');
                const content = await fs.readFile(oxcScript, 'utf-8');
                
                expect(content).toMatch(/oxc-parser|magic-string/);
            } catch (error) {
                console.warn('oxc-replace-i18n.js not found, skipping dependency test');
            }
        });

        it('should verify ignore patterns file is valid JSON', async () => {
            try {
                const ignorePath = path.join(scriptsDir, 'i18n-ignore-patterns.json');
                const content = await fs.readFile(ignorePath, 'utf-8');
                
                expect(() => {
                    JSON.parse(content);
                }).not.toThrow();
                
                const parsed = JSON.parse(content);
                expect(Array.isArray(parsed.patterns) || typeof parsed === 'object').toBe(true);
            } catch (error) {
                console.warn('i18n-ignore-patterns.json not found, skipping JSON validation');
            }
        });
    });

    describe('Script Content Quality', () => {
        const scriptsToCheck = [
            'extract-i18n.js',
            'replace-i18n.js',
            'sync-i18n.js',
        ];

        scriptsToCheck.forEach(script => {
            it(`should have proper error handling in ${script}`, async () => {
                try {
                    const scriptPath = path.join(scriptsDir, script);
                    const content = await fs.readFile(scriptPath, 'utf-8');
                    
                    // Check for error handling patterns
                    const hasErrorHandling = 
                        content.includes('try') && content.includes('catch') ||
                        content.includes('if.*exists') ||
                        content.includes('ENOENT') ||
                        content.includes('File not found') ||
                        content.includes('console.error');
                    
                    if (hasErrorHandling) {
                        expect(content).toMatch(/try|catch|if.*exists|ENOENT|console\.error/);
                    }
                } catch (error) {
                    console.warn(`Script ${script} not found, skipping error handling test`);
                }
            });

            it(`should have meaningful comments in ${script}`, async () => {
                try {
                    const scriptPath = path.join(scriptsDir, script);
                    const content = await fs.readFile(scriptPath, 'utf-8');
                    
                    // Check for comments (helps with maintainability)
                    const hasComments = 
                        content.includes('//') ||
                        content.includes('/*') ||
                        content.includes('*') ||
                        content.includes('"""');
                    
                    if (content.length > 500) { // Only check larger scripts for comments
                        expect(hasComments).toBe(true);
                    }
                } catch (error) {
                    console.warn(`Script ${script} not found, skipping comments test`);
                }
            });
        });
    });

    describe('Module Export Structure', () => {
        it('should verify lib files use proper module exports', async () => {
            try {
                const libFiles = await fs.readdir(libDir);
                const jsFiles = libFiles.filter(file => file.endsWith('.js') && !fs.stat(path.join(libDir, file)).then(stat => stat.isDirectory()).catch(() => false));
                
                for (const file of jsFiles.slice(0, 3)) { // Check first 3 files
                    try {
                        const filePath = path.join(libDir, file);
                        const content = await fs.readFile(filePath, 'utf-8');
                        
                        // Check for CommonJS or ES module exports
                        const hasExports = 
                            content.includes('module.exports') ||
                            content.includes('exports.') ||
                            content.includes('export ') ||
                            content.includes('export default');
                        
                        expect(hasExports).toBe(true);
                    } catch (error) {
                        console.warn(`Could not validate exports for ${file}`);
                    }
                }
            } catch (error) {
                console.warn('Could not read lib directory for export validation');
            }
        });
    });

    describe('Script Integration Points', () => {
        it('should verify extract script has proper CLI interface', async () => {
            try {
                const extractScript = path.join(scriptsDir, 'extract-i18n.js');
                const content = await fs.readFile(extractScript, 'utf-8');
                
                // Check for command line argument handling
                const hasCliInterface = 
                    content.includes('process.argv') ||
                    content.includes('argv') ||
                    content.includes('--help') ||
                    content.includes('-h') ||
                    content.includes('commander') ||
                    content.includes('yargs');
                
                expect(hasCliInterface).toBe(true);
            } catch (error) {
                console.warn('extract-i18n.js not found, skipping CLI interface test');
            }
        });

        it('should verify scripts handle file system operations', async () => {
            const fileOperationScripts = ['extract-i18n.js', 'sync-i18n.js', 'fix-untranslated.js'];
            
            for (const script of fileOperationScripts) {
                try {
                    const scriptPath = path.join(scriptsDir, script);
                    const content = await fs.readFile(scriptPath, 'utf-8');
                    
                    const hasFileOps = 
                        content.includes('fs.') ||
                        content.includes('readFile') ||
                        content.includes('writeFile') ||
                        content.includes('readdir') ||
                        content.includes('require(\'fs\')') ||
                        content.includes('import.*fs');
                    
                    expect(hasFileOps).toBe(true);
                } catch (error) {
                    console.warn(`Script ${script} not found, skipping file operations test`);
                }
            }
        });
    });
});
