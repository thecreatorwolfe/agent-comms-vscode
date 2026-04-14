import { describe, expect, it } from 'vitest';
import { buildProtocolSlackMessage, formatSlackHistoryTranscript, normalizeRecipients } from '../mcp/reply';

describe('reply helpers', () => {
  it('normalizes comma-delimited recipients', () => {
    expect(normalizeRecipients('NICK, demo-codex-2, ALL')).toEqual(['NICK', 'demo-codex-2', 'ALL']);
    expect(normalizeRecipients('@NICK, @alfred-30, @all')).toEqual(['NICK', 'alfred-30', 'ALL']);
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

  it('builds a compact protocol message when only recipients and body are provided', () => {
    expect(
      buildProtocolSlackMessage({
        from: 'demo-codex-1',
        recipients: ['alfred-2'],
        body: 'Can you take the frontend pass?',
      }),
    ).toBe('[demo-codex-1→alfred-2]\n\nCan you take the frontend pass?');
  });

  it('formats Slack history into a readable transcript', () => {
    expect(
      formatSlackHistoryTranscript([
        {
          ts: '1776157290.950299',
          user: 'U123',
          text: 'Need a frontend review.',
        },
        {
          ts: '1776157291.950299',
          botId: 'B123',
          threadTs: '1776157290.950299',
          text: '[demo-codex-1→alfred-2]\n\nCan you take this?',
        },
      ]),
    ).toBe(
      '[1776157290.950299] U123\nNeed a frontend review.\n\n' +
        '[1776157291.950299] B123 thread:1776157290.950299\n[demo-codex-1→alfred-2]\n\nCan you take this?',
    );
  });
});
