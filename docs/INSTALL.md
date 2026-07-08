# Install

## Prerequisites

- Node 22+
- VS Code 1.85+
- Slack App credentials already created for `#agent-communication`
- Claude Code and Codex installed locally

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create or populate `~/.agent-comms/.env`:

   ```env
   SLACK_APP_TOKEN=xapp-...
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=...
   SLACK_CHANNEL_ID=C0ASSA3BBGC
   SLACK_OPERATOR_USER_ID=U...
   ROUTER_SHARED_SECRET=...
   EXTENSION_PORT=47592
   LOG_LEVEL=info
   ```

   Slack app setup for the current coordination model:

   - import or mirror [`docs/slack-app-manifest.json`](./slack-app-manifest.json) if you want the Slack app config under version control
   - enable Socket Mode
   - subscribe to the `app_mention` event for operator controls such as `stop`, `listen`, and profile reset
   - subscribe to the `message.channels` event so agent protocol posts are seen by the hub
   - grant `app_mentions:read`, `channels:history`, `chat:write`, `chat:write.customize`, and `commands`
   - register the `/agent-comms` slash command if you want direct operator controls without an app mention

3. Compile the extension:

   ```bash
   npm run compile
   ```

4. Package locally if needed:

   ```bash
   npm run package:vsix
   ```

5. Install the extension in VS Code via `F5` or the packaged `.vsix`.

6. Open a local workspace window. On activation, Agent Comms now auto-rewrites the global bridge config and auto-starts the hub if this window can own the configured port.

7. Use `Agent Comms: Install Global Bridges` only if you want to force a manual repair of the generated files. It writes:

   - `~/.claude.json` with an `agent-comms` MCP server entry
   - `~/.codex/config.toml` with an `[mcp_servers.agent-comms]` entry
   - stable launcher scripts under `~/.agent-comms/bin/`
   - `~/.agent-comms/bin/claude-agent-comms`, a wrapper for manual Claude sessions that need inbound channel delivery
   - `~/.agent-comms/bin/claude-agent-comms-resume`, a stable wrapper for manual Claude resume sessions with Agent Comms already enabled

8. Spawn agents from `Agent Comms: Spawn Agent`.

## Notes

- The extension is installed globally, but the live hub is intentionally started in one workspace window at a time.
- The extension now tries to start the hub automatically on activation. If another window already owns the port, this window logs the conflict and retries later.
- Persistent logs are now written under `~/.agent-comms/logs/` for the hub and both bridge processes.
- Spawned Codex sessions apply `mcp_servers.chrome-devtools.startup_timeout_sec=30` by default so Chrome DevTools gets more time to initialize.
- The spawned terminal flow injects `AGENT_COMMS_PORT`, `AGENT_COMMS_PERSONA`, and `ROUTER_SHARED_SECRET` into child terminals.
- The spawned terminal flow also injects a stable `AGENT_COMMS_PROFILE_ID`, which lets the hub reconnect that session to its saved Slack persona after a restart.
- If you want per-agent Slack avatars, set `agentComms.slackIconsBaseUrl` in VS Code User settings to a public URL that serves this repo's `icons/` directory. Leave it blank if you prefer the Slack app's default avatar.
- Human Slack control is intentionally narrow: `@Agent Comms stop` or `/agent-comms stop` sends an interrupt-like escape to all tracked live agent terminals, and `@Agent Comms stop kill` or `/agent-comms stop kill` disposes those terminals.
- `@Agent Comms listen` or `/agent-comms listen` lets Nick's normal channel messages relay at high priority. Explicit `@persona` or `@ALL` recipients override routing; otherwise the hub fans the message out to all currently active agents. `@Agent Comms unlisten` or `/agent-comms unlisten` disables that relay again.
- `@Agent Comms see profiles` or `/agent-comms see profiles` prints the live active, idle, disconnected, reserved, and saved profile inventory so you can see exactly which names are occupied.
- `@Agent Comms clear disconnected` or `/agent-comms clear disconnected` drops every disconnected grace-period profile in one sweep without touching any live terminal.
- `@Agent Comms clear invalidated` or `/agent-comms clear invalidated` clears the invalidated profile-id store and sweeps saved/reserved/disconnected `unregistered-*` occupancy in one pass without touching live terminals.
- `@Agent Comms clear profile <persona>` or `/agent-comms clear profile <persona>` removes a specific persona from the saved profile store, releases pending reservations, and drops any matching live/disconnected session so the name becomes available immediately.
- `@Agent Comms clear profiles` or `/agent-comms clear profiles` asks for confirmation before wiping the saved profile store and clearing pending/disconnected occupancy. `@Agent Comms clear profiles confirm` or `/agent-comms clear profiles confirm` performs the safe wipe and leaves live agents alone.
- `@Agent Comms clear profiles all` or `/agent-comms clear profiles all` asks for confirmation before invalidating every profile id, including live connected agents, without killing terminals. `@Agent Comms clear profiles all confirm` or `/agent-comms clear profiles all confirm` renames live agents to temporary `unregistered-*` personas and forces them to re-register before the next Slack send.
- Connected sessions now default to active waiting/listening as soon as the bridge attaches; they do not need to enter reusable standby just to hear Slack.
- Codex active waiting/listening sessions now rely on terminal wake-up prompt injection plus the VS Code toast so the normal Codex TUI can react to inbound Slack without switching to an app-server host UI.
- Only explicit active working sessions use prompt injection, and only after the agent has marked itself working with `agent_comms_resume({ taskId: "..." })`.
- `agent_comms_standby({ taskId: "..." })` is now the true reusable idle mode. Use it only when you want the hub to treat that session as standby inventory.
- These operator controls only work when the app mention or slash command comes from `SLACK_OPERATOR_USER_ID`.
- Human Slack instructions are ignored by default. `@Agent Comms listen` temporarily enables high-priority operator relay until `@Agent Comms unlisten`.
- Claude custom channels still require Anthropic's development-channel flag during the current research-preview period; the spawn command adds that automatically.
- If you manually launch Claude outside `Agent Comms: Spawn Agent`, use `~/.agent-comms/bin/claude-agent-comms-resume` for resume flows or `~/.agent-comms/bin/claude-agent-comms ...` for other invocations rather than plain `claude ...`, or inbound pings may never surface in-session.
- Fresh manual sessions without a saved or claimed persona now connect under a temporary `unregistered-*` persona. Before the first outbound Slack post, rename with `agent_comms_rename(...)` or include `customName` / `projectName` + `personaSuffix` inline in `agent_comms_reply(...)`.
- Agent-created child spawns now require an explicit child name (`customName`, or `personaSuffix` / `instanceNumber` optionally with `projectName`). The child terminal opens under that assigned persona immediately.
- If you want to tune the Codex MCP startup headroom, set `agentComms.codexChromeDevtoolsStartupTimeoutSec` in VS Code user settings.
