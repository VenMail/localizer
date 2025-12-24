import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranslationOperations } from '../src/commands/untranslated/handlers/keyManagement/translationOperations';
import { I18nIndex } from '../src/core/i18nIndex';
import { workspace, window, commands } from 'vscode';

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
        file: (path: string) => ({ 
            fsPath: path,
            toString: () => path
        }),
        joinPath: (base: any, ...parts: string[]) => { 
            const fullPath = base.fsPath ? base.fsPath + '/' + parts.join('/') : parts.join('/');
            return {
                fsPath: fullPath,
                toString: () => fullPath
            };
        },
    },
    window: {
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showQuickPick: vi.fn(),
        showInputBox: vi.fn(),
    },
    commands: {
        executeCommand: vi.fn(),
    },
}));

// Mock the core i18nFs functions
vi.mock('../src/core/i18nFs', () => ({
    setTranslationValue: vi.fn(),
    setTranslationValuesBatch: vi.fn(),
}));

describe('TranslationOperations - Missing Default Translation Fix', () => {
    let translationOps: TranslationOperations;
    let mockI18nIndex: I18nIndex;
    let mockLog: any;
    let mockWorkspaceFolder: any;
    let mockDocumentUri: any;

    beforeEach(() => {
        // Create mock I18nIndex
        mockI18nIndex = {
            getRecord: vi.fn(),
            getAllKeys: vi.fn(),
            ensureInitialized: vi.fn(),
        } as any;

        // Create mock log
        mockLog = {
            appendLine: vi.fn(),
        };

        // Create mock workspace folder
        mockWorkspaceFolder = {
            uri: { fsPath: '/test/project' },
            name: 'test-project',
        };

        // Create mock document URI
        mockDocumentUri = {
            fsPath: '/test/project/src/components/TestComponent.tsx',
            toString: () => '/test/project/src/components/TestComponent.tsx',
        };

        // Create translation operations instance
        translationOps = new TranslationOperations(mockI18nIndex, mockLog);

        // Reset all mocks
        vi.clearAllMocks();
        
        // Setup default successful responses
        (workspace.fs.createDirectory as any).mockResolvedValue(undefined);
        (workspace.fs.readFile as any).mockResolvedValue(Buffer.from('{}'));
        (workspace.fs.writeFile as any).mockResolvedValue(undefined);
        (workspace.getWorkspaceFolder as any).mockReturnValue(mockWorkspaceFolder);
        (window.showWarningMessage as any).mockResolvedValue('Overwrite');
        (commands.executeCommand as any).mockResolvedValue(undefined);
    });

    describe('copyTranslationToDefaultLocale - Creating Missing Default Files', () => {
        it('should create missing default locale file when copying translation', async () => {
            const { setTranslationValue } = await import('../src/core/i18nFs');
            (setTranslationValue as any).mockResolvedValue(undefined);

            // Mock record with source locale but no target locale location
            const mockRecord = {
                key: 'Dashboard.heading.domain_management',
                locales: new Map([
                    ['fr', 'Gestion des domaines'],
                    ['es', 'Gestión de dominios'],
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr.json' } },
                    { locale: 'es', uri: { fsPath: '/test/project/src/i18n/es.json' } },
                    // Note: no 'en' location - this is the missing default we're testing
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            // Mock file system to show that target locale file doesn't exist
            (workspace.fs.stat as any)
                .mockResolvedValueOnce({ type: 1 }) // src/i18n directory exists
                .mockRejectedValueOnce(new Error('FileNotFound')) // en.json doesn't exist
                .mockRejectedValueOnce(new Error('FileNotFound')); // en directory doesn't exist

            await translationOps.copyTranslationToDefaultLocale(
                mockDocumentUri,
                'Dashboard.heading.domain_management',
                'fr',
                'en'
            );

            // Verify setTranslationValue was called with correct parameters
            expect(setTranslationValue).toHaveBeenCalledWith(
                mockWorkspaceFolder,
                'en',
                'Dashboard.heading.domain_management',
                'Gestion des domaines',
                { rootName: 'common' }
            );
        });

        it('should handle directory-based locale structure when creating missing default', async () => {
            const { setTranslationValue } = await import('../src/core/i18nFs');
            (setTranslationValue as any).mockResolvedValue(undefined);

            const mockRecord = {
                key: 'commons.button.enable_outreach',
                locales: new Map([
                    ['fr', 'Activer le suivi'],
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr/commons.json' } },
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            // Mock directory-based structure
            (workspace.fs.stat as any)
                .mockResolvedValueOnce({ type: 1 }) // src/i18n directory exists
                .mockResolvedValueOnce({ type: 1 }) // en directory exists
                .mockRejectedValueOnce(new Error('FileNotFound')); // en/commons.json doesn't exist

            await translationOps.copyTranslationToDefaultLocale(
                mockDocumentUri,
                'commons.button.enable_outreach',
                'fr',
                'en'
            );

            expect(setTranslationValue).toHaveBeenCalledWith(
                mockWorkspaceFolder,
                'en',
                'commons.button.enable_outreach',
                'Activer le suivi',
                { rootName: 'commons' }
            );
        });

        it('should use fallback path when no i18n directories exist', async () => {
            const { setTranslationValue } = await import('../src/core/i18nFs');
            (setTranslationValue as any).mockResolvedValue(undefined);

            const mockRecord = {
                key: 'Sales.heading.20_new_leads_customers',
                locales: new Map([
                    ['fr', '20 nouveaux prospects et clients'],
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/locales/fr.json' } },
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            // Mock all i18n directories as non-existent
            (workspace.fs.stat as any).mockRejectedValue(new Error('DirectoryNotFound'));

            await translationOps.copyTranslationToDefaultLocale(
                mockDocumentUri,
                'Sales.heading.20_new_leads_customers',
                'fr',
                'en'
            );

            expect(setTranslationValue).toHaveBeenCalledWith(
                mockWorkspaceFolder,
                'en',
                'Sales.heading.20_new_leads_customers',
                '20 nouveaux prospects et clients',
                { rootName: 'common' }
            );
        });

        it('should show overwrite confirmation when target locale already has translation', async () => {
            const { setTranslationValue } = await import('../src/core/i18nFs');
            (setTranslationValue as any).mockResolvedValue(undefined);

            const mockRecord = {
                key: 'Mails.title.campaigns',
                locales: new Map([
                    ['fr', 'Campagnes'],
                    ['en', 'Campaigns'], // Already exists
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr.json' } },
                    { locale: 'en', uri: { fsPath: '/test/project/src/i18n/en.json' } },
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            // Mock user choosing to cancel overwrite
            (window.showWarningMessage as any).mockResolvedValue('Cancel');

            await translationOps.copyTranslationToDefaultLocale(
                mockDocumentUri,
                'Mails.title.campaigns',
                'fr',
                'en'
            );

            // Should not call setTranslationValue since user cancelled
            expect(setTranslationValue).not.toHaveBeenCalled();
        });

        it('should refresh diagnostics after creating missing default file', async () => {
            const { setTranslationValue } = await import('../src/core/i18nFs');
            (setTranslationValue as any).mockResolvedValue(undefined);

            const mockRecord = {
                key: 'Meetings.text.connect_collaborate_and_celebrate',
                locales: new Map([
                    ['fr', 'Se connecter, collaborer et célébrer'],
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr.json' } },
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            // Mock file system - target file doesn't exist but would be created at src/i18n/en.json
            (workspace.fs.stat as any)
                .mockResolvedValueOnce({ type: 1 }) // src/i18n directory exists
                .mockRejectedValueOnce(new Error('FileNotFound')); // en.json doesn't exist

            await translationOps.copyTranslationToDefaultLocale(
                mockDocumentUri,
                'Meetings.text.connect_collaborate_and_celebrate',
                'fr',
                'en'
            );

            // Verify diagnostics refresh was called
            expect(commands.executeCommand).toHaveBeenCalledWith(
                'ai-localizer.i18n.refreshFileDiagnostics',
                expect.any(Object),
                ['Meetings.text.connect_collaborate_and_celebrate']
            );

            // Verify the URI contains the expected filename
            const callArgs = (commands.executeCommand as any).mock.calls[0];
            const uriArg = callArgs[1];
            expect(uriArg.toString()).toContain('en.json');
        });

        it('should handle multiple missing default translations in sequence', async () => {
            const { setTranslationValue } = await import('../src/core/i18nFs');
            (setTranslationValue as any).mockResolvedValue(undefined);

            const keys = [
                'Dashboard.heading.domain_management',
                'Dashboard.toast.dns_values_copied_to',
                'SDRAgent.text.domains',
                'SDRAgent.text.emails',
                'SDRAgent.text.phones',
            ];

            for (const key of keys) {
                const mockRecord = {
                    key,
                    locales: new Map([
                        ['fr', `French translation for ${key}`],
                    ]),
                    defaultLocale: 'en',
                    locations: [
                        { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr.json' } },
                    ],
                };

                (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

                await translationOps.copyTranslationToDefaultLocale(
                    mockDocumentUri,
                    key,
                    'fr',
                    'en'
                );
            }

            // Verify all keys were processed
            expect(setTranslationValue).toHaveBeenCalledTimes(5);
            
            // Verify each call had correct parameters
            for (let i = 0; i < keys.length; i++) {
                expect(setTranslationValue).toHaveBeenNthCalledWith(i + 1,
                    mockWorkspaceFolder,
                    'en',
                    keys[i],
                    `French translation for ${keys[i]}`,
                    { rootName: 'common' }
                );
            }
        });
    });

    describe('Error Handling', () => {
        it('should throw error when key not found in index', async () => {
            (mockI18nIndex.getRecord as any).mockReturnValue(null);

            await expect(translationOps.copyTranslationToDefaultLocale(
                mockDocumentUri,
                'non.existent.key',
                'fr',
                'en'
            )).rejects.toThrow('Key "non.existent.key" not found in index');
        });

        it('should throw error when source locale has no translation', async () => {
            const mockRecord = {
                key: 'test.key',
                locales: new Map([
                    ['fr', ''], // Empty translation
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr.json' } },
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            await expect(translationOps.copyTranslationToDefaultLocale(
                mockDocumentUri,
                'test.key',
                'fr',
                'en'
            )).rejects.toThrow('No translation found for key "test.key" in locale "fr"');
        });

        it('should throw error when source locale file not found', async () => {
            const mockRecord = {
                key: 'test.key',
                locales: new Map([
                    ['fr', 'French translation'],
                ]),
                defaultLocale: 'en',
                locations: [], // No source locale location
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            await expect(translationOps.copyTranslationToDefaultLocale(
                mockDocumentUri,
                'test.key',
                'fr',
                'en'
            )).rejects.toThrow('No locale file found for source locale "fr"');
        });

        it('should handle diagnostics refresh failure gracefully', async () => {
            const { setTranslationValue } = await import('../src/core/i18nFs');
            (setTranslationValue as any).mockResolvedValue(undefined);

            const mockRecord = {
                key: 'test.key',
                locales: new Map([
                    ['fr', 'French translation'],
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr.json' } },
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            // Mock diagnostics refresh to fail
            (commands.executeCommand as any).mockRejectedValue(new Error('Diagnostics refresh failed'));

            // Should not throw error, but should log it
            await expect(translationOps.copyTranslationToDefaultLocale(
                mockDocumentUri,
                'test.key',
                'fr',
                'en'
            )).resolves.not.toThrow();

            expect(setTranslationValue).toHaveBeenCalled();
        });
    });

    describe('Root Name Extraction', () => {
        it('should extract correct root name from various file paths', async () => {
            const { setTranslationValue } = await import('../src/core/i18nFs');
            (setTranslationValue as any).mockResolvedValue(undefined);

            const testCases = [
                {
                    sourcePath: '/test/project/src/i18n/fr.json',
                    expectedRootName: 'common',
                },
                {
                    sourcePath: '/test/project/src/i18n/fr/commons.json',
                    expectedRootName: 'commons',
                },
                {
                    sourcePath: '/test/project/src/i18n/fr/dashboard.json',
                    expectedRootName: 'dashboard',
                },
                {
                    sourcePath: '/test/project/locales/fr.json',
                    expectedRootName: 'common',
                },
                {
                    sourcePath: '/test/project/resources/js/i18n/auto/fr/sales.json',
                    expectedRootName: 'sales',
                },
            ];

            for (const testCase of testCases) {
                const mockRecord = {
                    key: 'test.key',
                    locales: new Map([
                        ['fr', 'French translation'],
                    ]),
                    defaultLocale: 'en',
                    locations: [
                        { locale: 'fr', uri: { fsPath: testCase.sourcePath } },
                    ],
                };

                (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

                await translationOps.copyTranslationToDefaultLocale(
                    mockDocumentUri,
                    'test.key',
                    'fr',
                    'en'
                );

                expect(setTranslationValue).toHaveBeenCalledWith(
                    mockWorkspaceFolder,
                    'en',
                    'test.key',
                    'French translation',
                    { rootName: testCase.expectedRootName }
                );

                vi.clearAllMocks();
            }
        });
    });
});
