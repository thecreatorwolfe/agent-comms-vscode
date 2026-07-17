import { describe, expect, it } from 'vitest';
import {
  parseAgentSlackEventText,
  parseHumanSlackControl,
  stripSlackUserMentions,
} from '../slack/parse';

describe('slack parsing', () => {
  it('strips Slack user mentions before control parsing', () => {
    expect(stripSlackUserMentions('<@U123> hello <@U999>')).toBe('hello');
  });

  it('accepts stop as the only non-destructive human Slack control', () => {
    expect(parseHumanSlackControl('<@U123> stop')).toEqual({ command: 'stop' });
  });

  it('accepts stop kill as the destructive human Slack control', () => {
    expect(parseHumanSlackControl('<@U123> stop kill')).toEqual({ command: 'stop_kill' });
  });

  it('accepts listen toggles and profile-clear controls from Slack', () => {
    expect(parseHumanSlackControl('<@U123> listen')).toEqual({ command: 'listen' });
    expect(parseHumanSlackControl('<@U123> unlisten')).toEqual({ command: 'unlisten' });
    expect(parseHumanSlackControl('<@U123> see profiles')).toEqual({ command: 'see_profiles' });
    expect(parseHumanSlackControl('<@U123> clear profile security-audit-codex-1')).toEqual({
      command: 'clear_profile',
      persona: 'security-audit-codex-1',
    });
    expect(parseHumanSlackControl('<@U123> clear profiles')).toEqual({ command: 'clear_profiles' });
    expect(parseHumanSlackControl('<@U123> clear profiles confirm')).toEqual({ command: 'clear_profiles_confirm' });
    expect(parseHumanSlackControl('<@U123> clear profiles all')).toEqual({ command: 'clear_profiles_all' });
    expect(parseHumanSlackControl('<@U123> clear profiles all confirm')).toEqual({ command: 'clear_profiles_all_confirm' });
    expect(parseHumanSlackControl('<@U123> clear disconnected')).toEqual({ command: 'clear_disconnected' });
    expect(parseHumanSlackControl('<@U123> clear invalidated')).toEqual({ command: 'clear_invalidated' });
  });

  it('ignores arbitrary human instructions from Slack', () => {
    expect(parseHumanSlackControl('<@U123> @security-audit-codex-1 please review this diff')).toEqual({
      command: 'ignore',
      normalized: '@security-audit-codex-1 please review this diff',
    });
  });

  it('parses bracketed agent protocol messages from the channel', () => {
    const result = parseAgentSlackEventText(`[security-audit-codex-1→security-audit-alfred-1] TASK:bosa-phase0 | UTC:2026-04-14T00:30Z
SUBJECT: API schema answer

Here is the schema.`);

    expect(result.route).toBe('agent_header');
    if (result.route !== 'agent_header') {
      throw new Error('unexpected route');
    }

    expect(result.message.recipients).toEqual(['security-audit-alfred-1']);
    expect(result.message.taskId).toBe('bosa-phase0');
  });

  it('keeps body @-mentions literal and out of routed recipients (B2)', () => {
    const result = parseAgentSlackEventText(`[security-audit-codex-1→NICK]

@alfred-2 please review the frontend branch. Site @1a6a696 is down.`);

    expect(result.route).toBe('agent_header');
    if (result.route !== 'agent_header') {
      throw new Error('unexpected route');
    }

    // Recipients come only from the header; body @tokens (known or unknown)
    // are literal text and are resolved to bonus targets later, never here.
    expect(result.message.recipients).toEqual(['NICK']);
    expect(result.message.body).toContain('@alfred-2');
    expect(result.message.body).toContain('@1a6a696');
  });

  it('flags malformed agent protocol posts instead of routing them', () => {
    const result = parseAgentSlackEventText(`[security-audit-codex-1→security-audit-alfred-1] TASK:not valid
SUBJECT: broken

Body`);

    expect(result.route).toBe('invalid_protocol');
  });

  it('ignores non-protocol channel chatter', () => {
    const result = parseAgentSlackEventText('hello channel');
    expect(result.route).toBe('unrouted');
  });
});
