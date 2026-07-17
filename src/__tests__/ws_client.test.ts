import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { AgentCommsWsClient, formatOutboundErrorMessage } from '../mcp/ws-client';

describe('formatOutboundErrorMessage', () => {
  it('names the reason, includes hub detail, and appends a remedy (B5)', () => {
    const message = formatOutboundErrorMessage('schema_invalid', 'Body sender does not match outbound persona');
    expect(message).toContain('schema_invalid');
    expect(message).toContain('Body sender does not match outbound persona');
    expect(message).toContain('Fix:');
  });

  it('stringifies structured detail payloads', () => {
    const message = formatOutboundErrorMessage('unknown_recipient', { unknownRecipients: ['ghost-1'] });
    expect(message).toContain('unknown_recipient');
    expect(message).toContain('ghost-1');
  });

  it('still produces a useful message when detail is absent', () => {
    const message = formatOutboundErrorMessage('slack_api_error', undefined);
    expect(message).toContain('slack_api_error');
    expect(message).toContain('Fix:');
  });
});

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

  it('stores persona source and registration state from auth.ack', async () => {
    const client = new AgentCommsWsClient({
      kind: 'codex',
      port: 47592,
      secret: 'secret',
      cwd: '/tmp/project',
    }) as AgentCommsWsClient & {
      handleIncoming: (raw: string) => Promise<void>;
    };

    await client.handleIncoming(
      JSON.stringify({
        type: 'auth.ack',
        persona: 'unregistered-codex-deadbeef',
        icon_url: 'https://example.com/icon.png',
        persona_source: 'generated',
        registration_required: true,
      }),
    );

    expect(client.getConnectionSnapshot()).toMatchObject({
      authenticated: true,
      persona: 'unregistered-codex-deadbeef',
      personaSource: 'generated',
      registrationRequired: true,
    });
  });

  it('updates the local snapshot when a live profile reset arrives', async () => {
    const client = new AgentCommsWsClient({
      kind: 'codex',
      port: 47592,
      secret: 'secret',
      cwd: '/tmp/project',
    }) as AgentCommsWsClient & {
      handleIncoming: (raw: string) => Promise<void>;
    };

    client.setCurrentPersona('checkout-flow-codex-7', {
      personaSource: 'saved',
      registrationRequired: false,
    });

    await client.handleIncoming(
      JSON.stringify({
        type: 'profile.reset',
        persona: 'unregistered-codex-deadbeef',
        icon_url: 'https://example.com/icon.png',
        registration_required: true,
      }),
    );

    expect(client.getConnectionSnapshot()).toMatchObject({
      persona: 'unregistered-codex-deadbeef',
      personaSource: 'generated',
      registrationRequired: true,
    });
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

  it('resolves sendStandbyAndWait once standby.ack arrives', async () => {
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

    const pending = client.sendStandbyAndWait('smoke-status', 1000);

    await client.handleIncoming(
      JSON.stringify({
        type: 'standby.ack',
        persona: 'demo-codex-1',
        task_id: 'smoke-status',
        status: 'idle',
        activity: 'waiting',
      }),
    );

    await expect(pending).resolves.toEqual({
      persona: 'demo-codex-1',
      taskId: 'smoke-status',
      status: 'idle',
      activity: 'waiting',
    });
  });

  it('resolves sendResumeAndWait once resume.ack arrives', async () => {
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

    const pending = client.sendResumeAndWait('smoke-status', 1000);

    await client.handleIncoming(
      JSON.stringify({
        type: 'resume.ack',
        persona: 'demo-codex-1',
        task_id: 'smoke-status',
        status: 'active',
        activity: 'working',
      }),
    );

    await expect(pending).resolves.toEqual({
      persona: 'demo-codex-1',
      taskId: 'smoke-status',
      status: 'active',
      activity: 'working',
    });
  });

  it('forces a reconnect when the extension reports persona_mismatch', async () => {
    const close = vi.fn();
    const client = new AgentCommsWsClient({
      kind: 'codex',
      port: 47592,
      secret: 'secret',
      cwd: '/tmp/project',
    }) as AgentCommsWsClient & {
      authenticated: boolean;
      persona?: string;
      ws: { readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
      handleIncoming: (raw: string) => Promise<void>;
    };

    client.authenticated = true;
    client.persona = 'demo-codex-1';
    client.ws = { readyState: WebSocket.OPEN, send: vi.fn(), close };

    await client.handleIncoming(
      JSON.stringify({
        type: 'error',
        reason: 'persona_mismatch',
      }),
    );

    expect(close).toHaveBeenCalledWith(4009, 'persona_mismatch');
  });
});
