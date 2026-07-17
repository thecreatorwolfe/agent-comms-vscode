import { describe, expect, it } from 'vitest';
import { MAX_BODY_LENGTH, parseAgentSlackMessage } from '../schema/slack_message';
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

  it('does not pull body @-mentions into routed recipients and keeps them literal (B2)', () => {
    const parsed = parseAgentSlackMessage(`[security-audit-codex-1→NICK]

@alfred-2 can you validate the frontend handoff? Site @1a6a696 is down.`);

    // Recipients come ONLY from the header. Body @tokens (known or unknown)
    // stay as literal text and never become routed recipients.
    expect(parsed.recipients).toEqual(['NICK']);
    expect(parsed.body).toContain('@alfred-2');
    expect(parsed.body).toContain('@1a6a696');
  });

  it('rejects a body longer than the documented cap (B7)', () => {
    const longBody = 'x'.repeat(MAX_BODY_LENGTH + 1);
    expect(() => parseAgentSlackMessage(`[security-audit-codex-1→NICK]\n\n${longBody}`)).toThrow();
  });

  it('accepts a body exactly at the documented cap (B7)', () => {
    const maxBody = 'x'.repeat(MAX_BODY_LENGTH);
    const parsed = parseAgentSlackMessage(`[security-audit-codex-1→NICK]\n\n${maxBody}`);
    expect(parsed.body).toHaveLength(MAX_BODY_LENGTH);
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
