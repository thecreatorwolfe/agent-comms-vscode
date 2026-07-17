import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AgentRegistry, AgentRecord } from '../registry/agents';
import { HeartbeatMonitor } from '../registry/heartbeat';
import {
  authFrameSchema,
  closeFrameSchema,
  eventAckFrameSchema,
  eventFrameSchema,
  heartbeatFrameSchema,
  outboundFrameSchema,
  pluginToExtensionFrameSchema,
  resumeFrameSchema,
  standbyFrameSchema,
  type EventAckFrame,
  type EventFrame,
  type PluginToExtensionFrame,
} from '../schema/frames';
import { taskIdSchema } from '../schema/slack_message';
import { constantTimeSecretEquals } from './auth';
import { resolveIconUrl } from '../persona/icons';
import type { PostedSlackMessage } from '../slack/post';
import { buildUnregisteredPersona } from '../persona/naming';

interface WsSessionState {
  persona?: string;
}

export interface WsGatewayOptions {
  server: http.Server;
  routerSharedSecret: string;
  registry: AgentRegistry;
  logger?: Logger;
  iconsBaseUrl?: string;
  onFault?: (source: string, error: unknown) => void;
  resolveSavedPersona?: (profileId: string) => string | undefined;
  isProfileInvalidated?: (profileId: string) => boolean;
  onAgentConnected?: (agent: AgentRecord) => Promise<void> | void;
  onOutbound: (request: z.infer<typeof outboundFrameSchema>) => Promise<PostedSlackMessage>;
}

type OutboundLikeError = Error & { reason?: string; details?: unknown };
const compatibilityThreadTsSchema = z.union([z.string().min(1), z.number().finite()]).transform((value) => String(value));

const compatibilitySendCommandSchema = z.object({
  cmd: z.literal('send'),
  persona: z.string().min(1).optional(),
  thread_ts: compatibilityThreadTsSchema.nullable().optional(),
  threadTs: compatibilityThreadTsSchema.nullable().optional(),
  task_id: taskIdSchema.optional(),
  taskId: taskIdSchema.optional(),
  body: z.string().min(1),
  client_msg_id: z.string().uuid().optional(),
  clientMsgId: z.string().uuid().optional(),
});

const compatibilityStandbyCommandSchema = z.object({
  cmd: z.literal('standby'),
  persona: z.string().min(1).optional(),
  task_id: taskIdSchema.optional(),
  taskId: taskIdSchema.optional(),
}).superRefine((value, ctx) => {
  if (!value.task_id && !value.taskId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['task_id'],
      message: 'Provide task_id or taskId.',
    });
  }
});

const compatibilityResumeCommandSchema = z.object({
  cmd: z.literal('resume'),
  persona: z.string().min(1).optional(),
  task_id: taskIdSchema.optional(),
  taskId: taskIdSchema.optional(),
});

const compatibilityCommandSchema = z.union([
  compatibilitySendCommandSchema,
  compatibilityStandbyCommandSchema,
  compatibilityResumeCommandSchema,
]);

type CompatibilityParseResult =
  | { ok: true; frame: PluginToExtensionFrame }
  | { ok: false; reason: 'not_compat' | 'invalid_compat'; details?: string };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function translateCompatibilityCommandPayload(
  payload: unknown,
  sessionPersona: string,
): CompatibilityParseResult {
  if (!isRecord(payload) || typeof payload.cmd !== 'string') {
    return { ok: false, reason: 'not_compat' };
  }

  const parsed = compatibilityCommandSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_compat', details: parsed.error.message };
  }

  switch (parsed.data.cmd) {
    case 'send':
      return {
        ok: true,
        frame: {
          type: 'outbound',
          persona: parsed.data.persona ?? sessionPersona,
          thread_ts: parsed.data.thread_ts ?? parsed.data.threadTs ?? null,
          task_id: parsed.data.task_id ?? parsed.data.taskId ?? 'agent-comms-send',
          body: parsed.data.body,
          client_msg_id: parsed.data.client_msg_id ?? parsed.data.clientMsgId ?? randomUUID(),
        },
      };
    case 'standby':
      return {
        ok: true,
        frame: {
          type: 'standby',
          persona: parsed.data.persona ?? sessionPersona,
          task_id: parsed.data.task_id ?? parsed.data.taskId ?? 'agent-comms-standby',
        },
      };
    case 'resume':
      return {
        ok: true,
        frame: {
          type: 'resume',
          persona: parsed.data.persona ?? sessionPersona,
          task_id: parsed.data.task_id ?? parsed.data.taskId,
        },
      };
  }
}

export class WsGateway {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  private readonly heartbeatMonitor: HeartbeatMonitor;
  private readonly options: WsGatewayOptions;
  private readonly sessions = new WeakMap<WebSocket, WsSessionState>();
  private readonly pendingEventAcks = new Map<
    string,
    {
      resolve: (ack: EventAckFrame | undefined) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private readonly recentEventAcks = new Map<string, EventAckFrame>();

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
    this.wss.on('error', (error) => {
      this.options.logger?.error({ err: error }, 'ws server error');
      this.options.onFault?.('ws.server', error);
    });
    this.wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request).catch((error) => {
        this.options.logger?.error({ err: error }, 'ws connection handler failed');
        this.options.onFault?.('ws.connection', error);
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

    try {
      sendFrame(agent.socket as WebSocket, validation.data);
      this.options.logger?.info(
        {
          deliveryId: frame.delivery_id,
          fromPersona: frame.from_persona,
          toPersona: frame.to_persona,
          slackTs: frame.slack_ts,
          taskId: frame.task_id,
        },
        'sent agent-comms event frame to bridge socket',
      );
      return true;
    } catch (error) {
      this.options.logger?.warn({ err: error, to: frame.to_persona }, 'failed to deliver ws event');
      this.options.onFault?.('ws.send_event', error);
      return false;
    }
  }

  waitForEventAck(deliveryId: string, timeoutMs = 600): Promise<EventAckFrame | undefined> {
    const existing = this.recentEventAcks.get(deliveryId);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingEventAcks.delete(deliveryId);
        resolve(undefined);
      }, timeoutMs);
      timeout.unref?.();
      this.pendingEventAcks.set(deliveryId, { resolve, timeout });
    });
  }

  renameSessionPersona(socketLike: AgentRecord['socket'], previousPersona: string, nextPersona: string): boolean {
    const socket = socketLike as WebSocket;
    const session = this.sessions.get(socket) ?? {};
    if (
      session.persona !== undefined &&
      session.persona !== previousPersona &&
      session.persona !== nextPersona
    ) {
      this.options.logger?.warn(
        { previousPersona, nextPersona, sessionPersona: session.persona },
        'ws session persona differed during rename; overwriting with new persona',
      );
    }

    session.persona = nextPersona;
    this.sessions.set(socket, session);
    return true;
  }

  resetSessionProfile(agent: AgentRecord, previousPersona: string): boolean {
    const socket = agent.socket as WebSocket;
    this.renameSessionPersona(socket, previousPersona, agent.persona);
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    sendFrame(socket, {
      type: 'profile.reset',
      persona: agent.persona,
      icon_url: resolveIconUrl({
        persona: agent.persona,
        kind: agent.kind,
        iconsBaseUrl: this.options.iconsBaseUrl,
      }),
      registration_required: true,
    });
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
    this.sessions.set(socket, session);
    const authTimeout = setTimeout(() => {
      sendFrame(socket, { type: 'auth.error', reason: 'malformed' });
      socket.close(4401, 'auth_timeout');
    }, 10_000);
    authTimeout.unref?.();

    socket.on('error', (error) => {
      this.options.logger?.warn({ err: error, persona: session.persona }, 'ws socket error');
      this.options.onFault?.('ws.socket', error);
    });

    socket.on('message', (raw) => {
      void (async () => {
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
            const claimedPersona = auth.data.persona?.trim() || undefined;
            const profileInvalidated = auth.data.profile_id
              ? this.options.isProfileInvalidated?.(auth.data.profile_id) ?? false
              : false;
            const rawSavedPersona = auth.data.profile_id && !profileInvalidated
              ? this.options.resolveSavedPersona?.(auth.data.profile_id)
              : undefined;
            // Reclaim the saved persona on reconnect (B8), but never steal a
            // persona a different session is holding live right now. A holder
            // in disconnect-grace is the normal reconnect path and is fine.
            const savedPersonaHeldLive = rawSavedPersona
              ? (() => {
                const held = this.options.registry.get(rawSavedPersona);
                return Boolean(held && !held.disconnectDeadlineAt);
              })()
              : false;
            const savedPersona = rawSavedPersona && !savedPersonaHeldLive ? rawSavedPersona : undefined;
            const claimedPersonaIsTemporary = Boolean(claimedPersona?.startsWith('unregistered-'));
            const personaSource = savedPersona
              ? 'saved'
              : claimedPersona && !profileInvalidated && !claimedPersonaIsTemporary
                ? 'claimed'
                : 'generated';
            const agent = this.options.registry.attach({
              cwd: auth.data.cwd,
              kind: auth.data.agent_kind,
              pid: auth.data.pid,
              socket: socket as unknown as AgentRecord['socket'],
              persona: savedPersona
                ?? (personaSource === 'claimed'
                  ? claimedPersona
                  : claimedPersonaIsTemporary
                    ? claimedPersona
                    : buildUnregisteredPersona(auth.data.agent_kind, randomUUID().replace(/-/g, '').slice(0, 10))),
              profileId: auth.data.profile_id || undefined,
            });
            agent.registrationRequired = personaSource === 'generated';
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
              persona_source: personaSource,
              registration_required: agent.registrationRequired,
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

        let normalizedFrame: PluginToExtensionFrame;
        const frame = pluginToExtensionFrameSchema.safeParse(payload);
        if (frame.success) {
          normalizedFrame = frame.data;
        } else {
          const compatibility = translateCompatibilityCommandPayload(payload, session.persona);
          if (!compatibility.ok) {
            sendFrame(socket, {
              type: 'error',
              reason: 'malformed_frame',
              details: compatibility.reason === 'invalid_compat'
                ? compatibility.details
                : frame.error.message,
            });
            return;
          }
          normalizedFrame = compatibility.frame;
        }

        if ('persona' in normalizedFrame && normalizedFrame.persona !== session.persona) {
          sendFrame(socket, { type: 'error', reason: 'persona_mismatch' });
          return;
        }

        await this.handleAuthedFrame(socket, normalizedFrame);
      })().catch((error) => {
        this.options.logger?.error({ err: error }, 'ws message handler failed');
        this.options.onFault?.('ws.message', error);
        if (socket.readyState === WebSocket.OPEN) {
          sendFrame(socket, { type: 'error', reason: 'internal_error' });
        }
      });
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      if (session.persona) {
        this.options.registry.markSocketClosed(session.persona);
      }
      this.sessions.delete(socket);
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
            ...(result.warning ? { warning: result.warning } : {}),
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
        const agent = this.options.registry.markStandby(standby.persona, standby.task_id);
        sendFrame(socket, {
          type: 'standby.ack',
          persona: agent.persona,
          task_id: agent.taskId,
          status: agent.status,
          activity: agent.activity,
        });
        return;
      }
      case 'resume': {
        const resume = resumeFrameSchema.parse(frame);
        const agent = this.options.registry.markResume(resume.persona, resume.task_id);
        sendFrame(socket, {
          type: 'resume.ack',
          persona: agent.persona,
          task_id: agent.taskId,
          status: agent.status,
          activity: agent.activity,
        });
        return;
      }
      case 'event.ack': {
        const ack = eventAckFrameSchema.parse(frame);
        const pending = this.pendingEventAcks.get(ack.delivery_id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingEventAcks.delete(ack.delivery_id);
          pending.resolve(ack);
        } else {
          this.recentEventAcks.set(ack.delivery_id, ack);
          const cleanup = setTimeout(() => {
            this.recentEventAcks.delete(ack.delivery_id);
          }, 5_000);
          cleanup.unref?.();
        }
        this.options.logger?.info(
          {
            deliveryId: ack.delivery_id,
            persona: ack.persona,
            surfaceStatus: ack.surface_status,
            surfaceMechanism: ack.surface_mechanism,
            surfaceAction: ack.surface_action,
            surfaceHandling: ack.surface_handling,
            surfaceSummary: ack.surface_summary,
            surfaceElapsedMs: ack.surface_elapsed_ms,
            loggingStatus: ack.logging_status,
          },
          'received bridge event surface ack',
        );
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
