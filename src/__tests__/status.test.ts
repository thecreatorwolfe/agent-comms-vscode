import { describe, expect, it } from 'vitest';
import { formatAgentConnectionSnapshot, formatAgentStatus } from '../mcp/status';

describe('formatAgentStatus', () => {
  it('includes pending inbox details for active agents', () => {
    expect(formatAgentStatus({
      persona: 'security-audit-codex-1',
      kind: 'codex',
      status: 'active',
      activity: 'working',
      taskId: 'phase-2',
      registrationRequired: false,
      pendingMessageCount: 3,
      pendingUrgentMessageCount: 1,
      lastInboundFrom: 'NICK',
      lastInboundAt: '2026-04-15T12:00:00.000Z',
      lastInboundTaskId: 'review-thread',
      lastInboundThreadTs: '1713081600.000100',
      connectedAt: '2026-04-15T11:00:00.000Z',
    })).toContain('Pending pings: 3');
    expect(formatAgentStatus({
      persona: 'security-audit-codex-1',
      kind: 'codex',
      status: 'active',
      activity: 'working',
      taskId: 'phase-2',
      registrationRequired: false,
      pendingMessageCount: 3,
      pendingUrgentMessageCount: 1,
      lastInboundFrom: 'NICK',
      lastInboundAt: '2026-04-15T12:00:00.000Z',
      lastInboundTaskId: 'review-thread',
      lastInboundThreadTs: '1713081600.000100',
      connectedAt: '2026-04-15T11:00:00.000Z',
    })).toContain('Urgent pings: 1');
    expect(formatAgentStatus({
      persona: 'security-audit-codex-1',
      kind: 'codex',
      status: 'active',
      activity: 'working',
      taskId: 'phase-2',
      registrationRequired: false,
      pendingMessageCount: 3,
      pendingUrgentMessageCount: 1,
      lastInboundFrom: 'NICK',
      lastInboundAt: '2026-04-15T12:00:00.000Z',
      lastInboundTaskId: 'review-thread',
      lastInboundThreadTs: '1713081600.000100',
      connectedAt: '2026-04-15T11:00:00.000Z',
    })).toContain('Last inbound from: NICK');
    expect(formatAgentStatus({
      persona: 'security-audit-codex-1',
      kind: 'codex',
      status: 'active',
      activity: 'working',
      taskId: 'phase-2',
      registrationRequired: false,
      pendingMessageCount: 3,
      pendingUrgentMessageCount: 1,
      lastInboundFrom: 'NICK',
      lastInboundAt: '2026-04-15T12:00:00.000Z',
      lastInboundTaskId: 'review-thread',
      lastInboundThreadTs: '1713081600.000100',
      connectedAt: '2026-04-15T11:00:00.000Z',
    })).toContain('Activity: working');
  });

  it('includes registration state in the connection snapshot', () => {
    expect(formatAgentConnectionSnapshot({
      state: 'connected',
      persona: 'unregistered-codex-deadbeef',
      authenticated: true,
      personaSource: 'generated',
      registrationRequired: true,
      lastError: undefined,
    })).toContain('Registration required: yes');
  });
});
