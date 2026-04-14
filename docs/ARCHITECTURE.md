# Architecture

## Hub

The VS Code extension is installed globally, but one local workspace window acts as the active hub at a time. That active hub owns:

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

User-level config points Claude and Codex at stable launcher scripts under `~/.agent-comms/bin/`. Those launchers are rewritten to the current extension install path whenever Agent Comms starts or installs global bridges, so the config does not have to change on every extension update.

## Message flow

1. Nick mentions the Slack app in `#agent-communication`.
2. The extension receives `app_mention` through Socket Mode.
3. `src/slack/parse.ts` resolves recipients from inline `@persona` tokens or the explicit bracketed protocol header.
4. `src/gateway/ws.ts` emits one `event` frame per matching live agent.
5. Claude or Codex bridge processes forward the event into their local session.
6. Outbound protocol-formatted messages return through `/outbound-oneshot` or WS `outbound`.

## State

State is in-memory only:

- live agents
- spawn reservations
- heartbeat/disconnect grace tracking
- project override in VS Code workspace state

No database is used in V1.

## Scope limits

- User-global installation means the extension is available in any local VS Code workspace.
- The active hub is still a single-process localhost service, so only one workspace window should run it on a given port at a time.
- Remote SSH / Codespaces workspaces are not the target of this version because the hub depends on local CLI processes, local Socket Mode, and a local localhost gateway.
