# Agent Comms for VS Code

A VS Code extension that runs a local hub connecting Claude Code and OpenAI Codex terminal sessions to each other and to a Slack channel.

## What it does

- Runs a hub inside one VS Code window: an HTTP + WebSocket server bound to `127.0.0.1`, plus a Slack connection over Socket Mode (`@slack/bolt`).
- Spawns Claude Code or Codex sessions in VS Code terminals, each with a stable persona name such as `security-audit-codex-1` (project, kind, instance number).
- Gives every session an MCP server with tools to send messages, read Slack history, spawn other agents, rename itself, and report or change its status.
- Routes Slack messages addressed to a persona into that agent's live session. Claude Code receives the message as an MCP channel notification; Codex gets a short ping typed into its terminal telling it to read the message with `agent_comms_read_slack`.
- Posts agent replies back to Slack under the agent's persona name, with an optional per-agent avatar.
- Lets one Slack user (the operator) control the fleet from Slack: interrupt (`stop`) or close (`stop kill`) all agent terminals, turn direct relay of their messages on or off, and inspect or clear saved personas.
- Writes the MCP config for Claude Code (`~/.claude.json`) and Codex (`~/.codex/config.toml`) each time the hub starts, pointing at stable launcher scripts in `~/.agent-comms/bin/` so extension updates do not break the config.

## How it works

```
                 Slack channel
                       ^
                       | Socket Mode events + conversations.history poll (5s)
                       | chat.postMessage (agent replies)
                       v
 +------------------- VS Code window (hub) --------------------+
 |  Slack client (src/slack)                                    |
 |  Registry + persona allocator (src/registry, src/persona)    |
 |  HTTP  127.0.0.1:47592  /spawn /rename /outbound-oneshot     |
 |                         /registry /slack-history /icons      |
 |  WS    127.0.0.1:47592/ws                                    |
 +--------------------------------------------------------------+
            ^ WebSocket (shared-secret auth)    | spawns terminals
            |                                   v
 +-----------------------+          +-----------------------+
 | MCP bridge process    |  stdio   | Claude Code / Codex   |
 | src/mcp/claude-channel| <------> | session in a VS Code  |
 | src/mcp/codex-server  |          | terminal              |
 +-----------------------+          +-----------------------+
```

1. An agent calls `agent_comms_reply({ recipients: ["codex-1"], body: "..." })`.
2. Its bridge sends the message to the hub over the WebSocket. The hub posts it to Slack with a protocol header (`[from→recipient]`).
3. The hub sees the post (realtime event or the 5-second history poll, de-duplicated), resolves the recipients against the live registry, and sends one event frame to each matching bridge.
4. The recipient's bridge pushes the message into its session (see above for how Claude Code and Codex differ).

Every HTTP route except `/healthz` and `/icons` requires the `X-Router-Secret` header, and WebSocket clients must authenticate with the same secret. Secrets are compared with `crypto.timingSafeEqual`.

State lives in memory (live agents, spawn reservations, heartbeats) and in VS Code global state (saved persona profiles, operator listen mode). There is no database. More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### MCP tools exposed to agents

| Tool | Purpose |
| --- | --- |
| `agent_comms_reply` | Send a message to one or more personas, `ALL`, or the operator (`NICK`) |
| `agent_comms_read_slack` | Read recent channel or thread history |
| `agent_comms_spawn` | Spawn a named child Claude or Codex agent, with optional model and reasoning effort |
| `agent_comms_rename` | Claim a persona name before the first post |
| `agent_comms_status` | Show this session's persona and status |
| `agent_comms_resume` | Mark the session as actively working on a task |
| `agent_comms_standby` | Mark the session as idle and reusable |

## Install

The extension is not published to the VS Code Marketplace. Build and install the `.vsix` from source.

Prerequisites: Node 22+, VS Code 1.85+, Claude Code and/or Codex CLI installed, and a Slack app.

```bash
git clone https://github.com/thecreatorwolfe/agent-comms-vscode.git
cd agent-comms-vscode
npm ci
npm run package          # compiles and writes agent-comms-vscode-<version>.vsix
code --install-extension agent-comms-vscode-<version>.vsix
```

Slack app setup: import [docs/slack-app-manifest.json](docs/slack-app-manifest.json). It enables Socket Mode, subscribes to `app_mention` and `message.channels`, registers the `/agent-comms` slash command, and requests the bot scopes `app_mentions:read`, `channels:history`, `chat:write`, `chat:write.customize`, and `commands`. Invite the bot to your channel.

Full steps: [docs/INSTALL.md](docs/INSTALL.md).

## Configuration

### Env file

The hub reads `~/.agent-comms/.env` by default. All values are validated on startup.

| Variable | Notes |
| --- | --- |
| `SLACK_APP_TOKEN` | Socket Mode app-level token |
| `SLACK_BOT_TOKEN` | Bot token |
| `SLACK_SIGNING_SECRET` | From the Slack app settings |
| `SLACK_CHANNEL_ID` | Channel the hub listens to and posts in |
| `SLACK_OPERATOR_USER_ID` | The only Slack user whose commands and messages the hub accepts |
| `ROUTER_SHARED_SECRET` | 64 hex characters, e.g. `openssl rand -hex 32` |
| `EXTENSION_PORT` | Default `47592` |
| `LOG_LEVEL` | Default `info` |

### VS Code settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `agentComms.envFilePath` | `${userHome}/.agent-comms/.env` | Location of the env file |
| `agentComms.port` | `47592` | Hub port. One window can own it at a time |
| `agentComms.codexChromeDevtoolsStartupTimeoutSec` | `30` | Startup timeout given to the chrome-devtools MCP server in spawned Codex sessions |
| `agentComms.claudeDevChannelsAutoAccept` | `true` | Send Enter to a new Claude terminal to accept the development-channels prompt |
| `agentComms.claudeDevChannelsAcceptDelaysMs` | `[2500, 5000, 8000]` | When those keystrokes are sent |
| `agentComms.slackIconsBaseUrl` | `""` | Public URL serving `icons/` for Slack avatars. Blank uses the app's default avatar |

### Commands

- `Agent Comms: Start Hub In This Workspace` / `Stop Hub In This Workspace`
- `Agent Comms: Spawn Agent`
- `Agent Comms: Show Live Registry`
- `Agent Comms: Set Project Name` (overrides the project part of persona names)
- `Agent Comms: Install Global Bridges` (rewrites the Claude/Codex config and launchers; normally done when the hub starts)

The hub starts on its own when a local workspace window opens. If another window owns the port, this window retries every 15 seconds.

### Operator controls in Slack

Sent as `@Agent Comms <command>` or `/agent-comms <command>`, and accepted only from `SLACK_OPERATOR_USER_ID`:

`stop`, `stop kill`, `listen`, `unlisten`, `see profiles`, `clear disconnected`, `clear invalidated`, `clear profile <persona>`, `clear profiles [confirm]`, `clear profiles all [confirm]`.

All other human messages in the channel are ignored unless `listen` is on.

## Development

```bash
npm ci
npm run compile     # tsc -> dist/
npm test            # vitest: 19 files, 129 tests
npm run lint        # tsc --noEmit
npm run package     # build the .vsix
```

Press `F5` in VS Code to run the extension in a development host (`.vscode/launch.json`).

CI (`.github/workflows/ci.yml`) compiles and runs the tests on every pull request and push to `main`. Pushing a `v*` tag builds the `.vsix` as a workflow artifact. A third workflow publishes `icons/` to GitHub Pages.

Logs go to the `Agent Comms` output channel and to `~/.agent-comms/logs/`. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) and [RELEASING.md](RELEASING.md).

## Status

Version 0.2.49. Limits of this version:

- One hub per machine, since it binds a single localhost port and Slack Socket Mode connection.
- Local workspaces only. Remote SSH and Codespaces are not supported.
- Claude Code channel delivery depends on Claude Code's development-channels flag, which the spawn command adds.

Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).
