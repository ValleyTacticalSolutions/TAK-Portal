# TAK-Portal

@AGENTS.md

## For Claude Code sessions (hands-on and agents)
- Read the shared lessons before changing code: `gh api repos/ValleyTacticalSolutions/tak-portal-ops/contents/rules/lessons.md --jq .content | base64 -d`. Add new traps there as one or two lines (symptom, cause, fix).
- Run `npm run verify` before saying anything works (see **Tests and verify** in `AGENTS.md`). Results are "passed" or "failed: why".
- Keep `AGENTS.md` the single source for repo rules. This file only imports it and adds Claude-specific notes. Don't repeat AGENTS.md rules here.
- **Git in IDE/CLI sessions: commit and push to `main` only** (see AGENTS.md). Never use another branch, create or merge PRs, or bump/release versions unless Justin explicitly asks for that exact action in the current message. (Changelog lines and `beta-version` per AGENTS.md are part of the code change, not a release.)
- The ops **`yes merge`** (and release) approval flow applies to **Slack** (and similar ops channels), not to IDE/CLI chat. Do not treat "yes merge" typed here as merge authorization unless Justin clearly means merge this PR from this chat.
