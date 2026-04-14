import { describe, expect, it } from 'vitest';
import { buildProtocolSlackMessage, normalizeRecipients } from '../mcp/reply';

describe('reply helpers', () => {
  it('normalizes comma-delimited recipients', () => {
    expect(normalizeRecipients('NICK, demo-codex-2, ALL')).toEqual(['NICK', 'demo-codex-2', 'ALL']);
  });

  it('builds a protocol header from structured reply input', () => {
    expect(
      buildProtocolSlackMessage({
        from: 'demo-codex-1',
        recipients: ['NICK'],
        taskId: 'smoke-tools-2026-04-14',
        subject: 'Agent Comms tool smoke',
        body: 'Runtime: Codex\nCWD: /tmp/project\nsmoke test complete',
        utc: '2026-04-14T08:38:30Z',
      }),
    ).toBe(
      '[demo-codex-1→NICK] TASK:smoke-tools-2026-04-14 | UTC:2026-04-14T08:38:30Z\n' +
        'SUBJECT: Agent Comms tool smoke\n\n' +
        'Runtime: Codex\nCWD: /tmp/project\nsmoke test complete',
    );
  });
});
