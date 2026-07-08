import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import type { AgentCommsLogLevel } from '../env';
import { createLogger } from '../log';
import {
  agentCommsReadSlackInputSchema,
  agentCommsReplyInputSchema,
  buildRegistrationRequiredMessage,
  buildProtocolSlackMessage,
  formatSlackHistoryTranscript,
  hasPersonaOverride,
  normalizeRecipients,
  renamePersonaForReply,
} from '../mcp/reply';
import { resolveBridgeEnv } from '../mcp/runtime-env';
import { fetchSelfAgentStatus, formatAgentConnectionSnapshot, formatAgentStatus } from '../mcp/status';
import { AgentCommsWsClient } from '../mcp/ws-client';
import type { EventFrame } from '../schema/frames';

type JsonRpcId = number | string;

interface JsonRpcErrorLike {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcRequestLike {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationLike {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponseLike {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorLike;
}

interface CodexAuthState {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

const AGENT_COMMS_CODEX_APP_SERVER_SERVICE = 'agent_comms_codex_bridge';
const AGENT_COMMS_CODEX_APP_SERVER_CLIENT_INFO = {
  name: 'agent_comms_codex_bridge',
  title: 'Agent Comms Codex App Server Bridge',
  version: '0.2.43',
};
const AGENT_COMMS_CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS =
  'Agent Comms delivers Slack coordination messages into this Codex session. Connected sessions default to active waiting/listening. Use agent_comms_resume({ taskId: "..." }) only when you are actively working and want pings to interrupt the session. Use agent_comms_standby({ taskId: "..." }) only when you intentionally want reusable idle/standby behavior. Preferred minimal send: agent_comms_reply({ recipients: ["alfred-2"], body: "Need review." }). Omit subject, taskId, and threadTs unless they materially help. If agent_comms_status reports Registration required: yes, call agent_comms_rename({ customName: "your-persona" }) first or include customName/projectName/personaSuffix/instanceNumber in that same structured reply call so the hub renames you before the first visible Slack post. Messages relayed from NICK are high priority and should be checked promptly.';
const APP_SERVER_AGENT_COMMS_DISABLE_OVERRIDE = 'mcp_servers.agent-comms.enabled=false';
const APP_SERVER_SUPABASE_DISABLE_OVERRIDE = 'mcp_servers.supabase.enabled=false';

const agentCommsSpawnInputSchema = z.object({
  kind: z.enum(['claude', 'codex']),
  briefFilePath: z.string().min(1),
  taskId: z.string().min(1),
  customName: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  personaSuffix: z.string().min(1).optional(),
  instanceNumber: z.number().int().min(1).optional(),
  reuseIdle: z.boolean().optional(),
}).refine(
  (value) => (
    value.customName !== undefined
    || value.personaSuffix !== undefined
    || value.instanceNumber !== undefined
  ),
  'Parent spawns must provide customName, personaSuffix, or instanceNumber so the child terminal is named deterministically.',
);

const agentCommsRenameInputSchema = z.object({
  customName: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  personaSuffix: z.string().min(1).optional(),
  instanceNumber: z.number().int().min(1).optional(),
}).refine(
  (value) => (
    value.customName !== undefined
    || value.projectName !== undefined
    || value.personaSuffix !== undefined
    || value.instanceNumber !== undefined
  ),
  'Provide at least one rename field.',
);

function buildSpawnToolSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['claude', 'codex'] },
      briefFilePath: { type: 'string', minLength: 1 },
      taskId: { type: 'string', minLength: 1 },
      customName: { type: 'string', minLength: 1 },
      projectName: { type: 'string', minLength: 1 },
      personaSuffix: { type: 'string', minLength: 1 },
      instanceNumber: { type: 'integer', minimum: 1 },
      reuseIdle: { type: 'boolean' },
    },
    required: ['kind', 'briefFilePath', 'taskId'],
    additionalProperties: false,
  };
}

function buildRenameToolSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      customName: { type: 'string', minLength: 1 },
      projectName: { type: 'string', minLength: 1 },
      personaSuffix: { type: 'string', minLength: 1 },
      instanceNumber: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  };
}

function buildReadSlackToolSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      threadTs: {
        anyOf: [
          { type: 'string', minLength: 1 },
          { type: 'number' },
        ],
      },
    },
    additionalProperties: false,
  };
}

function buildReplyToolSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      message: { type: 'string', minLength: 1 },
      recipients: {
        anyOf: [
          { type: 'string', minLength: 1 },
          { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        ],
      },
      subject: { type: 'string', minLength: 1, maxLength: 100 },
      body: { type: 'string', minLength: 1 },
      taskId: { type: 'string', minLength: 1 },
      threadTs: {
        anyOf: [
          { type: 'string', minLength: 1 },
          { type: 'number' },
        ],
      },
      customName: { type: 'string', minLength: 1 },
      projectName: { type: 'string', minLength: 1 },
      personaSuffix: { type: 'string', minLength: 1 },
      instanceNumber: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  };
}

function buildStandbyToolSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      taskId: { type: 'string', minLength: 1 },
    },
    required: ['taskId'],
    additionalProperties: false,
  };
}

function buildResumeToolSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      taskId: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  };
}

const AGENT_COMMS_DYNAMIC_TOOLS = [
  {
    name: 'agent_comms_spawn',
    description: 'Request that the local Agent Comms hub spawn a new Claude or Codex peer in VS Code. This is local-only and does not go through Slack. Parent spawns must assign the child persona up front with customName or with personaSuffix/instanceNumber (optionally plus projectName). The terminal opens under that persona immediately.',
    inputSchema: buildSpawnToolSchema(),
  },
  {
    name: 'agent_comms_rename',
    description: 'Rename this live agent without restarting. Use this before the first Slack post when agent_comms_status shows Registration required: yes. You can change the full persona with customName, or rebuild it with projectName plus personaSuffix/instanceNumber.',
    inputSchema: buildRenameToolSchema(),
  },
  {
    name: 'agent_comms_read_slack',
    description: 'Read recent messages from the configured Agent Comms Slack channel or a specific Slack thread.',
    inputSchema: buildReadSlackToolSchema(),
  },
  {
    name: 'agent_comms_reply',
    description: 'Send a Slack message through the local Agent Comms hub. Preferred minimal usage: agent_comms_reply({ recipients: ["alfred-2"], body: "Need review." }). The tool auto-builds the protocol header and can rename your persona inline before sending.',
    inputSchema: buildReplyToolSchema(),
  },
  {
    name: 'agent_comms_status',
    description: 'Read the live Agent Comms registry entry for this Codex session so you can confirm whether you are idle, active-working, or active-waiting, whether inbound pings are pending, and whether this session still needs persona registration before its first Slack post.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'agent_comms_standby',
    description: 'Mark this Codex agent idle and reusable while still reachable for future Slack messages.',
    inputSchema: buildStandbyToolSchema(),
  },
  {
    name: 'agent_comms_resume',
    description: 'Mark this Codex agent active again. Connected sessions already default to active waiting/listening. Pass `taskId` only when you are actively working on a task and want pings to interrupt the session. Omit `taskId` when you want to stay active-waiting at the prompt without prompt injection.',
    inputSchema: buildResumeToolSchema(),
  },
] as const;

function buildSlackTurnText(frame: EventFrame): string {
  const priority = frame.from_persona === 'NICK' ? 'HIGH PRIORITY\n' : '';
  const task = frame.task_id ? `Task: ${frame.task_id}\n` : '';
  return [
    `${priority}Agent Comms inbound Slack message.`,
    `From: ${frame.from_persona}`,
    `To: ${frame.to_persona}`,
    task.trimEnd(),
    `Slack thread: ${frame.thread_ts}`,
    '',
    frame.body_raw,
    '',
    'Treat this as a live coordination ping. Continue the work if needed, and use Agent Comms tools to respond only when a reply materially helps.',
  ].filter(Boolean).join('\n');
}

function buildTextInput(text: string): Array<{ type: 'text'; text: string; textElements: [] }> {
  return [{ type: 'text', text, textElements: [] }];
}

function parseCliArgs(argv: string[]): { appServerArgs: string[]; prompt?: string } {
  const appServerArgs: string[] = [];
  const valueFlags = new Set([
    '-c',
    '--config',
    '--enable',
    '--disable',
    '--listen',
    '--ws-auth',
    '--ws-token-file',
    '--ws-shared-secret-file',
    '--ws-issuer',
    '--ws-audience',
    '--ws-max-clock-skew-seconds',
  ]);
  const passthroughFlags = new Set([
    '--analytics-default-enabled',
    '-h',
    '--help',
  ]);
  let prompt: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueFlags.has(arg)) {
      appServerArgs.push(arg);
      if (index + 1 >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      appServerArgs.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (passthroughFlags.has(arg)) {
      appServerArgs.push(arg);
      continue;
    }

    prompt = argv.slice(index).join(' ');
    break;
  }

  return { appServerArgs, prompt: prompt?.trim() || undefined };
}

async function resolveInitialPrompt(argv: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const briefFilePath = env.AGENT_COMMS_BRIEF_FILE?.trim();
  if (briefFilePath) {
    try {
      const prompt = await fs.readFile(briefFilePath, 'utf8');
      if (prompt.trim()) {
        return prompt;
      }
    } catch {
      // Fall through to argv prompt if the brief file is missing.
    }
  }

  return parseCliArgs(argv).prompt;
}

function writeTerminalBanner(message: string): void {
  process.stdout.write(`${message}\n`);
}

function formatRpcError(error: unknown): string {
  if (error && typeof error === 'object') {
    const message = 'message' in error ? error.message : undefined;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }

  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }

  return String(error);
}

async function readCodexAuthState(): Promise<CodexAuthState> {
  const authPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  const raw = await fs.readFile(authPath, 'utf8');
  return JSON.parse(raw) as CodexAuthState;
}

async function buildChatgptAuthTokensRefreshResponse(): Promise<{
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: null;
}> {
  const authState = await readCodexAuthState();
  if (authState.auth_mode !== 'chatgpt') {
    throw new Error(`Unsupported Codex auth mode for app-server bridge: ${authState.auth_mode ?? 'unknown'}`);
  }

  const accessToken = authState.tokens?.access_token?.trim();
  const chatgptAccountId = authState.tokens?.account_id?.trim();
  if (!accessToken || !chatgptAccountId) {
    throw new Error('Codex auth.json is missing ChatGPT access_token or account_id');
  }

  return {
    accessToken,
    chatgptAccountId,
    chatgptPlanType: null,
  };
}

class JsonlRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextId = 1;
  private stdoutBuffer = '';

  constructor(
    appServerArgs: string[],
    private readonly onRequest: (message: JsonRpcRequestLike) => Promise<void> | void,
    private readonly onNotification: (message: JsonRpcNotificationLike) => Promise<void> | void,
  ) {
    const hasListenOverride = appServerArgs.includes('--listen');
    this.child = spawn(
      'codex',
      [
        'app-server',
        '-c',
        APP_SERVER_SUPABASE_DISABLE_OVERRIDE,
        ...appServerArgs,
        ...(hasListenOverride ? [] : ['--listen', 'stdio://']),
        '-c',
        APP_SERVER_AGENT_COMMS_DISABLE_OVERRIDE,
      ],
      {
        cwd: cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  }

  start(): void {
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      this.drainStdoutBuffer();
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    this.child.on('error', (error) => {
      this.rejectPending(new Error(`codex app-server spawn failed: ${error.message}`));
    });
    this.child.on('close', (code, signal) => {
      this.rejectPending(new Error(`codex app-server exited (${signal ?? code ?? 'unknown'})`));
    });
  }

  async stop(): Promise<void> {
    if (!this.child.killed) {
      this.child.stdin.end();
      this.child.kill('SIGTERM');
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.writeJson({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.writeJson({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.writeJson({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.writeJson({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        data,
      },
    });
  }

  private writeJson(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private drainStdoutBuffer(): void {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const parsed = JSON.parse(line) as JsonRpcNotificationLike | JsonRpcRequestLike | JsonRpcResponseLike;
    if ('id' in parsed && 'method' in parsed) {
      void this.onRequest(parsed as JsonRpcRequestLike);
      return;
    }

    if ('id' in parsed && ('result' in parsed || 'error' in parsed)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(`${parsed.error.message}${parsed.error.data ? ` (${JSON.stringify(parsed.error.data)})` : ''}`));
        return;
      }

      pending.resolve(parsed.result);
      return;
    }

    if ('method' in parsed) {
      void this.onNotification(parsed as JsonRpcNotificationLike);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class CodexAppServerBridge {
  private readonly rpc: JsonlRpcClient;
  private readonly childAppServerArgs: string[];
  private readonly initialPromptPromise: Promise<string | undefined>;
  private readonly logger;
  private readonly client: AgentCommsWsClient;
  private readonly readyPromise: Promise<void>;
  private readyResolver!: () => void;
  private readyRejecter!: (error: Error) => void;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private lastAgentMessageItemId: string | undefined;
  private deliveryQueue = Promise.resolve();

  constructor(
    private readonly bridgeEnv: ReturnType<typeof resolveBridgeEnv>,
    argv: string[],
  ) {
    const parsedArgs = parseCliArgs(argv);
    this.childAppServerArgs = parsedArgs.appServerArgs;
    this.initialPromptPromise = resolveInitialPrompt(argv, process.env);
    this.logger = createLogger({
      level: this.bridgeEnv.logLevel ?? (process.env.LOG_LEVEL as AgentCommsLogLevel | undefined) ?? 'info',
      destination: 'stderr',
      logFilePrefix: 'codex-app-server-bridge',
    });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });
    this.rpc = new JsonlRpcClient(
      this.childAppServerArgs,
      async (message) => {
        await this.handleServerRequest(message);
      },
      async (message) => {
        await this.handleServerNotification(message);
      },
    );
    this.client = new AgentCommsWsClient({
      kind: 'codex',
      port: this.bridgeEnv.port,
      secret: this.bridgeEnv.secret,
      cwd: cwd(),
      pid: this.bridgeEnv.pid,
      persona: this.bridgeEnv.claimedPersona,
      profileId: this.bridgeEnv.profileId,
      logger: this.logger,
      onEvent: async (frame) => {
        await this.queueInboundDelivery(frame);
      },
    });
  }

  async start(): Promise<void> {
    this.rpc.start();
    await this.client.start();

    await this.rpc.request('initialize', {
      clientInfo: AGENT_COMMS_CODEX_APP_SERVER_CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
      },
    });
    this.rpc.notify('initialized', {});

    const threadStart = await this.rpc.request<{ thread?: { id?: string } }>('thread/start', {
      cwd: cwd(),
      serviceName: AGENT_COMMS_CODEX_APP_SERVER_SERVICE,
      personality: 'pragmatic',
      developerInstructions: AGENT_COMMS_CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS,
      approvalPolicy: {
        granular: {
          sandbox_approval: false,
          rules: false,
          skill_approval: false,
          request_permissions: false,
          mcp_elicitations: false,
        },
      },
      dynamicTools: AGENT_COMMS_DYNAMIC_TOOLS,
    });

    this.threadId = threadStart.thread?.id;
    if (!this.threadId) {
      throw new Error('thread/start did not return a thread id');
    }

    const initialPrompt = await this.initialPromptPromise;

    const persona = this.bridgeEnv.claimedPersona ?? 'codex';
    writeTerminalBanner(`[agent-comms] Codex app-server bridge running for ${persona}.`);

    if (initialPrompt?.trim()) {
      await this.startTurn(initialPrompt, 'initial brief');
    }

    this.readyResolver();
  }

  async stop(): Promise<void> {
    await Promise.allSettled([
      this.client.stop(),
      this.rpc.stop(),
    ]);
  }

  private async handleServerRequest(message: JsonRpcRequestLike): Promise<void> {
    try {
      switch (message.method) {
        case 'account/chatgptAuthTokens/refresh':
          this.rpc.respond(message.id, await buildChatgptAuthTokensRefreshResponse());
          return;
        case 'item/tool/call': {
          const result = await this.handleDynamicToolCall(message.params as {
            tool?: string;
            arguments?: unknown;
          });
          this.rpc.respond(message.id, result);
          return;
        }
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          this.rpc.respond(message.id, { decision: 'accept' });
          return;
        case 'mcpServer/elicitation/request':
          this.rpc.respond(message.id, { action: 'decline', content: null });
          return;
        case 'item/tool/requestUserInput':
          this.rpc.respondError(message.id, -32000, 'request_user_input is not supported by the Agent Comms Codex bridge');
          return;
        default:
          this.rpc.respondError(message.id, -32601, `Unsupported app-server request: ${message.method}`);
      }
    } catch (error) {
      this.rpc.respondError(message.id, -32000, formatRpcError(error));
    }
  }

  private async handleServerNotification(message: JsonRpcNotificationLike): Promise<void> {
    const params = message.params as Record<string, unknown> | undefined;
    switch (message.method) {
      case 'turn/started':
        this.activeTurnId = typeof params?.turn === 'object' && params.turn && 'id' in params.turn
          ? String((params.turn as { id: string }).id)
          : this.activeTurnId;
        this.lastAgentMessageItemId = undefined;
        process.stdout.write('\n[agent-comms] turn started\n');
        return;
      case 'turn/completed': {
        const turn = params?.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
        if (turn?.id && turn.id === this.activeTurnId) {
          this.activeTurnId = undefined;
        }
        this.lastAgentMessageItemId = undefined;
        const suffix = turn?.error?.message ? ` error=${turn.error.message}` : '';
        process.stdout.write(`\n[agent-comms] turn completed status=${turn?.status ?? 'unknown'}${suffix}\n`);
        return;
      }
      case 'item/agentMessage/delta': {
        const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined;
        const delta = typeof params?.delta === 'string' ? params.delta : '';
        if (!delta) {
          return;
        }
        if (itemId && itemId !== this.lastAgentMessageItemId) {
          this.lastAgentMessageItemId = itemId;
          process.stdout.write('\n');
        }
        process.stdout.write(delta);
        return;
      }
      case 'error': {
        const error = params?.error as { message?: string } | undefined;
        process.stdout.write(`\n[agent-comms] app-server error: ${error?.message ?? 'unknown'}\n`);
        return;
      }
      default:
        return;
    }
  }

  private async queueInboundDelivery(frame: EventFrame): Promise<void> {
    this.deliveryQueue = this.deliveryQueue.then(async () => {
      await this.readyPromise;
      try {
        await this.deliverInboundSlack(frame);
        this.client.sendEventAck({
          delivery_id: frame.delivery_id,
          surface_status: 'ok',
          surface_mechanism: 'codex_app_server',
          logging_status: 'ok',
        });
      } catch (error) {
        this.logger.warn({
          err: error,
          deliveryId: frame.delivery_id,
          fromPersona: frame.from_persona,
        }, 'failed to route inbound Slack message into codex app-server');
        this.client.sendEventAck({
          delivery_id: frame.delivery_id,
          surface_status: 'failed',
          surface_mechanism: 'codex_app_server',
          logging_status: 'failed',
        });
      }
    }).catch((error) => {
      this.logger.warn({ err: error }, 'inbound delivery queue failed');
    });

    await this.deliveryQueue;
  }

  private async deliverInboundSlack(frame: EventFrame): Promise<void> {
    const text = buildSlackTurnText(frame);
    if (this.activeTurnId) {
      try {
        await this.rpc.request('turn/steer', {
          threadId: this.requireThreadId(),
          input: buildTextInput(text),
          expectedTurnId: this.activeTurnId,
        });
        return;
      } catch (error) {
        this.logger.info({
          err: error,
          deliveryId: frame.delivery_id,
          activeTurnId: this.activeTurnId,
        }, 'turn/steer rejected; falling back to turn/start');
      }
    }

    await this.startTurn(text, `Slack from ${frame.from_persona}`);
  }

  private async startTurn(text: string, label: string): Promise<void> {
    const response = await this.rpc.request<{ turn?: { id?: string } }>('turn/start', {
      threadId: this.requireThreadId(),
      input: buildTextInput(text),
    });

    this.activeTurnId = response.turn?.id;
    this.lastAgentMessageItemId = undefined;
    process.stdout.write(`\n[agent-comms] started ${label}\n`);
  }

  private requireThreadId(): string {
    if (!this.threadId) {
      throw new Error('Codex app-server thread is not ready');
    }

    return this.threadId;
  }

  private async handleDynamicToolCall(payload: {
    tool?: string;
    arguments?: unknown;
  }): Promise<{
    contentItems: Array<{ type: 'inputText'; text: string }>;
    success: boolean;
  }> {
    try {
      switch (payload.tool) {
        case 'agent_comms_spawn':
          return await this.handleSpawnTool(payload.arguments);
        case 'agent_comms_rename':
          return await this.handleRenameTool(payload.arguments);
        case 'agent_comms_read_slack':
          return await this.handleReadSlackTool(payload.arguments);
        case 'agent_comms_reply':
          return await this.handleReplyTool(payload.arguments);
        case 'agent_comms_status':
          return await this.handleStatusTool();
        case 'agent_comms_standby':
          return await this.handleStandbyTool(payload.arguments);
        case 'agent_comms_resume':
          return await this.handleResumeTool(payload.arguments);
        default:
          return this.toolResult(`Unsupported Agent Comms tool: ${payload.tool ?? 'unknown'}`, false);
      }
    } catch (error) {
      return this.toolResult(formatRpcError(error), false);
    }
  }

  private async handleSpawnTool(raw: unknown): Promise<{
    contentItems: Array<{ type: 'inputText'; text: string }>;
    success: boolean;
  }> {
    const parsed = agentCommsSpawnInputSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return this.toolResult(parsed.error.message, false);
    }

    await this.client.waitForAuth();
    const response = await fetch(`http://127.0.0.1:${this.bridgeEnv.port}/spawn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Router-Secret': this.bridgeEnv.secret,
      },
      body: JSON.stringify({
        kind: parsed.data.kind,
        brief_file_path: parsed.data.briefFilePath,
        custom_name: parsed.data.customName ?? null,
        project_name: parsed.data.projectName ?? null,
        persona_suffix: parsed.data.personaSuffix ?? null,
        instance_number: parsed.data.instanceNumber ?? null,
        parent_persona: this.client.getCurrentPersona() ?? this.bridgeEnv.claimedPersona ?? null,
        task_id: parsed.data.taskId,
        reuse_idle: parsed.data.reuseIdle ?? null,
      }),
    });

    const payload = await response.json() as {
      persona?: string;
      reused?: boolean;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        typeof payload.error === 'string'
          ? payload.error
          : `Spawn request failed with HTTP ${response.status}`,
      );
    }

    return this.toolResult(`Spawn request accepted for ${payload.persona}${payload.reused ? ' (reused idle agent)' : ''}.`);
  }

  private async handleRenameTool(raw: unknown): Promise<{
    contentItems: Array<{ type: 'inputText'; text: string }>;
    success: boolean;
  }> {
    const parsed = agentCommsRenameInputSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return this.toolResult(parsed.error.message, false);
    }

    const previousPersona = await this.client.waitForAuth();
    const response = await fetch(`http://127.0.0.1:${this.bridgeEnv.port}/rename`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Router-Secret': this.bridgeEnv.secret,
      },
      body: JSON.stringify({
        persona: previousPersona,
        custom_name: parsed.data.customName ?? null,
        project_name: parsed.data.projectName ?? null,
        persona_suffix: parsed.data.personaSuffix ?? null,
        instance_number: parsed.data.instanceNumber ?? null,
      }),
    });

    const payload = await response.json() as {
      persona?: string;
      previous_persona?: string;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        typeof payload.error === 'string'
          ? payload.error
          : `Rename request failed with HTTP ${response.status}`,
      );
    }

    if (!payload.persona) {
      throw new Error('Rename request did not return a persona');
    }

    this.client.setCurrentPersona(payload.persona, {
      personaSource: 'claimed',
      registrationRequired: false,
    });
    return this.toolResult(`Renamed ${payload.previous_persona ?? previousPersona} to ${payload.persona}.`);
  }

  private async handleReadSlackTool(raw: unknown): Promise<{
    contentItems: Array<{ type: 'inputText'; text: string }>;
    success: boolean;
  }> {
    const parsed = agentCommsReadSlackInputSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return this.toolResult(parsed.error.message, false);
    }

    await this.client.waitForAuth();
    const response = await fetch(`http://127.0.0.1:${this.bridgeEnv.port}/slack-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Router-Secret': this.bridgeEnv.secret,
      },
      body: JSON.stringify({
        thread_ts: parsed.data.threadTs ?? null,
        limit: parsed.data.limit ?? 20,
      }),
    });

    const payload = await response.json() as {
      messages?: Array<{
        ts: string;
        thread_ts?: string | null;
        user?: string;
        bot_id?: string;
        text: string;
      }>;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        typeof payload.error === 'string'
          ? payload.error
          : `Slack history request failed with HTTP ${response.status}`,
      );
    }

    return this.toolResult(
      formatSlackHistoryTranscript(
        (payload.messages ?? []).map((message) => ({
          ts: message.ts,
          threadTs: message.thread_ts ?? null,
          user: message.user,
          botId: message.bot_id,
          text: message.text,
        })),
      ),
    );
  }

  private async handleReplyTool(raw: unknown): Promise<{
    contentItems: Array<{ type: 'inputText'; text: string }>;
    success: boolean;
  }> {
    const parsed = agentCommsReplyInputSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return this.toolResult(parsed.error.message, false);
    }

    let persona = await this.client.waitForAuth();
    const connection = this.client.getConnectionSnapshot();
    const override = {
      customName: parsed.data.customName,
      projectName: parsed.data.projectName,
      personaSuffix: parsed.data.personaSuffix,
      instanceNumber: parsed.data.instanceNumber,
    };
    if (connection.registrationRequired && !hasPersonaOverride(override)) {
      return this.toolResult(buildRegistrationRequiredMessage(persona), false);
    }

    if (hasPersonaOverride(override)) {
      const renamed = await renamePersonaForReply({
        port: this.bridgeEnv.port,
        secret: this.bridgeEnv.secret,
        persona,
        override,
      });
      this.client.setCurrentPersona(renamed.persona, {
        personaSource: 'claimed',
        registrationRequired: false,
      });
      persona = renamed.persona;
    }

    const outboundBody = parsed.data.message ?? buildProtocolSlackMessage({
      from: persona,
      recipients: normalizeRecipients(parsed.data.recipients ?? []),
      taskId: parsed.data.taskId ?? 'agent-comms-reply',
      subject: parsed.data.subject ?? 'Agent Comms reply',
      body: parsed.data.body ?? '',
    });
    const posted = await this.client.sendOutboundAndWait({
      thread_ts: parsed.data.threadTs ?? null,
      task_id: parsed.data.taskId ?? 'agent-comms-reply',
      body: outboundBody,
      client_msg_id: randomUUID(),
    });

    return this.toolResult(`Sent outbound Slack message to the Agent Comms hub at ${posted.slackTs}.`);
  }

  private async handleStatusTool(): Promise<{
    contentItems: Array<{ type: 'inputText'; text: string }>;
    success: boolean;
  }> {
    const connection = this.client.getConnectionSnapshot();
    if (!connection.authenticated || !connection.persona) {
      return this.toolResult(formatAgentConnectionSnapshot(connection));
    }

    try {
      const status = await fetchSelfAgentStatus({
        port: this.bridgeEnv.port,
        secret: this.bridgeEnv.secret,
        persona: connection.persona,
      });
      return this.toolResult(`${formatAgentStatus(status)}\n${formatAgentConnectionSnapshot(connection)}`);
    } catch (error) {
      return this.toolResult(`${formatAgentConnectionSnapshot(connection)}\nRegistry error: ${formatRpcError(error)}`, false);
    }
  }

  private async handleStandbyTool(raw: unknown): Promise<{
    contentItems: Array<{ type: 'inputText'; text: string }>;
    success: boolean;
  }> {
    const parsed = z.object({ taskId: z.string().min(1) }).safeParse(raw ?? {});
    if (!parsed.success) {
      return this.toolResult(parsed.error.message, false);
    }

    await this.client.waitForAuth();
    const status = await this.client.sendStandbyAndWait(parsed.data.taskId);
    return this.toolResult(`Marked ${status.persona} standby for task ${status.taskId}. Status: ${status.status}. Activity: ${status.activity}.`);
  }

  private async handleResumeTool(raw: unknown): Promise<{
    contentItems: Array<{ type: 'inputText'; text: string }>;
    success: boolean;
  }> {
    const parsed = z.object({ taskId: z.string().optional() }).safeParse(raw ?? {});
    if (!parsed.success) {
      return this.toolResult(parsed.error.message, false);
    }

    await this.client.waitForAuth();
    const status = await this.client.sendResumeAndWait(parsed.data.taskId);
    return this.toolResult(`Marked ${status.persona} active${status.taskId ? ` for ${status.taskId}` : ''}. Status: ${status.status}. Activity: ${status.activity}.`);
  }

  private toolResult(text: string, success = true): {
    contentItems: Array<{ type: 'inputText'; text: string }>;
    success: boolean;
  } {
    return {
      contentItems: [{ type: 'inputText', text }],
      success,
    };
  }
}

async function main(): Promise<void> {
  const bridge = new CodexAppServerBridge(resolveBridgeEnv(), process.argv.slice(2));
  await bridge.start();

  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

void main().catch((error) => {
  console.error('[agent-comms-codex-app-server] fatal', error);
  process.exit(1);
});
