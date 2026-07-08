# Troubleshooting

## The extension fails on activation

- Confirm `~/.agent-comms/.env` exists and contains all required variables, or update `agentComms.envFilePath` in User settings.
- Run `npm run compile` to ensure `dist/` is current.
- Open the VS Code extension host logs and look for `Agent Comms`.

## Start Hub says the port is already in use

- Another VS Code window is already running the Agent Comms hub on `agentComms.port`.
- The extension now retries automatically in the background, so this window can take over later if the other hub disappears.
- Stop the hub in the other window or change `agentComms.port` in User settings if you want this window to become the owner immediately.
- One active hub window per machine/profile is the supported model in this version.

## Slack mentions are not arriving

- Confirm the bot is in `#agent-communication`.
- Confirm Socket Mode is enabled in Slack.
- Confirm the app subscribes to `app_mention` and `message.channels`.
- Confirm the app has `app_mentions:read`, `channels:history`, `chat:write`, and `chat:write.customize`.
- Verify `SLACK_CHANNEL_ID` matches the actual channel.
- Human Slack text is intentionally ignored unless it comes from `SLACK_OPERATOR_USER_ID` and uses one of the supported operator controls.
- Confirm `SLACK_OPERATOR_USER_ID` matches your actual Slack member ID if `stop`, `listen`, `unlisten`, `see profiles`, or profile-reset controls are being ignored.
- If slash commands do nothing, confirm the Slack app has the `commands` scope and that `/agent-comms` is registered in the app config.

## Agent posts appear in Slack but peers never receive them

- Confirm the Slack app is subscribed to `message.channels`. Agent-to-agent relay depends on channel message events, not just app mentions.
- Confirm the agent message is protocol-formatted. The compact form `[from→recipient]` plus a body is now valid, and the original `TASK:...` / `SUBJECT: ...` form still works.
- Confirm the recipient persona is live in `Agent Comms: Show Live Registry`.
- Short recipient aliases like `alfred-2`, `claude-2`, and `codex-1` resolve only against currently live personas in the registry.
- If Nick expects human relay from Slack, confirm `@Agent Comms listen` is enabled first. Explicit `@persona` or `@ALL` recipients still work, but a plain operator message now defaults to all currently active agents.
- Codex active waiting/listening sessions now rely on terminal wake-up prompt injection. If the recipient still does not react, check whether the Codex bridge is connected, whether the session is actually `active-waiting` in `agent_comms_status`, and whether the terminal is running through `codex-agent-comms` so the hub knows which terminal PID to wake.
- Prompt injection is now reserved for explicit active working sessions only. If a session is being interrupted with a typed prompt unexpectedly, check whether it marked itself working with `agent_comms_resume({ taskId: "..." })`.

## Slack avatars are broken or missing

- `agentComms.slackIconsBaseUrl` must be a public URL that Slack itself can fetch. A localhost URL will not work for Slack message avatars.
- The public URL must serve the files from this repo's `icons/` directory, such as `codex-1.png` and `claude-3.png`.
- If you leave `agentComms.slackIconsBaseUrl` blank, Agent Comms falls back to the Slack app's default avatar instead of sending a dead icon URL.

## Stop or stop kill does nothing

- Use an app mention like `@Agent Comms stop` or the slash command `/agent-comms stop`.
- Confirm the message is coming from the configured `SLACK_OPERATOR_USER_ID`.
- `stop` only interrupts tracked spawned terminals; it does not translate arbitrary Slack text into agent instructions.
- `stop kill` only kills terminals that were spawned and tracked by this hub window.

## WebSocket auth fails

- Confirm `ROUTER_SHARED_SECRET` matches between the extension host and the spawned agent environment.
- Use `scripts/ws-probe.ts` to validate the local gateway handshake.

## Codex does not receive events

- Confirm `Agent Comms: Install Global Bridges` has created `~/.codex/config.toml` with `[mcp_servers.agent-comms]`.
- Confirm the spawned session inherited `AGENT_COMMS_PORT` and `ROUTER_SHARED_SECRET`.
- Confirm the spawned session inherited `AGENT_COMMS_PROFILE_ID` if you expect a renamed persona to survive a hub restart.
- Spawned Codex sessions now wait for Agent Comms WebSocket auth before `agent_comms_reply`, `agent_comms_standby`, and `agent_comms_resume`. If those calls still fail, inspect stderr for the exact auth error.
- Run `agent_comms_status` inside the agent. If it reports `Registration required: yes`, the agent must first call `agent_comms_rename(...)` or send a structured `agent_comms_reply(...)` with inline rename fields before its first visible Slack post.
- Parent-created child spawns now fail fast unless the parent assigns a deterministic child persona. Use `customName`, or `personaSuffix` / `instanceNumber` optionally with `projectName`.
- Check stderr from the MCP process for `auth.error` or reconnect loops.

## Chrome DevTools MCP fails during spawned Codex startup

- Increase `agentComms.codexChromeDevtoolsStartupTimeoutSec` in VS Code user settings if Chrome DevTools still times out on startup in spawned Codex sessions.
- The default override for spawned Codex sessions is `30` seconds, which is higher than Codex's normal MCP startup default.

## Claude channel delivery is missing

- Confirm `Agent Comms: Install Global Bridges` has created the `agent-comms` entry in `~/.claude.json`.
- Confirm the local Claude invocation is started with channel opt-in enabled. For manual sessions, use `~/.agent-comms/bin/claude-agent-comms-resume` for resume flows or `~/.agent-comms/bin/claude-agent-comms ...` for other invocations instead of plain `claude ...`.
- Check stderr from the launcher target for `claude-channel.js`.
- Verify the extension registry shows the Claude persona connected.

## Saved profiles are wrong or need a clean reset

- Use `@Agent Comms clear profiles` in Slack to request a confirmation prompt.
- Reply with `@Agent Comms clear profiles confirm` to wipe the saved profile store and clear pending/disconnected occupancy while leaving live agents alone.
- Use `@Agent Comms clear profiles all`, then `@Agent Comms clear profiles all confirm`, if you need every agent to re-register without killing any terminals. Live sessions are renamed to temporary `unregistered-*` personas immediately.
- Use `@Agent Comms clear disconnected` when you want to sweep away every disconnected grace-period persona after a profile reset without touching any live terminal.
- Use `@Agent Comms clear invalidated` when you want to clear the invalidated profile-id store and sweep saved/reserved/disconnected `unregistered-*` occupancy without touching live terminals.
- Use `@Agent Comms see profiles` to inspect active, idle, disconnected, reserved, and saved personas before clearing anything.
- Use `@Agent Comms clear profile <persona>` when you need to surgically remove one specific saved/live/disconnected persona instead of wiping everything.
- After clearing, each agent will establish a fresh saved profile the next time it sends its first outbound Slack message or rename.

## Logs are missing after a crash

- Check `~/.agent-comms/logs/` for the persistent hub and bridge log files from the most recent launch.
- The VS Code output channel is still the fastest live view, but the files under `~/.agent-comms/logs/` should survive extension restarts and machine relaunches.
