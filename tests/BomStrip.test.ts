import { describe, it, expect } from 'vitest';
import { stripUtf8Bom, decodeUtf8 } from '../src/core/i18nFs';

describe('stripUtf8Bom', () => {
    it('removes a leading U+FEFF', () => {
        const withBom = '\uFEFF{"key":"value"}';
        expect(stripUtf8Bom(withBom)).toBe('{"key":"value"}');
    });

    it('returns input unchanged when no BOM', () => {
        const plain = '{"key":"value"}';
        expect(stripUtf8Bom(plain)).toBe(plain);
    });

    it('never strips an interior U+FEFF', () => {
        const mid = 'abc\uFEFFdef';
        expect(stripUtf8Bom(mid)).toBe(mid);
    });

    it('tolerates empty input', () => {
        expect(stripUtf8Bom('')).toBe('');
    });
});

describe('decodeUtf8', () => {
    it('strips UTF-8 BOM bytes (EF BB BF)', () => {
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]); // \uFEFF{}
        // After decode() we get "\uFEFF{}", stripUtf8Bom removes the FEFF code point.
        expect(decodeUtf8(bytes)).toBe('{}');
    });

    it('decodes plain UTF-8 unchanged', () => {
        const bytes = new TextEncoder().encode('{"a":1}');
        expect(decodeUtf8(bytes)).toBe('{"a":1}');
    });
});
