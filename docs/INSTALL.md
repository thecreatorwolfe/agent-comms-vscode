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

   - enable Socket Mode
   - subscribe to the `app_mention` event for human `stop` / `stop kill`
   - subscribe to the `message.channels` event so agent protocol posts are seen by the hub
   - grant `app_mentions:read`, `channels:history`, `chat:write`, and `chat:write.customize`

3. Compile the extension:

   ```bash
   npm run compile
   ```

4. Package locally if needed:

   ```bash
   npm run package:vsix
   ```

5. Install the extension in VS Code via `F5` or the packaged `.vsix`.

6. Run `Agent Comms: Install Global Bridges` from the Command Palette. This writes:

   - `~/.claude.json` with an `agent-comms` MCP server entry
   - `~/.codex/config.toml` with an `[mcp_servers.agent-comms]` entry
   - stable launcher scripts under `~/.agent-comms/bin/`
   - `~/.agent-comms/bin/claude-agent-comms`, a wrapper for manual Claude sessions that need inbound channel delivery

7. Open the local repo you want to orchestrate, then run `Agent Comms: Start Hub In This Workspace`.

8. Spawn agents from `Agent Comms: Spawn Agent`.

## Notes

- The extension is installed globally, but the live hub is intentionally started in one workspace window at a time.
- Spawned Codex sessions apply `mcp_servers.chrome-devtools.startup_timeout_sec=30` by default so Chrome DevTools gets more time to initialize.
- The spawned terminal flow injects `AGENT_COMMS_PORT`, `AGENT_COMMS_PERSONA`, and `ROUTER_SHARED_SECRET` into child terminals.
- If you want per-agent Slack avatars, set `agentComms.slackIconsBaseUrl` in VS Code User settings to a public URL that serves this repo's `icons/` directory. Leave it blank if you prefer the Slack app's default avatar.
- Human Slack control is intentionally narrow: `@Agent Comms stop` sends an interrupt-like escape to all tracked live agent terminals, and `@Agent Comms stop kill` disposes those terminals.
- Those two controls only work when the app mention comes from `SLACK_OPERATOR_USER_ID`.
- Normal human Slack instructions are ignored by the hub. Slack is for agent coordination and operator monitoring, not remote task steering.
- Claude custom channels still require Anthropic's development-channel flag during the current research-preview period; the spawn command adds that automatically.
- If you manually launch Claude outside `Agent Comms: Spawn Agent`, use `~/.agent-comms/bin/claude-agent-comms ...` rather than plain `claude ...` or inbound pings may never surface in-session.
- If you want to tune the Codex MCP startup headroom, set `agentComms.codexChromeDevtoolsStartupTimeoutSec` in VS Code user settings.
