import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_COMMS_CODEX_APPROVAL_TOML,
  DEFAULT_AGENT_COMMS_ENV_TEMPLATE,
  ensureGlobalBridgeLaunchers,
  getAgentCommsGlobalPaths,
  resolvePathTemplate,
  upsertClaudeConfigJson,
  upsertCodexConfigToml,
} from '../global';

describe('global path helpers', () => {
  it('includes the manual Codex Agent Comms launcher path', () => {
    expect(getAgentCommsGlobalPaths('/Users/tester').codexCliWrapperPath)
      .toBe('/Users/tester/.agent-comms/bin/codex-agent-comms');
  });

  it('includes the Codex app-server bridge launcher path', () => {
    expect(getAgentCommsGlobalPaths('/Users/tester').codexAppServerLauncherPath)
      .toBe('/Users/tester/.agent-comms/bin/codex-app-server-bridge.js');
  });

  it('resolves the default env path under the user home directory', () => {
    expect(
      resolvePathTemplate(DEFAULT_AGENT_COMMS_ENV_TEMPLATE, {
        userHome: '/Users/tester',
      }),
    ).toBe('/Users/tester/.agent-comms/.env');
  });

  it('resolves workspace-relative custom paths', () => {
    expect(
      resolvePathTemplate('./ops/agent.env', {
        workspaceRoot: '/tmp/project',
      }),
    ).toBe('/tmp/project/ops/agent.env');
  });

  it('includes the manual Claude Agent Comms launcher path', () => {
    expect(getAgentCommsGlobalPaths('/Users/tester').claudeCliWrapperPath)
      .toBe('/Users/tester/.agent-comms/bin/claude-agent-comms');
  });

  it('includes the stable Claude Agent Comms resume launcher path', () => {
    expect(getAgentCommsGlobalPaths('/Users/tester').claudeCliResumeWrapperPath)
      .toBe('/Users/tester/.agent-comms/bin/claude-agent-comms-resume');
  });

  it('writes the Codex wrapper as a plain Codex passthrough', async () => {
    const userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comms-global-'));
    const paths = await ensureGlobalBridgeLaunchers('/tmp/extension', userHome);
    const wrapper = await fs.readFile(paths.codexCliWrapperPath, 'utf8');

    expect(wrapper).toContain('exec codex "$@"');
  });
});

describe('global config upserts', () => {
  it('adds or replaces the Agent Comms Codex MCP table', () => {
    const initial = `[mcp_servers.other]\ncommand = "node"\n`;
    const inserted = upsertCodexConfigToml(initial, '/Users/tester/.agent-comms/bin/codex-server.js');

    expect(inserted).toContain('[mcp_servers.agent-comms]');
    expect(inserted).toContain('command = "node"');
    expect(inserted).toContain('/Users/tester/.agent-comms/bin/codex-server.js');
    expect(inserted).not.toContain('[profiles."agent-comms-codex"]');

    const replaced = upsertCodexConfigToml(inserted, '/Users/tester/.agent-comms/bin/codex-server-v2.js');
    expect(replaced.match(/\[mcp_servers\.agent-comms\]/g)).toHaveLength(1);
    expect(replaced).not.toContain('[profiles."agent-comms-codex"]');
    expect(replaced).toContain('/Users/tester/.agent-comms/bin/codex-server-v2.js');
  });

  it('replaces a global Codex never approval policy with MCP-elicitation-only granular approval', () => {
    const initial = `approval_policy = "never"\nservice_tier = "fast"\n`;
    const updated = upsertCodexConfigToml(initial, '/Users/tester/.agent-comms/bin/codex-server.js');

    expect(updated).toContain(AGENT_COMMS_CODEX_APPROVAL_TOML);
    expect(updated).not.toContain('approval_policy = "never"');
    expect(updated).toContain('service_tier = "fast"');
  });

  it('merges the Claude MCP server entry into ~/.claude.json', () => {
    const updated = upsertClaudeConfigJson(
      JSON.stringify({
        theme: 'dark',
        mcpServers: {
          existing: {
            command: 'node',
            args: ['/tmp/existing.js'],
          },
        },
      }),
      '/Users/tester/.agent-comms/bin/claude-channel.js',
    );

    const parsed = JSON.parse(updated);
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers.existing.args).toEqual(['/tmp/existing.js']);
    expect(parsed.mcpServers['agent-comms'].args).toEqual(['/Users/tester/.agent-comms/bin/claude-channel.js']);
  });
});
