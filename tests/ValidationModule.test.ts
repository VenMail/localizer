import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ValidationModule } from '../src/commands/untranslated/handlers/keyManagement/validationModule';
import { I18nIndex } from '../src/core/i18nIndex';

// Mock vscode modules
vi.mock('vscode', () => ({
    workspace: {
        getWorkspaceFolder: vi.fn(),
    },
    window: {
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showQuickPick: vi.fn(),
        showInputBox: vi.fn(),
    },
}));

// Import the mocked vscode modules
const { workspace, window } = await import('vscode');

describe('ValidationModule - Missing Default Translation Support', () => {
    let validationModule: ValidationModule;
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

        // Create validation module instance
        validationModule = new ValidationModule(mockI18nIndex, mockLog);

        // Reset all mocks
        vi.clearAllMocks();
        
        // Setup default successful responses
        (workspace.getWorkspaceFolder as any).mockReturnValue(mockWorkspaceFolder);
    });

    describe('validateCopyTranslationComprehensive - Missing Default Support', () => {
        it('should validate successfully when target locale file does not exist', async () => {
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
                    // Note: no 'en' location - this should now be allowed
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            const result = await validationModule.validateCopyTranslationComprehensive({
                documentUri: mockDocumentUri,
                key: 'Dashboard.heading.domain_management',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(true);
            expect(result.record).toBe(mockRecord);
            expect(result.folder).toBe(mockWorkspaceFolder);
            expect(result.error).toBeUndefined();
        });

        it('should validate successfully when target locale file exists', async () => {
            const mockRecord = {
                key: 'commons.button.enable_outreach',
                locales: new Map([
                    ['fr', 'Activer le suivi'],
                    ['en', 'Enable Outreach'], // Target already has translation
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr/commons.json' } },
                    { locale: 'en', uri: { fsPath: '/test/project/src/i18n/en/commons.json' } },
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            const result = await validationModule.validateCopyTranslationComprehensive({
                documentUri: mockDocumentUri,
                key: 'commons.button.enable_outreach',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(true);
            expect(result.record).toBe(mockRecord);
            expect(result.folder).toBe(mockWorkspaceFolder);
        });

        it('should fail validation when source locale has no translation', async () => {
            const mockRecord = {
                key: 'test.key',
                locales: new Map([
                    ['fr', ''], // Empty translation
                    ['es', 'Traducción española'],
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr.json' } },
                    { locale: 'es', uri: { fsPath: '/test/project/src/i18n/es.json' } },
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            const result = await validationModule.validateCopyTranslationComprehensive({
                documentUri: mockDocumentUri,
                key: 'test.key',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(false);
            expect(result.error).toContain('No translation found for key in locale "fr"');
        });

        it('should fail validation when key not found in index', async () => {
            (mockI18nIndex.getRecord as any).mockReturnValue(null);

            const result = await validationModule.validateCopyTranslationComprehensive({
                documentUri: mockDocumentUri,
                key: 'non.existent.key',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(false);
            expect(result.error).toContain('Key "non.existent.key" not found in index');
        });

        it('should fail validation when workspace folder not found', async () => {
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

            // Mock no workspace folder found
            (workspace.getWorkspaceFolder as any).mockReturnValue(null);

            const result = await validationModule.validateCopyTranslationComprehensive({
                documentUri: mockDocumentUri,
                key: 'test.key',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(false);
            expect(result.error).toContain('No workspace folder available');
        });
    });

    describe('validateCopyTranslation - Basic Parameter Validation', () => {
        it('should fail validation with missing document URI', () => {
            const result = validationModule.validateCopyTranslation({
                documentUri: null as any,
                key: 'test.key',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(false);
            expect(result.error).toBe('No document provided');
        });

        it('should fail validation with empty key', () => {
            const result = validationModule.validateCopyTranslation({
                documentUri: mockDocumentUri,
                key: '',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(false);
            expect(result.error).toBe('Invalid key provided');
        });

        it('should fail validation with whitespace-only key', () => {
            const result = validationModule.validateCopyTranslation({
                documentUri: mockDocumentUri,
                key: '   ',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(false);
            expect(result.error).toBe('Invalid key provided');
        });

        it('should fail validation with missing source locale', () => {
            const result = validationModule.validateCopyTranslation({
                documentUri: mockDocumentUri,
                key: 'test.key',
                sourceLocale: '',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(false);
            expect(result.error).toBe('Invalid source locale provided');
        });

        it('should fail validation with missing target locale', () => {
            const result = validationModule.validateCopyTranslation({
                documentUri: mockDocumentUri,
                key: 'test.key',
                sourceLocale: 'fr',
                targetLocale: '',
            });

            expect(result.isValid).toBe(false);
            expect(result.error).toBe('Invalid target locale provided');
        });

        it('should pass validation with valid parameters', () => {
            const result = validationModule.validateCopyTranslation({
                documentUri: mockDocumentUri,
                key: 'test.key',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(true);
            expect(result.error).toBeUndefined();
        });
    });

    describe('validateBulkOperation', () => {
        it('should fail validation with missing document URI', () => {
            const result = validationModule.validateBulkOperation({
                documentUri: null as any,
            });

            expect(result.isValid).toBe(false);
            expect(result.error).toBe('No document provided');
        });

        it('should pass validation with valid document URI', () => {
            const result = validationModule.validateBulkOperation({
                documentUri: mockDocumentUri,
            });

            expect(result.isValid).toBe(true);
            expect(result.error).toBeUndefined();
        });
    });

    describe('validateDocumentLanguage', () => {
        it('should pass validation for any document language (missing default fixes support all)', () => {
            const result = validationModule.validateDocumentLanguage(
                mockDocumentUri,
                ['javascript', 'typescript', 'vue']
            );

            expect(result.isValid).toBe(true);
            expect(result.error).toBeUndefined();
        });
    });

    describe('Logging Methods', () => {
        it('should log validation errors correctly', () => {
            validationModule.logValidationError('testOperation', 'Test error message');

            expect(mockLog.appendLine).toHaveBeenCalledWith(
                '[Validation] testOperation validation failed: Test error message'
            );
        });

        it('should log validation success correctly', () => {
            validationModule.logValidationSuccess('testOperation');

            expect(mockLog.appendLine).toHaveBeenCalledWith(
                '[Validation] testOperation validation passed'
            );
        });
    });

    describe('confirmOverwrite', () => {
        it('should return true when user chooses to overwrite', async () => {
            (window.showWarningMessage as any).mockResolvedValue('Overwrite');

            const result = await validationModule.confirmOverwrite('test.key', 'en');

            expect(result).toBe(true);
            expect(window.showWarningMessage).toHaveBeenCalledWith(
                'AI Localizer: Target locale "en" already has a translation for "test.key". Overwrite?',
                'Overwrite',
                'Cancel'
            );
        });

        it('should return false when user cancels overwrite', async () => {
            (window.showWarningMessage as any).mockResolvedValue('Cancel');

            const result = await validationModule.confirmOverwrite('test.key', 'en');

            expect(result).toBe(false);
        });

        it('should return false when user dismisses dialog', async () => {
            (window.showWarningMessage as any).mockResolvedValue(undefined);

            const result = await validationModule.confirmOverwrite('test.key', 'en');

            expect(result).toBe(false);
        });
    });

    describe('Integration Tests - Missing Default Scenarios', () => {
        it('should handle multiple missing default locale scenarios', async () => {
            const testCases = [
                {
                    key: 'Dashboard.heading.domain_management',
                    sourceLocale: 'fr',
                    targetLocale: 'en',
                    sourceTranslation: 'Gestion des domaines',
                },
                {
                    key: 'commons.button.enable_outreach',
                    sourceLocale: 'es',
                    targetLocale: 'en',
                    sourceTranslation: 'Activer le suivi',
                },
                {
                    key: 'SDRAgent.text.domains',
                    sourceLocale: 'fr',
                    targetLocale: 'en',
                    sourceTranslation: 'Domaines',
                },
            ];

            for (const testCase of testCases) {
                const mockRecord = {
                    key: testCase.key,
                    locales: new Map([
                        [testCase.sourceLocale, testCase.sourceTranslation],
                    ]),
                    defaultLocale: testCase.targetLocale,
                    locations: [
                        { 
                            locale: testCase.sourceLocale, 
                            uri: { fsPath: `/test/project/src/i18n/${testCase.sourceLocale}.json` } 
                        },
                        // Note: no target locale location - this should be allowed
                    ],
                };

                (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

                const result = await validationModule.validateCopyTranslationComprehensive({
                    documentUri: mockDocumentUri,
                    key: testCase.key,
                    sourceLocale: testCase.sourceLocale,
                    targetLocale: testCase.targetLocale,
                });

                expect(result.isValid).toBe(true);
                expect(result.record).toBe(mockRecord);
                expect(result.folder).toBe(mockWorkspaceFolder);
                expect(result.error).toBeUndefined();
            }
        });

        it('should validate scenario with multiple existing locales but missing default', async () => {
            const mockRecord = {
                key: 'complex.translation.key',
                locales: new Map([
                    ['fr', 'Traduction française'],
                    ['es', 'Traducción española'],
                    ['de', 'Deutsche Übersetzung'],
                    ['it', 'Traduzione italiana'],
                ]),
                defaultLocale: 'en',
                locations: [
                    { locale: 'fr', uri: { fsPath: '/test/project/src/i18n/fr.json' } },
                    { locale: 'es', uri: { fsPath: '/test/project/src/i18n/es.json' } },
                    { locale: 'de', uri: { fsPath: '/test/project/src/i18n/de.json' } },
                    { locale: 'it', uri: { fsPath: '/test/project/src/i18n/it.json' } },
                    // Note: no 'en' location - this should be allowed
                ],
            };

            (mockI18nIndex.getRecord as any).mockReturnValue(mockRecord);

            const result = await validationModule.validateCopyTranslationComprehensive({
                documentUri: mockDocumentUri,
                key: 'complex.translation.key',
                sourceLocale: 'fr',
                targetLocale: 'en',
            });

            expect(result.isValid).toBe(true);
            expect(result.record).toBe(mockRecord);
            expect(result.folder).toBe(mockWorkspaceFolder);
        });
    });
});
