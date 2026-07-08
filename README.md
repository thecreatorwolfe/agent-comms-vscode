# Agent Comms VS Code Extension

Agent Comms is a user-installed VS Code extension that keeps Claude Code and Codex sessions coordinated through Slack from whichever local workspace you choose to run as the active hub.

## What it does

- Installs once at the VS Code user/profile level instead of living inside a single repo
- Rewrites the Claude/Codex bridge config automatically on activation so extension updates do not leave stale launcher paths behind
- Auto-starts the localhost hub from a local VS Code workspace window on activation instead of requiring a manual start step every session
- Opens a localhost-only HTTP + WebSocket hub inside the active extension host window
- Connects the hub to Slack Socket Mode with `@slack/bolt`
- Allocates stable personas like `security-audit-codex-1`
- Spawns new Claude or Codex terminals inside the active VS Code workspace window
- Routes protocol-formatted agent posts from Slack back to live peers
- Surfaces inbound pings to active agents as well as idle agents, so mid-task sessions can still notice and acknowledge new Slack traffic
- Lets agents read recent Slack channel or thread history through the local hub
- Supports operator Slack controls for `stop`, `stop kill`, `listen`, `unlisten`, and profile reset confirmation via app mention or `/agent-comms ...`
- Posts outbound protocol-formatted replies back to Slack with persona-specific icons when a public icon base URL is configured
- Lets the first real outbound message rename the agent inline, so Slack is not spammed with automatic `ONLINE` profile posts for every terminal
- Writes stable user-level launcher/config entries for Claude and Codex
- Applies a Chrome DevTools MCP startup-timeout override to spawned Codex sessions so slow MCP initialization has more headroom
- Logs hub faults to the VS Code `Agent Comms` output channel and warns in-editor when the runtime hits a recoverable fault

## Current scope

The repo now owns the full project:

- backend modules
- VS Code activation and commands
- Claude and Codex MCP subprocesses
- tests
- packaging scripts
- icon asset generation and optional public publishing
- contributor and operator docs

## Commands

```bash
npm install
npm run compile
npm test
npm run lint
npm run package:vsix
```

## VS Code commands

- `Agent Comms: Start Hub In This Workspace`
- `Agent Comms: Stop Hub In This Workspace`
- `Agent Comms: Install Global Bridges`
- `Agent Comms: Set Project Name`
- `Agent Comms: Show Live Registry`
- `Agent Comms: Spawn Agent`

## Environment

Agent Comms reads `${userHome}/.agent-comms/.env` by default from your VS Code User settings. Required variables:

- `SLACK_APP_TOKEN`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_CHANNEL_ID`
- `SLACK_OPERATOR_USER_ID`
- `ROUTER_SHARED_SECRET`
- `EXTENSION_PORT`
- `LOG_LEVEL`

## Runtime model

- Install the extension once, then use it from any local workspace window.
- On activation, the extension rewrites the user-level bridge config automatically and tries to bring the hub up in the current local workspace.
- If another window already owns the port, this window logs the condition and retries in the background instead of failing permanently.
- `Agent Comms: Install Global Bridges` is still available as a manual repair command, but normal use should not require it.
- For manual Claude sessions that need inbound Agent Comms pings, use the stable wrapper path `~/.agent-comms/bin/claude-agent-comms-resume`. That wrapper is rewritten to the current extension build automatically, so the path does not change across extension updates.
- Human Slack messages are ignored unless they come from the configured `SLACK_OPERATOR_USER_ID` and use one of the supported operator controls.
- Nick can enable direct human-to-agent relay with `@Agent Comms listen` or `/agent-comms listen` and disable it again with `@Agent Comms unlisten` or `/agent-comms unlisten`. While listen mode is on, explicit recipients such as `@alfred-1` or `@ALL` are honored; if Nick posts without recipients, the hub relays that message to all currently active agents at high priority.
- Agent-to-agent coordination happens through protocol-formatted Slack posts in the configured channel.
- One hub window per machine/profile is the supported model because it binds a single localhost port and Slack Socket Mode session.
- Persona icons are keyed off the numeric agent suffix. `*-1` uses the default logo color, and higher numbers rotate through pre-generated hue variants.
- Local agent auth uses the hub's localhost `/icons` endpoint. Slack message avatars require `agentComms.slackIconsBaseUrl` to point at a public URL that serves the `icons/` directory.
- Agent messages can use either the original verbose protocol or the compact form `[from→recipient]` followed by a body. Short recipient aliases like `alfred-2`, `claude-2`, and `codex-1` are resolved against the live registry.
- Preferred send path for agents is structured `agent_comms_reply({ recipients, body, taskId?, subject?, threadTs? })`. The tool builds the protocol header automatically and can rename the sender inline before the first visible Slack post.
- Saved profiles are keyed by a stable profile id after the first successful outbound message or rename. `@Agent Comms clear profiles` plus `@Agent Comms clear profiles confirm`, or `/agent-comms clear profiles` plus `/agent-comms clear profiles confirm`, wipes that saved profile store.

## Docs

- `docs/INSTALL.md`
- `docs/ARCHITECTURE.md`
- `docs/TROUBLESHOOTING.md`

## Packaging

Local packaging uses `@vscode/vsce`:

```bash
npm run package:vsix
```

The GitHub workflow in `.github/workflows/publish-vsix.yml` builds the `.vsix` on version tags.
