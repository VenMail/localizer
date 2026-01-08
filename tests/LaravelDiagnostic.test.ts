import { describe, it, expect, beforeEach } from 'vitest';
import { DiagnosticAnalyzer, DiagnosticConfig } from '../src/services/diagnosticAnalyzer';
import { workspace, Uri, DiagnosticSeverity } from 'vscode';
import { MockOutputChannel } from './mocks/vscode';
import type { I18nIndex, TranslationRecord } from '../src/core/i18nIndex';
import type { ProjectConfigService } from '../src/services/projectConfigService';

const encoder = new TextEncoder();
let fileContent = '';
let mockFiles = new Map<string, string>();

(workspace.fs as any).readFile = async (uri: Uri) => {
    const path = uri.fsPath;
    if (mockFiles.has(path)) {
        return encoder.encode(mockFiles.get(path)!);
    }
    return encoder.encode(fileContent);
};

(workspace.fs as any).stat = async (uri: Uri) => {
    const path = uri.fsPath;
    if (mockFiles.has(path)) {
        return { type: 1 }; // File
    }
    throw new Error('File not found');
};

const baseConfig: DiagnosticConfig = {
    enabled: true,
    defaultLocale: 'en',
    missingSeverity: DiagnosticSeverity.Warning,
    untranslatedEnabled: false,
    untranslatedSeverity: DiagnosticSeverity.Warning,
    invalidSeverity: DiagnosticSeverity.Warning,
    missingReferenceEnabled: true,
    missingReferenceSeverity: DiagnosticSeverity.Error,
    verboseLogging: false,
};

const fakeProjectConfigService = {
    readConfig: async () => null,
} as unknown as ProjectConfigService;

const createRecord = (key: string, locale: string, path: string, value?: string): TranslationRecord => ({
    key,
    defaultLocale: 'en',
    locales: new Map([[locale, value !== undefined ? value : 'Value']]),
    locations: [{ locale, uri: Uri.file(path) }],
});

const createAnalyzer = (records: TranslationRecord[]): DiagnosticAnalyzer => {
    // Group records by key and merge their locales
    const recordsByKey = new Map<string, TranslationRecord>();
    
    for (const record of records) {
        const existing = recordsByKey.get(record.key);
        if (existing) {
            // Merge locales and locations
            for (const [locale, value] of record.locales) {
                existing.locales.set(locale, value);
            }
            existing.locations.push(...record.locations);
        } else {
            recordsByKey.set(record.key, { ...record });
        }
    }
    
    const fakeIndex = {
        ensureInitialized: async () => undefined,
        getAllKeys: () => Array.from(recordsByKey.keys()),
        getRecord: (key: string) => recordsByKey.get(key),
        getKeysForFile: (uri: Uri) => {
            const path = uri.fsPath;
            for (const record of recordsByKey.values()) {
                for (const loc of record.locations) {
                    if (loc.uri.fsPath === path) {
                        return {
                            locale: loc.locale,
                            keys: [record.key],
                        };
                    }
                }
            }
            return undefined;
        },
        getAllLocales: () => ['en', 'fr', 'de'],
    } as unknown as I18nIndex;

    return new DiagnosticAnalyzer(fakeIndex, fakeProjectConfigService, new MockOutputChannel());
};

describe('Laravel Diagnostic Issues', () => {
    beforeEach(() => {
        fileContent = '';
        mockFiles.clear();
    });

    it('should NOT flag existing Laravel keys in PHP source files', async () => {
        const analyzer = createAnalyzer([
            createRecord('messages.welcome', 'en', '/resources/lang/en/messages.php', 'Welcome'),
            createRecord('auth.failed', 'en', '/resources/lang/en/auth.php', 'These credentials do not match our records.'),
            createRecord('validation.required', 'en', '/resources/lang/en/validation.php', 'The :attribute field is required.'),
        ]);

        // Test PHP file with Laravel translation calls
        fileContent = `<?php
echo __('messages.welcome');
echo __("auth.failed");
if ($error) {
    echo __('validation.required');
}
`;
        const uri = Uri.file('/resources/views/welcome.blade.php');

        const diagnostics = await analyzer.analyzeSourceFile(uri, baseConfig);

        // Should have NO diagnostics since all keys exist
        expect(diagnostics).toHaveLength(0);
    });

    it('should flag missing Laravel keys in PHP source files', async () => {
        const analyzer = createAnalyzer([
            createRecord('messages.welcome', 'en', '/resources/lang/en/messages.php', 'Welcome'),
            // Note: auth.failed is missing
            createRecord('validation.required', 'en', '/resources/lang/en/validation.php', 'The :attribute field is required.'),
        ]);

        // Test PHP file with Laravel translation calls including a missing key
        fileContent = `<?php
echo __('messages.welcome');
echo __("auth.failed"); // This should be flagged as missing
if ($error) {
    echo __('validation.required');
}
`;
        const uri = Uri.file('/resources/views/welcome.blade.php');

        const diagnostics = await analyzer.analyzeSourceFile(uri, baseConfig);

        // Should have exactly 1 diagnostic for the missing key
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.code).toBe('ai-i18n.missing-reference');
        expect(diagnostics[0]?.message).toContain('auth.failed');
    });

    it('should correctly differentiate between Laravel view files and regular PHP files', async () => {
        const analyzer = createAnalyzer([
            createRecord('messages.welcome', 'en', '/resources/lang/en/messages.php', 'Welcome'),
            createRecord('app.title', 'en', '/locales/en/app.json', 'App Title'),
        ]);

        // Test Laravel Blade file (should be treated as Laravel)
        const bladeContent = "<?php echo __('messages.welcome'); ?>";
        const bladeUri = Uri.file('/resources/views/welcome.blade.php');

        // Test regular PHP file (should ALSO be treated as Laravel - all PHP files in Laravel use Laravel translations)
        const phpContent = "<?php echo __('app.title'); ?>";
        const phpUri = Uri.file('/app/Services/SomeService.php');

        // Mock workspace folder to ensure proper framework detection
        (workspace.getWorkspaceFolder as any) = (_uri: Uri) => {
            return { uri: Uri.file('/project'), name: 'project' };
        };

        // Set the correct content for each file
        fileContent = bladeContent;
        const bladeDiagnostics = await analyzer.analyzeSourceFile(bladeUri, baseConfig);
        
        fileContent = phpContent;
        const phpDiagnostics = await analyzer.analyzeSourceFile(phpUri, baseConfig);

        // Blade file should have no diagnostics (messages.welcome is a Laravel key)
        expect(bladeDiagnostics).toHaveLength(0);
        
        // PHP file SHOULD have diagnostics (app.title is a JSON key, but this PHP file should be treated as Laravel)
        // In Laravel, ALL PHP files should use Laravel PHP translation keys, not JSON keys
        expect(phpDiagnostics.length).toBeGreaterThan(0);
        expect(phpDiagnostics[0]?.message).toContain('app.title');
    });

    it('should correctly handle transactions.api_invalid_account key', async () => {
        const analyzer = createAnalyzer([
            createRecord('transactions.api_invalid_account', 'en', '/resources/lang/en/transactions.php', 'Invalid account'),
        ]);

        // Test PHP file using the transactions key
        fileContent = "<?php echo __('transactions.api_invalid_account'); ?>";
        const phpUri = Uri.file('/app/Repositories/TransactionRepository.php');

        const diagnostics = await analyzer.analyzeSourceFile(phpUri, baseConfig);

        // Should have no diagnostics since the key exists and is a Laravel key
        expect(diagnostics).toHaveLength(0);
    });

    it('should NOT flag Laravel locale files with missing default locale diagnostics incorrectly', async () => {
        // This test checks if Laravel locale files are being incorrectly flagged
        // for missing default locale translations when they shouldn't be
        const analyzer = createAnalyzer([
            createRecord('messages.welcome', 'en', '/resources/lang/en/messages.php', 'Welcome'),
            createRecord('messages.welcome', 'fr', '/resources/lang/fr/messages.php', 'Bienvenue'),
        ]);

        // Set up mock file content for the Laravel locale file
        mockFiles.set('/resources/lang/en/messages.php', '<?php return ["welcome" => "Welcome"];');
        
        const uri = Uri.file('/resources/lang/en/messages.php');
        const diagnostics = await analyzer.analyzeFile(uri, baseConfig);

        console.log('Laravel locale file diagnostics:', diagnostics.length);
        diagnostics.forEach(d => console.log('  -', d.message, d.code));

        // Should have no diagnostics since the Laravel locale file is correct
        expect(diagnostics).toHaveLength(0);
    });

    it('should handle Laravel trans() and @lang directives', async () => {
        const analyzer = createAnalyzer([
            createRecord('messages.hello', 'en', '/resources/lang/en/messages.php', 'Hello'),
            createRecord('buttons.save', 'en', '/resources/lang/en/buttons.php', 'Save'),
        ]);

        // Test with trans() and @lang
        fileContent = `<?php
echo trans('messages.hello');
echo trans('buttons.missing'); // This should be flagged
?>
@lang('buttons.save')
@lang('messages.missing') {{-- This should be flagged --}}
`;
        const uri = Uri.file('/resources/views/example.blade.php');

        const diagnostics = await analyzer.analyzeSourceFile(uri, baseConfig);

        // Should flag the two missing keys
        expect(diagnostics).toHaveLength(2);
        const missingKeys = diagnostics.map(d => d.message.match(/"([^"]+)"/)?.[1]).filter(Boolean);
        expect(missingKeys).toContain('buttons.missing');
        expect(missingKeys).toContain('messages.missing');
    });

    it('should not flag Laravel locale files for missing references', async () => {
        const analyzer = createAnalyzer([
            createRecord('messages.welcome', 'en', '/resources/lang/en/messages.php', 'Welcome'),
        ]);

        // Test the actual locale file - should not be analyzed for missing references
        fileContent = '<?php return ["welcome" => "Welcome"];';
        const uri = Uri.file('/resources/lang/en/messages.php');

        const diagnostics = await analyzer.analyzeSourceFile(uri, baseConfig);

        // Should have no diagnostics since locale files are skipped
        expect(diagnostics).toHaveLength(0);
    });
});
