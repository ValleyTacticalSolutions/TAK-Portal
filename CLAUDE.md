# TAK-Portal

@AGENTS.md

## For Claude Code sessions (hands-on and agents)
- Read the shared lessons before changing code: `rules/lessons.md` in `ValleyTacticalSolutions/tak-portal-ops`. Add new traps there as one or two lines (symptom, cause, fix).
- Run `npm test` before saying anything works. Results are "passed" or "failed: why".
- Every bug fix gets a proof test in `tests/` that fails without the fix.
- Keep `AGENTS.md` the single source for repo rules, so Cursor and Claude see the same thing. This file only imports it and adds Claude-specific notes.
