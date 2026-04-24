# Localizer — Codex agent instructions

Drop-in instruction file that teaches a Codex / OpenAI Agents SDK / OpenAI Codex-CLI agent how to drive the [`@ai-localizer/cli`](https://www.npmjs.com/package/@ai-localizer/cli) to add / update / clean up i18n for Vue 3, React/Next, and Laravel projects with near-zero token spend.

## Install

Copy `AGENTS.md` to the target project root:

```bash
curl -o AGENTS.md https://raw.githubusercontent.com/VenMail/localizer/main/codex-skills/localizer/AGENTS.md
```

Codex CLI auto-reads `AGENTS.md` from the project working directory.

Alternatively, paste the content into your agent's system prompt.

## Requirements in the target project

- Node >= 18
- `npx` available (bundled with Node), or `npm install -g @ai-localizer/cli`
- A supported framework: Vue 3, React, Next.js, or Laravel (Blade + Inertia)

## What it does

Walks the agent through the 9-step localization pipeline:

1. Scaffold framework i18n runtime (vue-i18n / next-intl)
2. `init` — write `package.json#aiI18n` + `.gitignore` entries
3. `extract` — scan source files, produce base locale JSON
4. `replace` — rewrite literals to i18n calls
5. `sync` — propagate keys to target locales
6. `translate plan` → agent fills JSON batch → `translate apply`
7. `cleanup` — remove dead keys
8. `status` — verify coverage
9. Boot dev server for visual verification

## License

Apache-2.0 © Chibueze Opata
