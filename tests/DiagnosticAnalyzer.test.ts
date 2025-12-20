import { describe, it, expect, beforeEach } from 'vitest';
import { DiagnosticAnalyzer, DiagnosticConfig } from '../src/services/diagnosticAnalyzer';
import { MockOutputChannel, workspace, Uri, DiagnosticSeverity } from 'vscode';
import type { I18nIndex, TranslationRecord } from '../src/core/i18nIndex';
import type { ProjectConfigService } from '../src/services/projectConfigService';

const encoder = new TextEncoder();
let fileContent = '';

(workspace.fs as any).readFile = async () => encoder.encode(fileContent);

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

const createRecord = (key: string, locale: string, path: string): TranslationRecord => ({
    key,
    defaultLocale: 'en',
    locales: new Map([[locale, 'Value']]),
    locations: [{ locale, uri: Uri.file(path) }],
});

const createAnalyzer = (records: TranslationRecord[]): DiagnosticAnalyzer => {
    const map = new Map<string, TranslationRecord>();
    records.forEach((record) => map.set(record.key, record));
    const fakeIndex = {
        ensureInitialized: async () => undefined,
        getAllKeys: () => Array.from(map.keys()),
        getRecord: (key: string) => map.get(key),
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
});
