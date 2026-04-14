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
  onAppMention: (event: SlackAppMentionEvent) => Promise<void> | void;
  onChannelMessage: (event: SlackChannelMessageEvent) => Promise<void> | void;
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
  });

  app.event('message', async ({ event }) => {
    if (!('channel' in event) || event.channel !== options.env.SLACK_CHANNEL_ID) {
      return;
    }

    if (!('text' in event) || typeof event.text !== 'string') {
      return;
    }

    const subtype = 'subtype' in event ? event.subtype : undefined;
    const botId = 'bot_id' in event ? event.bot_id : undefined;
    if (subtype !== 'bot_message' && !botId) {
      return;
    }
    const normalizedEvent = {
      user: 'user' in event ? event.user : undefined,
      bot_id: botId,
      subtype,
      text: event.text,
      channel: event.channel,
      ts: event.ts,
      thread_ts: 'thread_ts' in event ? event.thread_ts : undefined,
    };
    if (!isTrustedAgentRelayEvent(normalizedEvent, identity)) {
      options.logger?.warn(
        {
          user: normalizedEvent.user,
          bot_id: normalizedEvent.bot_id,
          ts: normalizedEvent.ts,
        },
        'ignored bot-style Slack message from untrusted sender',
      );
      return;
    }

    await options.onChannelMessage(normalizedEvent);
  });

  return {
    app,
    client: app.client,
    getIdentity(): SlackRuntimeIdentity | undefined {
      return identity;
    },
    async start(): Promise<void> {
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
    },
    async stop(): Promise<void> {
      await app.stop();
      options.logger?.info('Slack Socket Mode stopped');
    },
  };
}
