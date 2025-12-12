# Localizer – AI i18n for React, Vue & Laravel

Localizer is a VS Code extension that helps you build and maintain
JSON-based i18n for modern web apps. It supports React/Next.js, Vue/Nuxt, and
Laravel/Blade projects, with automatic string extraction, safe rewrites, and
AI-assisted translations.

## Features

- **Cross-framework i18n IntelliSense**  
  Hover, go to definition, and completions for translation keys in:
  - JavaScript / TypeScript
  - React (`.jsx/.tsx`)
  - Vue single-file components (`.vue`)
  - Laravel Blade / PHP views

- **Automatic extraction scripts**  
  Scan your source code and templates to build grouped locale JSON files under
  `resources/js/i18n/auto`.

- **Safe rewrite scripts**  
  Replace hard-coded UI strings in React, Vue templates, and Blade views with
  i18n helpers (`t('...')`, `$t('...')`, `__('...')`) using existing locale keys.

- **Auto-monitoring for new code (NEW!)**  
  Automatically detects when you write new code with translatable content and
  triggers extraction/rewrite when files are committed to git. Enabled by default.

- **AI-assisted translations (optional)**  
  Use OpenAI to generate translations for non-default locales during
  "convert selection to key" and when fixing untranslated strings.

- **Per-project configuration**  
  Configure locales, source root, and npm scripts via a guided command.

- **Status bar integration**  
  Quick access to settings and monitoring status via the status bar icon.

## Installation

1. Install the extension from the VS Code Marketplace (search for
   **"Localizer – AI i18n for React, Vue & Laravel"**), or use
   **Extensions: Install from VSIX...** with a packaged `.vsix` file.
2. Open a workspace that contains your app (React/Next.js, Vue/Nuxt, or Laravel).
3. Optionally configure your OpenAI API key for AI-assisted translations.

> For contributors and detailed development instructions (cloning the repo,
> running in an Extension Development Host, building `.vsix` packages), see
> [`dev.md`](./dev.md).

## Quickstart

1. Install **Localizer – AI i18n for React, Vue & Laravel** in VS Code or your
   VS Code–compatible IDE.
2. Open your React/Next.js, Vue/Nuxt, or Laravel project.
3. Run **AI Localizer: Configure Project i18n** to set up locales, source roots, and
   i18n scripts.
4. Run **AI Localizer: Rescan Translations** to index your locale JSON files.
5. In your code:
   - Hover over translation keys for quick previews.
   - Use **Go to Definition** to jump to the underlying JSON file.
   - Use **AI Localizer: Apply translations to selection** to turn UI text into
     i18n keys with AI-assisted translations.

## Basic Usage

### Ask AI for help

- Press `Ctrl+Shift+A` (or `Cmd+Shift+A` on macOS), or
- Right-click and choose **Ask AI for Help**.

This opens a prompt where you can ask questions about your code.

### Enable i18n IntelliSense

By default, the extension indexes translation JSON files matching
`ai-localizer.i18n.localeGlobs` and provides hover/definition/completions for
keys in the following languages:

- `javascript`, `typescript`, `javascriptreact`, `typescriptreact`
- `vue`
- `blade`, `php`

You can rescan keys at any time via the command:

- **AI Localizer: Rescan Translations** (`ai-localizer.i18n.rescan`)

### Configure a project for i18n scripts

Run the command:

- **AI Localizer: Configure Project i18n** (`ai-localizer.i18n.configureProject`)

This will:

- Locate your project `package.json`.
- Add npm scripts (if missing):
  - `i18n:extract` – run `scripts/extract-i18n.js`
  - `i18n:rewrite` – run `scripts/replace-i18n.js`
  - `i18n:rewrite-blade` – run `scripts/rewrite-i18n-blade.js` (Laravel views)
  - `i18n:sync` – sync non-default locales with the base locale
  - `i18n:fix-untranslated` – generate reports of untranslated strings
- Prompt for a comma-separated list of locales and store them in
  `package.json` under `aiI18n.locales`.
- Offer to set `aiI18n.srcRoot` (e.g. `resources/js` or `src`), which controls
  which source tree the scripts scan.
- Copy the helper scripts and `i18n-ignore-patterns.json` into your
  project `scripts/` folder.

Once configured, you can run the scripts with npm:

```bash
npm run i18n:extract
npm run i18n:rewrite
npm run i18n:rewrite-blade   # Laravel views
npm run i18n:sync
npm run i18n:fix-untranslated
```

## Framework-specific workflows

### React / Next.js

1. Configure the project (**AI Localizer: Configure Project i18n**).
2. Run `npm run i18n:extract` to build grouped `en` locale files under
   `resources/js/i18n/auto/en` or `src/i18n/auto/en` (depending on `srcRoot`).
3. Optionally run `npm run i18n:rewrite` to replace hard-coded JSX strings with
   `t('Namespace.kind.slug')` calls. The script:
   - Adds `import { t } from '@/i18n'` if needed.
   - Preserves JSX layout and whitespace as much as possible.
4. Use IntelliSense in your code:
   - Hover on `t('...')` keys for translations.
   - `F12` / "Go to Definition" jumps to the locale JSON file.
   - Autocomplete suggests known keys.

You can also use **AI Localizer: Copy React Language Switcher Component** to scaffold
an example `LanguageSwitcher` and React i18n runtime/hooks.

### Vue / Nuxt

1. Configure the project.
2. Run `npm run i18n:extract`:
   - Extracts from `.ts/.tsx/.js/.jsx` as in React.
   - Additionally scans `.vue` `<template>` blocks for simple
     `<Tag>Text</Tag>` nodes and records them as translations.
3. Run `npm run i18n:rewrite`:
   - For `.vue` files, rewrites `<Tag>Text</Tag>` to
     `<Tag>{{$t('Namespace.kind.slug')}}</Tag>` when a matching key exists.
4. Use IntelliSense on `$t('...')` calls inside `.vue` files.

### Laravel / Blade / PHP

1. Configure the project (typically `resources/js` and `resources/views`).
2. Run `npm run i18n:extract`:
   - Extracts React/Vue front-end strings under `resources/js`.
   - Scans `resources/views/**/*.blade.php` and `.php` for simple
     `<Tag>Text</Tag>` nodes and records them as translations.
3. Run `npm run i18n:rewrite-blade`:
   - Rewrites matching view literals to `{{ __("Namespace.kind.slug") }}`
     when a key exists in the base `en` locale tree.
4. In Blade/PHP files you can also use:
   - **AI Localizer: Convert Selection to Translation Key** to turn selected text
     into a `__('...')` call and automatically create the key in JSON files.

## Settings

The extension reads these settings under `ai-localizer`:

### AI Translation Settings
- `ai-localizer.openaiApiKey` – OpenAI API key used for AI-powered translations.
- `ai-localizer.openaiModel` – model ID (e.g. `gpt-4o-mini`).
- `ai-localizer.i18n.autoTranslate` – when `true`, automatically calls OpenAI
  to suggest translations for non-default locales when converting a selection
  to a key.

### Auto-Monitoring Settings (NEW!)
- `ai-localizer.i18n.autoMonitor` – Enable automatic monitoring of files for translatable content (default: `true`).
- `ai-localizer.i18n.autoExtract` – Automatically run extraction when new content is detected and committed (default: `true`).
- `ai-localizer.i18n.autoRewrite` – Automatically run rewrite after extraction (default: `true`).

### Other Settings
- `ai-localizer.i18n.defaultLocale` – Default locale (default: `en`).
- `ai-localizer.i18n.localeGlobs` – Glob patterns for locale JSON files.
- `ai-localizer.i18n.tImportPath` – Import path for translation helper (default: `@/i18n`).

Example (user or workspace settings):

```jsonc
{
  "ai-localizer.openaiApiKey": "sk-...",
  "ai-localizer.openaiModel": "gpt-4o-mini",
  "ai-localizer.i18n.autoTranslate": true,
  "ai-localizer.i18n.autoMonitor": true,
  "ai-localizer.i18n.autoExtract": true,
  "ai-localizer.i18n.autoRewrite": true,
  "ai-localizer.i18n.defaultLocale": "en",
  "ai-localizer.i18n.localeGlobs": [
    "resources/js/i18n/auto/**/*.json",
    "src/i18n/**/*.json"
  ]
}
```

## Requirements

- VS Code `^1.60.0`
- Node.js for running the i18n scripts (`node ./scripts/*.js`)
- (Optional) OpenAI API key for AI-assisted translations

## Release Notes
### 0.1.5

- Fix invalid cleanup issues arising from auto ignore patterns.

### 0.1.4

- Fixes for laravel go-i18n style catalogs. Added Python, C# and GoLang support.

### 0.1.1

- Major refactors, verified robust support for React and Vue based frameworks. Added one command to fix all issues.

### 0.0.1

- Initial release of Localizer – AI i18n for React, Vue & Laravel

---

**Enjoy!**
