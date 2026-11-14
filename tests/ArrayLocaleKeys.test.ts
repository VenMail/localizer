import { describe, expect, it } from 'vitest';
import { Uri } from 'vscode';
import { I18nIndex } from '../src/core/i18nIndex';

describe('#1 nested JSON array and object paths', () => {
    it('tracks structured array parent paths without converting them to scalar messages', () => {
        const index = new I18nIndex();
        const json = {
            howItWorks: {
                title: 'How It Works',
                steps: [
                    { title: 'Submit your email', description: 'Enter your email address' },
                    { title: 'Run a security scan', description: 'Check your website for vulnerabilities' },
                ],
            },
        };
        // Isolate the JSON-indexing behavior without workspace file discovery.
        (index as any).walkJson('', json, 'en', Uri.file('/project/src/locales/en.json'));
        expect(index.hasJsonContainerKey('howItWorks')).toBe(true);
        expect(index.hasJsonContainerKey('howItWorks.steps')).toBe(true);
        expect(index.hasJsonContainerKey('howItWorks.steps.0')).toBe(true);
        expect(index.getRecord('howItWorks.steps.0.title')?.locales.get('en')).toBe('Submit your email');
        expect(index.getRecord('howItWorks.steps.1.description')?.locales.get('en'))
            .toBe('Check your website for vulnerabilities');
        expect(index.getRecord('howItWorks.steps')).toBeUndefined();
        expect(index.hasJsonContainerKey('howItWorks.missing')).toBe(false);
    });

    it('preserves nested and mixed id-based catalogs', () => {
        const index = new I18nIndex();
        const json = { catalog: [{ id: 'welcome', translation: 'Welcome' }, { title: 'Step title' }] };
        (index as any).walkJson('', json, 'en', Uri.file('/project/src/locales/en.json'));
        expect(index.getRecord('catalog.welcome')?.locales.get('en')).toBe('Welcome');
        expect(index.getRecord('catalog.1.title')?.locales.get('en')).toBe('Step title');
    });
});
