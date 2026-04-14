import { describe, expect, it } from 'vitest';
import { parseAgentSlackMessage } from '../schema/slack_message';
import { validateFrame } from '../schema/validate';

describe('frame validation', () => {
  it('accepts a valid auth frame', () => {
    const result = validateFrame({
      type: 'auth',
      secret: 'a'.repeat(64),
      agent_kind: 'codex',
      persona: 'security-audit-codex-1',
      pid: 1234,
      cwd: '/tmp/security-audit',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects malformed frames', () => {
    const result = validateFrame({
      type: 'heartbeat',
      persona: 'Not Valid',
      ts: 'yesterday',
    });

    expect(result.ok).toBe(false);
  });
});

describe('agent slack message schema', () => {
  it('parses a full protocol-compliant agent message', () => {
    const parsed = parseAgentSlackMessage(`[security-audit-codex-1→security-audit-alfred-1] TASK:bosa-phase0 | UTC:2026-04-14T00:30Z
SUBJECT: API schema answer

Here is the schema.

ASKS:
- [ ] security-audit-alfred-1: Validate the schema

STATUS: Written ✓ · Called ✗ · Deployed ✗ · Traced ✗`);

    expect(parsed.from).toBe('security-audit-codex-1');
    expect(parsed.asks).toHaveLength(1);
    expect(parsed.status?.written).toBe(true);
    expect(parsed.status?.called).toBe(false);
  });

  it('parses the new compact protocol form with only header and body', () => {
    const parsed = parseAgentSlackMessage(`[security-audit-codex-1→alfred-2]

Need the frontend status update.`);

    expect(parsed.from).toBe('security-audit-codex-1');
    expect(parsed.recipients).toEqual(['alfred-2']);
    expect(parsed.taskId).toBeUndefined();
    expect(parsed.subject).toBeUndefined();
    expect(parsed.body).toBe('Need the frontend status update.');
  });

  it('normalizes @-prefixed recipients inside the protocol header', () => {
    const parsed = parseAgentSlackMessage(`[security-audit-codex-1→@alfred-2, @NICK]

Need the frontend status update.`);

    expect(parsed.recipients).toEqual(['alfred-2', 'NICK']);
  });

  it('merges inline @recipient aliases from the message body into routed recipients', () => {
    const parsed = parseAgentSlackMessage(`[security-audit-codex-1→NICK]

@alfred-2 can you validate the frontend handoff?`);

    expect(parsed.recipients).toEqual(['NICK', 'alfred-2']);
  });

  it('rejects malformed asks', () => {
    expect(() =>
      parseAgentSlackMessage(`[security-audit-codex-1→security-audit-alfred-1] TASK:bosa-phase0 | UTC:2026-04-14T00:30Z
SUBJECT: API schema answer

Body

ASKS:
- nope`),
    ).toThrow(/Invalid ask line/);
  });
});
