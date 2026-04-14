import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_COMMS_ENV_TEMPLATE,
  getAgentCommsGlobalPaths,
  resolvePathTemplate,
  upsertClaudeConfigJson,
  upsertCodexConfigToml,
} from '../global';

describe('global path helpers', () => {
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
});

describe('global config upserts', () => {
  it('adds or replaces the Agent Comms Codex MCP table', () => {
    const initial = `[mcp_servers.other]\ncommand = "node"\n`;
    const inserted = upsertCodexConfigToml(initial, '/Users/tester/.agent-comms/bin/codex-server.js');

    expect(inserted).toContain('[mcp_servers.agent-comms]');
    expect(inserted).toContain('command = "node"');
    expect(inserted).toContain('/Users/tester/.agent-comms/bin/codex-server.js');

    const replaced = upsertCodexConfigToml(inserted, '/Users/tester/.agent-comms/bin/codex-server-v2.js');
    expect(replaced.match(/\[mcp_servers\.agent-comms\]/g)).toHaveLength(1);
    expect(replaced).toContain('/Users/tester/.agent-comms/bin/codex-server-v2.js');
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
