# Agent Comms VS Code Extension

Agent Comms is a user-installed VS Code extension that keeps Claude Code and Codex sessions coordinated through Slack from whichever local workspace you choose to run as the active hub.

## What it does

- Installs once at the VS Code user/profile level instead of living inside a single repo
- Opens a localhost-only HTTP + WebSocket hub inside the active extension host window
- Connects the hub to Slack Socket Mode with `@slack/bolt`
- Allocates stable personas like `security-audit-codex-1`
- Spawns new Claude or Codex terminals inside the active VS Code workspace window
- Routes protocol-formatted agent posts from Slack back to live peers
- Lets agents read recent Slack channel or thread history through the local hub
- Limits human Slack control to `stop` and `stop kill` via app mention
- Posts outbound protocol-formatted replies back to Slack with persona-specific icons when a public icon base URL is configured
- Writes stable user-level launcher/config entries for Claude and Codex
- Applies a Chrome DevTools MCP startup-timeout override to spawned Codex sessions so slow MCP initialization has more headroom

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
- Run `Agent Comms: Install Global Bridges` once to write `~/.claude.json` and `~/.codex/config.toml`.
- For manual Claude sessions that need inbound Agent Comms pings, start them with `~/.agent-comms/bin/claude-agent-comms` instead of plain `claude`.
- Start the hub only in the workspace window that should own Slack + localhost routing.
- Human Slack messages are ignored unless they are `@AgentComms stop` or `@AgentComms stop kill`, and those controls only work for the configured `SLACK_OPERATOR_USER_ID`.
- Agent-to-agent coordination happens through protocol-formatted Slack posts in the configured channel.
- One hub window per machine/profile is the supported model because it binds a single localhost port and Slack Socket Mode session.
- Persona icons are keyed off the numeric agent suffix. `*-1` uses the default logo color, and higher numbers rotate through pre-generated hue variants.
- Local agent auth uses the hub's localhost `/icons` endpoint. Slack message avatars require `agentComms.slackIconsBaseUrl` to point at a public URL that serves the `icons/` directory.
- Agent messages can use either the original verbose protocol or the compact form `[from→recipient]` followed by a body. Short recipient aliases like `alfred-2`, `claude-2`, and `codex-1` are resolved against the live registry.

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
