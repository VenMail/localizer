import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder } from 'util';
import { workspaceLooksTypeScript } from './workspace';
import { FrameworkProfile, detectFrameworkProfile } from '../frameworks/detection';

export type Bundler = 'vite' | 'next' | 'webpack' | 'unknown';

export type LocaleLayout = 'single' | 'grouped';

export interface ProjectEnv {
    folder: vscode.WorkspaceFolder;
    framework?: FrameworkProfile;
    srcRoot: string;
    runtimeRoot: string;
    componentsRoot: string;
    composablesRoot?: string;
    isTypeScript: boolean;
    bundler: Bundler;
    /** Directory (relative to workspace root) where locale JSON files live. */
    localesDir: string;
    /** File layout convention for locale files. */
    localeLayout: LocaleLayout;
    /** Source language for AI translations (the "from" locale). */
    sourceLocale: string;
}

const envCache = new Map<string, ProjectEnv>();

async function readPackageJson(folder: vscode.WorkspaceFolder): Promise<any | undefined> {
    const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
    try {
        const data = await vscode.workspace.fs.readFile(pkgUri);
        const text = new TextDecoder('utf-8').decode(data);
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function detectBundlerFromPkg(pkg: any): Bundler {
    const deps = (pkg && pkg.dependencies) || {};
    const dev = (pkg && pkg.devDependencies) || {};
    const all = { ...deps, ...dev } as Record<string, string>;
    const has = (name: string) => Object.prototype.hasOwnProperty.call(all, name);

    if (has('vite')) return 'vite';
    if (has('next')) return 'next';
    if (has('webpack') || has('webpack-dev-server')) return 'webpack';
    return 'unknown';
}

function normalizeRoot(root: string): string {
    return root.replace(/\\/g, '/');
}

export async function getProjectEnv(folder: vscode.WorkspaceFolder): Promise<ProjectEnv> {
    const key = folder.uri.fsPath;
    const existing = envCache.get(key);
    if (existing) {
        return existing;
    }

    const [rawFramework, rawIsTypeScript, rawPkg] = await Promise.all([
        detectFrameworkProfile(folder),
        workspaceLooksTypeScript(folder),
        readPackageJson(folder),
    ]);

    const framework = rawFramework as FrameworkProfile | undefined;
    const isTypeScript = !!rawIsTypeScript;
    const pkg = rawPkg as any | undefined;

    let srcRoot = 'src';

    const aiI18n = pkg && typeof pkg.aiI18n === 'object' ? pkg.aiI18n : undefined;
    if (aiI18n && typeof aiI18n.srcRoot === 'string' && aiI18n.srcRoot.length > 0) {
        srcRoot = aiI18n.srcRoot;
    } else if (framework && typeof (framework as any).rootDir === 'string') {
        if (framework.kind === 'laravel') {
            const jsPath = path.join(folder.uri.fsPath, 'resources', 'js');
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(jsPath));
                srcRoot = 'resources/js';
            } catch {
                srcRoot = (framework as any).rootDir;
            }
        } else {
            srcRoot = (framework as any).rootDir;
        }
    }

    const srcRootPosix = normalizeRoot(srcRoot);

    let runtimeRoot: string;
    let componentsRoot: string;
    let composablesRoot: string | undefined;

    if (framework?.kind === 'nuxt') {
        runtimeRoot = 'i18n';
        componentsRoot = 'components';
        composablesRoot = 'composables';
    } else if (framework?.kind === 'vue') {
        runtimeRoot = `${srcRootPosix}/i18n`;
        componentsRoot = `${srcRootPosix}/components`;
        composablesRoot = `${srcRootPosix}/composables`;
    } else if (framework?.kind === 'react') {
        runtimeRoot = `${srcRootPosix}/i18n`;
        componentsRoot = `${srcRootPosix}/components`;
        composablesRoot = `${srcRootPosix}/hooks`;
    } else {
        runtimeRoot = `${srcRootPosix}/i18n`;
        componentsRoot = `${srcRootPosix}/components`;
        composablesRoot = undefined;
    }

    const bundler: Bundler = pkg ? detectBundlerFromPkg(pkg) : 'unknown';

    // Locale output defaults: Laravel keeps legacy path; other frameworks
    // prefer `<srcRoot>/locales`. Overridable via `aiI18n.localesDir`.
    let localesDir: string;
    if (aiI18n && typeof aiI18n.localesDir === 'string' && aiI18n.localesDir.length > 0) {
        localesDir = normalizeRoot(aiI18n.localesDir);
    } else if (framework?.kind === 'laravel') {
        localesDir = 'resources/js/i18n/auto';
    } else {
        localesDir = `${srcRootPosix}/locales`;
    }

    let localeLayout: LocaleLayout;
    if (aiI18n && (aiI18n.layout === 'single' || aiI18n.layout === 'grouped')) {
        localeLayout = aiI18n.layout;
    } else if (aiI18n && framework?.kind !== 'laravel') {
        localeLayout = 'single';
    } else {
        localeLayout = 'grouped';
    }

    let sourceLocale = 'en';
    if (aiI18n && typeof aiI18n.sourceLocale === 'string' && aiI18n.sourceLocale) {
        sourceLocale = aiI18n.sourceLocale;
    } else if (aiI18n && typeof aiI18n.defaultLocale === 'string' && aiI18n.defaultLocale) {
        sourceLocale = aiI18n.defaultLocale;
    }

    const env: ProjectEnv = {
        folder,
        framework,
        srcRoot: srcRootPosix,
        runtimeRoot,
        componentsRoot,
        composablesRoot,
        isTypeScript,
        bundler,
        localesDir,
        localeLayout,
        sourceLocale,
    };

    envCache.set(key, env);
    return env;
}
