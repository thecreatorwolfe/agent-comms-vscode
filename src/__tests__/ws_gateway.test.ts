import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WsGateway } from '../gateway/ws';
import { AgentRegistry, type AgentSocketLike } from '../registry/agents';

function createSocket(): AgentSocketLike {
  return {
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  };
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
});
