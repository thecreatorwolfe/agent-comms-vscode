import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { buildSpawnCommand } from '../spawn';

describe('spawn command building', () => {
  it('adds the Chrome DevTools startup-timeout override to Codex spawns', () => {
    const command = buildSpawnCommand('codex', 'demo-codex-2', '/tmp/brief.md', 30);

    expect(command).toContain("codex -c 'mcp_servers.chrome-devtools.startup_timeout_sec=30'");
    expect(command).toContain('"$(cat \'/tmp/brief.md\')"');
  });

  it('does not add Codex MCP config overrides to Claude spawns', () => {
    const command = buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md', 30);

    expect(command).toContain('~/.agent-comms/bin/claude-agent-comms');
    expect(command).not.toContain('chrome-devtools.startup_timeout_sec');
  });
});
