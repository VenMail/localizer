# @ai-localizer/cli

`ai-localize` — extract / replace / sync / translate / cleanup i18n for Vue 3, React/Next, and Laravel projects. Designed to be driven by Claude or Codex skills with near-zero AI token spend.

## Why

Deterministic i18n work (scanning files, rewriting code, diffing locale trees) should cost zero AI tokens. Only the **actual translation** of source strings needs an LLM. This CLI does all the deterministic parts in pure Node, then emits a compact JSON of only-missing pairs the AI fills in a single turn per locale. A persistent on-disk cache dedupes repeat source→target pairs across runs.

## Install

```bash
npm install -g @ai-localizer/cli
# or
npx @ai-localizer/cli <command>
```

Requires Node >= 18.

## Quick start

```bash
cd path/to/your/project
ai-localize init --source-locale=en --locales=en,fr,de
ai-localize extract
ai-localize replace
ai-localize sync
ai-localize translate plan
# AI agent fills .i18n-queue/<locale>.answers.json per locale
ai-localize translate apply
ai-localize cleanup
ai-localize status
```

## Commands

| Command | What it does |
|---|---|
| `init` | Write `package.json#aiI18n`, update `.gitignore` |
| `extract` | Scan source tree, seed base locale from literal strings |
| `replace` | Rewrite source files to use i18n calls (`$t(...)`, `useTranslations(...)`, `trans(...)`) |
| `sync` | Propagate keys from source locale to every other locale |
| `translate plan` | Emit `.i18n-queue/<locale>.pending.json` (cache-prefiltered untranslated pairs) |
| `translate apply` | Ingest `.i18n-queue/<locale>.answers.json`, merge, update cache, delete queue files |
| `cleanup` | Remove keys no longer referenced in source |
| `status` | Per-locale counts: translated / untranslated |
| `run` | `extract → replace → sync → cleanup` in one call (skips translate — needs AI turn) |

Flags: `--dry-run`, `--destructive`, `--targets=fr,de`, `--project-root=...`, `--source-locale=...`, `--locales=...`.

## AI agent skills

Designed to be driven by a Claude or Codex skill that:

1. Scaffolds the framework's i18n library (install `vue-i18n` / `next-intl`, wire `app.use(i18n)`).
2. Runs the CLI phases above.
3. Reads each `.i18n-queue/<locale>.pending.json` once per locale and writes the matching `.answers.json`.
4. Runs `translate apply` + `cleanup`.

Tokens spent: one Read + one Write per target locale, minus cache hits. For a 500-key project with 2 targets, cold cache ≈ 70 KB total AI I/O; re-runs after adding components ≈ <3 KB.

## Project config

The CLI reads `package.json#aiI18n` (or `composer.json#extra.aiI18n` for Laravel):

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

`layout: "single"` means `<localesDir>/<locale>.json`. `layout: "grouped"` means `<localesDir>/<locale>/<namespace>.json`.

## License

Apache-2.0 © Chibueze Opata
