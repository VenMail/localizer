import * as vscode from 'vscode';
import { TextDecoder } from 'util';

export type FrameworkKind = 'react' | 'vue' | 'nuxt' | 'laravel' | 'mixed';

export type ReactFlavor = 'spa' | 'next-pages' | 'next-app' | 'inertia-react';
export type VueFlavor = 'spa';
export type NuxtFlavor = 'nuxt2' | 'nuxt3';
export type LaravelFlavor = 'blade' | 'inertia-react';
export type MixedFlavor = 'laravel-react' | 'laravel-vue' | 'react-vue' | 'custom';

export type FrameworkProfile =
    | { kind: 'react'; flavor: ReactFlavor; rootDir: string; entryPatterns: string[] }
    | { kind: 'vue'; flavor: VueFlavor; rootDir: string; entryPatterns: string[] }
    | { kind: 'nuxt'; flavor: NuxtFlavor; rootDir: string; entryPatterns: string[] }
    | { kind: 'laravel'; flavor: LaravelFlavor; rootDir: string; entryPatterns: string[] }
    | { kind: 'mixed'; flavor: MixedFlavor; frameworks: FrameworkKind[]; rootDir: string; entryPatterns: string[] };

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

    // Detect mixed projects by checking for multiple framework indicators
    const detectedFrameworks: FrameworkKind[] = [];
    
    // Check for Laravel (most specific first)
    if (has('laravel/framework')) {
        detectedFrameworks.push('laravel');
    }
    
    // Check for React
    if (has('react') || has('react-dom')) {
        detectedFrameworks.push('react');
    }
    
    // Check for Vue
    if (has('vue')) {
        detectedFrameworks.push('vue');
    }
    
    // Check for Nuxt
    if (has('nuxt')) {
        detectedFrameworks.push('nuxt');
    }
    
    // If we detected multiple frameworks, it's a mixed project
    if (detectedFrameworks.length > 1) {
        // Determine the specific mixed flavor
        let flavor: MixedFlavor = 'custom';
        let rootDir = 'src';
        let entryPatterns: string[] = [];
        
        if (detectedFrameworks.includes('laravel') && detectedFrameworks.includes('react')) {
            flavor = 'laravel-react';
            rootDir = 'resources/js';
            entryPatterns = ['resources/js/app.tsx', 'resources/js/app.jsx', 'views/**/*.blade.php'];
        } else if (detectedFrameworks.includes('laravel') && detectedFrameworks.includes('vue')) {
            flavor = 'laravel-vue';
            rootDir = 'resources/js';
            entryPatterns = ['resources/js/app.js', 'resources/js/app.ts', 'views/**/*.blade.php'];
        } else if (detectedFrameworks.includes('react') && detectedFrameworks.includes('vue')) {
            flavor = 'react-vue';
            rootDir = 'src';
            entryPatterns = ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js'];
        }
        
        return { kind: 'mixed', flavor, frameworks: detectedFrameworks, rootDir, entryPatterns };
    }

    // Single framework detection (existing logic)
    if (detectedFrameworks.includes('nuxt')) {
        const isNuxt3 = has('nuxt') && !has('@nuxtjs/legacy-compat');
        const flavor: NuxtFlavor = isNuxt3 ? 'nuxt3' : 'nuxt2';
        const rootDir = 'src';
        const entryPatterns = isNuxt3 
            ? ['src/app.vue', 'src/pages/**/*.vue']
            : ['src/pages/**/*.vue', 'src/layouts/**/*.vue'];
        return { kind: 'nuxt', flavor, rootDir, entryPatterns };
    }

    // Plain Vue SPA
    if (detectedFrameworks.includes('vue')) {
        const rootDir = 'src';
        const entryPatterns = ['src/main.ts', 'src/main.js', 'src/App.vue'];
        return { kind: 'vue', flavor: 'spa', rootDir, entryPatterns };
    }

    // Laravel (single framework)
    if (detectedFrameworks.includes('laravel')) {
        // Check if it has Inertia (but we already handled mixed case above)
        if (has('@inertiajs/react') || has('@inertiajs/inertia-react')) {
            const rootDir = 'resources/js';
            const entryPatterns = ['resources/js/app.tsx', 'resources/js/app.jsx'];
            return { kind: 'laravel', flavor: 'inertia-react', rootDir, entryPatterns };
        }
        
        // Regular Laravel Blade project
        const rootDir = 'resources';
        const entryPatterns = ['views/**/*.blade.php', 'js/**/*.{js,ts,jsx,tsx,vue}'];
        return { kind: 'laravel', flavor: 'blade', rootDir, entryPatterns };
    }

    // React (single framework)
    if (detectedFrameworks.includes('react')) {
        // Next.js
        if (has('next')) {
            const rootDir = 'src';
            const entryPatterns = ['src/app/layout.tsx', 'src/pages/_app.tsx'];
            const flavor: ReactFlavor = 'next-app';
            return { kind: 'react', flavor, rootDir, entryPatterns };
        }

        // Generic React SPA
        const rootDir = 'src';
        const entryPatterns = ['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx'];
        return { kind: 'react', flavor: 'spa', rootDir, entryPatterns };
    }

    return undefined;
}
