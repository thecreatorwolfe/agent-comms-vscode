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
import { buildSpawnCommand, spawnAgent, SpawnPreconditionError, DEFAULT_DEV_CHANNELS_ACCEPT_DELAYS_MS } from '../spawn';
import { isSupportedSpawnEffort, isSupportedSpawnModel, normalizeSpawnEffort, normalizeSpawnModel, SPAWN_MODEL_VALUES } from '../spawn-model';

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

  it('passes a Codex model through -m (0.2.49) and refuses one a command line cannot carry', () => {
    const command = buildSpawnCommand('codex', 'demo-codex-2', '/tmp/brief.md', 30, 'gpt-6-astra');
    expect(command).toContain("~/.agent-comms/bin/codex-agent-comms -m 'gpt-6-astra' -c 'mcp_servers.chrome-devtools.startup_timeout_sec=30'");
    expect(() => buildSpawnCommand('codex', 'demo-codex-2', '/tmp/brief.md', 30, 'x; rm -rf /')).toThrow(/Unsupported codex model/);
  });
});

describe('spawn command effort selection (0.2.49)', () => {
  it('omits --effort when none is given', () => {
    expect(buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md')).not.toContain('--effort');
    expect(buildSpawnCommand('codex', 'demo-codex-2', '/tmp/brief.md')).not.toContain('model_reasoning_effort');
  });

  it('appends --effort for Claude and maps minimal → low', () => {
    expect(buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md', undefined, 'opus', 'xhigh'))
      .toBe("~/.agent-comms/bin/claude-agent-comms --model 'opus' --effort 'xhigh' -n 'demo-alfred-1' \"$(cat '/tmp/brief.md')\"");
    expect(buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md', undefined, null, 'MINIMAL')).toContain("--effort 'low'");
  });

  it('appends a TOML model_reasoning_effort for Codex and maps max → xhigh', () => {
    expect(buildSpawnCommand('codex', 'demo-codex-2', '/tmp/brief.md', undefined, null, 'high'))
      .toBe("~/.agent-comms/bin/codex-agent-comms -c 'model_reasoning_effort=\"high\"' \"$(cat '/tmp/brief.md')\"");
    expect(buildSpawnCommand('codex', 'demo-codex-2', '/tmp/brief.md', undefined, null, 'max')).toContain('model_reasoning_effort="xhigh"');
  });

  it('refuses an effort neither CLI knows', () => {
    expect(() => buildSpawnCommand('claude', 'demo-alfred-1', '/tmp/brief.md', undefined, null, 'turbo')).toThrow(/Unsupported effort/);
    expect(() => buildSpawnCommand('codex', 'demo-codex-2', '/tmp/brief.md', undefined, null, 'max-plus')).toThrow(/Unsupported effort/);
    expect(isSupportedSpawnEffort('claude', 'max')).toBe(true);
    expect(isSupportedSpawnEffort('codex', 'minimal')).toBe(true);
    expect(normalizeSpawnEffort('codex', 'max')).toBe('xhigh');
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

describe('spawn dev-channels auto-accept (0.2.49)', () => {
  it('writes a carriage return into a Claude terminal at each delay, and never into a Codex one', async () => {
    vi.useFakeTimers();
    try {
      const sendText = vi.fn();
      terminalStubs.createTerminal.mockReturnValue({ name: 'demo-alfred-9', show: vi.fn(), sendText, dispose: vi.fn() });
      const deps = { registry: new AgentRegistry(), workspaceRoot: '/tmp/project', extensionPort: 4011, routerSharedSecret: 'secret', extensionPath: '/tmp/extension', claudeDevChannelsAcceptDelaysMs: [100, 200] };
      await spawnAgent({ kind: 'claude', briefFilePath: '/tmp/brief.md', taskId: 'child-a', customName: 'demo-alfred-9', reuseIdle: false, effort: 'xhigh' }, deps);
      expect(sendText).toHaveBeenCalledTimes(1);           // the launch command only, so far
      expect(sendText.mock.calls[0][0]).toContain("--effort 'xhigh'");
      vi.advanceTimersByTime(150);
      expect(sendText).toHaveBeenCalledTimes(2);
      expect(sendText).toHaveBeenLastCalledWith('\r', false);
      vi.advanceTimersByTime(100);
      expect(sendText).toHaveBeenCalledTimes(3);

      const codexSend = vi.fn();
      terminalStubs.createTerminal.mockReturnValue({ name: 'demo-codex-3', show: vi.fn(), sendText: codexSend, dispose: vi.fn() });
      await spawnAgent({ kind: 'codex', briefFilePath: '/tmp/brief.md', taskId: 'child-b', customName: 'demo-codex-3', reuseIdle: false, model: 'gpt-6-astra', effort: 'low' }, deps);
      vi.advanceTimersByTime(1000);
      expect(codexSend).toHaveBeenCalledTimes(1);
      expect(codexSend.mock.calls[0][0]).toContain("-m 'gpt-6-astra' -c 'model_reasoning_effort=\"low\"'");
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be switched off, and has sane defaults', async () => {
    vi.useFakeTimers();
    try {
      const sendText = vi.fn();
      terminalStubs.createTerminal.mockReturnValue({ name: 'demo-alfred-10', show: vi.fn(), sendText, dispose: vi.fn() });
      await spawnAgent({ kind: 'claude', briefFilePath: '/tmp/brief.md', taskId: 'child-c', customName: 'demo-alfred-10', reuseIdle: false },
        { registry: new AgentRegistry(), workspaceRoot: '/tmp/project', extensionPort: 4011, routerSharedSecret: 'secret', extensionPath: '/tmp/extension', claudeDevChannelsAutoAccept: false });
      vi.advanceTimersByTime(20000);
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(DEFAULT_DEV_CHANNELS_ACCEPT_DELAYS_MS).toEqual([2500, 5000, 8000]);
    } finally {
      vi.useRealTimers();
    }
  });
});
