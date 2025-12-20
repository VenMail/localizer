import { describe, it, expect } from 'vitest';
import { STRING_PATTERNS, CODE_PATTERNS } from '../src/commands/untranslated/utils/StringPatterns';

describe('STRING_PATTERNS', () => {
    it('matches JSX expression strings', () => {
        const sample = "const view = <h1>{'Hello world'}</h1>;";
        const matches = [...sample.matchAll(STRING_PATTERNS.jsxExpr)];
        expect(matches).toHaveLength(1);
        expect(matches[0][2]).toBe('Hello world');
    });

    it('captures property values and quote type', () => {
        const snippet = "description: `Detailed summary here`,";
        const match = snippet.match(STRING_PATTERNS.property);
        expect(match).not.toBeNull();
        expect(match?.[1]).toBe('`');
        expect(match?.[2]).toBe('Detailed summary here');
    });

    it('finds generic string literals', () => {
        const snippet = "const message = 'Saved!';";
        const genericMatches = [...snippet.matchAll(STRING_PATTERNS.generic)];
        expect(genericMatches).toHaveLength(1);
        expect(genericMatches[0][2]).toBe('Saved!');
    });

    it('extracts template literal body', () => {
        const snippet = 'const tpl = `Order ${total}`;';
        const templateMatches = [...snippet.matchAll(STRING_PATTERNS.template)];
        expect(templateMatches).toHaveLength(1);
        expect(templateMatches[0][1]).toBe('Order ${total}');
    });

    it('matches blade array pairs', () => {
        const snippet = "'title' => 'Dashboard'";
        const match = snippet.match(STRING_PATTERNS.bladeArray);
        expect(match).not.toBeNull();
        expect(match?.[2]).toBe('title');
        expect(match?.[4]).toBe('Dashboard');
    });
});

describe('CODE_PATTERNS', () => {
    it('identifies JS-like code strings', () => {
        const snippet = 'const user = { name: "J" };';
        const looksLikeCode = CODE_PATTERNS.some((regex) => regex.test(snippet));
        expect(looksLikeCode).toBe(true);
    });
});
