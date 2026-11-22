# TAK-Portal

@AGENTS.md

## For Claude Code sessions (hands-on and agents)
- Read the shared lessons before changing code: `rules/lessons.md` in `ValleyTacticalSolutions/tak-portal-ops`. Add new traps there as one or two lines (symptom, cause, fix).
- Run `npm test` before saying anything works. Results are "passed" or "failed: why".
- Every bug fix gets a proof test in `tests/` that fails without the fix.
- Keep `AGENTS.md` the single source for repo rules, so Cursor and Claude see the same thing. This file only imports it and adds Claude-specific notes.
- **Git push target:** never push to any branch except `main`. Do not create or push `agent/*` (or other) branches unless Justin explicitly asks for that branch in the current message.
- Marketplace: bump `cloudtak-marketplace-version` in `package.json` whenever plugins are added/removed/changed or marketplace install/logic changes — see **CloudTAK Marketplace** in `AGENTS.md`.
- Marketplace `additionalActions`: only for required manual operator work (Caddy / reverse-proxy / major external config). Skip Refresh App, egress tips, disk notes, and other README material — see **CloudTAK Marketplace** in `AGENTS.md`.
- **UI:** every page must be mobile-friendly and match the rest of the site — see **UI — mobile-friendly by default** in `AGENTS.md`.
