import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { AgentCommsWsClient } from '../mcp/ws-client';

describe('AgentCommsWsClient waitForAuth', () => {
  it('resolves immediately once auth state is already present', async () => {
    const client = new AgentCommsWsClient({
      kind: 'codex',
      port: 47592,
      secret: 'secret',
      cwd: '/tmp/project',
    }) as AgentCommsWsClient & {
      authenticated: boolean;
      persona?: string;
    };

    client.authenticated = true;
    client.persona = 'demo-codex-1';

    await expect(client.waitForAuth(5)).resolves.toBe('demo-codex-1');
  });

  it('surfaces the last connection error when auth never arrives', async () => {
    const client = new AgentCommsWsClient({
      kind: 'codex',
      port: 47592,
      secret: 'secret',
      cwd: '/tmp/project',
    }) as AgentCommsWsClient & {
      lastConnectionError?: string;
    };

    client.lastConnectionError = 'Agent Comms auth failed: reservation_missing';

    await expect(client.waitForAuth(5)).rejects.toThrow('reservation_missing');
  });

  it('resolves sendOutboundAndWait once outbound.ack arrives', async () => {
    const client = new AgentCommsWsClient({
      kind: 'codex',
      port: 47592,
      secret: 'secret',
      cwd: '/tmp/project',
    }) as AgentCommsWsClient & {
      authenticated: boolean;
      persona?: string;
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
      handleIncoming: (raw: string) => Promise<void>;
    };

    client.authenticated = true;
    client.persona = 'demo-codex-1';
    client.ws = { readyState: WebSocket.OPEN, send: vi.fn() };

    const pending = client.sendOutboundAndWait(
      {
        thread_ts: null,
        task_id: 'smoke-tools-2026-04-14',
        body: '[demo-codex-1→NICK] TASK:smoke-tools-2026-04-14 | UTC:2026-04-14T08:38:30Z\nSUBJECT: hi\n\nbody',
        client_msg_id: '3a750519-fb06-4cd6-adb0-706e3cbb0b4a',
      },
      1000,
    );

    await client.handleIncoming(
      JSON.stringify({
        type: 'outbound.ack',
        persona: 'demo-codex-1',
        client_msg_id: '3a750519-fb06-4cd6-adb0-706e3cbb0b4a',
        slack_ts: '1713081600.000100',
        thread_ts: '1713081600.000100',
      }),
    );

    await expect(pending).resolves.toEqual({
      slackTs: '1713081600.000100',
      threadTs: '1713081600.000100',
    });
  });

  it('rejects sendOutboundAndWait once outbound.error arrives', async () => {
    const client = new AgentCommsWsClient({
      kind: 'codex',
      port: 47592,
      secret: 'secret',
      cwd: '/tmp/project',
    }) as AgentCommsWsClient & {
      authenticated: boolean;
      persona?: string;
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
      handleIncoming: (raw: string) => Promise<void>;
    };

    client.authenticated = true;
    client.persona = 'demo-codex-1';
    client.ws = { readyState: WebSocket.OPEN, send: vi.fn() };

    const pending = client.sendOutboundAndWait(
      {
        thread_ts: null,
        task_id: 'smoke-tools-2026-04-14',
        body: '[demo-codex-1→NICK] TASK:smoke-tools-2026-04-14 | UTC:2026-04-14T08:38:30Z\nSUBJECT: hi\n\nbody',
        client_msg_id: 'b9c6b0f9-852e-4695-b655-fbc8039f1886',
      },
      1000,
    );

    await client.handleIncoming(
      JSON.stringify({
        type: 'outbound.error',
        persona: 'demo-codex-1',
        client_msg_id: 'b9c6b0f9-852e-4695-b655-fbc8039f1886',
        reason: 'schema_invalid',
        details: 'Body sender does not match outbound persona',
      }),
    );

    await expect(pending).rejects.toThrow('schema_invalid');
  });
});
