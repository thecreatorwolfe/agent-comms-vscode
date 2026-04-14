import { describe, expect, it } from 'vitest';
import { isTrustedAgentRelayEvent, type SlackChannelMessageEvent, type SlackRuntimeIdentity } from '../slack/bolt';

describe('isTrustedAgentRelayEvent', () => {
  it('accepts a channel message from the configured Slack bot id', () => {
    const event: SlackChannelMessageEvent = {
      bot_id: 'B123',
      subtype: 'bot_message',
      text: '[demo-codex-1→demo-alfred-1] TASK:smoke | UTC:2026-04-14T08:00:00Z\nSUBJECT: hi\n\nbody',
      channel: 'C123',
      ts: '1713081600.000100',
    };
    const identity: SlackRuntimeIdentity = { botId: 'B123', botUserId: 'Ubot' };

    expect(isTrustedAgentRelayEvent(event, identity)).toBe(true);
  });

  it('accepts a channel message from the configured Slack bot user id', () => {
    const event: SlackChannelMessageEvent = {
      user: 'Ubot',
      subtype: 'bot_message',
      text: '[demo-codex-1→demo-alfred-1] TASK:smoke | UTC:2026-04-14T08:00:00Z\nSUBJECT: hi\n\nbody',
      channel: 'C123',
      ts: '1713081600.000100',
    };
    const identity: SlackRuntimeIdentity = { botUserId: 'Ubot' };

    expect(isTrustedAgentRelayEvent(event, identity)).toBe(true);
  });

  it('accepts a thread reply-style event when Slack only gives the bot user id', () => {
    const event: SlackChannelMessageEvent = {
      user: 'Ubot',
      text: '[demo-codex-1→demo-alfred-1]\n\n@alfred-1 ping',
      channel: 'C123',
      ts: '1713081600.000100',
      thread_ts: '1713081500.000001',
    };
    const identity: SlackRuntimeIdentity = { botUserId: 'Ubot' };

    expect(isTrustedAgentRelayEvent(event, identity)).toBe(true);
  });

  it('rejects a bot-style message from a different bot identity', () => {
    const event: SlackChannelMessageEvent = {
      user: 'Uother',
      bot_id: 'Bother',
      subtype: 'bot_message',
      text: '[demo-codex-1→demo-alfred-1] TASK:smoke | UTC:2026-04-14T08:00:00Z\nSUBJECT: hi\n\nbody',
      channel: 'C123',
      ts: '1713081600.000100',
    };
    const identity: SlackRuntimeIdentity = { botId: 'Btrusted', botUserId: 'Utrusted' };

    expect(isTrustedAgentRelayEvent(event, identity)).toBe(false);
  });

  it('rejects bot-style messages when no runtime identity is available yet', () => {
    const event: SlackChannelMessageEvent = {
      bot_id: 'B123',
      subtype: 'bot_message',
      text: '[demo-codex-1→demo-alfred-1] TASK:smoke | UTC:2026-04-14T08:00:00Z\nSUBJECT: hi\n\nbody',
      channel: 'C123',
      ts: '1713081600.000100',
    };

    expect(isTrustedAgentRelayEvent(event, undefined)).toBe(false);
  });
});
