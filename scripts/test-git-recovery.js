#!/usr/bin/env node
/* eslint-disable no-console */
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const { TextDecoder } = require('util');

const execFileAsync = promisify(execFile);
const decoder = new TextDecoder();

// Hardcoded target repo (mailer_web)
const repoRoot = path.resolve('c:\\dev\\mailer_web');

function parseArgs(argv) {
    const out = { locale: 'en' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--file' && argv[i + 1]) out.file = argv[i + 1];
        if (arg === '--key' && argv[i + 1]) out.key = argv[i + 1];
        if (arg === '--locale' && argv[i + 1]) out.locale = argv[i + 1];
    }
    return out;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function getKeyPathVariations(k) {
    const parts = k.split('.').filter(Boolean);
    const out = [k];
    if (parts.length > 1) out.push(parts.slice(1).join('.'));
    if (parts.length > 2) out.push(parts.slice(2).join('.'));
    out.push(parts[parts.length - 1]);
    if (parts.length > 2) out.push(parts.slice(-2).join('.'));
    return Array.from(new Set(out));
}
function looksLikeUserText(str) {
    const trimmed = str.trim();
    if (!trimmed || trimmed.length < 2) return false;
    if (!/[a-zA-Z]/.test(trimmed)) return false;
    if (/class(Name)?\s*=|style\s*=/.test(trimmed)) return false;
    return true;
}

function hasSuspiciousPlaceholderPattern(value) {
    // Pattern 1: Contains "value1", "value2", etc. WITHOUT braces (badly extracted placeholders)
    // First, remove all valid {placeholder} patterns from the text
    const withoutValidPlaceholders = value.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, '');
    
    // Now check if "value1", "value2", etc. appear in the remaining text (not in braces)
    if (/\b[Vv]alue\d+\b/.test(withoutValidPlaceholders)) {
        return true;
    }
    
    // Pattern 2: Contains common placeholder names in PascalCase or camelCase without braces
    const commonPlaceholders = /\b(Count|Total|Name|Value|Item|User|Email|Date|Time|Status|Type|Id)\b/;
    const hasCommonPlaceholder = commonPlaceholders.test(value);
    
    if (hasCommonPlaceholder) {
        // If it has multiple capital words in sequence, it's likely mangled
        if (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(value)) {
            return true;
        }
    }
    
    return false;
}
function calcScore(text, hintWords, hasTCall, placeholderHints) {
    let score = 0;
    const lower = text.toLowerCase();
    hintWords.forEach(h => { if (lower.includes(h)) score += 10; });
    placeholderHints.forEach(p => { if (lower.includes(p)) score += 3; });
    if (/^[A-Z]/.test(text)) score += 2;
    if (/[.!?]$/.test(text)) score += 2;
    if (text.includes(' ')) score += 1;
    if (hasTCall) score += 3;
    return score;
}
function derivePlaceholderName(expr) {
    const tokens = expr
        .trim()
        .replace(/\s+/g, ' ')
        .split(/[^A-Za-z0-9_]+/)
        .filter(Boolean);
    if (tokens.length === 0) return 'value';
    const candidate = tokens[tokens.length - 1].replace(/^\d+/, '');
    return (candidate || 'value').toLowerCase();
}
function normalizeTemplateLiteral(content) {
    if (!content) return null;
    const pieces = [];
    let lastIndex = 0;
    const exprPattern = /\$\{([^}]+)\}/g;
    let m;
    let placeholderIndex = 1;
    
    while ((m = exprPattern.exec(content)) !== null) {
        const staticText = content.slice(lastIndex, m.index);
        if (staticText) pieces.push(staticText);
        // Use generic value1, value2, etc. for multiple placeholders instead of derived names
        pieces.push(`{value${placeholderIndex}}`);
        placeholderIndex++;
        lastIndex = m.index + m[0].length;
    }
    if (lastIndex < content.length) {
        pieces.push(content.slice(lastIndex));
    }
    const normalized = pieces.join('').replace(/\s+/g, ' ').trim();
    if (!/[a-zA-Z]/.test(normalized)) return null;
    const withoutPlaceholders = normalized.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, ' ').trim();
    if (!withoutPlaceholders || !/[a-zA-Z]/.test(withoutPlaceholders)) return null;
    return normalized;
}
function extractPlaceholderHintsFromContent(content, k) {
    const placeholders = new Set();
    const pattern = new RegExp(`\\bt\\(\\s*['"]${escapeRegex(k)}['"]\\s*,\\s*\\{([^}]+)\\}`, 'g');
    let m;
    while ((m = pattern.exec(content)) !== null) {
        const obj = m[1];
        const props = obj.split(/[:,]/).map(p => p.trim());
        props.forEach(p => {
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p)) placeholders.add(p.toLowerCase());
        });
    }
    return Array.from(placeholders);
}
function extractHintWords(key) {
    const parts = key.split('.').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    return last
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);
}
async function getFileHistory(filePath, daysBack = 365, maxCommits = 200) {
    const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    const since = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
    const args = ['log', `--since=${since}`, '-n', String(maxCommits), '--format=%H|%s', '--', rel];
    let stdout = '';
    try {
        ({ stdout } = await execFileAsync('git', args, { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 }));
    } catch (e) {
        stdout = '';
    }
    let commits = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, ...msg] = line.split('|');
        return { hash: hash.trim(), message: msg.join('|').trim() };
    }).filter(c => c.hash);
    if (commits.length === 0) {
        const fbArgs = ['log', '-n', String(maxCommits), '--format=%H|%s', '--', rel];
        try {
            ({ stdout } = await execFileAsync('git', fbArgs, { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 }));
            commits = stdout.trim().split('\n').filter(Boolean).map(line => {
                const [hash, ...msg] = line.split('|');
                return { hash: hash.trim(), message: msg.join('|').trim() };
            }).filter(c => c.hash);
        } catch {
            commits = [];
        }
    }
    return commits;
}
async function getFileAtCommit(filePath, hash) {
    const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    try {
        const { stdout } = await execFileAsync('git', ['show', `${hash}:${rel}`], { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 });
        return stdout;
    } catch {
        return null;
    }
}
async function getDiff(filePath, from, to) {
    const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    try {
        const { stdout } = await execFileAsync('git', ['diff', from, to, '--', rel], { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 });
        return stdout;
    } catch {
        return null;
    }
}

async function searchLocaleFiles(locale) {
    const candidates = [];
    const patterns = [
        path.join('resources', 'js', 'i18n', 'auto', locale, '*.json'),
        path.join('resources', 'js', 'i18n', 'auto', locale, '**', '*.json'),
        path.join('locales', `${locale}.json`),
        path.join('locales', '**', `${locale}.json`),
        path.join('src', 'locales', locale, '*.json'),
        path.join('src', 'locales', locale, '**', '*.json'),
    ];
    for (const pattern of patterns) {
        try {
            const { stdout } = await execFileAsync('git', ['ls-files', pattern], { cwd: repoRoot });
            stdout.trim().split('\n').filter(Boolean).forEach(f => candidates.push(path.join(repoRoot, f)));
        } catch { /* ignore */ }
    }
    return Array.from(new Set(candidates));
}

async function findInLocaleHistory(localeFiles, keyPath) {
    const variations = getKeyPathVariations(keyPath);
    let foundSuspicious = false;
    
    for (const file of localeFiles) {
        if (foundSuspicious) break; // Skip remaining locale files if we found suspicious values
        
        const history = await getFileHistory(file, 365, 200);
        for (const commit of history) {
            const content = await getFileAtCommit(file, commit.hash);
            if (!content) continue;
            try {
                const json = JSON.parse(content);
                for (const variant of variations) {
                    const val = variant.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), json);
                    if (typeof val === 'string') {
                        // Quality check: skip suspicious placeholder patterns
                        if (hasSuspiciousPlaceholderPattern(val)) {
                            console.log(`    ⚠️  Found suspicious value in ${path.basename(file)}@${commit.hash.slice(0,7)}: "${val.slice(0, 50)}..." - skipping locale history`);
                            foundSuspicious = true;
                            break;
                        }
                        
                        return { value: val, source: `locale-history:${path.basename(file)}@${commit.hash.slice(0,7)}` };
                    }
                }
                
                if (foundSuspicious) break;
            } catch { /* ignore */ }
        }
    }
    return null;
}

async function recoverFromSource(filePath, keyPath, daysBack = 120) {
    const hintWords = extractHintWords(keyPath);
    const history = await getFileHistory(filePath, daysBack, 200);
    if (!history.length) {
        console.log('    No history found for source file');
        return null;
    }

    console.log(`    Searching ${history.length} commits in source file history`);
    console.log(`    Hint words: ${hintWords.join(', ')}`);

    const contentHead = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const placeholderHints = extractPlaceholderHintsFromContent(contentHead, keyPath);
    console.log(`    Placeholder hints: ${placeholderHints.join(', ')}`);
    
    const keyPattern = new RegExp(`\\bt\\(\\s*['"]${escapeRegex(keyPath)}['"]`);

    const keywordIdx = history.findIndex(c => /i18n|translat|lang|locale|intl/i.test(c.message));
    const ordered = keywordIdx >= 0 ? history.slice(keywordIdx) : history;
    console.log(`    Scanning ${ordered.length} commits (starting from translation commit if found)`);

    const tryDiffPair = async (older, newer) => {
        const diff = await getDiff(filePath, older, newer);
        if (!diff) return null;
        const lines = diff.split('\n');
        const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1));
        const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
        const hasT = added.some(l => keyPattern.test(l));

        if (hasT) {
            console.log(`      📝 Found t() call added in ${newer.slice(0,7)}, scanning ${removed.length} removed lines`);
        }

        const candidates = [];
        
        // First, try to extract from individual lines
        for (const line of removed) {
            const texts = extractAllUserTextFromContent(line, hintWords);
            
            if (hasT && texts.length > 0) {
                console.log(`        Extracted ${texts.length} text(s) from single line: "${line.slice(0, 100)}..."`);
                texts.forEach(t => console.log(`          - "${t.text.slice(0, 60)}..." (initial score: ${t.score})`));
            }
            
            for (const t of texts) {
                const lowerText = t.text.toLowerCase();
                const hm = hintWords.filter(h => lowerText.includes(h)).length;
                const phm = placeholderHints.filter(p => lowerText.includes(p)).length;
                if (hm === 0 && phm === 0) {
                    if (hasT) console.log(`          ⚠️  Rejected (no hint or placeholder matches): "${t.text.slice(0, 60)}..."`);
                    continue;
                }
                const tScore = t.score + (phm > 0 ? 3 * phm : 0) + (hasT ? 3 : 0);
                candidates.push({ text: t.text, score: tScore, hintMatches: hm, placeholderMatches: phm });
            }
        }
        
        // CRITICAL FIX: Also try extracting from joined removed lines (handles multi-line template literals)
        if (removed.length > 1) {
            const joinedRemoved = removed.join('\n');
            const joinedTexts = extractAllUserTextFromContent(joinedRemoved, hintWords);
            
            if (hasT && joinedTexts.length > 0) {
                console.log(`        Extracted ${joinedTexts.length} text(s) from joined removed lines (multi-line support)`);
                joinedTexts.forEach(t => console.log(`          - "${t.text.slice(0, 60)}..." (initial score: ${t.score})`));
            }
            
            for (const t of joinedTexts) {
                const lowerText = t.text.toLowerCase();
                const hm = hintWords.filter(h => lowerText.includes(h)).length;
                const phm = placeholderHints.filter(p => lowerText.includes(p)).length;
                if (hm === 0 && phm === 0) continue;
                const tScore = t.score + (phm > 0 ? 3 * phm : 0) + (hasT ? 3 : 0);
                candidates.push({ text: t.text, score: tScore, hintMatches: hm, placeholderMatches: phm });
            }
        }
        
        if (hasT && candidates.length > 0) {
            console.log(`      Found ${candidates.length} candidate(s) from removed lines:`);
            candidates.slice(0, 3).forEach(c => {
                console.log(`        - "${c.text.slice(0, 60)}..." (score: ${c.score}, hints: ${c.hintMatches}, ph: ${c.placeholderMatches})`);
            });
        }
        
        if (!candidates.length) return null;
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates.find(c => isAcceptableText(c.text, hintWords, placeholderHints));
        if (!best) {
            if (hasT) {
                console.log(`      ❌ No acceptable candidate found (all rejected by isAcceptableText)`);
            }
            return null;
        }
        if (hasT) {
            console.log(`      ✅ Selected: "${best.text.slice(0, 60)}..." (score: ${best.score})`);
        }
        return { value: best.text, source: `diff:${older.slice(0,7)}..${newer.slice(0,7)}` };
    };

    if (keywordIdx >= 0 && keywordIdx + 1 < ordered.length) {
        const hit = await tryDiffPair(ordered[1].hash, ordered[0].hash);
        if (hit) return hit;
    }

    for (let i = 0; i < ordered.length - 1; i++) {
        const hit = await tryDiffPair(ordered[i + 1].hash, ordered[i].hash);
        if (hit) return hit;
    }

    let bestCandidate = null;
    for (const commit of ordered) {
        const content = await getFileAtCommit(filePath, commit.hash);
        if (!content) continue;
        if (keyPattern.test(content)) continue;
        const texts = extractAllUserTextFromContent(content, hintWords);
        if (texts.length) {
            texts.sort((a, b) => b.score - a.score);
            const best = texts.find(t =>
                t.score >= 3 &&
                isAcceptableText(t.text, hintWords, placeholderHints)
            );
            if (best) {
                if (!bestCandidate || best.score > bestCandidate.score) {
                    bestCandidate = { value: best.text, source: `source:${commit.hash.slice(0,7)}`, score: best.score };
                }
            }
        }
    }
    if (bestCandidate) return { value: bestCandidate.value, source: bestCandidate.source };
    return null;
}

function extractAllUserTextFromContent(content, hintWords) {
    const candidates = [];
    const seen = new Set();
    const add = (text, bonus = 0) => {
        const t = text.trim();
        if (!t || seen.has(t) || !looksLikeUserText(t)) return;
        seen.add(t);
        const score = calcScore(t, hintWords, false, []);
        candidates.push({ text: t, score: score + bonus });
    };
    const jsxText = />([^<>{]+)</g;
    let m;
    while ((m = jsxText.exec(content)) !== null) add(m[1], 2);
    const tpl = /`([^`]+)`/g;
    while ((m = tpl.exec(content)) !== null) {
        const normalized = normalizeTemplateLiteral(m[1]);
        if (normalized) {
            add(normalized, 4);
        } else {
            add(m[1], 1);
        }
    }
    const dq = /"([^"\\]|\\.){3,}"/g;
    while ((m = dq.exec(content)) !== null) add(m[0].slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, ' '), 0);
    const sq = /'([^'\\]|\\.){3,}'/g;
    while ((m = sq.exec(content)) !== null) add(m[0].slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, ' '), 0);
    return candidates;
}

function hasSignalText(text, hintWords, placeholderHints) {
    const lower = text.toLowerCase();
    const hasHint = hintWords.some(h => lower.includes(h));
    const hasPh = placeholderHints.some(p => lower.includes(p));
    return hasHint || hasPh;
}

function isAcceptableText(text, hintWords, placeholderHints) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed.length > 160) return false;
    if (trimmed.includes('\n')) return false;
    if (trimmed.includes('.') && !/\s/.test(trimmed)) return false;
    if (!(/\s/.test(trimmed) || /\{[a-zA-Z_]/.test(trimmed))) return false;
    if (!hasSignalText(trimmed, hintWords, placeholderHints)) return false;
    return meetsHintThreshold(trimmed, hintWords, placeholderHints);
}

function meetsHintThreshold(text, hintWords, placeholderHints) {
    const lower = text.toLowerCase();
    const hintMatches = hintWords.filter(h => lower.includes(h)).length;
    const phMatches = placeholderHints.filter(p => lower.includes(p)).length;
    
    // Also count ANY placeholders in the text (even if they don't match hint names)
    const anyPlaceholders = (text.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) || []).length;
    
    const target = hintWords.length >= 3 ? Math.ceil(hintWords.length * 0.6) : 1;
    if (hintMatches >= target) return true;
    
    // Be lenient: if we have ANY placeholders and match most hint words, accept it
    if (hintMatches >= target - 1 && (phMatches > 0 || anyPlaceholders > 0) && hintWords.length >= 2) return true;
    
    return false;
}

(async () => {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed.file || !parsed.key) {
        console.error('Usage: node scripts/test-git-recovery.js --file <sourcePath> --key <i18n.key> [--locale en]');
        process.exit(1);
    }

    const sourcePath = path.resolve(repoRoot, parsed.file);
    const key = parsed.key;
    const locale = parsed.locale || 'en';

    console.log(`Repo: ${repoRoot}`);
    console.log(`Source: ${sourcePath}`);
    console.log(`Key: ${key}`);
    console.log(`Locale: ${locale}`);

    const localeFiles = await searchLocaleFiles(locale);
    let recovered = await findInLocaleHistory(localeFiles, key);
    if (recovered) {
        console.log('Recovered from locale history:', recovered);
        process.exit(0);
    }

    recovered = await recoverFromSource(sourcePath, key, 365);
    if (recovered) {
        console.log('Recovered from source history:', recovered);
        process.exit(0);
    }

    console.log('No value recovered.');
    process.exit(1);
})();

