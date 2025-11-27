import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder } from 'util';

export type FrameworkKind = 'react' | 'vue' | 'nuxt' | 'laravel';

export type ReactFlavor = 'spa' | 'next-pages' | 'next-app' | 'inertia-react';
export type VueFlavor = 'spa';
export type NuxtFlavor = 'nuxt2' | 'nuxt3';
export type LaravelFlavor = 'blade';

export type FrameworkProfile =
    | { kind: 'react'; flavor: ReactFlavor; rootDir: string; entryPatterns: string[] }
    | { kind: 'vue'; flavor: VueFlavor; rootDir: string; entryPatterns: string[] }
    | { kind: 'nuxt'; flavor: NuxtFlavor; rootDir: string; entryPatterns: string[] }
    | { kind: 'laravel'; flavor: LaravelFlavor; rootDir: string; entryPatterns: string[] };

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

function mergedDeps(pkg: any): Record<string, string> {
    const deps = (pkg && pkg.dependencies) || {};
    const dev = (pkg && pkg.devDependencies) || {};
    return { ...deps, ...dev };
}

export async function detectFrameworkProfile(
    folder: vscode.WorkspaceFolder,
): Promise<FrameworkProfile | undefined> {
    const pkg = await readPackageJson(folder);
    if (!pkg) return undefined;
    const deps = mergedDeps(pkg);

    const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);

    // Inertia Vue (Laravel) - detect before generic Vue
    if (has('@inertiajs/vue3') || has('@inertiajs/inertia-vue3')) {
        const rootDir = 'resources/js';
        const entryPatterns = ['resources/js/app.ts', 'resources/js/app.js', 'resources/js/Pages/**/*.vue'];
        return { kind: 'vue', flavor: 'spa', rootDir, entryPatterns };
    }

    // Nuxt (implies Vue)
    if (has('nuxt') || has('nuxt-edge') || has('nuxt3')) {
        const flavor: NuxtFlavor = has('nuxt3') ? 'nuxt3' : 'nuxt2';
        const rootDir = 'src';
        const entryPatterns = ['pages/**/*.vue', 'app.vue', 'layouts/**/*.vue'];
        return { kind: 'nuxt', flavor, rootDir, entryPatterns };
    }

    // Plain Vue SPA
    if (has('vue')) {
        const rootDir = 'src';
        const entryPatterns = ['src/main.ts', 'src/main.js', 'src/App.vue'];
        return { kind: 'vue', flavor: 'spa', rootDir, entryPatterns };
    }

    // React / Next / Inertia
    if (has('react') || has('react-dom')) {
        // Next.js
        if (has('next')) {
            const rootDir = 'src';
            const entryPatterns = ['src/app/layout.tsx', 'src/pages/_app.tsx'];
            const flavor: ReactFlavor = 'next-app';
            return { kind: 'react', flavor, rootDir, entryPatterns };
        }

        // Inertia React (Laravel)
        if (has('@inertiajs/react') || has('@inertiajs/inertia-react')) {
            const rootDir = 'resources/js';
            const entryPatterns = ['resources/js/app.tsx', 'resources/js/app.jsx'];
            return { kind: 'react', flavor: 'inertia-react', rootDir, entryPatterns };
        }

        // Generic React SPA
        const rootDir = 'src';
        const entryPatterns = ['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx'];
        return { kind: 'react', flavor: 'spa', rootDir, entryPatterns };
    }

    // Laravel (Blade-centric) fallback
    if (has('laravel-mix') || has('vite')) {
        const rootDir = 'resources';
        const entryPatterns = ['views/**/*.blade.php', 'js/**/*.{js,ts,jsx,tsx,vue}'];
        return { kind: 'laravel', flavor: 'blade', rootDir, entryPatterns };
    }

    return undefined;
}
