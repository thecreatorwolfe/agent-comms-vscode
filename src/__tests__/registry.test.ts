import { describe, expect, it } from 'vitest';
import { AgentRegistry, type AgentSocketLike } from '../registry/agents';

function createSocket(): AgentSocketLike {
  return {
    send() {
      return undefined;
    },
    close() {
      return undefined;
    },
    terminate() {
      return undefined;
    },
  };
}

describe('AgentRegistry', () => {
  it('creates a reservation, then attaches the matching persona', () => {
    const registry = new AgentRegistry();
    const reservation = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      briefFilePath: '/tmp/brief.md',
      taskId: 'schema-pass',
    });

    const agent = registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      pid: 123,
      socket: createSocket(),
      persona: reservation.persona,
    });

    expect(agent.persona).toBe('security-audit-codex-1');
    expect(registry.getReservation(agent.persona)).toBeUndefined();
  });

  it('allocates direct-boot agents when no persona is supplied', () => {
    const registry = new AgentRegistry();
    const agent = registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'claude',
      pid: 321,
      socket: createSocket(),
    });

    expect(agent.persona).toBe('security-audit-alfred-1');
  });

  it('marks agents idle and can find reusable idle peers', () => {
    const registry = new AgentRegistry();
    const reserved = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      briefFilePath: '/tmp/brief.md',
      taskId: 'phase-1',
    });
    registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      pid: 456,
      socket: createSocket(),
      persona: reserved.persona,
    });

    registry.markStandby(reserved.persona, 'phase-1');
    const idle = registry.findIdleAgent('security-audit', 'codex');

    expect(idle?.persona).toBe(reserved.persona);
    expect(idle?.status).toBe('idle');
  });

  it('expires stale reservations and releases their number', () => {
    const registry = new AgentRegistry({ reservationTtlMs: 1 });
    const reservation = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'claude',
      briefFilePath: '/tmp/brief.md',
      taskId: 'phase-1',
    }, 0);

    registry.releaseExpired(2);
    const next = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'claude',
      briefFilePath: '/tmp/brief-2.md',
      taskId: 'phase-2',
    }, 3);

    expect(reservation.persona).toBe('security-audit-alfred-1');
    expect(next.persona).toBe('security-audit-alfred-1');
  });

  it('holds disconnected agents through the grace period, then releases them', () => {
    const registry = new AgentRegistry({ disconnectGraceMs: 10 });
    const reservation = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      briefFilePath: '/tmp/brief.md',
      taskId: 'phase-1',
    }, 0);
    registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      pid: 999,
      socket: createSocket(),
      persona: reservation.persona,
    }, 0);

    registry.markSocketClosed(reservation.persona, 5);
    expect(registry.list()).toHaveLength(0);

    registry.releaseExpired(16);
    const replacement = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      briefFilePath: '/tmp/brief-2.md',
      taskId: 'phase-2',
    }, 20);

    expect(replacement.persona).toBe('security-audit-codex-1');
  });
});
