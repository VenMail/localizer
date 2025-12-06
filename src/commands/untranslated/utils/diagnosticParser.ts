/**
 * Parse untranslated diagnostic message to extract key and locales
 */
export function parseUntranslatedDiagnostic(message: string): { key: string; locales: string[] } | null {
    if (!message) return null;

    const missingNewMatch = message.match(/^Missing translation for "(.+?)"\s*\[([A-Za-z0-9_-]+)\]/);
    if (missingNewMatch) {
        const key = missingNewMatch[1].trim();
        const locale = missingNewMatch[2].trim();
        return { key, locales: [locale] };
    }

    const untranslatedNewMatch = message.match(
        /^Untranslated \(same as default\) "(.+?)"\s*\[([A-Za-z0-9_-]+)\]/,
    );
    if (untranslatedNewMatch) {
        const key = untranslatedNewMatch[1].trim();
        const locale = untranslatedNewMatch[2].trim();
        return { key, locales: [locale] };
    }

    const clean = message.replace(/^AI i18n:\s*/, '');

    const missingMatch = clean.match(
        /^Missing translation for key\s+(.+?)\s+in locale\s+([A-Za-z0-9_-]+)/,
    );
    if (missingMatch) {
        const key = missingMatch[1].trim();
        const locale = missingMatch[2].trim();
        return { key, locales: [locale] };
    }

    const untranslatedMatch = clean.match(
        /^Untranslated \(same as default\) value for key\s+(.+?)\s+in locale\s+([A-Za-z0-9_-]+)/,
    );
    if (untranslatedMatch) {
        const key = untranslatedMatch[1].trim();
        const locale = untranslatedMatch[2].trim();
        return { key, locales: [locale] };
    }

    const selectionMatch = clean.match(
        /^Missing translations for\s+(.+?)\s+in locales:\s+(.+)$/,
    );
    if (selectionMatch) {
        const key = selectionMatch[1].trim();
        const localesRaw = selectionMatch[2]
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
        if (!key || !localesRaw.length) return null;
        return { key, locales: localesRaw };
    }

    return null;
}

/**
 * Parse style diagnostic message to extract key, locale, and suggested value
 */
export function parseStyleDiagnostic(message: string): { key: string; locale: string; suggested: string } | null {
    if (!message) return null;

    const newMatch = message.match(/^Style suggestion "(.+?)"\s*\[([A-Za-z0-9_-]+)\]\s*\(([^)]*)\)/);
    if (newMatch) {
        const key = newMatch[1].trim();
        const locale = newMatch[2].trim();
        const details = newMatch[3] || '';
        const sugMatch = details.match(/suggested:\s*([^|)]+)/i);
        const suggested = sugMatch ? sugMatch[1].trim() : '';
        if (!key || !locale || !suggested) return null;
        return { key, locale, suggested };
    }

    const clean = String(message).replace(/^AI i18n:\s*/, '');
    const legacyMatch = clean.match(
        /^Style suggestion for key\s+(.+?)\s+in locale\s+([A-Za-z0-9_-]+)\s*\(([^)]*)\)/,
    );
    if (!legacyMatch) return null;
    const key = legacyMatch[1].trim();
    const locale = legacyMatch[2].trim();
    const details = legacyMatch[3] || '';
    const sugMatch = details.match(/suggested:\s*([^|)]+)/i);
    const suggested = sugMatch ? sugMatch[1].trim() : '';
    if (!key || !locale || !suggested) return null;
    return { key, locale, suggested };
}

