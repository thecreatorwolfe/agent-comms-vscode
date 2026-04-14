# src/registry — Owner: Codex

Per `docs/AGENT_ORCHESTRATION_CODEX_BRIEF.md` §2.

Files to implement:
- `agents.ts` — in-memory `Map<persona, AgentRecord>` and `(project, kind) → Set<N>` index
- `allocator.ts` — lowest-unused-integer allocation for (project, kind); custom-name collision handling
- `heartbeat.ts` — 25s interval, 60s timeout, 30s disconnect grace (per protocol §6 + §8)

Do not add new files here without asking Alfred.
