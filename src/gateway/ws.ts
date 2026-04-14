import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AgentRegistry, AgentRecord } from '../registry/agents';
import { HeartbeatMonitor } from '../registry/heartbeat';
import {
  authFrameSchema,
  closeFrameSchema,
  eventFrameSchema,
  heartbeatFrameSchema,
  outboundFrameSchema,
  pluginToExtensionFrameSchema,
  resumeFrameSchema,
  standbyFrameSchema,
  type EventFrame,
} from '../schema/frames';
import { constantTimeSecretEquals } from './auth';
import { resolveIconUrl } from '../persona/icons';
import type { PostedSlackMessage } from '../slack/post';

interface WsSessionState {
  persona?: string;
}

export interface WsGatewayOptions {
  server: http.Server;
  routerSharedSecret: string;
  registry: AgentRegistry;
  logger?: Logger;
  iconsBaseUrl?: string;
  onAgentConnected?: (agent: AgentRecord) => Promise<void> | void;
  onOutbound: (request: z.infer<typeof outboundFrameSchema>) => Promise<PostedSlackMessage>;
}

type OutboundLikeError = Error & { reason?: string; details?: unknown };

function normalizeOutboundError(error: unknown): { reason: 'schema_invalid' | 'unknown_recipient' | 'slack_api_error'; details?: unknown } {
  const candidate = error as OutboundLikeError;
  if (candidate?.reason === 'schema_invalid' || candidate?.reason === 'unknown_recipient' || candidate?.reason === 'slack_api_error') {
    return {
      reason: candidate.reason,
      details: candidate.details ?? candidate.message,
    };
  }

  return {
    reason: 'slack_api_error',
    details: error instanceof Error ? error.message : error,
  };
}

function sendFrame(socket: WebSocket, frame: unknown): void {
  socket.send(JSON.stringify(frame));
}

export class WsGateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly heartbeatMonitor: HeartbeatMonitor;
  private readonly options: WsGatewayOptions;

  constructor(options: WsGatewayOptions) {
    this.options = options;
    this.heartbeatMonitor = new HeartbeatMonitor({
      registry: options.registry,
      logger: options.logger,
      onStaleAgent: (agent) => {
        agent.socket.terminate?.();
      },
    });

    this.options.server.on('upgrade', this.handleUpgrade);
    this.wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request).catch((error) => {
        this.options.logger?.error({ err: error }, 'ws connection handler failed');
        socket.close(1011, 'internal_error');
      });
    });
  }

  start(): void {
    this.heartbeatMonitor.start();
  }

  async stop(): Promise<void> {
    this.heartbeatMonitor.stop();
    this.options.server.off('upgrade', this.handleUpgrade);
    for (const client of this.wss.clients) {
      client.close(1001, 'server_shutdown');
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  sendEvent(frame: EventFrame): boolean {
    const validation = eventFrameSchema.safeParse(frame);
    if (!validation.success) {
      throw new Error(validation.error.message);
    }

    const agent = this.options.registry.get(frame.to_persona);
    if (!agent || agent.disconnectDeadlineAt) {
      return false;
    }

    sendFrame(agent.socket as WebSocket, validation.data);
    return true;
  }

  private readonly handleUpgrade = (request: http.IncomingMessage, socket: import('node:net').Socket, head: Buffer): void => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (websocket) => {
      this.wss.emit('connection', websocket, request);
    });
  };

  private async handleConnection(socket: WebSocket, _request: http.IncomingMessage): Promise<void> {
    const session: WsSessionState = {};
    const authTimeout = setTimeout(() => {
      sendFrame(socket, { type: 'auth.error', reason: 'malformed' });
      socket.close(4401, 'auth_timeout');
    }, 10_000);
    authTimeout.unref?.();

    socket.on('message', async (raw) => {
      const payload = this.parseJson(raw.toString());
      if (!payload) {
        sendFrame(socket, { type: 'error', reason: 'invalid_json' });
        return;
      }

      if (!session.persona) {
        const auth = authFrameSchema.safeParse(payload);
        if (!auth.success) {
          sendFrame(socket, { type: 'auth.error', reason: 'malformed' });
          socket.close(4401, 'malformed_auth');
          return;
        }

        if (!constantTimeSecretEquals(this.options.routerSharedSecret, auth.data.secret)) {
          sendFrame(socket, { type: 'auth.error', reason: 'invalid_secret' });
          socket.close(4403, 'invalid_secret');
          return;
        }

        try {
          const agent = this.options.registry.attach({
            cwd: auth.data.cwd,
            kind: auth.data.agent_kind,
            pid: auth.data.pid,
            socket: socket as unknown as AgentRecord['socket'],
            persona: auth.data.persona || undefined,
          });
          session.persona = agent.persona;
          clearTimeout(authTimeout);
          sendFrame(socket, {
            type: 'auth.ack',
            persona: agent.persona,
            icon_url: resolveIconUrl({
              persona: agent.persona,
              kind: agent.kind,
              iconsBaseUrl: this.options.iconsBaseUrl,
            }),
          });
          await this.options.onAgentConnected?.(agent);
        } catch (error) {
          sendFrame(socket, {
            type: 'auth.error',
            reason: error instanceof Error && error.message.includes('Missing reservation')
              ? 'reservation_missing'
              : 'persona_conflict',
          });
          socket.close(4409, 'persona_conflict');
        }
        return;
      }

      const frame = pluginToExtensionFrameSchema.safeParse(payload);
      if (!frame.success) {
        sendFrame(socket, { type: 'error', reason: 'malformed_frame', details: frame.error.message });
        return;
      }

      if ('persona' in frame.data && frame.data.persona !== session.persona) {
        sendFrame(socket, { type: 'error', reason: 'persona_mismatch' });
        return;
      }

      await this.handleAuthedFrame(socket, frame.data);
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      if (session.persona) {
        this.options.registry.markSocketClosed(session.persona);
      }
    });
  }

  private async handleAuthedFrame(socket: WebSocket, frame: z.infer<typeof pluginToExtensionFrameSchema>): Promise<void> {
    switch (frame.type) {
      case 'heartbeat': {
        const heartbeat = heartbeatFrameSchema.parse(frame);
        this.options.registry.recordHeartbeat(heartbeat.persona);
        sendFrame(socket, {
          type: 'heartbeat.ack',
          persona: heartbeat.persona,
          ts: new Date().toISOString(),
        });
        return;
      }
      case 'outbound': {
        const outbound = outboundFrameSchema.parse(frame);
        try {
          const result = await this.options.onOutbound(outbound);
          sendFrame(socket, {
            type: 'outbound.ack',
            persona: outbound.persona,
            client_msg_id: outbound.client_msg_id,
            slack_ts: result.slackTs,
            thread_ts: result.threadTs,
          });
        } catch (error) {
          const normalized = normalizeOutboundError(error);
          sendFrame(socket, {
            type: 'outbound.error',
            persona: outbound.persona,
            client_msg_id: outbound.client_msg_id,
            reason: normalized.reason,
            details: normalized.details,
          });
        }
        return;
      }
      case 'standby': {
        const standby = standbyFrameSchema.parse(frame);
        this.options.registry.markStandby(standby.persona, standby.task_id);
        return;
      }
      case 'resume': {
        const resume = resumeFrameSchema.parse(frame);
        this.options.registry.markResume(resume.persona, resume.task_id);
        return;
      }
      case 'close': {
        const close = closeFrameSchema.parse(frame);
        this.options.registry.dropImmediately(close.persona);
        socket.close(1000, close.reason);
        return;
      }
      case 'auth':
        return;
    }
  }

  private parseJson(input: string): unknown {
    try {
      return JSON.parse(input);
    } catch {
      return undefined;
    }
  }
}
