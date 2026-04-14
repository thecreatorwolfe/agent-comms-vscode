import http from 'node:http';
import express from 'express';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { AgentRegistry } from '../registry/agents';
import type { PostedSlackMessage } from '../slack/post';
import { taskIdSchema } from '../schema/slack_message';
import { createHttpSecretMiddleware } from './auth';
import type { SpawnRequest, SpawnResult } from '../spawn';

const spawnRequestSchema = z.object({
  kind: z.enum(['claude', 'codex']),
  brief_file_path: z.string().min(1),
  custom_name: z.string().min(1).nullable().optional(),
  parent_persona: z.string().min(1).nullable().optional(),
  task_id: taskIdSchema,
  reuse_idle: z.boolean().nullable().optional(),
});

const outboundOneshotSchema = z.object({
  persona: z.string().min(1),
  thread_ts: z.string().nullable().optional(),
  task_id: taskIdSchema,
  body: z.string().min(1),
  client_msg_id: z.string().uuid(),
});

export interface GatewayHttpServerOptions {
  port: number;
  routerSharedSecret: string;
  iconsDir: string;
  registry: AgentRegistry;
  logger?: Logger;
  onSpawn: (request: SpawnRequest) => Promise<SpawnResult>;
  onOutbound: (request: z.infer<typeof outboundOneshotSchema>) => Promise<PostedSlackMessage>;
}

function normalizeRouteError(error: unknown): { status: number; body: unknown } {
  if (error && typeof error === 'object') {
    const reason = 'reason' in error ? error.reason : undefined;
    if (reason === 'schema_invalid') {
      return { status: 400, body: { error: reason, details: (error as { details?: unknown }).details } };
    }
    if (reason === 'unknown_recipient') {
      return { status: 400, body: { error: reason, details: (error as { details?: unknown }).details } };
    }
  }

  if (error instanceof Error) {
    if (error.name === 'SpawnConflictError') {
      return { status: 409, body: { error: error.message } };
    }
    if (error.name === 'SpawnPreconditionError') {
      return { status: 412, body: { error: error.message } };
    }
    return { status: 500, body: { error: error.message } };
  }

  return { status: 500, body: { error: 'Unknown error' } };
}

export class GatewayHttpServer {
  readonly app = express();
  readonly server: http.Server;
  private readonly options: GatewayHttpServerOptions;

  constructor(options: GatewayHttpServerOptions) {
    this.options = options;
    this.server = http.createServer(this.app);
    this.configure();
  }

  private configure(): void {
    this.app.use(express.json({ limit: '1mb' }));
    this.app.get('/healthz', (_request, response) => {
      response.json({ ok: true });
    });
    this.app.use('/icons', express.static(path.resolve(this.options.iconsDir)));

    const requireSecret = createHttpSecretMiddleware(this.options.routerSharedSecret);
    this.app.post('/spawn', requireSecret, async (request, response) => {
      const parsed = spawnRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: parsed.error.message });
        return;
      }

      try {
        const result = await this.options.onSpawn({
          kind: parsed.data.kind,
          briefFilePath: parsed.data.brief_file_path,
          customName: parsed.data.custom_name ?? undefined,
          parentPersona: parsed.data.parent_persona ?? null,
          taskId: parsed.data.task_id,
          reuseIdle: parsed.data.reuse_idle ?? null,
        });
        response.json(result);
      } catch (error) {
        this.options.logger?.error({ err: error }, 'spawn request failed');
        const normalized = normalizeRouteError(error);
        response.status(normalized.status).json(normalized.body);
      }
    });

    this.app.post('/outbound-oneshot', requireSecret, async (request, response) => {
      const parsed = outboundOneshotSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: parsed.error.message });
        return;
      }

      try {
        const result = await this.options.onOutbound(parsed.data);
        response.json({ slack_ts: result.slackTs, thread_ts: result.threadTs });
      } catch (error) {
        this.options.logger?.error({ err: error }, 'outbound oneshot failed');
        const normalized = normalizeRouteError(error);
        response.status(normalized.status).json(normalized.body);
      }
    });

    this.app.get('/registry', requireSecret, (_request, response) => {
      response.json({
        agents: this.options.registry.list().map((agent) => ({
          persona: agent.persona,
          kind: agent.kind,
          status: agent.status,
          task_id: agent.taskId ?? null,
          connected_at: new Date(agent.connectedAt).toISOString(),
        })),
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
