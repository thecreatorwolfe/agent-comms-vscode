import { describe, expect, it, vi, beforeEach } from 'vitest';

const terminalStubs = vi.hoisted(() => {
  const createTerminal = vi.fn();
  return { createTerminal };
});

vi.mock('vscode', () => ({
  window: {
    createTerminal: terminalStubs.createTerminal,
    showQuickPick: vi.fn(),
  },
}));

import { AgentRegistry } from '../registry/agents';
import { buildSpawnCommand, spawnAgent, SpawnPreconditionError } from '../spawn';
import { isSupportedSpawnModel, normalizeSpawnModel, SPAWN_MODEL_VALUES } from '../spawn-model';

describe('spawn command building', () => {
  beforeEach(() => {
    terminalStubs.createTerminal.mockReset();
  });

  it('adds the Chrome DevTools startup-timeout override to Codex spawns', () => {
    const command = buildSpawnCommand('codex', 'demo-codex-2', '/tmp/brief.md', 30);

    expect(command).toContain("~/.agent-comms/bin/codex-agent-comms -c 'mcp_servers.chrome-devtools.startup_timeout_sec=30'");
    expect(command).toContain('"$(cat \'/tmp/brief.md\')"');
  });

  it('does not add Codex MCP config overrides to Claude spawns', () => {
    const command = buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md', 30);

    expect(command).toContain('~/.agent-comms/bin/claude-agent-comms');
    expect(command).not.toContain('chrome-devtools.startup_timeout_sec');
  });

  it('rejects parent spawns that do not assign a deterministic child persona', async () => {
    await expect(spawnAgent({
      kind: 'codex',
      briefFilePath: '/tmp/brief.md',
      taskId: 'child-review',
      parentPersona: 'checkout-flow-alfred-1',
      reuseIdle: false,
    }, {
      registry: new AgentRegistry(),
      workspaceRoot: '/tmp/project',
      extensionPort: 4011,
      routerSharedSecret: 'secret',
      extensionPath: '/tmp/extension',
    })).rejects.toThrow(SpawnPreconditionError);

    expect(terminalStubs.createTerminal).not.toHaveBeenCalled();
  });

  it('opens the terminal under the parent-assigned child persona', async () => {
    const show = vi.fn();
    const sendText = vi.fn();
    terminalStubs.createTerminal.mockReturnValue({
      name: 'checkout-flow-codex-7',
      show,
      sendText,
      dispose: vi.fn(),
    });

    const result = await spawnAgent({
      kind: 'codex',
      briefFilePath: '/tmp/brief.md',
      taskId: 'child-review',
      parentPersona: 'checkout-flow-alfred-1',
      customName: 'checkout-flow-codex-7',
      reuseIdle: false,
    }, {
      registry: new AgentRegistry(),
      workspaceRoot: '/tmp/project',
      extensionPort: 4011,
      routerSharedSecret: 'secret',
      extensionPath: '/tmp/extension',
    });

    expect(terminalStubs.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
      name: 'checkout-flow-codex-7',
      env: expect.objectContaining({
        AGENT_COMMS_PERSONA: 'checkout-flow-codex-7',
      }),
    }));
    expect(show).toHaveBeenCalledWith(true);
    expect(sendText).toHaveBeenCalled();
    expect(result.persona).toBe('checkout-flow-codex-7');
    expect(result.terminalName).toBe('checkout-flow-codex-7');
  });
});

describe('spawn command model selection', () => {
  it('omits the --model flag when no model is given (unchanged behavior)', () => {
    const command = buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md');

    expect(command).toBe("~/.agent-comms/bin/claude-agent-comms -n 'demo-alfred-1' \"$(cat '/tmp/brief.md')\"");
    expect(command).not.toContain('--model');
  });

  it('appends the --model flag for a short alias', () => {
    const command = buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md', undefined, 'opus');

    expect(command).toContain("--model 'opus'");
    expect(command).toContain("-n 'demo-alfred-1'");
  });

  it('appends the --model flag for a full model id', () => {
    const command = buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md', undefined, 'claude-opus-4-8');

    expect(command).toContain("--model 'claude-opus-4-8'");
  });

  it('normalizes model casing and whitespace', () => {
    const command = buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md', undefined, '  OPUS ');

    expect(command).toContain("--model 'opus'");
  });

  it('throws for an unsupported model on a Claude spawn', () => {
    expect(() => buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md', undefined, 'gpt-4o')).toThrow(/Unsupported model/);
  });

  it('rejects a model on a Codex spawn', () => {
    expect(() => buildSpawnCommand('codex', 'demo-codex-2', '/tmp/brief.md', 30, 'opus')).toThrow(/only supported for kind='claude'/);
  });
});

describe('spawn model normalization', () => {
  it('accepts all aliases and full ids', () => {
    for (const value of SPAWN_MODEL_VALUES) {
      expect(isSupportedSpawnModel(value)).toBe(true);
      expect(normalizeSpawnModel(value)).toBe(value);
    }
  });

  it('is case-insensitive and trims input', () => {
    expect(normalizeSpawnModel('Fable')).toBe('fable');
    expect(normalizeSpawnModel('  claude-sonnet-5  ')).toBe('claude-sonnet-5');
  });

  it('rejects unknown values', () => {
    expect(isSupportedSpawnModel('gpt-4o')).toBe(false);
    expect(() => normalizeSpawnModel('gpt-4o')).toThrow(/Unsupported model/);
  });
});
