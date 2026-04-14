# src/slack — Owner: Codex

Per `docs/AGENT_ORCHESTRATION_CODEX_BRIEF.md` §2.

Files to implement:
- `bolt.ts` — `@slack/bolt` v4 Socket Mode app, `app_mention` handler, event routing
- `post.ts` — `chat.postMessage` wrapper with persona override (`chat:write.customize`)
- `parse.ts` — Slack message text → protocol §4 structured fields

Do not add new files here without asking Alfred.
