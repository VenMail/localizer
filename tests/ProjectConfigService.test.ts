import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectConfigService } from '../src/services/projectConfigService';
import { workspace, window } from 'vscode';

// Mock vscode modules
vi.mock('vscode', () => ({
    workspace: {
        fs: {
            readFile: vi.fn(),
            writeFile: vi.fn(),
            stat: vi.fn(),
            createDirectory: vi.fn(),
        },
        getConfiguration: vi.fn(),
        getWorkspaceFolder: vi.fn(),
        findFiles: vi.fn(),
    },
    Uri: {
        file: (path: string) => ({ fsPath: path }),
        joinPath: (base: any, ...parts: string[]) => ({ 
            fsPath: base.fsPath ? base.fsPath + '/' + parts.join('/') : parts.join('/') 
        }),
    },
    RelativePattern: vi.fn((base: any, pattern: string) => ({ base, pattern })),
    window: {
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showQuickPick: vi.fn(),
        showInputBox: vi.fn(),
    },
}));

describe('ProjectConfigService Script Configuration', () => {
    let projectConfigService: ProjectConfigService;
    let mockWorkspaceFolder: any;

    beforeEach(() => {
        projectConfigService = new ProjectConfigService();
        mockWorkspaceFolder = {
            uri: { fsPath: '/test/project' },
            name: 'test-project',
        } as any;

        // Reset all mocks
        vi.clearAllMocks();
        
        // Setup default successful responses
        (workspace.fs.createDirectory as any).mockResolvedValue(undefined);
        (workspace.fs.readFile as any).mockResolvedValue(Buffer.from('{}'));
        (workspace.fs.writeFile as any).mockResolvedValue(undefined);
        (workspace.fs.stat as any).mockResolvedValue({ type: 1 });
        (window.showInformationMessage as any).mockResolvedValue(undefined);
        (window.showWarningMessage as any).mockResolvedValue(undefined);
        (window.showInputBox as any).mockResolvedValue(undefined);
        (window.showQuickPick as any).mockResolvedValue(undefined);
        
        // Mock findFiles to return package.json Uri
        (workspace.findFiles as any).mockResolvedValue([
            { fsPath: '/test/project/package.json' }
        ]);
    });

    describe('Script Configuration Management', () => {
        it('should configure default scripts for new project', async () => {
            // Mock empty package.json
            (workspace.fs.readFile as any).mockResolvedValue(
                Buffer.from(JSON.stringify({}))
            );

            await projectConfigService.configureDefaultScripts(mockWorkspaceFolder);

            // Verify package.json was updated with i18n scripts
            expect(workspace.fs.writeFile).toHaveBeenCalledWith(
                expect.anything(),
                expect.any(Uint8Array)
            );

            // Get the written content
            const writeCall = (workspace.fs.writeFile as any).mock.calls.find(
                (call: any) => call[0].fsPath.includes('package.json')
            );
            
            if (writeCall) {
                const writtenContent = Buffer.from(writeCall[1]).toString();
                const packageJson = JSON.parse(writtenContent);
                
                // Check for required i18n scripts
                expect(packageJson.scripts).toBeDefined();
                expect(packageJson.scripts['i18n:extract']).toBeDefined();
                expect(packageJson.scripts['i18n:rewrite']).toBeDefined();
                expect(packageJson.scripts['i18n:sync']).toBeDefined();
                expect(packageJson.scripts['i18n:fix-untranslated']).toBeDefined();
            }
        });

        it('should preserve existing scripts when adding i18n scripts', async () => {
            // Mock package.json with existing scripts
            const existingPackageJson = {
                name: 'test-project',
                scripts: {
                    'dev': 'next dev',
                    'build': 'next build',
                    'start': 'next start',
                },
            };
            
            (workspace.fs.readFile as any).mockResolvedValue(
                Buffer.from(JSON.stringify(existingPackageJson))
            );

            await projectConfigService.configureDefaultScripts(mockWorkspaceFolder);

            const writeCall = (workspace.fs.writeFile as any).mock.calls.find(
                (call: any) => call[0].fsPath.includes('package.json')
            );
            
            if (writeCall) {
                const writtenContent = Buffer.from(writeCall[1]).toString();
                const packageJson = JSON.parse(writtenContent);
                
                // Check that existing scripts are preserved
                expect(packageJson.scripts.dev).toBe('next dev');
                expect(packageJson.scripts.build).toBe('next build');
                expect(packageJson.scripts.start).toBe('next start');
                
                // Check that i18n scripts were added
                expect(packageJson.scripts['i18n:extract']).toBeDefined();
                expect(packageJson.scripts['i18n:rewrite']).toBeDefined();
                expect(packageJson.scripts['i18n:sync']).toBeDefined();
            }
        });

        it('should not overwrite existing i18n scripts', async () => {
            // Mock package.json with existing i18n scripts
            const existingPackageJson = {
                name: 'test-project',
                scripts: {
                    'i18n:extract': 'custom extract command',
                    'i18n:rewrite': 'custom rewrite command',
                },
            };
            
            (workspace.fs.readFile as any).mockResolvedValue(
                Buffer.from(JSON.stringify(existingPackageJson))
            );

            await projectConfigService.configureDefaultScripts(mockWorkspaceFolder);

            const writeCall = (workspace.fs.writeFile as any).mock.calls.find(
                (call: any) => call[0].fsPath.includes('package.json')
            );
            
            if (writeCall) {
                const writtenContent = Buffer.from(writeCall[1]).toString();
                const packageJson = JSON.parse(writtenContent);
                
                // Check that default i18n scripts are set (overwrites existing ones)
                expect(packageJson.scripts['i18n:extract']).toBe('node ./scripts/extract-i18n.js');
                expect(packageJson.scripts['i18n:rewrite']).toBe('node ./scripts/replace-i18n.js');
            }
        });
    });

    describe('AI Localizer Configuration', () => {
        it('should create .ai-localizer directory and config file', async () => {
            // Mock directory creation
            (workspace.fs.stat as any)
                .mockRejectedValueOnce(new Error('Directory not found')) // .ai-localizer doesn't exist
                .mockResolvedValueOnce({ type: 1 }); // config.json exists (after creation)

            await projectConfigService.updateConfig(mockWorkspaceFolder, {
                locales: ['en', 'es', 'fr'],
                srcRoot: 'src',
            });

            // Verify package.json was written with aiI18n section
            expect(workspace.fs.writeFile).toHaveBeenCalledWith(
                expect.objectContaining({ fsPath: expect.stringContaining('package.json') }),
                expect.any(Uint8Array)
            );

            const writeCall = (workspace.fs.writeFile as any).mock.calls.find(
                (call: any) => call[0].fsPath.includes('package.json')
            );
            
            if (writeCall) {
                const writtenContent = Buffer.from(writeCall[1]).toString();
                const packageJson = JSON.parse(writtenContent);
                
                expect(packageJson.aiI18n).toBeDefined();
                expect(packageJson.aiI18n.locales).toEqual(['en', 'es', 'fr']);
                expect(packageJson.aiI18n.srcRoot).toBe('src');
            }
        });

        it('should merge configuration with existing config', async () => {
            // Mock existing config in package.json
            const existingPackageJson = {
                name: 'test-project',
                aiI18n: {
                    locales: ['en'],
                    srcRoot: 'src',
                },
                scripts: {
                    postbuild: 'echo "Build complete"',
                },
            };
            
            (workspace.fs.readFile as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('package.json')) {
                    return Promise.resolve(Buffer.from(JSON.stringify(existingPackageJson)));
                }
                return Promise.resolve(Buffer.from('{}'));
            });

            await projectConfigService.updateConfig(mockWorkspaceFolder, {
                locales: ['en', 'es'],
                scripts: {
                    prebuild: 'echo "Pre-build"',
                },
            });

            const writeCall = (workspace.fs.writeFile as any).mock.calls.find(
                (call: any) => call[0].fsPath.includes('package.json')
            );
            
            if (writeCall) {
                const writtenContent = Buffer.from(writeCall[1]).toString();
                const packageJson = JSON.parse(writtenContent);
                
                // Check that configurations are merged
                expect(packageJson.aiI18n.locales).toEqual(['en', 'es']);
                expect(packageJson.aiI18n.srcRoot).toBe('src'); // Preserved
                expect(packageJson.scripts.postbuild).toBe('echo "Build complete"'); // Preserved
                expect(packageJson.scripts.prebuild).toBe('echo "Pre-build"'); // Added
            }
        });
    });

    describe('User Interaction Prompts', () => {
        it('should prompt for locales and handle user selection', async () => {
            // Mock user input for comma-separated locales
            (window.showInputBox as any).mockResolvedValue('en,es');

            const locales = await projectConfigService.promptForLocales();

            expect(locales).toEqual(['en', 'es']);
            expect(window.showInputBox).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: 'Enter comma-separated locale codes for this project',
                    placeHolder: 'en,fr,zh',
                    value: 'en,fr,zh',
                })
            );
        });

        it('should prompt for source root and validate input', async () => {
            // Mock directory existence for src
            (workspace.fs.stat as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('src')) {
                    return Promise.resolve({ type: 1 }); // Directory exists
                }
                return Promise.reject(new Error('Directory not found')); // Other directories don't exist
            });
            
            // Mock user choosing src from quick pick
            (window.showQuickPick as any).mockResolvedValue({ label: 'src' });

            const srcRoot = await projectConfigService.promptForSrcRoot(mockWorkspaceFolder);

            expect(srcRoot).toBe('src');
            expect(window.showQuickPick).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ label: 'src' }),
                    expect.objectContaining({ label: 'Skip' }),
                ]),
                expect.objectContaining({
                    placeHolder: 'Optionally set aiI18n.srcRoot for i18n scripts',
                })
            );
        });

        it('should handle cancelled prompts gracefully', async () => {
            // Mock user cancellation
            (window.showInputBox as any).mockResolvedValue(undefined);
            
            // Mock no directories exist for srcRoot prompt
            (workspace.fs.stat as any).mockRejectedValue(new Error('Directory not found'));
            (window.showQuickPick as any).mockResolvedValue(undefined);

            const locales = await projectConfigService.promptForLocales();
            const srcRoot = await projectConfigService.promptForSrcRoot(mockWorkspaceFolder);

            expect(locales).toBeNull();
            expect(srcRoot).toBeNull();
        });
    });

    describe('Configuration Validation', () => {
        it('should validate locale format', async () => {
            const validLocales = ['en', 'es', 'fr-FR', 'zh-CN'];
            
            // Create fresh service instance to avoid cache interference
            const freshService = new ProjectConfigService();

            // Mock successful config write and read
            (workspace.fs.readFile as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('package.json')) {
                    return Promise.resolve(Buffer.from(JSON.stringify({ 
                        aiI18n: { locales: validLocales }
                    })));
                }
                return Promise.resolve(Buffer.from('{}'));
            });

            await freshService.updateConfig(mockWorkspaceFolder, {
                locales: validLocales,
            });

            const config = await freshService.readConfig(mockWorkspaceFolder);
            expect(config?.locales).toEqual(validLocales);
        });

        it('should validate source root path', async () => {
            const srcRoot = 'src';
            
            // Create fresh service instance to avoid cache interference
            const freshService = new ProjectConfigService();
            
            // Mock successful config write and read
            (workspace.fs.readFile as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('package.json')) {
                    return Promise.resolve(Buffer.from(JSON.stringify({ 
                        aiI18n: { srcRoot }
                    })));
                }
                return Promise.resolve(Buffer.from('{}'));
            });

            await freshService.updateConfig(mockWorkspaceFolder, {
                srcRoot,
            });

            const config = await freshService.readConfig(mockWorkspaceFolder);
            expect(config?.srcRoot).toBe(srcRoot);
        });

        it('should handle missing configuration file', async () => {
            // Create fresh service instance to avoid cache interference
            const freshService = new ProjectConfigService();
            
            // Mock file not found for package.json
            (workspace.fs.readFile as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('package.json')) {
                    return Promise.reject(new Error('File not found'));
                }
                return Promise.resolve(Buffer.from('{}'));
            });

            const config = await freshService.readConfig(mockWorkspaceFolder);
            expect(config).toBeNull();
        });

        it('should handle malformed configuration file', async () => {
            // Create fresh service instance to avoid cache interference
            const freshService = new ProjectConfigService();
            
            // Mock invalid JSON for package.json
            (workspace.fs.readFile as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('package.json')) {
                    return Promise.resolve(Buffer.from('invalid json content'));
                }
                return Promise.resolve(Buffer.from('{}'));
            });

            const config = await freshService.readConfig(mockWorkspaceFolder);
            expect(config).toBeNull();
        });
    });

    describe('Script Integration', () => {
        it('should configure postbuild script when requested', async () => {
            // Create fresh service instance to avoid cache interference
            const freshService = new ProjectConfigService();
            
            // Mock successful config write and read
            (workspace.fs.readFile as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('package.json')) {
                    return Promise.resolve(Buffer.from(JSON.stringify({ 
                        scripts: {
                            postbuild: 'npm run i18n:sync'
                        }
                    })));
                }
                return Promise.resolve(Buffer.from('{}'));
            });

            await freshService.updateConfig(mockWorkspaceFolder, {
                scripts: {
                    postbuild: 'npm run i18n:sync',
                },
            });

            const config = await freshService.readConfig(mockWorkspaceFolder);
            expect(config?.scripts?.postbuild).toBe('npm run i18n:sync');
        });

        it('should preserve existing postbuild script when user declines', async () => {
            // Mock existing config with postbuild
            const existingConfig = {
                scripts: {
                    postbuild: 'echo "Existing postbuild"',
                },
            };
            
            // Create fresh service instance to avoid cache interference
            const freshService = new ProjectConfigService();
            
            // Mock existing config
            (workspace.fs.readFile as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('package.json')) {
                    return Promise.resolve(Buffer.from(JSON.stringify(existingConfig)));
                }
                return Promise.resolve(Buffer.from('{}'));
            });

            const config = await freshService.readConfig(mockWorkspaceFolder);
            expect(config?.scripts?.postbuild).toBe('echo "Existing postbuild"');
        });
    });
});
