import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WsGateway, translateCompatibilityCommandPayload } from '../gateway/ws';
import { AgentRegistry, type AgentSocketLike } from '../registry/agents';
import { AgentProfileStore } from '../profile-store';

function createSocket(): AgentSocketLike {
  return {
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  };
}

class MemoryMemento {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    if (!this.values.has(key)) {
      return defaultValue as T;
    }

    return this.values.get(key) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an inet server address');
  }

  return address.port;
}

async function openAuthedSocket(options: {
  port: number;
  profileId: string;
  persona?: string;
}): Promise<{
  socket: WebSocket;
  authAck: Record<string, unknown>;
  waitForFrame: (type: string) => Promise<Record<string, unknown>>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${options.port}/ws`);
  const frames: Array<Record<string, unknown>> = [];
  const waiters = new Map<string, Array<(frame: Record<string, unknown>) => void>>();

  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    frames.push(frame);
    const frameType = typeof frame.type === 'string' ? frame.type : '';
    const queue = waiters.get(frameType);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      next?.(frame);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  socket.send(JSON.stringify({
    type: 'auth',
    secret: 'a'.repeat(64),
    agent_kind: 'codex',
    persona: options.persona ?? '',
    profile_id: options.profileId,
    pid: 6001,
    cwd: '/tmp/restart-proof',
  }));

  const waitForFrame = async (type: string): Promise<Record<string, unknown>> => {
    const existing = frames.find((frame) => frame.type === type);
    if (existing) {
      return existing;
    }

    return new Promise((resolve) => {
      const queue = waiters.get(type) ?? [];
      queue.push(resolve);
      waiters.set(type, queue);
    });
  };

  const authAck = await waitForFrame('auth.ack');
  return { socket, authAck, waitForFrame };
}

describe('WsGateway renameSessionPersona', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && 'code' in error && error.code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
          return;
        }

        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })));
  });

  it('updates the live socket session persona immediately after a rename', () => {
    const registry = new AgentRegistry();
    const server = http.createServer();
    servers.push(server);
    const gateway = new WsGateway({
      server,
      routerSharedSecret: 'a'.repeat(64),
      registry,
      onOutbound: vi.fn(),
    });
    const socket = createSocket();
    const reservation = registry.reserve({
      cwd: '/tmp/security-audit',
      kind: 'claude',
      briefFilePath: '/tmp/brief.md',
      taskId: 'frontend-pass',
    }, 0);
    registry.attach({
      cwd: '/tmp/security-audit',
      kind: 'claude',
      pid: 8080,
      socket,
      persona: reservation.persona,
    }, 0);

    const renamed = registry.rename({
      persona: reservation.persona,
      projectName: 'checkout-flow',
      instanceNumber: 30,
    });

    const internal = gateway as unknown as {
      sessions: WeakMap<object, { persona?: string }>;
      renameSessionPersona: (socketLike: AgentSocketLike, previousPersona: string, nextPersona: string) => boolean;
    };
    internal.sessions.set(socket as unknown as object, { persona: reservation.persona });

    expect(internal.renameSessionPersona(socket, reservation.persona, renamed.agent.persona)).toBe(true);
    expect(internal.sessions.get(socket as unknown as object)?.persona).toBe('checkout-flow-alfred-30');
  });

  it('recreates missing ws session state during rename instead of silently failing', () => {
    const registry = new AgentRegistry();
    const server = http.createServer();
    servers.push(server);
    const gateway = new WsGateway({
      server,
      routerSharedSecret: 'a'.repeat(64),
      registry,
      onOutbound: vi.fn(),
    });
    const socket = createSocket();

    expect((gateway as unknown as {
      renameSessionPersona: (socketLike: AgentSocketLike, previousPersona: string, nextPersona: string) => boolean;
      sessions: WeakMap<object, { persona?: string }>;
    }).renameSessionPersona(socket, 'old-alfred-2', 'new-alfred-2')).toBe(true);

    expect((gateway as unknown as {
      sessions: WeakMap<object, { persona?: string }>;
    }).sessions.get(socket as unknown as object)?.persona).toBe('new-alfred-2');
  });

  it('translates cmd-send compatibility payloads into outbound frames and preserves client_msg_id', () => {
    const parsed = translateCompatibilityCommandPayload({
      cmd: 'send',
      threadTs: 1776174995.431979,
      taskId: 'frontend-pass',
      body: '[checkout-flow-alfred-30→NICK]\n\nNeed review.',
      clientMsgId: '3a750519-fb06-4cd6-adb0-706e3cbb0b4a',
    }, 'checkout-flow-alfred-30');

    expect(parsed).toEqual({
      ok: true,
      frame: {
        type: 'outbound',
        persona: 'checkout-flow-alfred-30',
        thread_ts: '1776174995.431979',
        task_id: 'frontend-pass',
        body: '[checkout-flow-alfred-30→NICK]\n\nNeed review.',
        client_msg_id: '3a750519-fb06-4cd6-adb0-706e3cbb0b4a',
      },
    });
  });

  it('fills a generated client_msg_id when cmd-send omits one', () => {
    const parsed = translateCompatibilityCommandPayload({
      cmd: 'send',
      body: '[checkout-flow-alfred-30→NICK]\n\nNeed review.',
    }, 'checkout-flow-alfred-30');

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.type !== 'outbound') {
      throw new Error('expected outbound frame');
    }

    expect(parsed.frame.persona).toBe('checkout-flow-alfred-30');
    expect(parsed.frame.client_msg_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('restores a saved persona after a hub restart, still delivers events, and requires re-registration after profile clear', async () => {
    const profileId = randomUUID();
    const memento = new MemoryMemento();
    const profileStore = new AgentProfileStore(memento as never);

    const server1 = http.createServer();
    servers.push(server1);
    const registry1 = new AgentRegistry();
    const gateway1 = new WsGateway({
      server: server1,
      routerSharedSecret: 'a'.repeat(64),
      registry: registry1,
      resolveSavedPersona: (id) => profileStore.get(id)?.persona,
      onAgentConnected: async (agent) => {
        await profileStore.noteAgent({
          profileId: agent.profileId,
          persona: agent.persona,
          kind: agent.kind,
          cwd: agent.cwd,
          taskId: agent.taskId ?? null,
        });
      },
      onOutbound: vi.fn(),
    });
    gateway1.start();
    const port1 = await listen(server1);
    const first = await openAuthedSocket({
      port: port1,
      profileId,
      persona: 'checkout-flow-codex-7',
    });

    expect(first.authAck).toMatchObject({
      persona: 'checkout-flow-codex-7',
      persona_source: 'claimed',
      registration_required: false,
    });

    first.socket.close();
    await gateway1.stop();
    await new Promise<void>((resolve, reject) => server1.close((error) => error ? reject(error) : resolve()));

    const server2 = http.createServer();
    servers.push(server2);
    const registry2 = new AgentRegistry();
    const gateway2 = new WsGateway({
      server: server2,
      routerSharedSecret: 'a'.repeat(64),
      registry: registry2,
      resolveSavedPersona: (id) => profileStore.get(id)?.persona,
      onAgentConnected: async (agent) => {
        await profileStore.noteAgent({
          profileId: agent.profileId,
          persona: agent.persona,
          kind: agent.kind,
          cwd: agent.cwd,
          taskId: agent.taskId ?? null,
        });
      },
      onOutbound: vi.fn(),
    });
    gateway2.start();
    const port2 = await listen(server2);
    const recovered = await openAuthedSocket({
      port: port2,
      profileId,
    });

    expect(recovered.authAck).toMatchObject({
      persona: 'checkout-flow-codex-7',
      persona_source: 'saved',
      registration_required: false,
    });

    expect(gateway2.sendEvent({
      type: 'event',
      delivery_id: '11111111-1111-4111-8111-111111111111',
      from_persona: 'NICK',
      to_persona: 'checkout-flow-codex-7',
      thread_ts: '1713081600.000100',
      body_raw: 'Check Slack now.',
      body_parsed: {
        from: 'NICK',
        recipients: ['checkout-flow-codex-7'],
        body: 'Check Slack now.',
        asks: [],
      },
      slack_ts: '1713081600.000100',
    })).toBe(true);

    await expect(recovered.waitForFrame('event')).resolves.toMatchObject({
      from_persona: 'NICK',
      to_persona: 'checkout-flow-codex-7',
    });

    const ackPromise = gateway2.waitForEventAck('11111111-1111-4111-8111-111111111111', 1_000);
    recovered.socket.send(JSON.stringify({
      type: 'event.ack',
      persona: 'checkout-flow-codex-7',
      delivery_id: '11111111-1111-4111-8111-111111111111',
      surface_status: 'ok',
      surface_mechanism: 'codex_elicitation',
      logging_status: 'ok',
      surface_action: 'accept',
      surface_handling: 'reply_now',
      surface_summary: 'Need review on the checkout flow.',
      surface_elapsed_ms: 12,
    }));

    await expect(ackPromise).resolves.toMatchObject({
      delivery_id: '11111111-1111-4111-8111-111111111111',
      surface_status: 'ok',
      surface_mechanism: 'codex_elicitation',
      logging_status: 'ok',
      surface_action: 'accept',
      surface_handling: 'reply_now',
      surface_summary: 'Need review on the checkout flow.',
      surface_elapsed_ms: 12,
    });

    recovered.socket.close();
    await gateway2.stop();
    await new Promise<void>((resolve, reject) => server2.close((error) => error ? reject(error) : resolve()));

    await profileStore.clear();

    const server3 = http.createServer();
    servers.push(server3);
    const registry3 = new AgentRegistry();
    const gateway3 = new WsGateway({
      server: server3,
      routerSharedSecret: 'a'.repeat(64),
      registry: registry3,
      resolveSavedPersona: (id) => profileStore.get(id)?.persona,
      onOutbound: vi.fn(),
    });
    gateway3.start();
    const port3 = await listen(server3);
    const cleared = await openAuthedSocket({
      port: port3,
      profileId,
    });

    expect(cleared.authAck.persona).toMatch(/^unregistered-codex-/);
    expect(cleared.authAck).toMatchObject({
      persona_source: 'generated',
      registration_required: true,
    });

    cleared.socket.close();
    await gateway3.stop();
    await new Promise<void>((resolve, reject) => server3.close((error) => error ? reject(error) : resolve()));
  });

  it('ignores an invalidated profile id on reconnect and forces a temporary unregistered persona', async () => {
    const profileId = randomUUID();
    const memento = new MemoryMemento();
    const profileStore = new AgentProfileStore(memento as never);

    await profileStore.save({
      profileId,
      persona: 'checkout-flow-codex-9',
      kind: 'codex',
      cwd: '/tmp/restart-proof',
      lastSeenAt: '2026-04-15T12:00:00.000Z',
      lastTaskId: 'phase-2',
    });
    await profileStore.invalidateProfileIds([profileId]);

    const server = http.createServer();
    servers.push(server);
    const registry = new AgentRegistry();
    const gateway = new WsGateway({
      server,
      routerSharedSecret: 'a'.repeat(64),
      registry,
      resolveSavedPersona: (id) => profileStore.get(id)?.persona,
      isProfileInvalidated: (id) => profileStore.isProfileInvalidated(id),
      onOutbound: vi.fn(),
    });
    gateway.start();
    const port = await listen(server);
    const reconnected = await openAuthedSocket({
      port,
      profileId,
      persona: 'checkout-flow-codex-9',
    });

    expect(reconnected.authAck.persona).toMatch(/^unregistered-codex-/);
    expect(reconnected.authAck).toMatchObject({
      persona_source: 'generated',
      registration_required: true,
    });

    reconnected.socket.close();
    await gateway.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
