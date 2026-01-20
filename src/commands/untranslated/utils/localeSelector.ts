import { I18nIndex } from '../../../core/i18nIndex';

/**
 * Utility class for intelligent locale selection
 * Centralizes the logic for choosing the best source locale for translation operations
 */
export class LocaleSelector {
    /**
     * Select the best source locale for copying translation to default locale
     * Uses multiple factors: locale priority, content quality, semantic similarity, and language family
     */
    static selectBestSourceLocale(
        key: string, 
        existingLocales: string[], 
        defaultLocale: string,
        i18nIndex: I18nIndex
    ): string {
        if (existingLocales.length === 0) {
            throw new Error('No existing locales available');
        }
        
        if (existingLocales.length === 1) {
            return existingLocales[0];
        }

        // Priority order for locales (prefer English variants and common languages)
        const localePriority = ['en', 'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IE', 'en-NZ', 'en-ZA', 'en-IN'];
        
        // Extract key segments for semantic matching - only allowed for common/general keys
        const keySegments = this.extractKeySegments(key);
        const allowSemanticMatching = key.toLowerCase().includes('common') || key.toLowerCase().includes('general');
        
        // Score each locale based on multiple factors
        const localeScores = existingLocales.map(locale => {
            let score = 0;
            
            // Factor 1: Locale priority (higher is better)
            const priorityIndex = localePriority.indexOf(locale);
            if (priorityIndex !== -1) {
                score += (localePriority.length - priorityIndex) * 10;
            }
            
            // Factor 2: Key similarity - check if this locale has similar keys
            const record = i18nIndex.getRecord(key);
            if (record) {
                const sourceValue = record.locales.get(locale);
                if (sourceValue) {
                    // Prefer non-empty values
                    if (sourceValue.trim()) {
                        score += 5;
                    }
                    
                    // Prefer values that look like actual translations (not placeholders)
                    if (!sourceValue.includes('TODO') && !sourceValue.includes('FIXME') && !sourceValue.includes('placeholder')) {
                        score += 3;
                    }
                    
                    // Prefer reasonable length (not too short, not too long)
                    const length = sourceValue.length;
                    if (length >= 3 && length <= 200) {
                        score += 2;
                    }
                    
                    // Factor 4: Semantic similarity between key and translation content
                    // ONLY allow semantic matching for keys containing 'common' or 'general'
                    if (allowSemanticMatching) {
                        const semanticScore = this.calculateSemanticSimilarity(keySegments, sourceValue);
                        score += semanticScore;
                    }
                }
            }
            
            // Factor 3: Locale similarity to default locale
            if (locale.startsWith(defaultLocale.split('-')[0])) {
                score += 8; // Same language family
            }
            
            return { locale, score };
        });
        
        // Sort by score (highest first) and return the best locale
        localeScores.sort((a, b) => b.score - a.score);
        
        return localeScores[0].locale;
    }

    /**
     * Extract meaningful segments from a translation key
     */
    private static extractKeySegments(key: string): string[] {
        return key
            .split('.')
            .filter(segment => segment.length > 0)
            .map(segment => segment.toLowerCase().replace(/[_-]/g, ' '))
            .filter(segment => !['common', 'general', 'ui', 'text', 'label', 'title', 'message'].includes(segment));
    }

    /**
     * Calculate semantic similarity between key segments and translation content
     */
    private static calculateSemanticSimilarity(keySegments: string[], translationValue: string): number {
        if (keySegments.length === 0) return 0;
        
        const valueLower = translationValue.toLowerCase();
        let similarityScore = 0;
        
        // Check for direct word matches
        for (const segment of keySegments) {
            const words = segment.split(' ').filter(word => word.length > 2);
            for (const word of words) {
                if (valueLower.includes(word)) {
                    similarityScore += 4;
                }
            }
        }
        
        // Check for related concepts (import vs import, file vs file, etc.)
        const relatedConcepts: Record<string, string[]> = {
            'import': ['import', 'importer', 'importar', 'importieren', 'importa'],
            'export': ['export', 'exporter', 'exportar', 'exportieren'],
            'file': ['file', 'fichier', 'archivo', 'datei', 'file'],
            'save': ['save', 'sauvegarder', 'guardar', 'speichern'],
            'delete': ['delete', 'supprimer', 'eliminar', 'löschen'],
            'create': ['create', 'créer', 'crear', 'erstellen'],
            'edit': ['edit', 'modifier', 'editar', 'bearbeiten'],
            'cancel': ['cancel', 'annuler', 'cancelar', 'abbrechen'],
            'submit': ['submit', 'soumettre', 'enviar', 'absenden'],
            'error': ['error', 'erreur', 'error', 'fehler'],
            'success': ['success', 'succès', 'éxito', 'erfolg'],
            'warning': ['warning', 'avertissement', 'advertencia', 'warnung'],
            'failed': ['failed', 'échec', 'error', 'fehlgeschlagen', 'fallido'],
            'heading': ['heading', 'titre', 'título', 'überschrift', 'titolo'],
            'title': ['title', 'titre', 'título', 'titel', 'titolo'],
        };
        
        for (const segment of keySegments) {
            const words = segment.split(' ').filter(word => word.length > 2);
            for (const word of words) {
                const concepts = relatedConcepts[word];
                if (concepts) {
                    for (const concept of concepts) {
                        if (valueLower.includes(concept)) {
                            similarityScore += 2;
                        }
                    }
                }
            }
        }
        
        // Penalize negative semantic matches (e.g., "failed" when looking for "import")
        const negativeWords = ['failed', 'error', 'échec', 'error', 'fehlgeschlagen', 'fallido'];
        const positiveWords = ['import', 'save', 'create', 'success', 'succès', 'éxito', 'erfolg'];
        
        const hasNegativeMatch = negativeWords.some(word => valueLower.includes(word));
        const hasPositiveMatch = positiveWords.some(word => valueLower.includes(word));
        
        if (hasNegativeMatch && hasPositiveMatch) {
            // Mixed content, slight penalty
            similarityScore -= 1;
        } else if (hasNegativeMatch && !hasPositiveMatch && keySegments.some(s => s.includes('import') || s.includes('save') || s.includes('create'))) {
            // Negative content for positive key, bigger penalty
            similarityScore -= 3;
        }
        
        return Math.max(0, similarityScore); // Don't return negative scores
    }
}
