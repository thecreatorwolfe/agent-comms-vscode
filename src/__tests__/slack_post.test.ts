import type { WebClient } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import { postPersonaMessage } from '../slack/post';

const VALID_PROTOCOL_MESSAGE =
  '[demo-codex-2→NICK] TASK:slack-icon-test | UTC:2026-04-14T12:00:00Z\n' +
  'SUBJECT: Slack icon test\n\n' +
  'smoke test complete';

function createClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({
        ok: true,
        ts: '1776157290.950299',
      }),
    },
  } as unknown as WebClient;
}

describe('postPersonaMessage', () => {
  it('omits icon_url when the caller explicitly disables Slack icon fallback', async () => {
    const client = createClient();

    await postPersonaMessage({
      client,
      channel: 'C123',
      persona: 'demo-codex-2',
      kind: 'codex',
      text: VALID_PROTOCOL_MESSAGE,
      iconUrl: null,
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        icon_url: undefined,
        username: 'demo-codex-2',
      }),
    );
  });

  it('uses the configured public icons base URL for Slack persona messages', async () => {
    const client = createClient();

    await postPersonaMessage({
      client,
      channel: 'C123',
      persona: 'demo-codex-2',
      kind: 'codex',
      text: VALID_PROTOCOL_MESSAGE,
      iconsBaseUrl: 'https://example.com/icons/',
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        icon_url: 'https://example.com/icons/codex-2.png',
        username: 'demo-codex-2',
      }),
    );
  });

  it('preserves the requested thread timestamp for thread replies', async () => {
    const client = createClient();

    const posted = await postPersonaMessage({
      client,
      channel: 'C123',
      persona: 'demo-codex-2',
      kind: 'codex',
      text: VALID_PROTOCOL_MESSAGE,
      threadTs: '1776177341.721089',
    });

    expect(posted).toEqual({
      slackTs: '1776157290.950299',
      threadTs: '1776177341.721089',
    });
  });
});
