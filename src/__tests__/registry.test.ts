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
    expect(agent.activity).toBe('waiting');
    expect(agent.taskId).toBe('schema-pass');
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
    expect(agent.activity).toBe('waiting');
  });

  it('reattaches a claimed persona even when the reservation was lost', () => {
    const registry = new AgentRegistry();

    const agent = registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      pid: 654,
      socket: createSocket(),
      persona: 'security-audit-codex-7',
    });

    expect(agent.persona).toBe('security-audit-codex-7');
    expect(agent.status).toBe('active');
    expect(agent.activity).toBe('waiting');
    expect(registry.get('security-audit-codex-7')?.pid).toBe(654);
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
    expect(idle?.activity).toBe('waiting');
  });

  it('tracks pending inbound messages on active agents without making them reusable', () => {
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

    registry.noteInboundMessage(reserved.persona, {
      fromPersona: 'NICK',
      urgent: true,
      taskId: 'phase-2',
      threadTs: '1713081600.000100',
      receivedAt: '2026-04-15T12:00:00.000Z',
    });

    const active = registry.get(reserved.persona);

    expect(active?.status).toBe('active');
    expect(active?.activity).toBe('waiting');
    expect(active?.pendingMessageCount).toBe(1);
    expect(active?.pendingUrgentMessageCount).toBe(1);
    expect(active?.lastInboundFrom).toBe('NICK');
    expect(registry.findIdleAgent('security-audit', 'codex')).toBeUndefined();

    registry.clearPendingMessages(reserved.persona);
    expect(registry.get(reserved.persona)?.pendingMessageCount).toBe(0);
    expect(registry.get(reserved.persona)?.lastInboundFrom).toBeUndefined();
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

  it('renames a live agent and preserves routing state', () => {
    const registry = new AgentRegistry();
    const reservation = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'claude',
      briefFilePath: '/tmp/brief.md',
      taskId: 'frontend-pass',
    }, 0);
    registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'claude',
      pid: 8080,
      socket: createSocket(),
      persona: reservation.persona,
    }, 0);

    const renamed = registry.rename({
      persona: reservation.persona,
      projectName: 'checkout-flow',
      instanceNumber: 30,
    });

    expect(renamed.previousPersona).toBe('security-audit-alfred-1');
    expect(renamed.agent.persona).toBe('checkout-flow-alfred-30');
    expect(registry.get('checkout-flow-alfred-30')?.pid).toBe(8080);
    expect(registry.get('security-audit-alfred-1')).toBeUndefined();
  });

  it('marks resumed agents as waiting when no task is supplied', () => {
    const registry = new AgentRegistry();
    const reservation = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      briefFilePath: '/tmp/brief.md',
      taskId: 'frontend-pass',
    }, 0);
    registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      pid: 8082,
      socket: createSocket(),
      persona: reservation.persona,
    }, 0);

    const resumed = registry.markResume(reservation.persona);

    expect(resumed.status).toBe('active');
    expect(resumed.activity).toBe('waiting');
    expect(resumed.taskId).toBeUndefined();
  });

  it('marks resumed agents as working when a task is supplied', () => {
    const registry = new AgentRegistry();
    const reservation = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      briefFilePath: '/tmp/brief.md',
      taskId: 'frontend-pass',
    }, 0);
    registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      pid: 8083,
      socket: createSocket(),
      persona: reservation.persona,
    }, 0);

    const resumed = registry.markResume(reservation.persona, 'frontend-pass');

    expect(resumed.status).toBe('active');
    expect(resumed.activity).toBe('working');
    expect(resumed.taskId).toBe('frontend-pass');
  });

  it('invalidates a live agent registration without dropping the session', () => {
    const registry = new AgentRegistry();
    const reservation = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      briefFilePath: '/tmp/brief.md',
      taskId: 'frontend-pass',
    }, 0);
    registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'codex',
      pid: 8081,
      socket: createSocket(),
      persona: reservation.persona,
    }, 0);

    registry.noteInboundMessage(reservation.persona, {
      fromPersona: 'NICK',
      urgent: true,
      taskId: 'review-thread',
      threadTs: '1713081600.000100',
      receivedAt: '2026-04-15T12:00:00.000Z',
    });

    const invalidated = registry.invalidateRegistration(reservation.persona);

    expect(invalidated.previousPersona).toBe('security-audit-codex-1');
    expect(invalidated.agent.persona).toMatch(/^unregistered-codex-/);
    expect(invalidated.agent.pid).toBe(8081);
    expect(invalidated.agent.registrationRequired).toBe(true);
    expect(invalidated.agent.pendingMessageCount).toBe(0);
    expect(invalidated.agent.lastInboundFrom).toBeUndefined();
    expect(registry.get(reservation.persona)).toBeUndefined();
    expect(registry.get(invalidated.agent.persona)?.pid).toBe(8081);
  });
});
