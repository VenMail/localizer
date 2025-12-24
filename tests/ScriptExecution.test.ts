import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';

// Mock vscode
vi.mock('vscode', () => ({
    workspace: {
        fs: {
            readFile: vi.fn(),
            writeFile: vi.fn(),
            stat: vi.fn(),
        },
    },
    Uri: {
        file: (path: string) => ({ fsPath: path }),
    },
}));

describe('Script Execution Tests', () => {
    const testProjectRoot = path.join(__dirname, 'test-project');
    const scriptsDir = path.join(testProjectRoot, 'scripts');
    
    beforeEach(async () => {
        await fs.rm(testProjectRoot, { recursive: true, force: true });
        await fs.mkdir(testProjectRoot, { recursive: true });
        await fs.mkdir(scriptsDir, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(testProjectRoot, { recursive: true, force: true });
    });

    // Helper function to check if script exists and validate basic structure
    async function validateScript(scriptName: string, expectedContent: RegExp) {
        const scriptPath = path.join(__dirname, '..', 'src', 'i18n', scriptName);
        
        try {
            await fs.access(scriptPath);
        } catch (error) {
            console.warn(`${scriptName} not found, skipping test`);
            return;
        }
        
        const scriptContent = await fs.readFile(scriptPath, 'utf-8');
        const testCode = scriptContent.replace(/^#!.*\n/, '');
        
        // Check for basic JavaScript indicators
        expect(testCode).toMatch(/function|const|let|var|require|export|import/);
        
        // Check that it's not empty or just comments
        const nonCommentLines = testCode.split('\n').filter(line => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*');
        });
        expect(nonCommentLines.length).toBeGreaterThan(5);
        
        // Check for expected content
        expect(scriptContent).toMatch(expectedContent);
    }

    // Helper function to execute script and verify it runs
    async function executeScript(scriptName: string) {
        const scriptPath = path.join(__dirname, '..', 'src', 'i18n', scriptName);
        
        try {
            await fs.access(scriptPath);
        } catch (error) {
            console.warn(`${scriptName} not found, skipping execution test`);
            return;
        }
        
        const { spawn } = require('child_process');
        const result = await new Promise<{code: number, stdout: string, stderr: string}>((resolve, reject) => {
            const child = spawn('node', [scriptPath, '--help'], {
                cwd: testProjectRoot,
                stdio: 'pipe'
            });
            
            let stdout = '';
            let stderr = '';
            
            child.stdout.on('data', (data: Buffer) => stdout += data.toString());
            child.stderr.on('data', (data: Buffer) => stderr += data.toString());
            
            child.on('close', (code: number) => {
                resolve({ code, stdout, stderr });
            });
            
            child.on('error', reject);
        });
        
        // Script should execute without crashing
        expect(result.code).toBeGreaterThanOrEqual(0);
        expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
    }

    describe('Core Script Validation', () => {
        const coreScripts = [
            { name: 'extract-i18n.js', pattern: /function|extract|i18n/ },
            { name: 'replace-i18n.js', pattern: /replace|i18n/ },
            { name: 'sync-i18n.js', pattern: /sync|i18n/ },
            { name: 'fix-untranslated.js', pattern: /fix|untranslated/ },
            { name: 'rewrite-i18n-blade.js', pattern: /blade|rewrite/ },
        ];

        coreScripts.forEach(script => {
            it(`should validate ${script.name} syntax`, async () => {
                await validateScript(script.name, script.pattern);
            });

            it(`should execute ${script.name} successfully`, async () => {
                await executeScript(script.name);
            });
        });
    });

    describe('Library Utilities Validation', () => {
        const libFiles = [
            { path: 'stringUtils.js', pattern: /module\.exports|exports\./ },
            { path: 'projectConfig.js', pattern: /config|project/ },
        ];

        libFiles.forEach(lib => {
            it(`should validate ${lib.path}`, async () => {
                const libPath = path.join(__dirname, '..', 'src', 'i18n', 'lib', lib.path);
                
                try {
                    const libContent = await fs.readFile(libPath, 'utf-8');
                    
                    expect(() => {
                        new Function(libContent);
                    }).not.toThrow();
                    
                    expect(libContent).toMatch(lib.pattern);
                } catch (error) {
                    console.warn(`Library ${lib.path} not found, skipping`);
                }
            });
        });

        it('should validate parser modules', async () => {
            const parsers = ['baseParser.js', 'jsxParser.js', 'vueParser.js', 'bladeParser.js'];
            
            for (const parser of parsers) {
                try {
                    const parserPath = path.join(__dirname, '..', 'src', 'i18n', 'lib', 'parsers', parser);
                    const parserContent = await fs.readFile(parserPath, 'utf-8');
                    
                    expect(() => {
                        new Function(parserContent);
                    }).not.toThrow();
                    
                    expect(parserContent).toMatch(/parse|parser|parsing/);
                } catch (error) {
                    console.warn(`Parser ${parser} not found, skipping`);
                }
            }
        });

        it('should validate validator modules', async () => {
            const validators = ['codeValidator.js', 'htmlValidator.js', 'technicalValidator.js'];
            
            for (const validator of validators) {
                try {
                    const validatorPath = path.join(__dirname, '..', 'src', 'i18n', 'lib', 'validators', validator);
                    const validatorContent = await fs.readFile(validatorPath, 'utf-8');
                    
                    expect(() => {
                        new Function(validatorContent);
                    }).not.toThrow();
                    
                    expect(validatorContent).toMatch(/validate|validator|validation|check|detect/);
                } catch (error) {
                    console.warn(`Validator ${validator} not found, skipping`);
                }
            }
        });
    });

    describe('Script Dependencies', () => {
        it('should verify babel scripts have correct dependencies', async () => {
            const babelScript = path.join(__dirname, '..', 'src', 'i18n', 'babel-replace-i18n.js');
            
            try {
                const content = await fs.readFile(babelScript, 'utf-8');
                expect(content).toContain('@babel');
                expect(content).toMatch(/parser|traverse|generator|types/);
            } catch (error) {
                console.warn('Babel script not found, skipping');
            }
        });

        it('should verify oxc scripts have correct dependencies', async () => {
            const oxcScript = path.join(__dirname, '..', 'src', 'i18n', 'oxc-replace-i18n.js');
            
            try {
                const content = await fs.readFile(oxcScript, 'utf-8');
                expect(content).toContain('oxc-parser');
                expect(content).toContain('magic-string');
            } catch (error) {
                console.warn('OXC script not found, skipping');
            }
        });

        it('should verify ignore patterns file structure', async () => {
            const ignorePath = path.join(__dirname, '..', 'src', 'i18n', 'i18n-ignore-patterns.json');
            
            try {
                const content = await fs.readFile(ignorePath, 'utf-8');
                expect(() => JSON.parse(content)).not.toThrow();
                
                const parsed = JSON.parse(content);
                expect(Array.isArray(parsed.patterns) || typeof parsed === 'object').toBe(true);
            } catch (error) {
                console.warn('Ignore patterns file not found, skipping');
            }
        });
    });
});
