import { describe, it, expect } from 'vitest';
import { FrameworkCodeGenerator } from '../src/commands/untranslated/utils/FrameworkCodeGenerator';
import { MockTextDocument } from './utils/mockTextDocument';
import { Range, Position } from 'vscode';

const fullRange = (doc: MockTextDocument): Range => {
    const lastLine = doc.lineCount - 1;
    return new Range(new Position(0, 0), new Position(lastLine, doc.lineAt(lastLine).text.length));
};

describe('FrameworkCodeGenerator.generateReplacement', () => {
    it('returns Blade expression for Blade files', () => {
        const doc = new MockTextDocument('Blade content', 'blade', 'file.blade.php');
        const result = FrameworkCodeGenerator.generateReplacement({
            document: doc as any,
            range: fullRange(doc),
            key: 'App.text.heading'
        });
        expect(result).toBe("{{ __('App.text.heading') }}");
    });

    it('returns Vue $t call for Vue files', () => {
        const doc = new MockTextDocument('<template></template>', 'vue', 'comp.vue');
        const result = FrameworkCodeGenerator.generateReplacement({
            document: doc as any,
            range: fullRange(doc),
            key: 'App.button.submit'
        });
        expect(result).toBe("{{$t('App.button.submit')}}");
    });

    it('includes placeholder arguments for JS template literals', () => {
        const source = 'const label = `Welcome ${user.name}!`;';
        const doc = new MockTextDocument(source, 'typescript');
        const templateInfo = {
            baseText: 'Welcome {name}!',
            placeholders: [{ name: 'name', expression: 'user.name' }],
        };
        const replacement = FrameworkCodeGenerator.generateReplacement({
            document: doc as any,
            range: fullRange(doc),
            key: 'App.text.welcome',
            templateInfo,
            isJsSource: true,
        });
        expect(replacement).toBe("t('App.text.welcome', { name: user.name })");
    });
});

describe('FrameworkCodeGenerator.addImportIfNeeded', () => {
    const makeDoc = (text: string, languageId = 'typescript') => new MockTextDocument(text, languageId);

    it('inserts import when missing in JS files', () => {
        const doc = makeDoc("const value = t('foo');");
        const edit = FrameworkCodeGenerator.createEdit({
            document: doc as any,
            range: fullRange(doc),
            key: 'App.text.sample'
        });
        FrameworkCodeGenerator.addImportIfNeeded(doc as any, edit, '@/i18n');
        const operations = (edit as any).getOperations();
        const insertOp = operations.find((op: any) => op.type === 'insert');
        expect(insertOp?.text).toContain("import { t } from '@/i18n';");
    });

    it('skips import for Vue files', () => {
        const doc = makeDoc('<template></template>', 'vue');
        const edit = FrameworkCodeGenerator.createEdit({
            document: doc as any,
            range: fullRange(doc),
            key: 'App.text.sample'
        });
        FrameworkCodeGenerator.addImportIfNeeded(doc as any, edit, '@/i18n');
        const operations = (edit as any).getOperations();
        expect(operations.filter((op: any) => op.type === 'insert')).toHaveLength(0);
    });
});
