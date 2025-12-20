import { describe, it, expect } from 'vitest';
import { TemplateLiteralProcessor } from '../src/commands/untranslated/utils/TemplateLiteralProcessor';

describe('TemplateLiteralProcessor.analyze', () => {
    it('extracts base text and placeholders from template literal', () => {
        const info = TemplateLiteralProcessor.analyze('`Hello ${user.name}! You have ${count} messages`');
        expect(info).not.toBeNull();
        expect(info?.baseText).toBe('Hello {name}! You have {count} messages');
        expect(info?.placeholders).toEqual([
            { name: 'name', expression: 'user.name' },
            { name: 'count', expression: 'count' }
        ]);
    });

    it('returns null for non-template strings', () => {
        const info = TemplateLiteralProcessor.analyze('"plain"');
        expect(info).toBeNull();
    });
});

describe('TemplateLiteralProcessor.extractStaticParts', () => {
    it('returns static segments between interpolations', () => {
        const parts = TemplateLiteralProcessor.extractStaticParts('Hello ${user} world ${place}!');
        expect(parts.map((p) => p.text.trim())).toEqual(['Hello', 'world', '!']);
    });
});

describe('TemplateLiteralProcessor.getCombinedStaticText', () => {
    it('joins static segments into a single string', () => {
        const combined = TemplateLiteralProcessor.getCombinedStaticText('Welcome ${user} to ${place}!');
        expect(combined).toBe('Welcome   to  !');
    });
});
