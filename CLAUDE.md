# TAK-Portal

@AGENTS.md

## For Claude Code sessions (hands-on and agents)
- Read the shared lessons before changing code: `gh api repos/ValleyTacticalSolutions/tak-portal-ops/contents/rules/lessons.md --jq .content | base64 -d`. Add new traps there as one or two lines (symptom, cause, fix).
- Run `npm test` before saying anything works. Results are "passed" or "failed: why".
- Every bug fix gets a proof test in `tests/` that fails without the fix.
- Keep `AGENTS.md` the single source for repo rules. This file only imports it and adds Claude-specific notes. Don't repeat AGENTS.md rules here.
- **Git in IDE/CLI sessions:** do not commit, push, create PRs, merge PRs, or bump/release versions unless Justin explicitly asks for that exact git action in the current message. Implementing code is fine; leave a dirty working tree for Justin to review and ship. When unsure whether a message is asking to ship, ask or stop after code changes. (Changelog lines and `beta-version` per AGENTS.md are part of the code change, not a release.)
- The ops **`yes merge`** (and release) approval flow applies to **Slack** (and similar ops channels), not to IDE/CLI chat. Do not treat "yes merge" typed here as merge authorization unless Justin clearly means merge this PR from this chat.
- **Git push target:** never push to any branch except `main`. Do not create or push `agent/*` (or other) branches unless Justin explicitly asks for that branch in the current message.
