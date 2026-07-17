import type { WebClient } from '@slack/web-api';
import { resolveIconUrl } from '../persona/icons';
import type { AgentKind } from '../persona/naming';
import { validateSlackMessageText } from '../schema/validate';

export interface PostSlackMessageOptions {
  client: WebClient;
  channel: string;
  text: string;
  username?: string;
  iconUrl?: string | null;
  threadTs?: string | null;
  clientMsgId?: string;
  validateProtocol?: boolean;
}

export interface PostPersonaMessageOptions extends Omit<PostSlackMessageOptions, 'username' | 'iconUrl' | 'validateProtocol'> {
  persona: string;
  kind: AgentKind;
  iconsBaseUrl?: string;
  iconUrl?: string | null;
}

export interface PostedSlackMessage {
  slackTs: string;
  threadTs: string;
  // Non-fatal warning surfaced back to the sender (e.g. a recipient that is
  // not registered on this hub but was still posted to the shared channel).
  warning?: string;
}

export async function postSlackMessage(options: PostSlackMessageOptions): Promise<PostedSlackMessage> {
  if (options.validateProtocol ?? false) {
    const validation = validateSlackMessageText(options.text);
    if (!validation.ok) {
      throw Object.assign(new Error('Protocol slack message validation failed'), {
        reason: 'schema_invalid',
        details: validation.error.message,
      });
    }
  }

  const response = await options.client.chat.postMessage({
    channel: options.channel,
    text: options.text,
    username: options.username,
    icon_url: options.iconUrl ?? undefined,
    thread_ts: options.threadTs ?? undefined,
  });

  if (!response.ok || !response.ts) {
    throw Object.assign(new Error(`Slack API error: ${response.error ?? 'unknown_error'}`), {
      reason: 'slack_api_error',
      details: response.error,
    });
  }

  const responseThreadTs = typeof response.message === 'object'
    && response.message !== null
    && 'thread_ts' in response.message
    && typeof response.message.thread_ts === 'string'
    ? response.message.thread_ts
    : undefined;

  return {
    slackTs: response.ts,
    threadTs: responseThreadTs ?? options.threadTs ?? response.ts,
  };
}

export async function postPersonaMessage(options: PostPersonaMessageOptions): Promise<PostedSlackMessage> {
  const iconUrl = options.iconUrl === undefined
    ? resolveIconUrl({
      persona: options.persona,
      kind: options.kind,
      iconsBaseUrl: options.iconsBaseUrl,
    })
    : options.iconUrl ?? undefined;

  return postSlackMessage({
    client: options.client,
    channel: options.channel,
    text: options.text,
    username: options.persona,
    iconUrl,
    threadTs: options.threadTs,
    clientMsgId: options.clientMsgId,
    validateProtocol: true,
  });
}
