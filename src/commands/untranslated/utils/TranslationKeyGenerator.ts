/**
 * Translation key generation utility
 * Extracted from ConvertSelectionCommand to improve organization and reusability
 */

import { slugifyForKey } from '../../../core/i18nIndex';

export interface KeyGenerationOptions {
    kind: string;
    namespace: string;
    sourceText: string;
}

export class TranslationKeyGenerator {
    /**
     * Generate a translation key based on source text and context
     */
    static generateKey(options: KeyGenerationOptions): string {
        const { kind, namespace, sourceText } = options;
        
        let baseNamespace = namespace;
        if (this.isCommonShortText(sourceText)) {
            baseNamespace = 'Commons';
        }
        
        const slug = slugifyForKey(sourceText);
        return `${baseNamespace}.${kind}.${slug}`;
    }

    /**
     * Determine if text should use Commons namespace
     * Common short text gets special namespace treatment
     */
    private static isCommonShortText(text: string): boolean {
        const trimmed = String(text || '').trim();
        if (!trimmed) {
            return false;
        }
        const cleaned = trimmed.replace(/\s+/g, ' ').trim();
        if (/[.!?]/.test(cleaned)) {
            return false;
        }
        const words = cleaned.split(' ').filter((w) => !!w);
        if (!words.length || words.length > 2) {
            return false;
        }
        if (cleaned.length > 24) {
            return false;
        }
        if (/[/_]/.test(cleaned)) {
            return false;
        }
        return true;
    }

    /**
     * Get available text kinds for user selection
     */
    static getTextKinds(): Array<{ label: string; description: string }> {
        return [
            { label: 'text', description: 'Generic UI text (default)' },
            { label: 'heading', description: 'Headings and titles' },
            { label: 'button', description: 'Buttons and primary actions' },
            { label: 'label', description: 'Field labels and chips' },
            { label: 'placeholder', description: 'Input placeholders' },
            { label: 'toast', description: 'Toast and notification messages' },
        ];
    }

    /**
     * Infer kind from tag name (for context-aware key generation)
     */
    static inferKindFromTag(tagName: string): string {
        if (!tagName) return 'text';
        const lower = tagName.toLowerCase();

        const tagKinds: Record<string, string> = {
            // Headings
            'h1': 'heading', 'h2': 'heading', 'h3': 'heading',
            'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
            'title': 'heading',
            
            // Buttons and actions
            'button': 'button',
            'a': 'button', 'link': 'button',
            
            // Labels and form elements
            'label': 'label', 'span': 'label',
            'div': 'text', 'p': 'text',
            
            // Inputs
            'textarea': 'placeholder', 'input': 'placeholder',
            'select': 'placeholder', 'option': 'label',
            
            // Tables
            'th': 'heading', 'td': 'text',
            'caption': 'text',
            
            // Lists
            'li': 'text', 'dt': 'heading', 'dd': 'text',
            
            // Media
            'img': 'text', 'figure': 'text', 'figcaption': 'text',
            
            // Semantic HTML5
            'header': 'heading', 'footer': 'text',
            'nav': 'button', 'aside': 'text',
            'article': 'heading', 'section': 'heading',
            'main': 'heading',
            
            // Forms
            'form': 'text', 'fieldset': 'heading',
            'legend': 'heading',
            
            // Interactive
            'summary': 'button', 'details': 'text',
        };

        return tagKinds[lower] || 'text';
    }

    /**
     * Infer kind from attribute name
     */
    static inferKindFromAttr(attrName: string): string {
        if (!attrName) return 'text';
        const lower = attrName.toLowerCase();

        const attrKinds: Record<string, string> = {
            // Text content
            'title': 'heading', 'alt': 'text', 'label': 'label',
            'placeholder': 'placeholder', 'value': 'text',
            
            // ARIA attributes
            'aria-label': 'label', 'aria-placeholder': 'placeholder',
            'aria-description': 'text', 'aria-title': 'heading',
            
            // Common attributes
            'tooltip': 'text', 'hint': 'text', 'help': 'text',
            'description': 'text', 'summary': 'text',
            
            // Form attributes
            'name': 'label', 'id': 'text', 'class': 'text',
            
            // Link attributes
            'href': 'text', 'src': 'text', 'data-*': 'text'
        };

        return attrKinds[lower] || 'text';
    }

    /**
     * Validate generated key for common issues
     */
    static validateKey(key: string): { isValid: boolean; issues: string[] } {
        const issues: string[] = [];

        if (!key || typeof key !== 'string') {
            issues.push('Key must be a non-empty string');
            return { isValid: false, issues };
        }

        if (key.length > 200) {
            issues.push('Key is too long (max 200 characters)');
        }

        if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
            issues.push('Key contains invalid characters (only letters, numbers, dots, hyphens, underscores allowed)');
        }

        if (key.startsWith('.') || key.endsWith('.')) {
            issues.push('Key cannot start or end with a dot');
        }

        if (key.includes('..')) {
            issues.push('Key cannot contain consecutive dots');
        }

        const parts = key.split('.');
        if (parts.length < 2) {
            issues.push('Key should have at least namespace and kind parts (e.g., "Commons.button.save")');
        }

        if (parts.length > 5) {
            issues.push('Key has too many parts (max 5 parts recommended)');
        }

        return { isValid: issues.length === 0, issues };
    }
}
