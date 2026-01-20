import { computeEditDistance } from './textAnalysis';

/**
 * Calculate semantic similarity between two translation keys
 * This prevents false matches like "import_file" vs "failed_to_import_file"
 */
export function calculateKeySimilarity(key1: string, key2: string): number {
    if (key1 === key2) return 1.0; // Perfect match
    
    const parts1 = key1.split('.').filter(Boolean);
    const parts2 = key2.split('.').filter(Boolean);
    
    // Different number of parts suggests different semantic meaning
    const partCountDiff = Math.abs(parts1.length - parts2.length);
    if (partCountDiff > 1) {
        return 0.1; // Very low similarity for significantly different structures
    }
    
    // Check if keys have opposite semantic meanings
    if (hasOppositeMeaning(key1, key2)) {
        return 0.0; // No similarity for opposite meanings
    }
    
    // Calculate similarity based on common segments
    const commonSegments = findCommonSegments(parts1, parts2);
    const totalSegments = Math.max(parts1.length, parts2.length);
    
    if (totalSegments === 0) return 0.0;
    
    const segmentSimilarity = commonSegments.length / totalSegments;
    
    // Calculate edit distance for the most different segments
    let maxEditDistance = 0;
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const segment1 = parts1[i] || '';
        const segment2 = parts2[i] || '';
        const distance = computeEditDistance(segment1, segment2);
        const maxLen = Math.max(segment1.length, segment2.length);
        const normalizedDistance = maxLen > 0 ? distance / maxLen : 0;
        maxEditDistance = Math.max(maxEditDistance, normalizedDistance);
    }
    
    // Combine segment similarity with edit distance
    const editSimilarity = 1 - maxEditDistance;
    const overallSimilarity = (segmentSimilarity * 0.7) + (editSimilarity * 0.3);
    
    return Math.max(0, Math.min(1, overallSimilarity));
}

/**
 * Check if two keys have opposite or significantly different semantic meanings
 * Uses pattern-based analysis instead of hardcoded dictionaries
 */
function hasOppositeMeaning(key1: string, key2: string): boolean {
    const key1Lower = key1.toLowerCase();
    const key2Lower = key2.toLowerCase();
    
    // Extract semantic patterns from both keys
    const patterns1 = extractSemanticPatterns(key1Lower);
    const patterns2 = extractSemanticPatterns(key2Lower);
    
    // Check for direct semantic opposites
    for (const pattern1 of patterns1) {
        for (const pattern2 of patterns2) {
            if (areSemanticOpposites(pattern1, pattern2)) {
                return true;
            }
        }
    }
    
    // Check if one has negative/failed patterns and the other has positive/action patterns
    const hasNegative1 = patterns1.some(p => p.type === 'failure' || p.type === 'negative');
    const hasNegative2 = patterns2.some(p => p.type === 'failure' || p.type === 'negative');
    const hasPositive1 = patterns1.some(p => p.type === 'success' || p.type === 'action');
    const hasPositive2 = patterns2.some(p => p.type === 'success' || p.type === 'action');
    
    return (hasNegative1 && hasPositive2) || (hasNegative2 && hasPositive1);
}

/**
 * Extract semantic patterns from a key using pattern recognition
 */
export function extractSemanticPatterns(key: string): SemanticPattern[] {
    const patterns: SemanticPattern[] = [];
    
    // Failure/negative patterns - more comprehensive
    const failurePatterns = [
        /(failed|failure|error|unable|cannot|could_not|not_able|invalid|wrong|incorrect|bad|missing|absent)/g,
        /(unsuccessful|unavailable|inaccessible|forbidden|denied|rejected|declined|refused|blocked)/g,
        /(no_|not_|non_|un_|in_|dis_|mis_|anti_|contra_|counter_|de_|revert|reset)/g,
        /(broken|crashed|corrupted|damaged|lost|stolen|expired|timeout|cancelled|aborted)/g,
        /(empty|void|null|undefined|none|nothing|zero|blank|clear)/g
    ];
    
    // Success/positive patterns
    const successPatterns = [
        /(success|successful|complete|completed|done|finished|ready|ok|good|valid|correct)/g,
        /(available|accessible|allowed|permitted|granted|approved|accepted|confirmed|verified)/g,
        /(active|alive|working|functional|operational|running|loaded|saved|stored)/g,
        /(full|filled|populated|loaded|ready|prepared|initialized|started|launched)/g
    ];
    
    // Action patterns - more comprehensive
    const actionPatterns = [
        /(import|export|save|load|create|delete|add|remove|edit|modify|update|change|replace)/g,
        /(show|hide|display|reveal|conceal|open|close|start|stop|begin|end|finish|terminate)/g,
        /(submit|cancel|confirm|reject|accept|approve|deny|allow|forbid|grant|revoke)/g,
        /(enable|disable|activate|deactivate|turn_on|turn_off|switch|toggle|power|unpower)/g,
        /(connect|disconnect|link|unlink|join|leave|enter|exit|login|logout|signin|signout)/g,
        /(upload|download|send|receive|transmit|transfer|copy|move|rename|duplicate)/g,
        /(install|uninstall|setup|teardown|build|destroy|compile|execute|run|halt)/g,
        /(lock|unlock|secure|encrypt|decrypt|protect|unprotect|guard|unguard)/g,
        /(increase|decrease|grow|shrink|expand|contract|magnify|minify|zoom_in|zoom_out)/g,
        /(merge|split|combine|separate|join|divide|unite|group|ungroup)/g
    ];
    
    // State patterns
    const statePatterns = [
        /(active|inactive|enabled|disabled|on|off|open|closed|visible|hidden|shown|hidden)/g,
        /(busy|idle|waiting|pending|processing|loading|saving|deleting|updating)/g,
        /(online|offline|connected|disconnected|synced|unsynced|linked|unlinked)/g,
        /(locked|unlocked|secured|unsecured|protected|unprotected)/g,
        /(focused|unfocused|selected|unselected|checked|unchecked|marked|unmarked)/g
    ];
    
    // Check for failure patterns
    for (const pattern of failurePatterns) {
        const matches = key.matchAll(pattern);
        for (const match of matches) {
            patterns.push({ type: 'failure', word: match[0], position: match.index || 0 });
        }
    }
    
    // Check for success patterns
    for (const pattern of successPatterns) {
        const matches = key.matchAll(pattern);
        for (const match of matches) {
            patterns.push({ type: 'success', word: match[0], position: match.index || 0 });
        }
    }
    
    // Check for action patterns
    for (const pattern of actionPatterns) {
        const matches = key.matchAll(pattern);
        for (const match of matches) {
            patterns.push({ type: 'action', word: match[0], position: match.index || 0 });
        }
    }
    
    // Check for state patterns
    for (const pattern of statePatterns) {
        const matches = key.matchAll(pattern);
        for (const match of matches) {
            patterns.push({ type: 'state', word: match[0], position: match.index || 0 });
        }
    }
    
    return patterns;
}

/**
 * Check if two semantic patterns are opposites
 */
function areSemanticOpposites(pattern1: SemanticPattern, pattern2: SemanticPattern): boolean {
    const word1 = pattern1.word.toLowerCase();
    const word2 = pattern2.word.toLowerCase();
    
    // Direct semantic opposites
    const semanticOpposites = [
        ['import', 'export'],
        ['save', 'load'],
        ['create', 'delete'],
        ['add', 'remove'],
        ['edit', 'view'],
        ['show', 'hide'],
        ['display', 'conceal'],
        ['open', 'close'],
        ['start', 'stop'],
        ['begin', 'end'],
        ['submit', 'cancel'],
        ['confirm', 'reject'],
        ['accept', 'decline'],
        ['approve', 'deny'],
        ['enable', 'disable'],
        ['activate', 'deactivate'],
        ['turn_on', 'turn_off'],
        ['switch', 'toggle'],
        ['success', 'failure'],
        ['complete', 'incomplete'],
        ['active', 'inactive'],
        ['enabled', 'disabled'],
        ['on', 'off'],
        ['visible', 'hidden'],
        ['connect', 'disconnect'],
        ['login', 'logout'],
        ['upload', 'download'],
        ['install', 'uninstall'],
        ['lock', 'unlock'],
        ['increase', 'decrease'],
        ['expand', 'contract'],
        ['merge', 'split'],
        ['join', 'separate']
    ];
    
    // Check for direct semantic opposites
    for (const [opposite1, opposite2] of semanticOpposites) {
        if ((word1.includes(opposite1) && word2.includes(opposite2)) ||
            (word1.includes(opposite2) && word2.includes(opposite1))) {
            return true;
        }
    }
    
    // Pattern-based opposites
    if (pattern1.type === 'action' && pattern2.type === 'failure') return true;
    if (pattern1.type === 'failure' && pattern2.type === 'action') return true;
    if (pattern1.type === 'success' && pattern2.type === 'failure') return true;
    if (pattern1.type === 'failure' && pattern2.type === 'success') return true;
    if (pattern1.type === 'state' && pattern2.type === 'failure') return true;
    if (pattern1.type === 'failure' && pattern2.type === 'state') return true;
    
    return false;
}

interface SemanticPattern {
    type: 'action' | 'failure' | 'negative' | 'state' | 'success';
    word: string;
    position: number;
}

/**
 * Find common segments between two key part arrays
 */
function findCommonSegments(parts1: string[], parts2: string[]): string[] {
    const common: string[] = [];
    
    for (const part1 of parts1) {
        for (const part2 of parts2) {
            if (areSegmentsSimilar(part1, part2)) {
                if (!common.includes(part1)) {
                    common.push(part1);
                }
                break;
            }
        }
    }
    
    return common;
}

/**
 * Check if two key segments are similar enough to be considered the same
 * Uses robust pattern analysis instead of hardcoded dictionaries
 */
function areSegmentsSimilar(segment1: string, segment2: string): boolean {
    if (segment1 === segment2) return true;
    
    const seg1Lower = segment1.toLowerCase();
    const seg2Lower = segment2.toLowerCase();
    
    // Extract semantic patterns for both segments
    const patterns1 = extractSemanticPatterns(seg1Lower);
    const patterns2 = extractSemanticPatterns(seg2Lower);
    
    // If both segments have semantic patterns, check for compatibility
    if (patterns1.length > 0 && patterns2.length > 0) {
        // Check if they have opposite meanings
        for (const pattern1 of patterns1) {
            for (const pattern2 of patterns2) {
                if (areSemanticOpposites(pattern1, pattern2)) {
                    return false; // Opposite meanings are not similar
                }
            }
        }
        
        // Check if they have the same semantic type
        const types1 = new Set(patterns1.map(p => p.type));
        const types2 = new Set(patterns2.map(p => p.type));
        
        // If both are action words, they must be very similar
        if (types1.has('action') && types2.has('action')) {
            return calculateActionSimilarity(seg1Lower, seg2Lower) > 0.8;
        }
        
        // If both are failure/negative words, they must be very similar
        if ((types1.has('failure') || types1.has('negative')) && 
            (types2.has('failure') || types2.has('negative'))) {
            return calculateActionSimilarity(seg1Lower, seg2Lower) > 0.8;
        }
    }
    
    // Check for common variations (singular/plural, common synonyms)
    const variations: Record<string, string[]> = {
        'file': ['files'],
        'user': ['users'],
        'item': ['items'],
        'data': ['datum'],
        'status': ['state'],
        'message': ['messages'],
        'button': ['buttons'],
        'form': ['forms'],
        'page': ['pages'],
        'list': ['lists'],
        'table': ['tables'],
        'modal': ['modals'],
        'dialog': ['dialogs'],
        'window': ['windows'],
        'tab': ['tabs'],
        'menu': ['menus'],
        'icon': ['icons'],
        'image': ['images'],
        'text': ['texts'],
        'label': ['labels'],
        'title': ['titles'],
        'header': ['headers'],
        'footer': ['footers'],
        'sidebar': ['sidebars'],
        'navbar': ['navbars'],
        'content': ['contents'],
        'body': ['bodies'],
        'section': ['sections'],
        'article': ['articles'],
        'component': ['components'],
        'element': ['elements'],
        'widget': ['widgets'],
        'control': ['controls'],
        'field': ['fields'],
        'input': ['inputs'],
        'output': ['outputs'],
        'result': ['results'],
        'value': ['values'],
        'option': ['options'],
        'choice': ['choices'],
        'selection': ['selections'],
        'setting': ['settings'],
        'config': ['configs'],
        'parameter': ['parameters'],
        'property': ['properties'],
        'attribute': ['attributes'],
        'feature': ['features'],
        'function': ['functions'],
        'method': ['methods'],
        'operation': ['operations'],
        'process': ['processes'],
        'task': ['tasks'],
        'job': ['jobs'],
        'work': ['works'],
        'activity': ['activities'],
        'event': ['events'],
        'action': ['actions'],
        'behavior': ['behaviors'],
        'state': ['states'],
        'condition': ['conditions'],
        'requirement': ['requirements'],
        'specification': ['specifications'],
        'description': ['descriptions'],
        'information': ['informations'],
        'details': ['detail'],
        'summary': ['summaries'],
        'overview': ['overviews'],
        'introduction': ['introductions'],
        'conclusion': ['conclusions'],
        'beginning': ['beginnings'],
        'end': ['ends'],
        'start': ['starts'],
        'stop': ['stops'],
        'middle': ['middles'],
        'center': ['centers'],
        'top': ['tops'],
        'bottom': ['bottoms'],
        'left': ['lefts'],
        'right': ['rights'],
        'front': ['fronts'],
        'back': ['backs'],
        'inside': ['insides'],
        'outside': ['outsides'],
        'above': ['aboves'],
        'below': ['belows'],
        'before': ['befores'],
        'after': ['afters'],
        'during': ['durings'],
        'while': ['whiles'],
        'when': ['whens'],
        'where': ['wheres'],
        'how': ['hows'],
        'why': ['whys'],
        'what': ['whats'],
        'which': ['whiches'],
        'who': ['whos'],
        'whom': ['whoms'],
        'whose': ['whoses'],
    };
    
    // Check if one is a variation of the other
    for (const [base, variants] of Object.entries(variations)) {
        if ((segment1 === base && variants.includes(segment2)) ||
            (segment2 === base && variants.includes(segment1))) {
            return true;
        }
    }
    
    // Use edit distance for remaining cases, but be more strict
    const distance = computeEditDistance(segment1, segment2);
    const maxLen = Math.max(segment1.length, segment2.length);
    const normalizedDistance = maxLen > 0 ? distance / maxLen : 1;
    
    // Consider similar only if edit distance is less than 20% of the longer string
    return normalizedDistance < 0.2;
}

/**
 * Calculate similarity between action words with strict criteria
 */
function calculateActionSimilarity(word1: string, word2: string): number {
    if (word1 === word2) return 1.0;
    
    // Extract the base action part (remove common prefixes/suffixes)
    const base1 = extractActionBase(word1);
    const base2 = extractActionBase(word2);
    
    if (base1 === base2) return 0.9;
    
    // Use edit distance on the base parts
    const distance = computeEditDistance(base1, base2);
    const maxLen = Math.max(base1.length, base2.length);
    const normalizedDistance = maxLen > 0 ? distance / maxLen : 1;
    
    return 1 - normalizedDistance;
}

/**
 * Extract the base action part from a word
 */
function extractActionBase(word: string): string {
    // Remove common prefixes
    const prefixes = ['re', 'un', 'de', 'dis', 'mis', 'over', 'under', 'pre', 'post', 'sub', 'super', 'auto', 'co', 'counter', 'hyper', 'mega', 'micro', 'mini', 'multi', 'neo', 'non', 'over', 'para', 'post', 'pro', 'pseudo', 'quasi', 'semi', 'sub', 'super', 'trans', 'ultra', 'un'];
    
    let base = word;
    for (const prefix of prefixes) {
        if (base.startsWith(prefix) && base.length > prefix.length) {
            base = base.substring(prefix.length);
            break;
        }
    }
    
    // Remove common suffixes
    const suffixes = ['ing', 'ed', 'er', 'est', 'ly', 'tion', 'sion', 'ment', 'ness', 'ity', 'able', 'ible', 'ous', 'ious', 'al', 'ial', 'ic', 'ical', 'ize', 'ise', 'fy', 'fy', 'en'];
    
    for (const suffix of suffixes) {
        if (base.endsWith(suffix) && base.length > suffix.length) {
            base = base.substring(0, base.length - suffix.length);
            break;
        }
    }
    
    return base;
}

/**
 * Find the best matching key for a given target key from a list of candidates
 * Returns null if no good match is found
 * Only allows similarity matching for keys containing 'common' or 'general' to prevent incorrect matches
 */
export function findBestKeyMatch(
    targetKey: string, 
    candidateKeys: string[], 
    threshold: number = 0.6
): string | null {
    // Only allow key similarity matching for keys containing 'common' or 'general'
    const allowMatching = targetKey.toLowerCase().includes('common') || targetKey.toLowerCase().includes('general');
    
    if (!allowMatching) {
        return null; // Prevent guessing/restoring from unrelated keys
    }
    
    let bestMatch: string | null = null;
    let bestScore = 0;
    
    for (const candidate of candidateKeys) {
        if (!candidate || candidate === targetKey) continue;
        
        const score = calculateKeySimilarity(targetKey, candidate);
        if (score > bestScore && score >= threshold) {
            bestScore = score;
            bestMatch = candidate;
        }
    }
    
    return bestMatch;
}
