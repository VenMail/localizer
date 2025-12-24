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

/**
 * Parse invalid/non-translatable diagnostic to extract key.
 */
export function parseInvalidDiagnostic(message: string): { key: string } | null {
    if (!message) return null;

    const newMatch = message.match(/^Invalid\/non-translatable value "(.+?)"\s*\[/);
    if (newMatch) {
        const key = newMatch[1].trim();
        if (!key) return null;
        return { key };
    }

    const clean = message.replace(/^AI i18n:\s*/, '');
    const m = clean.match(/^Invalid\/non-translatable default value for key\s+(.+?)\s+in locale\s+/);
    if (!m) return null;
    const key = m[1].trim();
    if (!key) return null;
    return { key };
}

/**
 * Parse placeholder mismatch diagnostic to extract key and locale.
 */
export function parsePlaceholderDiagnostic(message: string): { key: string; locale: string } | null {
    if (!message) return null;

    const newMatch = message.match(/^Placeholder mismatch "(.+?)"\s*\[([A-Za-z0-9_-]+)\]/);
    if (newMatch) {
        const key = newMatch[1].trim();
        const locale = newMatch[2].trim();
        if (!key || !locale) return null;
        return { key, locale };
    }

    const clean = message.replace(/^AI i18n:\s*/, '');
    const m = clean.match(/^Placeholder mismatch for key\s+(.+?)\s+in locale\s+([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const key = m[1].trim();
    const locale = m[2].trim();
    if (!key || !locale) return null;
    return { key, locale };
}

/**
 * Parse missing translation key reference diagnostics to extract key.
 */
export function parseMissingReferenceDiagnostic(message: string): { key: string } | null {
    if (!message) return null;

    const match = message.match(/^Missing translation key "(.+?)"/);
    if (match) {
        const key = match[1].trim();
        if (!key) return null;
        return { key };
    }

    const altMatch = message.match(/^Translation key "(.+?)"\s+is not defined/);
    if (altMatch) {
        const key = altMatch[1].trim();
        if (!key) return null;
        return { key };
    }

    return null;
}

/**
 * Parse missing default locale diagnostic to extract key and default locale.
 */
export function parseMissingDefaultDiagnostic(message: string): { key: string; defaultLocale: string; existingLocales: string[] } | null {
    if (!message || typeof message !== 'string') return null;

    // More robust regex that handles whitespace and edge cases
    const match = message.match(/^Missing default locale translation for "([^"]+)"\s*\[([A-Za-z0-9_-]+)\]\s*\(exists in:\s*([^)]+)\)/);
    if (!match) return null;

    const [, key, defaultLocale, existingLocalesStr] = match;
    
    // Validate and clean the extracted values
    const cleanKey = key.trim();
    const cleanDefaultLocale = defaultLocale.trim();
    const existingLocales = existingLocalesStr
        .split(',')
        .map(l => l.trim())
        .filter(l => l.length > 0); // Filter out empty strings

    // Additional validation
    if (!cleanKey || !cleanDefaultLocale || existingLocales.length === 0) {
        return null;
    }

    // Validate locale format (basic check)
    if (!/^[A-Za-z0-9_-]+$/.test(cleanDefaultLocale)) {
        return null;
    }

    // Validate existing locales format
    const invalidLocales = existingLocales.filter(l => !/^[A-Za-z0-9_-]+$/.test(l));
    if (invalidLocales.length > 0) {
        return null;
    }

    return { 
        key: cleanKey, 
        defaultLocale: cleanDefaultLocale, 
        existingLocales 
    };
}

