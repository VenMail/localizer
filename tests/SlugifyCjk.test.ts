import { describe, it, expect } from 'vitest';
import { slugifyForKey } from '../src/core/i18nIndex';

describe('slugifyForKey — CJK source strings', () => {
    it('produces distinct keys for distinct Chinese phrases', () => {
        const a = slugifyForKey('确定');
        const b = slugifyForKey('请输入PPT主题');
        const c = slugifyForKey('弹入');
        expect(a).not.toBe('text');
        expect(b).not.toBe('text');
        expect(c).not.toBe('text');
        expect(new Set([a, b, c]).size).toBe(3);
    });

    it('still honours ASCII slugs for mixed content', () => {
        expect(slugifyForKey('Hello World')).toBe('hello_world');
    });

    it('returns stable hash for same CJK input', () => {
        const a = slugifyForKey('无法读取文件');
        const b = slugifyForKey('无法读取文件');
        expect(a).toBe(b);
    });

    it('never emits a bare "text" fallback for non-empty input', () => {
        expect(slugifyForKey('关闭')).not.toBe('text');
    });

    it('uses plain "text" only for empty / whitespace input', () => {
        expect(slugifyForKey('')).toBe('text');
        expect(slugifyForKey('   ')).toBe('text');
    });
});
