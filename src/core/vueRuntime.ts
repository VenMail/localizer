import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { getProjectEnv } from './projectEnv';
import { stripUtf8Bom } from './i18nFs';

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function readText(uri: vscode.Uri): Promise<string | null> {
    try {
        const data = await vscode.workspace.fs.readFile(uri);
        return stripUtf8Bom(utf8Decoder.decode(data));
    } catch {
        return null;
    }
}

async function readJson<T = any>(uri: vscode.Uri): Promise<T | null> {
    const text = await readText(uri);
    if (!text) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

function hasPackageDep(pkg: any, name: string): boolean {
    if (!pkg || typeof pkg !== 'object') return false;
    const deps = pkg.dependencies || {};
    const dev = pkg.devDependencies || {};
    return !!(deps[name] || dev[name]);
}

/**
 * Greenfield bootstrap: install vue-i18n + scaffold locales + patch main.ts.
 * Fully interactive — every destructive step is gated behind a user prompt.
 * Returns true if the project is ready to extract, false if the user aborted.
 */
export async function bootstrapVueI18nProject(
    folder: vscode.WorkspaceFolder,
): Promise<boolean> {
    const env = await getProjectEnv(folder);
    if (env.framework?.kind !== 'vue' && env.framework?.kind !== 'nuxt') {
        return true; // Non-Vue project — nothing to bootstrap here.
    }

    const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
    const pkg = await readJson<any>(pkgUri);
    if (!pkg) {
        return true; // No package.json — let the standard flow handle this.
    }

    const alreadyHasVueI18n = hasPackageDep(pkg, 'vue-i18n');

    // Step 1: Offer to install vue-i18n if missing.
    if (!alreadyHasVueI18n) {
        const choice = await vscode.window.showInformationMessage(
            'This Vue project has no `vue-i18n` dependency. Install it now and scaffold `src/locales/` + main entry wiring?',
            { modal: true },
            'Install & scaffold',
            'Scaffold only',
            'Skip',
        );
        if (choice === 'Skip' || !choice) {
            return false;
        }
        if (choice === 'Install & scaffold') {
            const terminal = vscode.window.createTerminal({
                name: 'AI Localizer: vue-i18n install',
                cwd: folder.uri.fsPath,
            });
            terminal.show(true);
            // Prefer the detected package manager if present; fall back to npm.
            const hasPnpm = await fileExists(vscode.Uri.joinPath(folder.uri, 'pnpm-lock.yaml'));
            const hasYarn = await fileExists(vscode.Uri.joinPath(folder.uri, 'yarn.lock'));
            const installCmd = hasPnpm
                ? 'pnpm add vue-i18n@9'
                : hasYarn
                ? 'yarn add vue-i18n@9'
                : 'npm install vue-i18n@9';
            terminal.sendText(installCmd, true);
            vscode.window.showInformationMessage(
                `Running \`${installCmd}\` in terminal. Re-run First-Time Setup once install completes.`,
            );
        }
    }

    // Step 2: Scaffold empty locale files for every configured locale.
    const locales = Array.isArray(pkg?.aiI18n?.locales) && pkg.aiI18n.locales.length
        ? pkg.aiI18n.locales.filter((l: unknown) => typeof l === 'string' && l)
        : [env.sourceLocale];

    const localesDirUri = vscode.Uri.joinPath(folder.uri, env.localesDir);
    try {
        await vscode.workspace.fs.createDirectory(localesDirUri);
    } catch {
        // Already exists — fine.
    }

    for (const locale of locales) {
        if (env.localeLayout === 'single') {
            const localeFile = vscode.Uri.joinPath(localesDirUri, `${locale}.json`);
            if (!(await fileExists(localeFile))) {
                await vscode.workspace.fs.writeFile(
                    localeFile,
                    utf8Encoder.encode('{}\n'),
                );
            }
        } else {
            const localeDir = vscode.Uri.joinPath(localesDirUri, locale);
            try {
                await vscode.workspace.fs.createDirectory(localeDir);
            } catch {
                // ignore
            }
        }
    }

    // Step 3: Patch main entry — show diff, require confirmation.
    await patchVueMainEntry(folder, env.srcRoot, env.localesDir, locales, env.sourceLocale);

    return true;
}

async function patchVueMainEntry(
    folder: vscode.WorkspaceFolder,
    srcRoot: string,
    localesDir: string,
    locales: string[],
    sourceLocale: string,
): Promise<void> {
    const candidates = [
        `${srcRoot}/main.ts`,
        `${srcRoot}/main.js`,
        `${srcRoot}/main.mts`,
    ];
    let mainUri: vscode.Uri | null = null;
    for (const rel of candidates) {
        const uri = vscode.Uri.joinPath(folder.uri, rel);
        if (await fileExists(uri)) {
            mainUri = uri;
            break;
        }
    }
    if (!mainUri) {
        vscode.window.showWarningMessage(
            'AI Localizer: could not locate main.ts/main.js — skipped vue-i18n wiring. Add `app.use(i18n)` manually.',
        );
        return;
    }

    const original = await readText(mainUri);
    if (original === null) return;

    // Idempotency: don't re-patch if vue-i18n is already wired.
    if (/from ['"]vue-i18n['"]/.test(original) || /createI18n\s*\(/.test(original)) {
        return;
    }

    const localesImportPath = `${localesDir.replace(/^\.?\//, '').replace(new RegExp(`^${srcRoot}/`), '@/')}`;
    const importLines: string[] = [
        `import { createI18n } from 'vue-i18n';`,
    ];
    for (const locale of locales) {
        const safeIdent = locale.replace(/[^A-Za-z0-9_$]/g, '_');
        importLines.push(`import ${safeIdent} from '${localesImportPath}/${locale}.json';`);
    }
    const messagesEntries = locales
        .map((l) => `  '${l}': ${l.replace(/[^A-Za-z0-9_$]/g, '_')}`)
        .join(',\n');
    const setupBlock = [
        '',
        'const i18n = createI18n({',
        '  legacy: false,',
        `  locale: '${sourceLocale}',`,
        `  fallbackLocale: '${sourceLocale}',`,
        '  messages: {',
        messagesEntries,
        '  },',
        '});',
        '',
    ].join('\n');

    // Insert imports after the last import line; insert setup + .use(i18n) near createApp.
    const lines = original.split(/\r?\n/);
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i += 1) {
        if (/^\s*import\s.+from\s.+;?\s*$/.test(lines[i])) {
            lastImportIdx = i;
        }
    }
    const insertAt = lastImportIdx + 1;
    const patched = [
        ...lines.slice(0, insertAt),
        ...importLines,
        ...lines.slice(insertAt),
    ].join('\n');

    // Try to inject `.use(i18n)` into an existing createApp chain.
    let patchedWithSetup = patched;
    if (/createApp\s*\(/.test(patched)) {
        patchedWithSetup = patched.replace(
            /(createApp\s*\([^)]*\))(\s*)(\.\s*use\s*\([^)]*\))?/,
            (match, createCall, ws) => `${createCall}${ws}.use(i18n)${ws}`,
        );
        // Drop `.use(i18n)` duplicates if the regex double-injected.
        patchedWithSetup = patchedWithSetup.replace(/(\.use\(i18n\))\s*\1/g, '$1');
    }

    // Place the setup block just before the first `createApp`.
    patchedWithSetup = patchedWithSetup.replace(
        /(\n\s*const\s+\w+\s*=\s*createApp\s*\()/,
        `\n${setupBlock}$1`,
    );

    if (patchedWithSetup === original) {
        return;
    }

    const proceed = await vscode.window.showInformationMessage(
        `AI Localizer wants to patch ${path.relative(folder.uri.fsPath, mainUri.fsPath)} to wire vue-i18n. Review the file after changes.`,
        { modal: true },
        'Apply patch',
        'Skip',
    );
    if (proceed !== 'Apply patch') return;

    await vscode.workspace.fs.writeFile(mainUri, utf8Encoder.encode(patchedWithSetup));
    const doc = await vscode.workspace.openTextDocument(mainUri);
    await vscode.window.showTextDocument(doc);
}

export async function ensureVueI18nRuntime(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    _switcherRelativePath: string,
): Promise<void> {
    const env = await getProjectEnv(folder);
    const looksTs = env.isTypeScript;
    const runtimeFileName = looksTs ? 'index.ts' : 'index.js';
    const composableFileName = looksTs ? 'useTranslation.ts' : 'useTranslation.js';

    const runtimeRel = `${env.runtimeRoot}/${runtimeFileName}`;
    const composablesBase = env.composablesRoot || env.runtimeRoot.replace(/\/i18n$/, '/composables');
    const compRel = `${composablesBase}/${composableFileName}`;

    const runtimeUri = vscode.Uri.file(path.join(folder.uri.fsPath, runtimeRel));
    const compUri = vscode.Uri.file(path.join(folder.uri.fsPath, compRel));

    const runtimeExists = await fileExists(runtimeUri);
    const compExists = await fileExists(compUri);

    if (!runtimeExists) {
        const srcRuntime = vscode.Uri.joinPath(
            context.extensionUri,
            'src',
            'i18n',
            'runtime',
            'vue',
            looksTs ? 'i18n.ts' : 'i18n.js',
        );
        try {
            const data = await vscode.workspace.fs.readFile(srcRuntime);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(runtimeUri.fsPath)));
            await vscode.workspace.fs.writeFile(runtimeUri, data);
        } catch (err) {
            console.error('Failed to copy Vue i18n runtime:', err);
        }
    }

    if (!compExists) {
        const srcComp = vscode.Uri.joinPath(
            context.extensionUri,
            'src',
            'i18n',
            'runtime',
            'vue',
            looksTs ? 'useTranslation.ts' : 'useTranslation.js',
        );
        try {
            const data = await vscode.workspace.fs.readFile(srcComp);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(compUri.fsPath)));
            await vscode.workspace.fs.writeFile(compUri, data);
        } catch (err) {
            console.error('Failed to copy Vue useTranslation composable:', err);
        }
    }
}
