import { describe, it, expect } from 'vitest';
import { TranslationKeyGenerator } from '../src/commands/untranslated/utils/TranslationKeyGenerator';

describe('TranslationKeyGenerator.generateKey', () => {
    it('generates key using namespace, kind, and slug', () => {
        const key = TranslationKeyGenerator.generateKey({
            kind: 'text',
            namespace: 'Dashboard',
            sourceText: 'Hello world'
        });
        expect(key).toBe('Commons.text.hello_world');
    });

    it('falls back to Commons namespace for short text', () => {
        const key = TranslationKeyGenerator.generateKey({
            kind: 'button',
            namespace: 'Profile',
            sourceText: 'OK'
        });
        expect(key.startsWith('Commons.button')).toBe(true);
    });
});

describe('TranslationKeyGenerator.getTextKinds', () => {
    it('lists available kinds', () => {
        const kinds = TranslationKeyGenerator.getTextKinds();
        expect(kinds.map((k) => k.label)).toContain('button');
    });
});

describe('TranslationKeyGenerator.inferKindFromTag', () => {
    it('maps headings to heading kind', () => {
        expect(TranslationKeyGenerator.inferKindFromTag('h1')).toBe('heading');
    });

    it('defaults to text', () => {
        expect(TranslationKeyGenerator.inferKindFromTag('custom')).toBe('text');
    });
});

describe('TranslationKeyGenerator.inferKindFromAttr', () => {
    it('recognizes placeholder attributes', () => {
        expect(TranslationKeyGenerator.inferKindFromAttr('placeholder')).toBe('placeholder');
    });

    it('defaults to text for unknown attributes', () => {
        expect(TranslationKeyGenerator.inferKindFromAttr('data-test')).toBe('text');
    });
});
