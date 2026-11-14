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

`@babel/parser` and `oxc-parser` are installed with the package. The legacy
Babel JSX backend additionally requires `@babel/generator`, `@babel/traverse`
and `@babel/types`.

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

### Vue setup scripts

The default `replace` backend reuses a top-level `useI18n()` composer or its
`t` binding in `<script setup>`. When a component has no such binding, it
leaves script strings unchanged unless the project explicitly opts in:

```json
{
  "aiI18n": {
    "vueSetupTranslation": "vue-i18n-composition"
  }
}
```

Use this setting only when the project uses Vue I18n's Composition API and has
configured it accordingly (for legacy-capable Vue I18n versions, this means
`createI18n({ legacy: false, ... })`). The rewriter then imports `useI18n` and
creates a collision-safe binding only in setup scripts that need one. It does
not configure or install Vue I18n. Existing composers and their scope/options
are preserved. See the [Vue I18n composition guide](https://vue-i18n.intlify.dev/guide/advanced/composition).

## License

Apache-2.0 © Chibueze Opata
