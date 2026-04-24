# Localizer — Claude skill

Teaches Claude Code / Claude Desktop how to drive the [`@ai-localizer/cli`](https://www.npmjs.com/package/@ai-localizer/cli) to add / update / clean up i18n for Vue 3, React/Next, and Laravel projects with near-zero token spend.

## Install

Copy the skill directory into your Claude skills folder:

**Windows**:
```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\localizer" -Target "<path-to-repo>\skills\localizer"
```

**macOS / Linux**:
```bash
ln -s <path-to-repo>/skills/localizer ~/.claude/skills/localizer
```

Or clone directly into `~/.claude/skills/localizer/`.

## Requirements in the target project

- Node >= 18
- `npx` available (bundled with Node), or `npm install -g @ai-localizer/cli`
- A supported framework: Vue 3, React, Next.js, or Laravel (Blade + Inertia)

## Trigger phrases

Claude will invoke this skill when you say things like:
- "add English and French to this project"
- "localize this Vue app"
- "translate this project to Spanish"
- "clean up unused i18n keys"

## License

Apache-2.0 © Chibueze Opata
