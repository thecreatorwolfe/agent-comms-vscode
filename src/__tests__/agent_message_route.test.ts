import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayHttpServer, type AgentMessageResult } from '../gateway/http';
import { AgentNotFoundError, AgentUnreachableError, UnsupportedRuntimeError } from '../codex/agent-message';

const SECRET = 'test-secret';

const OK: AgentMessageResult = {
  persona: 'astra-1', kind: 'codex', activity: 'working', delivery: 'confirmed', transport: 'codex_queue',
  thread_id: 'th-1', delivery_id: 'dead1234', text_chars: 4, confirmed_in_ms: 12,
  execution_verified: false, note: 'queued',
};

let running: GatewayHttpServer | undefined;
afterEach(async () => { await running?.stop(); running = undefined; });

async function serve(onAgentMessage: (request: unknown) => Promise<AgentMessageResult>) {
  const server = new GatewayHttpServer({
    port: 0,
    routerSharedSecret: SECRET,
    iconsDir: '.',
    registry: { list: () => [] } as never,
    onSpawn: async () => ({ persona: 'x', terminalName: 'x', reused: false }),
    onOutbound: async () => ({ slackTs: '1', threadTs: '1' }) as never,
    onReadSlack: async () => ({ channel: 'c', messages: [] }),
    onRename: async () => ({ persona: 'a', previous_persona: 'b' }),
    onAgentMessage: onAgentMessage as never,
  });
  await server.start();
  running = server;
  const address = server.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const call = (body: unknown, auth = true) => fetch(`http://127.0.0.1:${port}/agent-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Router-Secret': SECRET } : {}) },
    body: JSON.stringify(body),
  });
  return { call };
}

describe('POST /agent-message', () => {
  it('requires the router secret before it will look at the body', async () => {
    const handler = vi.fn(async () => OK);
    const { call } = await serve(handler);
    const response = await call({ persona: 'astra-1', text: 'hi' }, false);
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes free-form multi-line text through untouched and returns the delivery receipt', async () => {
    const handler = vi.fn(async () => OK);
    const { call } = await serve(handler);
    const text = 'line one\n\nline "two" with `backticks` and $VARS';
    const response = await call({ persona: 'astra-1', text, sender: 'Nick' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivery: 'confirmed', execution_verified: false });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ persona: 'astra-1', text, sender: 'Nick' });
  });

  it('rejects blank, NUL-bearing and oversize text without calling the delivery path', async () => {
    const handler = vi.fn(async () => OK);
    const { call } = await serve(handler);
    for (const body of [
      { persona: 'astra-1', text: '' },
      { persona: 'astra-1', text: '   ' },
      { persona: 'astra-1', text: 'has\u0000nul' },
      { persona: 'astra-1', text: 'x'.repeat(32_001) },
      { persona: '', text: 'hi' },
      { text: 'hi' },
    ]) {
      expect((await call(body)).status).toBe(400);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('maps each refusal to a status a caller can act on', async () => {
    for (const [error, status] of [
      [new AgentNotFoundError('no such lane'), 404],
      [new AgentUnreachableError('session gone'), 409],
      [new UnsupportedRuntimeError('claude lane'), 501],
    ] as const) {
      const { call } = await serve(async () => { throw error; });
      const response = await call({ persona: 'astra-1', text: 'hi' });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: error.message });
      await running?.stop();
      running = undefined;
    }
  });
});
