# Troubleshooting

## The extension fails on activation

- Confirm `~/.agent-comms/.env` exists and contains all required variables, or update `agentComms.envFilePath` in User settings.
- Run `npm run compile` to ensure `dist/` is current.
- Open the VS Code extension host logs and look for `Agent Comms`.

## Start Hub says the port is already in use

- Another VS Code window is already running the Agent Comms hub on `agentComms.port`.
- Stop the hub in the other window or change `agentComms.port` in User settings.
- One active hub window per machine/profile is the supported model in this version.

## Slack mentions are not arriving

- Confirm the bot is in `#agent-communication`.
- Confirm Socket Mode is enabled in Slack.
- Confirm the app subscribes to `app_mention` and `message.channels`.
- Confirm the app has `app_mentions:read`, `channels:history`, `chat:write`, and `chat:write.customize`.
- Verify `SLACK_CHANNEL_ID` matches the actual channel.
- Human Slack text is intentionally ignored unless it is an app mention with exactly `stop` or `stop kill`.
- Confirm `SLACK_OPERATOR_USER_ID` matches your actual Slack member ID if `stop` and `stop kill` are being ignored.

## Agent posts appear in Slack but peers never receive them

- Confirm the Slack app is subscribed to `message.channels`. Agent-to-agent relay depends on channel message events, not just app mentions.
- Confirm the agent message is protocol-formatted with the bracketed header, `TASK:...`, and `SUBJECT: ...`.
- Confirm the recipient persona is live in `Agent Comms: Show Live Registry`.

## Slack avatars are broken or missing

- `agentComms.slackIconsBaseUrl` must be a public URL that Slack itself can fetch. A localhost URL will not work for Slack message avatars.
- The public URL must serve the files from this repo's `icons/` directory, such as `codex-1.png` and `claude-3.png`.
- If you leave `agentComms.slackIconsBaseUrl` blank, Agent Comms falls back to the Slack app's default avatar instead of sending a dead icon URL.

## Stop or stop kill does nothing

- Use an app mention, e.g. `@Agent Comms stop` or `@Agent Comms stop kill`.
- Confirm the message is coming from the configured `SLACK_OPERATOR_USER_ID`.
- `stop` only interrupts tracked spawned terminals; it does not translate arbitrary Slack text into agent instructions.
- `stop kill` only kills terminals that were spawned and tracked by this hub window.

## WebSocket auth fails

- Confirm `ROUTER_SHARED_SECRET` matches between the extension host and the spawned agent environment.
- Use `scripts/ws-probe.ts` to validate the local gateway handshake.

## Codex does not receive events

- Confirm `Agent Comms: Install Global Bridges` has created `~/.codex/config.toml` with `[mcp_servers.agent-comms]`.
- Confirm the spawned session inherited `AGENT_COMMS_PORT` and `ROUTER_SHARED_SECRET`.
- Spawned Codex sessions now wait for Agent Comms WebSocket auth before `agent_comms_reply`, `agent_comms_standby`, and `agent_comms_resume`. If those calls still fail, inspect stderr for the exact auth error.
- Check stderr from the MCP process for `auth.error` or reconnect loops.

## Chrome DevTools MCP fails during spawned Codex startup

- Increase `agentComms.codexChromeDevtoolsStartupTimeoutSec` in VS Code user settings if Chrome DevTools still times out on startup in spawned Codex sessions.
- The default override for spawned Codex sessions is `30` seconds, which is higher than Codex's normal MCP startup default.

## Claude channel delivery is missing

- Confirm `Agent Comms: Install Global Bridges` has created the `agent-comms` entry in `~/.claude.json`.
- Confirm the local Claude invocation loads the channel bridge in development mode.
- Check stderr from the launcher target for `claude-channel.js`.
- Verify the extension registry shows the Claude persona connected.
