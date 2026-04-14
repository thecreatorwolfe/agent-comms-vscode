# Changelog

## 0.2.13

- Regenerated the Codex and Claude icon pack from the provided OpenAI and Anthropic source logos
- Split icon handling so local agent auth uses the hub's localhost `/icons` endpoint while Slack posts only use a configured public icon base URL
- Stopped sending dead default icon URLs to Slack when no public icon host is configured

## 0.2.12

- Disabled Bolt's default `ignoreSelf` filter so Agent Comms can ingest its own protocol Slack posts and relay them to live peers
- Made `agent_comms_reply` wait for a real outbound ack/error from the hub instead of reporting success immediately
- Added structured `agent_comms_reply` inputs so the tool can stamp the live persona automatically without placeholder guessing

## 0.2.11

- Fixed VS Code activation by removing the extra `spawn_command` runtime module edge that was missing from the packaged VSIX
- Cleaned the extension build/package path so stale compiled files in `dist/` do not leak into future VSIX packages

## 0.2.10

- Made the Codex and Claude Agent Comms tools wait for WebSocket auth before replying, standing by, resuming, or spawning peers
- Added a spawned-Codex `chrome-devtools` MCP startup-timeout override, configurable through `agentComms.codexChromeDevtoolsStartupTimeoutSec`
- Refreshed the packaged Slack icon set so Codex and Claude personas can use distinct hue-shifted logo variants keyed off the agent number

## 0.2.9

- Made the Claude and Codex Agent Comms MCP servers fall back to `~/.agent-comms/.env` so they start cleanly in restarted non-spawned sessions

## 0.2.8

- Hardened inbound Slack relay handling so only messages from the authenticated Agent Comms Slack bot identity are routed to live agents

## 0.2.7

- Moved MCP subprocess logging to stderr so Codex/Claude MCP handshakes are not corrupted by logger output on stdout

## 0.2.6

- Locked Slack `stop` and `stop kill` controls to a single configured operator via `SLACK_OPERATOR_USER_ID`

## 0.2.5

- Reworked the Claude channel bridge into a full MCP tool server so Claude now has the same `agent_comms_spawn`, `agent_comms_reply`, `agent_comms_standby`, and `agent_comms_resume` tools as Codex

## 0.2.4

- Changed Slack ingress so human app mentions no longer steer agents; only `stop` and `stop kill` are honored
- Added channel-message routing for protocol-formatted agent posts so live Claude/Codex peers can coordinate through Slack
- Added terminal tracking plus Slack-driven interrupt/kill handling for spawned live agents
- Added `agent_comms_spawn` to the Codex MCP server so agents can request new local peers without going through Slack

## 0.2.3

- Fixed VS Code activation/runtime logging so the extension no longer crashes on missing `pino-pretty`
- Switched the main VS Code extension runtime to plain Pino output by default

## 0.2.2

- Replaced raw Zod env parse output with a readable error that names the missing `~/.agent-comms/.env` fields
- Added a test covering the env validation error message

## 0.2.1

- Fixed VSIX packaging so runtime `node_modules/**/src/**` files are not stripped from dependencies like `ecdsa-sig-formatter`
- Repackaged the extension after verifying the activation failure cause in VS Code extension-host logs

## 0.2.0

- Extracted Agent Comms into its own standalone repo
- Switched the default env/config model to user-global paths under `~/.agent-comms/`
- Added explicit `Start Hub`, `Stop Hub`, and `Install Global Bridges` VS Code commands
- Added user-level Claude and Codex bridge installer logic with stable launcher scripts
- Updated the Claude spawn flow to load the development channel bridge automatically
- Added tests for global path resolution and config upsert behavior

## 0.1.0

- Added the extension runtime, Slack gateway, registry, persona allocation, and schema validation layers
- Added Claude and Codex MCP bridge subprocesses
- Added unit tests for schema, parsing, persona mapping, allocation, and registry behavior
- Added install, troubleshooting, architecture, CI, packaging, and Pages scaffolding
