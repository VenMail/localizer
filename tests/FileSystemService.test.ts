import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileSystemService } from '../src/services/fileSystemService';
import { workspace, Uri, ExtensionContext, window } from 'vscode';
import * as path from 'path';

// Mock crypto globally
vi.mock('crypto', () => ({
    createHash: vi.fn(() => ({
        update: vi.fn().mockReturnThis(),
        digest: vi.fn(() => 'mock-checksum'),
    })),
}));

// Mock vscode modules
vi.mock('vscode', () => ({
    workspace: {
        fs: {
            createDirectory: vi.fn(),
            readFile: vi.fn(),
            writeFile: vi.fn(),
            stat: vi.fn(),
            readDirectory: vi.fn(),
        },
        getWorkspaceFolder: vi.fn(),
        findFiles: vi.fn(),
    },
    Uri: {
        file: (path: string) => ({ fsPath: path }),
        joinPath: (base: any, ...parts: string[]) => ({ 
            fsPath: path.join(base.fsPath || base, ...parts) 
        }),
    },
    RelativePattern: vi.fn((base: any, pattern: string) => ({ base, pattern })),
    window: {
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
    },
    FileType: {
        File: 1,
        Directory: 2,
    },
}));

// Mock workspace utilities
vi.mock('../src/core/workspace', () => ({
    isPackageInstalled: vi.fn(() => false),
    installPackages: vi.fn(),
}));

describe('FileSystemService Script Copying', () => {
    let fileSystemService: FileSystemService;
    let mockContext: ExtensionContext;
    let mockProjectRoot: string;

    beforeEach(() => {
        fileSystemService = new FileSystemService();
        mockProjectRoot = '/test/project';
        mockContext = {
            extensionUri: { fsPath: '/test/extension' },
            secrets: {
                get: vi.fn(),
                store: vi.fn(),
            },
        } as any;

        // Reset all mocks
        vi.clearAllMocks();
        
        // Setup default successful responses
        (workspace.fs.createDirectory as any).mockResolvedValue(undefined);
        (workspace.fs.readFile as any).mockResolvedValue(Buffer.from('mock content'));
        (workspace.fs.writeFile as any).mockResolvedValue(undefined);
        (workspace.fs.stat as any).mockResolvedValue({ type: 1 }); // File type
        (workspace.fs.readDirectory as any).mockResolvedValue([
            ['extract-i18n.js', 1],
            ['replace-i18n.js', 1],
            ['sync-i18n.js', 1],
            ['fix-untranslated.js', 1],
            ['rewrite-i18n-blade.js', 1],
            ['cleanup-i18n-unused.js', 1],
            ['restore-i18n-invalid.js', 1],
        ]);
        (workspace.getWorkspaceFolder as any).mockReturnValue({
            uri: { fsPath: mockProjectRoot },
        });
        (window.showInformationMessage as any).mockResolvedValue(undefined);
        (window.showWarningMessage as any).mockResolvedValue(undefined);
    });

    describe('copyScriptsToProject', () => {
        it('should create scripts directory and copy all required scripts', async () => {
            await fileSystemService.copyScriptsToProject(mockContext, mockProjectRoot);

            // Verify scripts directory creation
            expect(workspace.fs.createDirectory).toHaveBeenCalledWith(
                expect.objectContaining({ fsPath: expect.stringContaining('scripts') })
            );

            // Verify main scripts are copied
            const expectedScripts = [
                'extract-i18n.js',
                'replace-i18n.js',
                'sync-i18n.js',
                'fix-untranslated.js',
                'rewrite-i18n-blade.js',
                'cleanup-i18n-unused.js',
                'restore-i18n-invalid.js',
            ];

            expectedScripts.forEach(script => {
                expect(workspace.fs.writeFile).toHaveBeenCalledWith(
                    expect.objectContaining({ fsPath: expect.stringContaining(script) }),
                    expect.any(Uint8Array)
                );
            });
        });

        it('should copy lib utilities and create subdirectories', async () => {
            await fileSystemService.copyScriptsToProject(mockContext, mockProjectRoot);

            // Verify lib directory and subdirectories are created
            expect(workspace.fs.createDirectory).toHaveBeenCalledWith(
                expect.objectContaining({ fsPath: expect.stringContaining('lib') })
            );
            expect(workspace.fs.createDirectory).toHaveBeenCalledWith(
                expect.objectContaining({ fsPath: expect.stringContaining('parsers') })
            );
            expect(workspace.fs.createDirectory).toHaveBeenCalledWith(
                expect.objectContaining({ fsPath: expect.stringContaining('validators') })
            );

            // Verify lib files are copied
            const expectedLibFiles = [
                'projectConfig.js',
                'stringUtils.js',
                'ignorePatterns.js',
                'translationStore.js',
                'textValidation.js',
                'vueTemplateParser.js',
                'localeUtils.js',
            ];

            expectedLibFiles.forEach(file => {
                expect(workspace.fs.writeFile).toHaveBeenCalledWith(
                    expect.objectContaining({ fsPath: expect.stringContaining(path.join('lib', file)) }),
                    expect.any(Uint8Array)
                );
            });
        });

        it('should copy parser and validator files', async () => {
            await fileSystemService.copyScriptsToProject(mockContext, mockProjectRoot);

            const expectedParsers = [
                'index.js',
                'baseParser.js',
                'jsxParser.js',
                'vueParser.js',
                'bladeParser.js',
                'svelteParser.js',
                'genericParser.js',
            ];

            const expectedValidators = [
                'index.js',
                'cssValidator.js',
                'codeValidator.js',
                'htmlValidator.js',
                'technicalValidator.js',
            ];

            expectedParsers.forEach(parser => {
                expect(workspace.fs.writeFile).toHaveBeenCalledWith(
                    expect.objectContaining({ fsPath: expect.stringContaining(path.join('lib', 'parsers', parser)) }),
                    expect.any(Uint8Array)
                );
            });

            expectedValidators.forEach(validator => {
                expect(workspace.fs.writeFile).toHaveBeenCalledWith(
                    expect.objectContaining({ fsPath: expect.stringContaining(path.join('lib', 'validators', validator)) }),
                    expect.any(Uint8Array)
                );
            });
        });

        it('should copy ignore patterns file', async () => {
            await fileSystemService.copyScriptsToProject(mockContext, mockProjectRoot);

            expect(workspace.fs.writeFile).toHaveBeenCalledWith(
                expect.objectContaining({ fsPath: expect.stringContaining('i18n-ignore-patterns.json') }),
                expect.any(Uint8Array)
            );
        });

        it('should create scripts/package.json with commonjs type', async () => {
            await fileSystemService.copyScriptsToProject(mockContext, mockProjectRoot);

            const packageJsonCall = (workspace.fs.writeFile as any).mock.calls.find(
                (                call: { fsPath: string | string[]; }[]) => call[0].fsPath.includes('package.json')
            );

            expect(packageJsonCall).toBeDefined();
            const writtenContent = Buffer.from(packageJsonCall[1]).toString();
            const packageJson = JSON.parse(writtenContent);
            
            expect(packageJson.type).toBe('commonjs');
            expect(packageJson.name).toBe('ai-localizer-scripts');
            expect(packageJson.private).toBe(true);
        });

        it('should handle directory creation failures gracefully', async () => {
            (workspace.fs.createDirectory as any).mockRejectedValue(new Error('Permission denied'));

            await expect(fileSystemService.copyScriptsToProject(mockContext, mockProjectRoot))
                .rejects.toThrow('Failed to create scripts directory');
        });

        it('should show warning messages for failed file copies', async () => {
            // Mock the first writeFile call to fail, others to succeed
            (workspace.fs.writeFile as any)
                .mockRejectedValueOnce(new Error('File write error'))
                .mockResolvedValue(undefined);

            await fileSystemService.copyScriptsToProject(mockContext, mockProjectRoot);

            // Check that some warning was shown (could be script copy or dependency related)
            expect(window.showWarningMessage).toHaveBeenCalled();
        });
    });

    describe('Script Version Management', () => {
        it('should detect outdated scripts correctly', async () => {
            // Mock getFileChecksum to return null (project script doesn't exist)
            // Mock getBundledScriptChecksum to return a checksum
            vi.spyOn(fileSystemService, 'getFileChecksum').mockResolvedValue(null);
            vi.spyOn(fileSystemService, 'getBundledScriptChecksum').mockResolvedValue('mock-checksum');

            const isOutdated = await fileSystemService.isScriptOutdated(
                mockContext,
                mockProjectRoot,
                'extract-i18n.js'
            );

            expect(isOutdated).toBe(true);
        });

        it('should identify all outdated scripts', async () => {
            // Mock getFileChecksum to return null for some scripts (don't exist)
            // Mock getBundledScriptChecksum to always return a checksum
            vi.spyOn(fileSystemService, 'getFileChecksum').mockImplementation((uri) => {
                if (uri.fsPath.includes('extract-i18n.js') || uri.fsPath.includes('sync-i18n.js')) {
                    return Promise.resolve(null); // These scripts don't exist in project
                }
                return Promise.resolve('existing-checksum'); // Other scripts exist
            });
            vi.spyOn(fileSystemService, 'getBundledScriptChecksum').mockResolvedValue('bundled-checksum');

            const outdatedScripts = await fileSystemService.getOutdatedScripts(
                mockContext,
                mockProjectRoot
            );

            expect(outdatedScripts).toContain('extract-i18n.js');
            expect(outdatedScripts).toContain('sync-i18n.js');
        });
    });

    describe('Dependency Management', () => {
        it('should detect Node version and choose appropriate script stack', async () => {
            // Mock .nvmrc file with Node 20.16.0 (supports oxc)
            (workspace.fs.readFile as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('.nvmrc')) {
                    return Promise.resolve(Buffer.from('20.16.0'));
                }
                return Promise.resolve(Buffer.from('mock content'));
            });

            // Mock user to choose "Install" for dependencies
            (window.showInformationMessage as any).mockResolvedValue('Install');

            const { isPackageInstalled } = await import('../src/core/workspace');
            (isPackageInstalled as any).mockReturnValue(false);

            await fileSystemService.copyScriptsToProject(mockContext, mockProjectRoot);

            // Should attempt to install oxc dependencies for Node 20.16.0
            const { installPackages } = await import('../src/core/workspace');
            expect(installPackages).toHaveBeenCalledWith(
                expect.anything(),
                ['oxc-parser', 'magic-string'],
                true
            );
        });

        it('should fallback to babel dependencies for older Node versions', async () => {
            // Mock .nvmrc file with Node 18.0.0 (doesn't support oxc)
            (workspace.fs.readFile as any).mockImplementation((uri: any) => {
                if (uri.fsPath.includes('.nvmrc')) {
                    return Promise.resolve(Buffer.from('18.0.0'));
                }
                return Promise.resolve(Buffer.from('mock content'));
            });

            // Mock user to choose "Install" for dependencies
            (window.showInformationMessage as any).mockResolvedValue('Install');

            const { isPackageInstalled } = await import('../src/core/workspace');
            (isPackageInstalled as any).mockReturnValue(false);

            await fileSystemService.copyScriptsToProject(mockContext, mockProjectRoot);

            const { installPackages } = await import('../src/core/workspace');
            expect(installPackages).toHaveBeenCalledWith(
                expect.anything(),
                [
                    '@babel/parser',
                    '@babel/traverse',
                    '@babel/generator',
                    '@babel/types',
                ],
                true
            );
        });
    });

    describe('File System Utilities', () => {
        it('should check file existence correctly', async () => {
            // Test existing file
            (workspace.fs.stat as any).mockResolvedValue({ type: 1 });
            const exists = await fileSystemService.fileExists(Uri.file('/test/file.js'));
            expect(exists).toBe(true);

            // Test non-existing file
            (workspace.fs.stat as any).mockRejectedValue(new Error('File not found'));
            const notExists = await fileSystemService.fileExists(Uri.file('/test/notfound.js'));
            expect(notExists).toBe(false);
        });

        it('should read and write JSON files correctly', async () => {
            const testData = { test: 'value', nested: { prop: true } };
            const testUri = Uri.file('/test/data.json');

            // Test writing
            await fileSystemService.writeJsonFile(testUri, testData);
            expect(workspace.fs.writeFile).toHaveBeenCalledWith(
                testUri,
                expect.any(Uint8Array)
            );

            // Test reading
            (workspace.fs.readFile as any).mockResolvedValue(
                Buffer.from(JSON.stringify(testData))
            );
            const readData = await fileSystemService.readJsonFile(testUri);
            expect(readData).toEqual(testData);
        });

        it('should handle JSON read errors gracefully', async () => {
            (workspace.fs.readFile as any).mockRejectedValue(new Error('Read error'));
            
            const result = await fileSystemService.readJsonFile(Uri.file('/test/invalid.json'));
            expect(result).toBeNull();
        });
    });
});
