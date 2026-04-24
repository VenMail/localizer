import { describe, it, expect } from 'vitest';
// The validators module is JS; require() keeps it simple and portable here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
    shouldTranslate,
    validateText,
    hasBasicRequirements,
    looksLikeHumanText,
} = require('../src/i18n/lib/validators/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isTranslatableText } = require('../src/i18n/lib/textValidation.js');

describe('validators — CJK / non-ASCII input', () => {
    it('hasBasicRequirements accepts short Chinese phrases', () => {
        expect(hasBasicRequirements('确定')).toBe(true);
        expect(hasBasicRequirements('弹入')).toBe(true);
        expect(hasBasicRequirements('无法读取文件')).toBe(true);
    });

    it('looksLikeHumanText accepts Chinese', () => {
        expect(looksLikeHumanText('确定')).toBe(true);
        expect(looksLikeHumanText('请输入PPT主题')).toBe(true);
    });

    it('shouldTranslate returns true for Chinese UI strings', () => {
        expect(shouldTranslate('确定')).toBe(true);
        expect(shouldTranslate('弹入')).toBe(true);
        expect(shouldTranslate('无法正确读取 / 解析该文件')).toBe(true);
        expect(shouldTranslate('请输入PPT主题，如：大学生职业生涯规划')).toBe(true);
    });

    it('validateText returns valid for Chinese', () => {
        const r = validateText('确定');
        expect(r.valid).toBe(true);
    });

    it('still rejects plain technical identifiers', () => {
        expect(shouldTranslate('bounceIn')).toBe(false);
    });

    it('isTranslatableText accepts Chinese', () => {
        expect(isTranslatableText('弹入')).toBe(true);
        expect(isTranslatableText('保存')).toBe(true);
    });
});
