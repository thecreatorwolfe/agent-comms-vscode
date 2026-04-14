import { describe, expect, it, vi } from 'vitest';
import { SpawnedTerminalRegistry } from '../registry/terminals';

describe('SpawnedTerminalRegistry', () => {
  it('tracks and disposes terminals by persona', () => {
    const dispose = vi.fn();
    const registry = new SpawnedTerminalRegistry();
    registry.track('security-audit-codex-1', {
      name: 'security-audit-codex-1',
      dispose,
    });

    expect(registry.disposeTracked('security-audit-codex-1')).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.listTrackedPersonas()).toEqual([]);
  });

  it('untracks terminals when the terminal closes externally', () => {
    const registry = new SpawnedTerminalRegistry();
    const terminal = {
      name: 'security-audit-alfred-1',
      dispose: vi.fn(),
    };
    registry.track('security-audit-alfred-1', terminal);

    expect(registry.untrackTerminal(terminal)).toBe('security-audit-alfred-1');
    expect(registry.listTrackedPersonas()).toEqual([]);
  });
});
