import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { Logger } from 'pino';
import type { AgentCommsEnv } from '../env';

export interface SlackAppMentionEvent {
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

export interface SlackChannelMessageEvent {
  user?: string;
  bot_id?: string;
  subtype?: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

export interface SlackSlashCommandEvent {
  user: string;
  text: string;
  channel: string;
  command: string;
  ts: string;
}

export interface SlackRuntimeIdentity {
  botId?: string;
  botUserId?: string;
  appId?: string;
  teamId?: string;
}

export interface SlackBoltRuntime {
  app: App;
  client: WebClient;
  getIdentity(): SlackRuntimeIdentity | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateSlackBoltRuntimeOptions {
  env: AgentCommsEnv;
  logger?: Logger;
  onFault?: (source: string, error: unknown) => void;
  onAppMention: (event: SlackAppMentionEvent) => Promise<void> | void;
  onChannelMessage: (event: SlackChannelMessageEvent) => Promise<void> | void;
  onHumanChannelMessage?: (event: SlackChannelMessageEvent) => Promise<void> | void;
  onSlashCommand?: (event: SlackSlashCommandEvent) => Promise<string | void> | string | void;
}

const AGENT_PROTOCOL_HEADER = /^\s*\[[^\]\n]+→[^\]\n]+\]/u;

/**
 * True when the message text carries the agent coordination protocol header
 * `[from→recipients]` on its first line. Such messages are delivered to the
 * agent-relay path no matter which hub instance, bot token, or user token
 * originated them: the shared Slack channel is the bus, and a peer hub (or a
 * user-token relay) posting a message addressed to a locally-registered
 * persona must still wake that persona. De-duplication of our own echoes and
 * filtering to locally-registered recipients happens downstream, so this is
 * safe from loops and cross-talk between hubs.
 */
export function looksLikeAgentProtocolMessage(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) {
    return false;
  }

  const stripped = text.replace(/<@[A-Z0-9]+>/g, ' ').trimStart();
  return AGENT_PROTOCOL_HEADER.test(stripped);
}

export function isTrustedAgentRelayEvent(
  event: SlackChannelMessageEvent,
  identity: SlackRuntimeIdentity | undefined,
): boolean {
  if (!identity) {
    return false;
  }

  if (event.bot_id && identity.botId && event.bot_id === identity.botId) {
    return true;
  }

  if (event.user && identity.botUserId && event.user === identity.botUserId) {
    return true;
  }

  return false;
}

export function createSlackBoltRuntime(options: CreateSlackBoltRuntimeOptions): SlackBoltRuntime {
  const app = new App({
    token: options.env.SLACK_BOT_TOKEN,
    appToken: options.env.SLACK_APP_TOKEN,
    signingSecret: options.env.SLACK_SIGNING_SECRET,
    ignoreSelf: false,
    socketMode: true,
    deferInitialization: false,
  });
  let identity: SlackRuntimeIdentity | undefined;

  app.event('app_mention', async ({ event }) => {
    try {
      if (event.channel !== options.env.SLACK_CHANNEL_ID) {
        return;
      }

      await options.onAppMention({
        user: event.user ?? 'unknown',
        text: event.text,
        channel: event.channel,
        ts: event.ts,
        thread_ts: 'thread_ts' in event ? event.thread_ts : undefined,
      });
    } catch (error) {
      options.logger?.error({ err: error, ts: event.ts }, 'slack app_mention handler failed');
      options.onFault?.('slack.app_mention', error);
    }
  });

  app.command('/agent-comms', async ({ command, ack }) => {
    try {
      if (command.channel_id !== options.env.SLACK_CHANNEL_ID) {
        await ack({
          response_type: 'ephemeral',
          text: 'Agent Comms slash commands are only enabled in the configured coordination channel.',
        });
        return;
      }

      const responseText = await options.onSlashCommand?.({
        user: command.user_id,
        text: command.text,
        channel: command.channel_id,
        command: command.command,
        ts: new Date().toISOString(),
      });
      await ack({
        response_type: 'ephemeral',
        text: responseText ?? 'Agent Comms acknowledged.',
      });
    } catch (error) {
      options.logger?.error({ err: error, command: command.command }, 'slack slash command handler failed');
      options.onFault?.('slack.command', error);
      await ack({
        response_type: 'ephemeral',
        text: 'Agent Comms command failed. Check the Agent Comms output channel in VS Code.',
      });
    }
  });

  app.event('message', async ({ event }) => {
    try {
      if (!('channel' in event) || event.channel !== options.env.SLACK_CHANNEL_ID) {
        return;
      }

      if (!('text' in event) || typeof event.text !== 'string') {
        return;
      }

      const subtype = 'subtype' in event ? event.subtype : undefined;
      const botId = 'bot_id' in event ? event.bot_id : undefined;
      const normalizedEvent = {
        user: 'user' in event ? event.user : undefined,
        bot_id: botId,
        subtype,
        text: event.text,
        channel: event.channel,
        ts: event.ts,
        thread_ts: 'thread_ts' in event ? event.thread_ts : undefined,
      };
      // Any message carrying the agent protocol header is coordination
      // traffic. Deliver it to the relay path regardless of which hub, bot
      // token, or user token posted it. This is the root fix for cross-hub
      // messages (e.g. a peer hub or a user-token relay) never waking a
      // locally-registered persona. Downstream de-dupes our own echoes and
      // filters to locally-registered recipients.
      if (looksLikeAgentProtocolMessage(normalizedEvent.text)) {
        await options.onChannelMessage(normalizedEvent);
        return;
      }

      const isBotStyleEvent = subtype === 'bot_message'
        || Boolean(normalizedEvent.bot_id)
        || Boolean(normalizedEvent.user && identity?.botUserId && normalizedEvent.user === identity.botUserId);
      if (!isBotStyleEvent) {
        await options.onHumanChannelMessage?.(normalizedEvent);
        return;
      }

      // Bot-style traffic that is NOT agent protocol (e.g. other Slack apps).
      // Keep the original trust gate so unrelated bot chatter is ignored.
      if (!isTrustedAgentRelayEvent(normalizedEvent, identity)) {
        options.logger?.warn(
          {
            user: normalizedEvent.user,
            bot_id: normalizedEvent.bot_id,
            ts: normalizedEvent.ts,
          },
          'ignored non-protocol bot-style Slack message from untrusted sender',
        );
        return;
      }

      await options.onChannelMessage(normalizedEvent);
    } catch (error) {
      options.logger?.error({ err: error, ts: 'ts' in event ? event.ts : undefined }, 'slack message handler failed');
      options.onFault?.('slack.message', error);
    }
  });

  return {
    app,
    client: app.client,
    getIdentity(): SlackRuntimeIdentity | undefined {
      return identity;
    },
    async start(): Promise<void> {
      try {
        const auth = await app.client.auth.test();
        identity = {
          botId: 'bot_id' in auth && typeof auth.bot_id === 'string' ? auth.bot_id : undefined,
          botUserId: 'user_id' in auth && typeof auth.user_id === 'string' ? auth.user_id : undefined,
          appId: 'app_id' in auth && typeof auth.app_id === 'string' ? auth.app_id : undefined,
          teamId: 'team_id' in auth && typeof auth.team_id === 'string' ? auth.team_id : undefined,
        };
        if (!identity.botId && !identity.botUserId) {
          throw new Error('Slack auth.test did not return a bot identity for Agent Comms.');
        }

        await app.start();
        options.logger?.info('Slack Socket Mode started');
      } catch (error) {
        options.onFault?.('slack.start', error);
        throw error;
      }
    },
    async stop(): Promise<void> {
      try {
        await app.stop();
        options.logger?.info('Slack Socket Mode stopped');
      } catch (error) {
        options.onFault?.('slack.stop', error);
        throw error;
      }
    },
  };
}
