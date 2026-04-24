# Localizer — i18n pipeline for Codex / agent-driven workflows

Adds full i18n setup to a fresh project, or extends an existing one with new locales, in a few minutes. All deterministic work (string extraction, source rewrite, locale sync, dead-key cleanup) runs through the `ai-localize` CLI and spends zero AI tokens. The agent only does the translation step itself, via a compact JSON batch handoff.

Trigger this workflow for requests like "add <language> to this project", "localize this app", "translate this to <language>", "clean up unused translation keys", "set up i18n for this repo". Works with Vue 3, React, Next.js, and Laravel (Blade + Inertia).

## When to use

Trigger on user requests like:

- "add English and French to `C:\dev\PPTist`"
- "localize this Vue app"
- "translate this project to Spanish"
- "clean up unused i18n keys"
- "set up i18n from scratch here"
- "why are some strings still hard-coded?"

## The `ai-localize` CLI

Published as [`@ai-localizer/cli`](https://www.npmjs.com/package/@ai-localizer/cli). Invoke via `npx` (no install required) or globally:

```bash
npx -y @ai-localizer/cli <cmd> --project <dir> [flags]
# or, after `npm install -g @ai-localizer/cli`:
ai-localize <cmd> --project <dir> [flags]
```

Subcommands: `init`, `extract`, `replace`, `sync`, `translate plan|apply`, `cleanup`, `status`, `run`. Each takes `--help`.

Below, all examples use `npx -y @ai-localizer/cli` as the invocation prefix. Substitute `ai-localize` if the CLI is globally installed.

## Workflow

### Step 1 — Scaffold the i18n runtime (framework-specific, one-time)

The CLI does **not** install i18n libraries. Handle scaffolding directly via Edit/Bash before invoking the CLI.

**Vue 3** — if `vue-i18n` is not in `package.json`:
1. `npm install vue-i18n@9` in the target project.
2. Create `src/i18n/index.ts`:
   ```ts
   import { createI18n } from 'vue-i18n';
   import en from '../locales/en.json';
   import fr from '../locales/fr.json';
   export const i18n = createI18n({
     legacy: false,
     locale: 'en',
     fallbackLocale: 'en',
     messages: { en, fr },
   });
   ```
3. In `src/main.ts`: `import { i18n } from './i18n'; app.use(i18n);`
4. Vite needs `resolve.alias['@']` for `@/i18n` imports — check `vite.config.ts`; most Vue templates already have it.

**Next.js** — install `next-intl` and follow its App-Router setup (messages under `messages/<locale>.json`). Set `localesDir: "messages"` in init.

**Laravel (Blade + Inertia)** — already has `trans()`. Default layout is `grouped` under `resources/js/i18n/auto/`.

### Step 2 — `init`

```bash
npx -y @ai-localizer/cli init --project <dir> --source-locale <src> --locales <csv>
```

Example for PPTist (Chinese source → add English + French):
```bash
npx -y @ai-localizer/cli init --project C:/dev/PPTist --source-locale zh --locales zh,en,fr
```

Writes `package.json#aiI18n`, adds `.i18n-cache/` and `.i18n-queue/` to `.gitignore`, creates the locales directory. Idempotent — rerun with `--force` to overwrite an existing block.

### Step 3 — `extract`

Scans source files, produces `<localesDir>/<sourceLocale>.json` (single layout) or `<localesDir>/<sourceLocale>/*.json` (grouped). Existing translations are merged, never overwritten.

```bash
npx -y @ai-localizer/cli extract --project <dir>
```

### Step 4 — `replace`

Rewrites source files: hard-coded strings become `$t('key')` (Vue templates), `t('key')` (JS/TS/JSX), or `trans('key')` (Blade).

```bash
npx -y @ai-localizer/cli replace --project <dir>
```

After this step the project still runs the same — just via i18n keys instead of literals.

### Step 5 — `sync`

Propagates keys from source locale to every target locale file. Non-destructive (untranslated keys initially copy the source string as placeholder). Re-run after every extract.

```bash
npx -y @ai-localizer/cli sync --project <dir>
```

### Step 6 — `translate plan` + translate + `translate apply`

This is the only AI-spending step. `plan` emits `.i18n-queue/<locale>.pending.json` containing only keys that are:
- missing from the target locale, OR
- equal to the source value (untranslated)
- AND not already cached from a prior run

```bash
npx -y @ai-localizer/cli translate plan --project <dir>
```

**Agent turn** — for each `<locale>.pending.json` listed in the plan output:

1. Read the pending file.
2. Produce translations as a flat `{key: translation}` JSON.
3. Write it to the exact path `.i18n-queue/<locale>.answers.json`.

**Translation rules the agent must follow:**
- Preserve placeholders verbatim: `{count}`, `{{name}}`, `%s`, `%d`, `{0}`.
- Match UI brevity conventions — French/German button labels are usually shorter than English descriptions; use language-native idiom for "Save" / "Cancel" / "OK".
- Keep technical terms in English if that's industry standard (e.g. "API", "JSON", "URL").
- Skip nothing. Answer every key in the pending file. If a string is genuinely untranslatable (URL, code token), return the source value unchanged.
- Answers JSON must be **flat** — keys with dots, not nested objects. The merger splits dots into tree paths.

Then:

```bash
npx -y @ai-localizer/cli translate apply --project <dir>
```

This merges the answers into the locale files, updates `.i18n-cache/cache.json`, and deletes the queue files. Subsequent `plan` runs serve these translations from cache automatically.

### Step 7 — `cleanup`

Removes locale keys that no source file references anymore. Safe to run any time.

```bash
npx -y @ai-localizer/cli cleanup --project <dir>
```

### Step 8 — `status`

Verify coverage:

```bash
npx -y @ai-localizer/cli status --project <dir>
```

Output like:
```
source keys:   485
en       485 translated      0 untranslated  (100%)
fr       485 translated      0 untranslated  (100%)
```

### Step 9 — Verify

Start the dev server and exercise the language switcher:
```bash
cd <dir> && npm run dev
```
Load the app, toggle the locale, confirm no missing-key warnings in the console.

## Token-minimization rules (strict)

1. **Never** translate literals by reading .vue/.tsx files directly. Always go through `translate plan` → answers JSON. One Read + one Write per locale per run.
2. **Never** re-translate a key that already has a non-default value — `plan` filters those out.
3. **Never** invoke OpenAI or any external translation API from this skill. The agent itself is the translator.
4. If `plan` reports `0 pairs pending` for a locale, skip that locale's agent turn entirely.
5. Run `cleanup` before re-translating after a big refactor — removes keys you'd otherwise waste a batch on.
6. Persistent cache at `.i18n-cache/cache.json` is gitignored but survives across runs. Do not delete it manually.

## Common shortcuts

**Full fresh setup** (after Step 1 scaffolding):
```bash
npx -y @ai-localizer/cli run --project <dir>     # extract + replace + sync + cleanup
npx -y @ai-localizer/cli translate plan --project <dir>
# → agent reads each pending file, writes answers
npx -y @ai-localizer/cli translate apply --project <dir>
npx -y @ai-localizer/cli status --project <dir>
```

**Just add a new locale to an existing project** (no source rewrite needed):
```bash
# 1. edit package.json#aiI18n.locales to include the new code
npx -y @ai-localizer/cli sync --project <dir>
npx -y @ai-localizer/cli translate plan --project <dir>
# → agent answers
npx -y @ai-localizer/cli translate apply --project <dir>
```

**Just clean up after a big delete/rename**:
```bash
npx -y @ai-localizer/cli cleanup --project <dir>
npx -y @ai-localizer/cli status --project <dir>
```

## Common traps

- **PPTist-style Chinese-source projects** — pass `--source-locale zh`; the default is `en`.
- **Vue SFC templates** — `$t('…')` works in `<template>`, `t('…')` in `<script setup>`. The replace phase picks the right one automatically.
- **Laravel projects** — layout is grouped; `localesDir` default is `resources/js/i18n/auto`.
- **No `package.json#aiI18n`** — `init` must run first; every other command reads config from there.
- **Queue files left over** — if `apply` crashed mid-run, re-run `apply` to finish merging, or delete `.i18n-queue/` to start translation over.
- **Keys with spaces or punctuation** — the extractor slugifies them (`"Save changes"` → `Commons.button.save_changes`). Don't rename the key after translation; the cache is keyed by the source *text*, not the key path.

## File layout reference

```
<project>/
├─ package.json                         # aiI18n block written by `init`
├─ .gitignore                           # + .i18n-cache/ and .i18n-queue/
├─ src/
│  └─ locales/                          # (or resources/js/i18n/auto/ for Laravel)
│     ├─ en.json                        # source locale (single layout)
│     └─ fr.json                        # target locale
├─ .i18n-cache/
│  └─ cache.json                        # persistent source→target cache
└─ .i18n-queue/                         # transient; deleted after apply
   ├─ fr.pending.json                   # written by `translate plan`
   └─ fr.answers.json                   # Claude writes this
```
