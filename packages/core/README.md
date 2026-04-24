# @ai-localizer/core

Pure-Node i18n pipeline for Vue 3, React/Next, and Laravel projects. Designed for AI agent orchestration with minimal token spend.

## What this is

The engine behind [`@ai-localizer/cli`](https://www.npmjs.com/package/@ai-localizer/cli). Zero-UI, zero-framework library of:

- **Phase scripts** — `extract`, `replace`, `sync`, `cleanup`, `fix-untranslated`, `restore-invalid`, `apply-report-fixes`. Spawnable as subprocesses via `runScript()` against any project root.
- **Parsers** — Vue SFC, JSX/TSX, Blade, Svelte, generic JS.
- **Validators** — HTML/code/technical content detection, placeholder safety checks.
- **Translator queue** — `translatorQueue.plan()` / `translatorQueue.apply()` for Claude-in-session JSON handoff.
- **Translator cache** — persistent on-disk dedupe of source→target pairs.

Most users should install the CLI. Install this package directly only if you want to embed the pipeline in your own Node tooling.

## Install

```bash
npm install @ai-localizer/core
```

Optional deps for legacy Babel-based JSX extraction fallback: `@babel/parser @babel/generator @babel/traverse @babel/types`. Default path uses `oxc-parser` (already bundled).

## API

```js
const {
  scriptPaths,
  runScript,
  projectConfig,
  stringUtils,
  localeUtils,
  validators,
  parsers,
  translatorQueue,
  translatorCache,
} = require('@ai-localizer/core');

// Run a phase script against a target project
await runScript('extract', { projectRoot: '/path/to/project' });

// Plan translation handoff
const summary = translatorQueue.plan('/path/to/project', {
  targets: ['fr', 'de'],
});
// -> writes .i18n-queue/<locale>.pending.json per locale

// After AI fills .i18n-queue/<locale>.answers.json:
translatorQueue.apply('/path/to/project');
```

### Subpath exports

```js
const { detectLocalesDir } = require('@ai-localizer/core/lib/projectConfig');
const { slugifyForKey } = require('@ai-localizer/core/lib/stringUtils');
```

## Project config

The pipeline reads `package.json#aiI18n` (or `composer.json#extra.aiI18n` for Laravel):

```json
{
  "aiI18n": {
    "sourceLocale": "en",
    "locales": ["en", "fr", "de"],
    "localesDir": "src/locales",
    "layout": "single"
  }
}
```

## License

Apache-2.0 © Chibueze Opata
