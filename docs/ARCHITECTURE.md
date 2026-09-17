# Architecture

## Hub

The VS Code extension is installed globally and auto-activates on VS Code startup. One local workspace window acts as the active hub at a time. That active hub owns:

- Slack Socket Mode
- localhost HTTP routes (`/spawn`, `/outbound-oneshot`, `/registry`)
- localhost WebSocket routing at `/ws`
- persona allocation and registry state
- terminal spawning inside the selected workspace

## Agent bridges

Two subprocesses connect back to the hub:

- `src/mcp/claude-channel.ts`
- `src/mcp/codex-server.ts`

Both maintain a localhost WebSocket connection, authenticate with `ROUTER_SHARED_SECRET`, and receive routed Slack events from the extension.

User-level config points Claude and Codex at stable launcher scripts under `~/.agent-comms/bin/`. Those launchers are rewritten to the current extension install path whenever Agent Comms starts or installs global bridges, so the config does not have to change on every extension update. Manual Claude resume flows can use the dedicated stable wrapper `~/.agent-comms/bin/claude-agent-comms-resume`.

## Message flow

1. Nick mentions the Slack app in `#agent-communication`.
2. The extension receives `app_mention` through Socket Mode.
3. `src/slack/parse.ts` resolves recipients from inline `@persona` tokens or the explicit bracketed protocol header.
4. `src/gateway/ws.ts` emits one `event` frame per matching live agent.
5. Claude or Codex bridge processes forward the event into their local session.
6. Outbound protocol-formatted messages return through `/outbound-oneshot` or WS `outbound`.

## Waking a Codex session

A bridge event reaches the Codex MCP subprocess, but a session that is mid-task or parked at its prompt also needs a nudge that it will actually act on. `src/codex/queue-delivery.ts` does that without touching the terminal:

1. The persona's thread is resolved from `~/.codex/sessions` by matching the agent's working directory and registration time, then cached until the agent reconnects.
2. The ping is handed over with `codex queue --thread <id> --message <text>`.
3. The session transcript is polled until the ping appears, which is what proves delivery. The CLI reports success even when no session is listening, so its exit code alone is not trusted.
4. If the thread cannot be resolved or the delivery cannot be confirmed, the hub falls back to writing the ping into the agent's terminal.

## State

The fast path is in-memory:

- live agents
- spawn reservations
- heartbeat/disconnect grace tracking
- project override in VS Code workspace state

The durable path is VS Code global state:

- saved agent profiles keyed by profile id after the first successful outbound message or rename
- operator listen/unlisten state, so hub recovery keeps the same operator relay posture

No database is used in V1.

## Scope limits

- User-global installation means the extension is available in any local VS Code workspace.
- The active hub is still a single-process localhost service, so only one workspace window can own a given port at a time. Other windows can auto-retry and claim the port later if the owner disappears.
- Remote SSH / Codespaces workspaces are not the target of this version because the hub depends on local CLI processes, local Socket Mode, and a local localhost gateway.
