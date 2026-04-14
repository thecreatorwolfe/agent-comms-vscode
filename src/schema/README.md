# src/schema — Owner: Codex

Per `docs/AGENT_ORCHESTRATION_CODEX_BRIEF.md` §2.

Files to implement:
- `frames.ts` — zod schemas for every WS frame type in protocol §6 (auth, heartbeat, outbound, standby, resume, close; and reverse direction)
- `slack_message.ts` — zod schema for the §4 Slack text format; parse + validate
- `validate.ts` — single entry point: `validate(frame) → {ok, data} | {ok:false, error}`

Do not add new files here without asking Alfred.
