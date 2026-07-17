import type { Logger } from 'pino';
import { looksLikeAgentProtocolMessage, type SlackBoltRuntime, type SlackChannelMessageEvent } from './bolt';

export const CHANNEL_POLL_INTERVAL_MS = 5_000;

/**
 * Actively polls the shared Slack channel for agent-protocol messages.
 *
 * Slack Socket Mode load-balances each event across ALL of an app's live
 * connections. When multiple hubs (the fleet) share one Slack app, a given
 * message event is delivered to only ONE hub — not necessarily the hub that
 * owns the addressed persona — so realtime inbound pings are unreliable ("not
 * responding"; pending stays 0). This poller guarantees every hub sees every
 * channel message and delivers the ones addressed to its own locally-registered
 * personas, independent of which connection Slack routed the realtime event to.
 *
 * Delivery is de-duplicated against the Socket Mode path by the caller (via
 * RecentlyDeliveredSlackTs inside the shared inbound handler), so each message
 * is delivered at most once regardless of which path observed it first. (B1)
 */
export class ChannelInboundPoller {
  private cursorTs: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly slack: Pick<SlackBoltRuntime, 'client'>,
    private readonly channelId: string,
    private readonly intervalMs: number,
    private readonly onProtocolMessage: (event: SlackChannelMessageEvent) => Promise<void>,
    private readonly logger?: Logger,
  ) {}

  async start(): Promise<void> {
    // Seed the cursor at the latest message so startup does not replay history;
    // only messages posted after boot are delivered.
    try {
      const seed = await this.slack.client.conversations.history({ channel: this.channelId, limit: 1 });
      this.cursorTs = Array.isArray(seed.messages) && seed.messages[0] && typeof seed.messages[0].ts === 'string'
        ? seed.messages[0].ts
        : undefined;
    } catch (error) {
      this.logger?.warn({ err: error }, 'channel poller seed failed; starting from latest observed message');
    }

    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const response = await this.slack.client.conversations.history({
        channel: this.channelId,
        oldest: this.cursorTs,
        limit: 50,
      });
      if (!response.ok) {
        return;
      }

      const messages = (Array.isArray(response.messages) ? response.messages : [])
        .filter((message): message is typeof message & { text: string; ts: string } => (
          typeof message === 'object'
          && message !== null
          && 'text' in message
          && typeof message.text === 'string'
          && 'ts' in message
          && typeof message.ts === 'string'
        ))
        .sort((left, right) => Number(left.ts) - Number(right.ts));

      for (const message of messages) {
        if (this.cursorTs && Number(message.ts) <= Number(this.cursorTs)) {
          continue;
        }
        this.cursorTs = message.ts;
        if (!looksLikeAgentProtocolMessage(message.text)) {
          continue;
        }

        await this.onProtocolMessage({
          user: 'user' in message && typeof message.user === 'string' ? message.user : undefined,
          bot_id: 'bot_id' in message && typeof message.bot_id === 'string' ? message.bot_id : undefined,
          subtype: 'subtype' in message && typeof message.subtype === 'string' ? message.subtype : undefined,
          text: message.text,
          channel: this.channelId,
          ts: message.ts,
          thread_ts: 'thread_ts' in message && typeof message.thread_ts === 'string' ? message.thread_ts : undefined,
        });
      }
    } catch (error) {
      this.logger?.warn({ err: error }, 'channel poller iteration failed');
    } finally {
      this.polling = false;
    }
  }
}
