/**
 * Consolidated template literal processing utility
 * Combines logic from analyzeTemplateLiteral and extractStaticPartsFromTemplate
 */

export interface TemplateInfo {
    baseText: string;
    placeholders: Array<{ name: string; expression: string }>;
}

export interface StaticPart {
    text: string;
    offset: number;
}

export class TemplateLiteralProcessor {
    /**
     * Analyze a template literal and extract base text with placeholders
     * Combines the logic from analyzeTemplateLiteral method
     */
    static analyze(rawLiteral: string): TemplateInfo | null {
        if (!rawLiteral || rawLiteral.length < 2 || rawLiteral[0] !== '`' || rawLiteral[rawLiteral.length - 1] !== '`') {
            return null;
        }

        const inner = rawLiteral.slice(1, -1);
        const placeholders: Array<{ name: string; expression: string }> = [];
        let baseText = '';
        let lastIndex = 0;
        const usedNames = new Set<string>();

        const interpolationRegex = /\$\{([^}]*)\}/g;
        let match: RegExpExecArray | null;
        
        while ((match = interpolationRegex.exec(inner)) !== null) {
            const expr = match[1].trim();
            baseText += inner.slice(lastIndex, match.index);

            if (expr.length > 0) {
                let name: string | null = null;

                // Handle .length patterns
                const lengthMatch = expr.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\.length\s*$/);
                if (lengthMatch && lengthMatch[1]) {
                    const base = lengthMatch[1];
                    name = /count$/i.test(base) ? base : `${base}Count`;
                }

                // Handle identifier patterns
                if (!name) {
                    const idMatch = expr.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
                    if (idMatch && idMatch[1]) {
                        name = idMatch[1];
                    }
                }

                // Generate fallback name
                if (!name) {
                    name = `value${placeholders.length + 1}`;
                }

                // Ensure unique name
                let uniqueName = name;
                let counter = 2;
                while (usedNames.has(uniqueName)) {
                    uniqueName = `${name}${counter}`;
                    counter += 1;
                }
                usedNames.add(uniqueName);

                placeholders.push({ name: uniqueName, expression: expr });
                baseText += `{${uniqueName}}`;
            }

            lastIndex = interpolationRegex.lastIndex;
        }

        baseText += inner.slice(lastIndex);
        return { baseText, placeholders };
    }

    /**
     * Extract static text parts from a template literal, excluding interpolations
     * Combines the logic from extractStaticPartsFromTemplate method
     */
    static extractStaticParts(template: string): StaticPart[] {
        const parts: StaticPart[] = [];
        
        // Split by ${...} interpolations
        const segments = template.split(/\$\{[^}]*\}/);
        let currentOffset = 0;
        
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (segment.trim().length > 0) {
                parts.push({ text: segment, offset: currentOffset });
            }
            
            // Move offset forward by segment length + interpolation length
            currentOffset += segment.length;
            if (i < segments.length - 1) {
                // Find the interpolation that was removed
                const remainingTemplate = template.substring(currentOffset);
                const interpolationMatch = remainingTemplate.match(/^\$\{[^}]*\}/);
                if (interpolationMatch) {
                    currentOffset += interpolationMatch[0].length;
                }
            }
        }
        
        return parts;
    }

    /**
     * Get combined static text from template literal
     * Useful for validation and translatability checks
     */
    static getCombinedStaticText(template: string): string {
        const staticParts = this.extractStaticParts(template);
        return staticParts.map(p => p.text).join(' ').trim();
    }

    /**
     * Check if template literal has meaningful static content
     */
    static hasTranslatableContent(template: string): boolean {
        const combinedText = this.getCombinedStaticText(template);
        return combinedText.length > 0 && !/^[.,;:!?'"()[\]{}<>\/\\|@#$%^&*+=~`-]+$/.test(combinedText);
    }

    /**
     * Create replacement string for template literal with placeholders
     */
    static createReplacement(baseText: string, placeholders: Array<{ name: string; expression: string }>): string {
        if (placeholders.length === 0) {
            return `'${baseText}'`;
        }

        const argsObject = placeholders
            .map(p => `${p.name}: ${p.expression}`)
            .join(', ');
        
        return `t('${baseText}', { ${argsObject} })`;
    }
}
