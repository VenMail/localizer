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

describe('DiagnosticAnalyzer.analyzeSourceFile', () => {
    beforeEach(() => {
        fileContent = '';
    });

    it('reports missing references for unmatched t() calls in JS/TS files', async () => {
        const analyzer = createAnalyzer([
            createRecord('app.valid', 'en', '/locales/en/app.json'),
        ]);
        fileContent = "const label = t('app.missing');";
        const uri = Uri.file('/src/App.tsx');

        const diagnostics = await analyzer.analyzeSourceFile(uri, baseConfig);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.code).toBe('ai-i18n.missing-reference');
        expect(diagnostics[0]?.message).toContain('app.missing');
    });

    it('skips matches that occur inside comments or string literals', async () => {
        const analyzer = createAnalyzer([
            createRecord('app.valid', 'en', '/locales/en/app.json'),
        ]);
        fileContent = `// t('app.missing') inside comment\nconst doc = "Example with $t('app.missing')";`;
        const uri = Uri.file('/src/Info.ts');

        const diagnostics = await analyzer.analyzeSourceFile(uri, baseConfig);

        expect(diagnostics).toHaveLength(0);
    });

    it('detects missing Laravel translation helpers like __() in PHP files', async () => {
        const analyzer = createAnalyzer([
            createRecord('laravel.valid', 'en', '/resources/lang/en/messages.php'),
        ]);
        fileContent = "<?php echo __('laravel.missing'); ?>";
        const uri = Uri.file('/resources/views/example.php');

        const diagnostics = await analyzer.analyzeSourceFile(uri, baseConfig);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.message).toContain('laravel.missing');
    });

    it('skips false positives in complex/minified code', async () => {
        const analyzer = createAnalyzer([
            createRecord('app.valid', 'en', '/locales/en/app.json'),
        ]);
        // This should NOT be flagged as a missing translation because it's complex code
        fileContent = 't("div",{class:a(l(he)("rounded-xl border bg-card text-card-foreground shadow"';
        const uri = Uri.file('/src/Component.tsx');

        const diagnostics = await analyzer.analyzeSourceFile(uri, baseConfig);

        expect(diagnostics).toHaveLength(0);
    });

    it('skips false positives in JSX expressions', async () => {
        const analyzer = createAnalyzer([
            createRecord('app.valid', 'en', '/locales/en/app.json'),
        ]);
        // This should NOT be flagged as a missing translation because it's JSX
        fileContent = '<div className={t("some-class")}>Content</div>';
        const uri = Uri.file('/src/Component.tsx');

        const diagnostics = await analyzer.analyzeSourceFile(uri, baseConfig);

        expect(diagnostics).toHaveLength(0);
    });
});

describe('DiagnosticAnalyzer.analyzeFile', () => {
    beforeEach(() => {
        fileContent = '';
        mockFiles.clear();
    });

    it('flags missing translations in default locale when other locales exist', async () => {
        // Set up mock file content for the default locale file with missing translation
        mockFiles.set('/locales/en/app.json', JSON.stringify({
            "app.title": "" // Empty string = missing translation
        }));
        
        const analyzer = createAnalyzer([
            createRecord('app.title', 'en', '/locales/en/app.json', ''), // Missing in default locale
            createRecord('app.title', 'fr', '/locales/fr/app.json', 'Titre'), // Present in French  
            createRecord('app.title', 'de', '/locales/de/app.json', 'Titel'), // Present in German
        ]);
        
        const uri = Uri.file('/locales/en/app.json');
        const diagnostics = await analyzer.analyzeFile(uri, baseConfig);

        expect(diagnostics.length).toBeGreaterThan(0);
        const missingDiag = diagnostics.find(d => d.code === 'ai-i18n.missing-default');
        expect(missingDiag).toBeDefined();
        expect(missingDiag?.message).toContain('Missing default locale translation for "app.title" [en]');
    });

    it('flags missing translations in non-default locales', async () => {
        // Set up mock file content for the French locale file with missing translation
        mockFiles.set('/locales/fr/app.json', JSON.stringify({
            "app.title": "" // Empty string = missing translation
        }));
        
        const analyzer = createAnalyzer([
            createRecord('app.title', 'en', '/locales/en/app.json', 'Title'), // Present in default locale
            createRecord('app.title', 'fr', '/locales/fr/app.json', ''), // Missing in French
            createRecord('app.title', 'de', '/locales/de/app.json', 'Titel'), // Present in German
        ]);
        
        const uri = Uri.file('/locales/fr/app.json');
        const diagnostics = await analyzer.analyzeFile(uri, baseConfig);

        expect(diagnostics.length).toBeGreaterThan(0);
        const missingDiag = diagnostics.find(d => d.code === 'ai-i18n.untranslated');
        expect(missingDiag).toBeDefined();
        expect(missingDiag?.message).toContain('Missing translation for "app.title" [fr]');
    });
});
