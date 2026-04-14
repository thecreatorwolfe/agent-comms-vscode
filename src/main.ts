import path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from 'pino';
import { loadAgentCommsEnv } from './env';
import { ensureGlobalBridgeLaunchers } from './global';
import { createLogger } from './log';
import {
  createSlackBoltRuntime,
  type SlackAppMentionEvent,
  type SlackChannelMessageEvent,
} from './slack/bolt';
import { parseAgentSlackEventText, parseHumanSlackControl } from './slack/parse';
import { postPersonaMessage, postSlackMessage, type PostedSlackMessage } from './slack/post';
import { AgentRegistry } from './registry/agents';
import { SpawnedTerminalRegistry } from './registry/terminals';
import { GatewayHttpServer } from './gateway/http';
import { WsGateway } from './gateway/ws';
import { PROJECT_OVERRIDE_KEY, resolveProjectName } from './persona/project';
import { parseAutomaticPersona, resolveRecipientAlias } from './persona/naming';
import { resolveIconUrl } from './persona/icons';
import type { ParsedSlackMessage } from './schema/slack_message';
import { validateSlackMessageText } from './schema/validate';
import { spawnAgent, type SpawnRequest, type SpawnResult } from './spawn';
import type { EventFrame } from './schema/frames';
import { wakeProcessTty } from './wake';

type OutboundRequest = {
  persona: string;
  thread_ts?: string | null;
  task_id: string;
  body: string;
  client_msg_id: string;
};

type RenameRequest = {
  persona: string;
  project_name?: string | null;
  custom_name?: string | null;
  persona_suffix?: string | null;
  instance_number?: number | null;
};

type RouteErrorReason = 'schema_invalid' | 'unknown_recipient' | 'slack_api_error';

class RecentlyDeliveredSlackTs {
  private readonly deliveredUntil = new Map<string, number>();

  constructor(private readonly ttlMs = 60_000) {}

  note(slackTs: string, now = Date.now()): void {
    this.prune(now);
    this.deliveredUntil.set(slackTs, now + this.ttlMs);
  }

  has(slackTs: string, now = Date.now()): boolean {
    this.prune(now);
    const expiresAt = this.deliveredUntil.get(slackTs);
    if (!expiresAt) {
      return false;
    }

    if (expiresAt <= now) {
      this.deliveredUntil.delete(slackTs);
      return false;
    }

    return true;
  }

  private prune(now: number): void {
    for (const [slackTs, expiresAt] of this.deliveredUntil.entries()) {
      if (expiresAt <= now) {
        this.deliveredUntil.delete(slackTs);
      }
    }
  }
}

function createRouteError(reason: RouteErrorReason, message: string, details?: unknown): Error & { reason: RouteErrorReason; details?: unknown } {
  return Object.assign(new Error(message), { reason, details });
}

export interface AgentCommsRuntime {
  showRegistry(): void;
  spawnFromPalette(): Promise<void>;
  spawn(request: SpawnRequest): Promise<SpawnResult>;
  dispose(): Promise<void>;
}

class AgentCommsRuntimeImpl implements AgentCommsRuntime {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly env: ReturnType<typeof loadAgentCommsEnv>,
    private readonly registry: AgentRegistry,
    private readonly terminals: SpawnedTerminalRegistry,
    private readonly slack: ReturnType<typeof createSlackBoltRuntime>,
    private readonly httpGateway: GatewayHttpServer,
    private readonly wsGateway: WsGateway,
  ) {}

  showRegistry(): void {
    const payload = {
      project: resolveProjectName({
        cwd: this.workspaceRoot,
        override: this.context.workspaceState.get<string | undefined>(PROJECT_OVERRIDE_KEY),
      }),
      agents: this.registry.list().map((agent) => ({
        persona: agent.persona,
        kind: agent.kind,
        status: agent.status,
        taskId: agent.taskId ?? null,
        connectedAt: new Date(agent.connectedAt).toISOString(),
      })),
      reservations: this.registry.listReservations().map((reservation) => ({
        persona: reservation.persona,
        kind: reservation.kind,
        taskId: reservation.taskId,
        expiresAt: new Date(reservation.expiresAt).toISOString(),
      })),
    };

    this.outputChannel.clear();
    this.outputChannel.appendLine(JSON.stringify(payload, null, 2));
    this.outputChannel.show(true);
  }

  async spawnFromPalette(): Promise<void> {
    const kind = await vscode.window.showQuickPick(
      [
        { label: 'Claude', value: 'claude' as const },
        { label: 'Codex', value: 'codex' as const },
      ],
      { placeHolder: 'Which agent do you want to spawn?' },
    );
    if (!kind) {
      return;
    }

    const briefSelection = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri: vscode.Uri.file(this.workspaceRoot),
      filters: {
        Markdown: ['md', 'markdown', 'txt'],
      },
    });
    if (!briefSelection?.length) {
      return;
    }

    const taskId = await vscode.window.showInputBox({
      prompt: 'Task ID (kebab-case)',
      validateInput: (value) => (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? undefined : 'Use kebab-case'),
    });
    if (!taskId) {
      return;
    }

    const projectName = await vscode.window.showInputBox({
      prompt: 'Optional task/project name override',
      placeHolder: 'Leave blank to use the workspace project name',
    });

    const personaSuffix = await vscode.window.showInputBox({
      prompt: 'Optional persona suffix override',
      placeHolder: 'Examples: alfred-30, codex-12, design-lead',
    });

    await this.spawn({
      kind: kind.value,
      briefFilePath: briefSelection[0].fsPath,
      projectName: projectName?.trim() || undefined,
      personaSuffix: personaSuffix?.trim() || undefined,
      parentPersona: null,
      taskId,
      reuseIdle: null,
    });
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    return spawnAgent(request, {
      registry: this.registry,
      workspaceRoot: this.workspaceRoot,
      extensionPort: this.env.EXTENSION_PORT,
      routerSharedSecret: this.env.ROUTER_SHARED_SECRET,
      extensionPath: this.context.extensionPath,
      codexChromeDevtoolsStartupTimeoutSec: vscode.workspace
        .getConfiguration('agentComms')
        .get<number>('codexChromeDevtoolsStartupTimeoutSec'),
      projectOverride: this.context.workspaceState.get<string | undefined>(PROJECT_OVERRIDE_KEY),
      trackTerminal: (persona, terminal) => this.terminals.track(persona, terminal),
    });
  }

  async dispose(): Promise<void> {
    await this.wsGateway.stop();
    await this.httpGateway.stop();
    await this.slack.stop();
    this.outputChannel.dispose();
  }
}

function getPrimaryWorkspaceRoot(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error('Agent Comms requires an open local workspace.');
  }
  if (workspaceFolder.uri.scheme !== 'file') {
    throw new Error('Agent Comms currently supports only local file-system workspaces.');
  }

  return workspaceFolder.uri.fsPath;
}

async function announceAgentOnline(
  slack: ReturnType<typeof createSlackBoltRuntime>,
  env: ReturnType<typeof loadAgentCommsEnv>,
  agent:
    | {
        persona: string;
        taskId?: string;
        parentPersona?: string | null;
        kind: 'claude' | 'codex';
      }
    | undefined,
  slackIconsBaseUrl?: string,
): Promise<void> {
  if (!agent) {
    return;
  }

  const text = agent.parentPersona
    ? `${agent.persona} ONLINE. Task: ${agent.taskId ?? 'unknown'}. Peer of ${agent.parentPersona}.`
    : `${agent.persona} ONLINE. Task: ${agent.taskId ?? 'unknown'}.`;

  await postSlackMessage({
    client: slack.client,
    channel: env.SLACK_CHANNEL_ID,
    text,
    username: agent.persona,
    iconUrl: slackIconsBaseUrl
      ? resolveIconUrl({ persona: agent.persona, kind: agent.kind, iconsBaseUrl: slackIconsBaseUrl })
      : undefined,
  });
}

function normalizeConfiguredBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

async function sendTerminalEscape(terminal: vscode.Terminal): Promise<void> {
  terminal.show(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
    text: '\u001b',
  });
}

async function interruptOrKillLiveAgents(
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  mode: 'interrupt' | 'kill',
): Promise<{ affected: string[]; untracked: string[] }> {
  const affected: string[] = [];
  const untracked: string[] = [];

  for (const agent of registry.list()) {
    const terminal = terminals.get(agent.persona);
    if (!terminal) {
      untracked.push(agent.persona);
      continue;
    }

    if (mode === 'kill') {
      terminals.disposeTracked(agent.persona);
      registry.dropImmediately(agent.persona);
    } else {
      await sendTerminalEscape(terminal as vscode.Terminal);
    }

    affected.push(agent.persona);
  }

  return { affected, untracked };
}

function buildHumanControlAck(
  command: 'stop' | 'stop kill',
  result: { affected: string[]; untracked: string[] },
): string {
  if (result.affected.length === 0 && result.untracked.length === 0) {
    return `${command.toUpperCase()} acknowledged. No live spawned agents were running.`;
  }

  const affectedLine = result.affected.length > 0
    ? `${command.toUpperCase()} acknowledged. Affected: ${result.affected.join(', ')}.`
    : `${command.toUpperCase()} acknowledged. No tracked live agents were affected.`;
  const untrackedLine = result.untracked.length > 0
    ? ` Untracked live agents were not controlled: ${result.untracked.join(', ')}.`
    : '';
  return `${affectedLine}${untrackedLine}`;
}

function resolveLiveRecipient(recipient: string, livePersonas: string[]): string | null {
  return resolveRecipientAlias(recipient, livePersonas);
}

function resolveEventTargets(
  registry: AgentRegistry,
  recipients: string[],
  fromPersona: string,
): { targets: string[]; unknownRecipients: string[] } {
  const livePersonas = registry.list().map((agent) => agent.persona);
  const targets = new Set<string>();
  const unknownRecipients: string[] = [];

  for (const recipient of recipients) {
    if (recipient === 'NICK') {
      continue;
    }

    if (recipient === 'ALL') {
      for (const persona of livePersonas) {
        if (persona !== fromPersona) {
          targets.add(persona);
        }
      }
      continue;
    }

    const resolvedRecipient = resolveLiveRecipient(recipient, livePersonas);
    if (resolvedRecipient) {
      if (resolvedRecipient !== fromPersona) {
        targets.add(resolvedRecipient);
      }
    } else {
      unknownRecipients.push(recipient);
    }
  }

  return { targets: [...targets], unknownRecipients };
}

async function handleHumanAppMention(
  event: SlackAppMentionEvent,
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  slack: ReturnType<typeof createSlackBoltRuntime>,
  env: ReturnType<typeof loadAgentCommsEnv>,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  if (event.user !== env.SLACK_OPERATOR_USER_ID) {
    outputChannel.appendLine(
      `[agent-comms] ignored operator control from unauthorized Slack user ${event.user} at ${event.ts}`,
    );
    return;
  }

  const parsed = parseHumanSlackControl(event.text);
  if (parsed.command === 'ignore') {
    return;
  }

  const mode = parsed.command === 'stop_kill' ? 'kill' : 'interrupt';
  const ack = buildHumanControlAck(
    parsed.command === 'stop_kill' ? 'stop kill' : 'stop',
    await interruptOrKillLiveAgents(registry, terminals, mode),
  );

  await postSlackMessage({
    client: slack.client,
    channel: env.SLACK_CHANNEL_ID,
    text: ack,
    threadTs: event.thread_ts ?? event.ts,
  });
}

async function handleInboundAgentMessage(
  event: SlackChannelMessageEvent,
  registry: AgentRegistry,
  wsGateway: WsGateway,
  outputChannel: vscode.OutputChannel,
  recentlyDeliveredSlackTs: RecentlyDeliveredSlackTs,
  logger?: Logger,
): Promise<void> {
  if (recentlyDeliveredSlackTs.has(event.ts)) {
    outputChannel.appendLine(`[agent-comms] skipped duplicate local delivery for Slack ts ${event.ts}`);
    return;
  }

  const parsed = parseAgentSlackEventText(event.text);
  if (parsed.route === 'unrouted') {
    return;
  }

  if (parsed.route === 'invalid_protocol') {
    outputChannel.appendLine(`[agent-comms] ignored invalid protocol message at ${event.ts}: ${parsed.error.message}`);
    return;
  }

  await deliverParsedAgentMessage(
    parsed.message,
    {
      slackTs: event.ts,
      threadTs: event.thread_ts ?? event.ts,
    },
    registry,
    wsGateway,
    outputChannel,
    logger,
  );
}

async function deliverParsedAgentMessage(
  message: ParsedSlackMessage,
  eventMeta: {
    slackTs: string;
    threadTs: string;
  },
  registry: AgentRegistry,
  wsGateway: WsGateway,
  outputChannel: vscode.OutputChannel,
  logger?: Logger,
): Promise<void> {
  const sender = message.from;
  const { targets } = resolveEventTargets(registry, message.recipients, sender);
  for (const target of targets) {
    const targetAgent = registry.get(target);
    const wasIdle = targetAgent?.status === 'idle';
    const delivered = wsGateway.sendEvent({
      type: 'event',
      from_persona: sender,
      to_persona: target,
      thread_ts: eventMeta.threadTs,
      task_id: message.taskId,
      body_raw: message.body,
      body_parsed: message,
      slack_ts: eventMeta.slackTs,
    });

    if (!delivered) {
      outputChannel.appendLine(`[agent-comms] local delivery skipped for ${target} at ${eventMeta.slackTs}`);
      continue;
    }

    if (!targetAgent || !wasIdle) {
      continue;
    }

    registry.markResume(target, message.taskId);
    const woke = await wakeProcessTty(targetAgent.pid, { logger });
    outputChannel.appendLine(
      woke
        ? `[agent-comms] woke idle agent ${target} after inbound delivery`
        : `[agent-comms] delivered inbound message to idle agent ${target}, but tty wake failed`,
    );
  }
}

async function handleOutboundRequest(
  payload: OutboundRequest,
  registry: AgentRegistry,
  slack: ReturnType<typeof createSlackBoltRuntime>,
  env: ReturnType<typeof loadAgentCommsEnv>,
  wsGateway: WsGateway,
  outputChannel: vscode.OutputChannel,
  recentlyDeliveredSlackTs: RecentlyDeliveredSlackTs,
  logger?: Logger,
  slackIconsBaseUrl?: string,
): Promise<PostedSlackMessage> {
  const validation = validateSlackMessageText(payload.body);
  if (!validation.ok) {
    throw createRouteError('schema_invalid', 'Outbound Slack body failed validation', validation.error.message);
  }

  const parsedBody = validation.data;
  if (parsedBody.from !== payload.persona) {
    throw createRouteError('schema_invalid', 'Body sender does not match outbound persona', {
      bodyFrom: parsedBody.from,
      persona: payload.persona,
    });
  }

  const livePersonas = registry.list().map((agent) => agent.persona);
  const unknownRecipients = parsedBody.recipients.filter((recipient) => {
    if (recipient === 'ALL' || recipient === 'NICK') {
      return false;
    }

    return resolveLiveRecipient(recipient, livePersonas) === null;
  });
  if (unknownRecipients.length > 0) {
    throw createRouteError('unknown_recipient', 'Outbound message includes unknown recipients', {
      unknownRecipients,
      knownPersonas: livePersonas,
    });
  }

  const senderKind = registry.get(payload.persona)?.kind ?? parseAutomaticPersona(payload.persona)?.kind;
  if (!senderKind) {
    throw createRouteError('schema_invalid', 'Unable to resolve sender kind', { persona: payload.persona });
  }

  const posted = await postPersonaMessage({
    client: slack.client,
    channel: env.SLACK_CHANNEL_ID,
    persona: payload.persona,
    kind: senderKind,
    text: payload.body,
    threadTs: payload.thread_ts ?? null,
    clientMsgId: payload.client_msg_id,
    iconsBaseUrl: slackIconsBaseUrl,
    iconUrl: slackIconsBaseUrl ? undefined : null,
  });

  recentlyDeliveredSlackTs.note(posted.slackTs);
  await deliverParsedAgentMessage(
    parsedBody,
    {
      slackTs: posted.slackTs,
      threadTs: posted.threadTs,
    },
    registry,
    wsGateway,
    outputChannel,
    logger,
  );

  return posted;
}

async function handleReadSlackHistory(
  slack: ReturnType<typeof createSlackBoltRuntime>,
  env: ReturnType<typeof loadAgentCommsEnv>,
  request: { thread_ts?: string | null; limit: number },
): Promise<{
  channel: string;
  messages: Array<{
    ts: string;
    thread_ts?: string | null;
    user?: string;
    bot_id?: string;
    text: string;
  }>;
}> {
  const response = request.thread_ts
    ? await slack.client.conversations.replies({
      channel: env.SLACK_CHANNEL_ID,
      ts: request.thread_ts,
      limit: request.limit,
    })
    : await slack.client.conversations.history({
      channel: env.SLACK_CHANNEL_ID,
      limit: request.limit,
    });

  if (!response.ok) {
    throw createRouteError('slack_api_error', 'Slack history read failed', response.error);
  }

  const rawMessages = Array.isArray(response.messages) ? response.messages : [];
  const messages = rawMessages
    .filter((message): message is typeof message & { text: string; ts: string } => (
      typeof message === 'object' &&
      message !== null &&
      'text' in message &&
      typeof message.text === 'string' &&
      'ts' in message &&
      typeof message.ts === 'string'
    ))
    .map((message) => ({
      ts: message.ts,
      thread_ts: 'thread_ts' in message && typeof message.thread_ts === 'string' ? message.thread_ts : null,
      user: 'user' in message && typeof message.user === 'string' ? message.user : undefined,
      bot_id: 'bot_id' in message && typeof message.bot_id === 'string' ? message.bot_id : undefined,
      text: message.text,
    }))
    .sort((left, right) => Number(left.ts) - Number(right.ts));

  return {
    channel: env.SLACK_CHANNEL_ID,
    messages,
  };
}

async function handleRenameRequest(
  request: RenameRequest,
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  wsGateway: WsGateway,
): Promise<{ persona: string; previous_persona: string }> {
  const renamed = registry.rename({
    persona: request.persona,
    projectName: request.project_name ?? null,
    customName: request.custom_name ?? null,
    personaSuffix: request.persona_suffix ?? null,
    instanceNumber: request.instance_number ?? null,
  });

  terminals.renamePersona(renamed.previousPersona, renamed.agent.persona);
  wsGateway.renameSessionPersona(renamed.agent.socket, renamed.previousPersona, renamed.agent.persona);
  return {
    persona: renamed.agent.persona,
    previous_persona: renamed.previousPersona,
  };
}

export async function bootstrap(context: vscode.ExtensionContext): Promise<AgentCommsRuntime> {
  const workspaceRoot = getPrimaryWorkspaceRoot();
  await ensureGlobalBridgeLaunchers(context.extensionPath);

  const outputChannel = vscode.window.createOutputChannel('Agent Comms');
  const configuration = vscode.workspace.getConfiguration('agentComms');
  const env = loadAgentCommsEnv({
    envFilePath: configuration.get<string>('envFilePath'),
    workspaceRoot: workspaceRoot,
    extensionPath: context.extensionPath,
  });
  const slackIconsBaseUrl = normalizeConfiguredBaseUrl(configuration.get<string>('slackIconsBaseUrl'));
  const localIconsBaseUrl = `http://127.0.0.1:${env.EXTENSION_PORT}/icons`;
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: false,
  });

  const registry = new AgentRegistry({ logger });
  const terminals = new SpawnedTerminalRegistry();
  const recentlyDeliveredSlackTs = new RecentlyDeliveredSlackTs();
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      terminals.untrackTerminal(terminal);
    }),
  );
  let slackRuntime!: ReturnType<typeof createSlackBoltRuntime>;
  let wsGateway!: WsGateway;
  const httpGateway = new GatewayHttpServer({
    port: env.EXTENSION_PORT,
    routerSharedSecret: env.ROUTER_SHARED_SECRET,
    iconsDir: path.resolve(context.extensionPath, 'icons'),
    registry,
    logger,
    onSpawn: async (request) =>
      spawnAgent(request, {
        registry,
        workspaceRoot: workspaceRoot,
        extensionPort: env.EXTENSION_PORT,
        routerSharedSecret: env.ROUTER_SHARED_SECRET,
        extensionPath: context.extensionPath,
        codexChromeDevtoolsStartupTimeoutSec: configuration.get<number>('codexChromeDevtoolsStartupTimeoutSec'),
        projectOverride: context.workspaceState.get<string | undefined>(PROJECT_OVERRIDE_KEY),
        trackTerminal: (persona, terminal) => terminals.track(persona, terminal),
        logger,
      }),
    onOutbound: async (request) => handleOutboundRequest(
      request,
      registry,
      slackRuntime,
      env,
      wsGateway,
      outputChannel,
      recentlyDeliveredSlackTs,
      logger,
      slackIconsBaseUrl,
    ),
    onReadSlack: async (request) => handleReadSlackHistory(slackRuntime, env, request),
    onRename: async (request) => handleRenameRequest(request, registry, terminals, wsGateway),
  });

  wsGateway = new WsGateway({
    server: httpGateway.server,
    routerSharedSecret: env.ROUTER_SHARED_SECRET,
    registry,
    logger,
    iconsBaseUrl: localIconsBaseUrl,
    onOutbound: async (request) => handleOutboundRequest(
      request,
      registry,
      slackRuntime,
      env,
      wsGateway,
      outputChannel,
      recentlyDeliveredSlackTs,
      logger,
      slackIconsBaseUrl,
    ),
    onAgentConnected: async (agent) => announceAgentOnline(slackRuntime, env, agent, slackIconsBaseUrl),
  });

  slackRuntime = createSlackBoltRuntime({
    env,
    logger,
    onAppMention: async (event) => handleHumanAppMention(event, registry, terminals, slackRuntime, env, outputChannel),
    onChannelMessage: async (event) => handleInboundAgentMessage(
      event,
      registry,
      wsGateway,
      outputChannel,
      recentlyDeliveredSlackTs,
      logger,
    ),
  });

  await httpGateway.start();
  wsGateway.start();
  await slackRuntime.start();

  return new AgentCommsRuntimeImpl(
    context,
    workspaceRoot,
    outputChannel,
    env,
    registry,
    terminals,
    slackRuntime,
    httpGateway,
    wsGateway,
  );
}
