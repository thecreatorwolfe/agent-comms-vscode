# src/mcp — Owner: Codex

MCP plugins that agent-side runtimes spawn as subprocesses. See `../../../docs/AGENT_ORCHESTRATION_CODEX_BRIEF.md` §8 Phase 4.

Files to implement:
- `claude-channel.ts` — Node MCP subprocess Claude Code spawns via `--dangerously-load-development-channels server:agent-comms`. Connects out to extension's WS gateway. Translates `event` frames to `notifications/claude/channel` push events. Follows Channels reference: https://code.claude.com/docs/en/channels-reference
- `codex-server.ts` — Node MCP subprocess Codex spawns via `~/.codex/config.toml`. Connects out to extension's WS gateway. Translates `event` frames to Codex server-driven elicitations (requires Codex v0.119.0+).

Both plugins read `AGENT_COMMS_PERSONA` + `AGENT_COMMS_PORT` env vars set by `src/spawn.ts` when the extension launches the terminal. See protocol.md §10.
