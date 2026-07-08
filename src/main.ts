import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from 'pino';
import { loadAgentCommsEnv } from './env';
import { ensureGlobalBridgeLaunchers } from './global';
import { createLogger, resolveAgentCommsLogDir } from './log';
import {
  createSlackBoltRuntime,
  type SlackAppMentionEvent,
  type SlackChannelMessageEvent,
  type SlackSlashCommandEvent,
} from './slack/bolt';
import { parseAgentSlackEventText, parseHumanSlackControl, stripSlackUserMentions } from './slack/parse';
import { postPersonaMessage, postSlackMessage, type PostedSlackMessage } from './slack/post';
import { AgentRegistry, type AgentRecord } from './registry/agents';
import { SpawnedTerminalRegistry } from './registry/terminals';
import { GatewayHttpServer } from './gateway/http';
import { WsGateway } from './gateway/ws';
import { PROJECT_OVERRIDE_KEY, resolveProjectName } from './persona/project';
import { parseAutomaticPersona, resolveRecipientAlias } from './persona/naming';
import { parsedSlackMessageSchema, type ParsedSlackMessage } from './schema/slack_message';
import { validateSlackMessageText } from './schema/validate';
import { spawnAgent, type SpawnRequest, type SpawnResult } from './spawn';
import { AgentProfileStore } from './profile-store';
import { OperatorSettingsStore } from './operator-store';
import {
  collectPidTerminalMatchContext,
  formatPidTerminalMatchContext,
} from './process-tree';

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

interface OperatorControlState {
  listenEnabled: boolean;
  clearProfilesAwaitingConfirm: 'safe' | 'all' | null;
}

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

export interface BootstrapOptions {
  outputChannel?: vscode.OutputChannel;
  onFault?: (fault: { source: string; error: unknown; message: string }) => void;
}

class AgentCommsRuntimeImpl implements AgentCommsRuntime {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly ownOutputChannel: boolean,
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
        activity: agent.activity,
        registrationRequired: agent.registrationRequired ?? false,
        taskId: agent.taskId ?? null,
        disconnectDeadlineAt: agent.disconnectDeadlineAt ? new Date(agent.disconnectDeadlineAt).toISOString() : null,
        pendingMessages: agent.pendingMessageCount ?? 0,
        pendingUrgentMessages: agent.pendingUrgentMessageCount ?? 0,
        lastInboundFrom: agent.lastInboundFrom ?? null,
        lastInboundAt: agent.lastInboundAt ?? null,
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
    if (this.ownOutputChannel) {
      this.outputChannel.dispose();
    }
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

function normalizeConfiguredBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

async function sendTerminalEscape(terminal: { show(preserveFocus?: boolean): void }): Promise<void> {
  terminal.show(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
    text: '\u001b',
  });
}

async function sendTerminalEnter(terminal: { show(preserveFocus?: boolean): void }): Promise<void> {
  terminal.show(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
    text: '\r',
  });
}

type TerminalLookupResult = {
  terminal?: vscode.Terminal;
  matchedBy?: 'pid' | 'tty+tpgid' | 'tty';
  targetDebug: string;
  terminalsDebug: string;
};

async function describeVisibleTerminals(): Promise<string> {
  const descriptions = await Promise.all(vscode.window.terminals.map(async (terminal) => {
    try {
      const terminalPid = await terminal.processId;
      if (!terminalPid) {
        return `${terminal.name}{pid=unresolved}`;
      }
      const context = await collectPidTerminalMatchContext(terminalPid);
      return `${terminal.name}{${formatPidTerminalMatchContext(terminalPid, context)}}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${terminal.name}{error=${message}}`;
    }
  }));
  return descriptions.length > 0 ? descriptions.join('; ') : 'none';
}

async function findTerminalByPid(pid: number): Promise<TerminalLookupResult> {
  const targetContext = await collectPidTerminalMatchContext(pid);
  const targetDebug = formatPidTerminalMatchContext(pid, targetContext);
  if (targetContext.lineage.size === 0) {
    return {
      targetDebug,
      terminalsDebug: await describeVisibleTerminals(),
    };
  }

  for (const terminal of vscode.window.terminals) {
    try {
      const terminalPid = await terminal.processId;
      if (!terminalPid) {
        continue;
      }

      if (targetContext.lineage.has(terminalPid)) {
        return {
          terminal,
          matchedBy: 'pid',
          targetDebug,
          terminalsDebug: await describeVisibleTerminals(),
        };
      }
    } catch {
      // Ignore terminals whose process id cannot be resolved.
    }
  }

  let ttyOnlyTerminal: vscode.Terminal | undefined;
  let ttyOnlyMatchCount = 0;
  if (targetContext.ttys.size > 0) {
    for (const terminal of vscode.window.terminals) {
      try {
        const terminalPid = await terminal.processId;
        if (!terminalPid) {
          continue;
        }
        const terminalContext = await collectPidTerminalMatchContext(terminalPid);
        const sharesTty = [...terminalContext.ttys].some((tty) => targetContext.ttys.has(tty));
        if (!sharesTty) {
          continue;
        }
        const sharesTerminalProcessGroup = [...terminalContext.tpgids].some((tpgid) => targetContext.tpgids.has(tpgid));
        if (sharesTerminalProcessGroup) {
          return {
            terminal,
            matchedBy: 'tty+tpgid',
            targetDebug,
            terminalsDebug: await describeVisibleTerminals(),
          };
        }
        ttyOnlyTerminal = terminal;
        ttyOnlyMatchCount += 1;
      } catch {
        // Ignore terminals whose process id cannot be resolved.
      }
    }
  }

  if (ttyOnlyTerminal && ttyOnlyMatchCount === 1) {
    return {
      terminal: ttyOnlyTerminal,
      matchedBy: 'tty',
      targetDebug,
      terminalsDebug: await describeVisibleTerminals(),
    };
  }

  return {
    targetDebug,
    terminalsDebug: await describeVisibleTerminals(),
  };
}

async function trackTerminalForAgent(
  agent: AgentRecord,
  terminals: SpawnedTerminalRegistry,
): Promise<void> {
  if (terminals.get(agent.persona)) {
    return;
  }

  const lookup = await findTerminalByPid(agent.pid);
  if (lookup.terminal) {
    terminals.track(agent.persona, lookup.terminal);
  }
}

async function renameTrackedTerminalPersona(
  previousPersona: string,
  nextPersona: string,
  pid: number,
  terminals: SpawnedTerminalRegistry,
  outputChannel: vscode.OutputChannel,
): Promise<boolean> {
  let terminal = terminals.get(previousPersona);
  if (!terminal) {
    const lookup = await findTerminalByPid(pid);
    if (lookup.terminal) {
      terminals.track(previousPersona, lookup.terminal);
      terminal = lookup.terminal;
    }
  }

  const tracked = terminals.renamePersona(previousPersona, nextPersona);
  if (!terminal) {
    return tracked;
  }

  try {
    terminal.show(true);
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
      name: nextPersona,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(
      `[agent-comms] failed to rename terminal for ${previousPersona} -> ${nextPersona}: ${message}`,
    );
  }

  return true;
}

function buildActiveAgentPromptInput(
  target: string,
  sender: string,
  message: ParsedSlackMessage,
): string {
  const task = message.taskId ? ` Task: ${message.taskId}.` : '';
  return `Agent Comms ping from ${sender} to ${target}.${task} Stop and check Slack now with agent_comms_read_slack, then acknowledge or reply if needed. If you are already handling this ping, ignore this duplicate.`;
}

async function promptTrackedAgentTerminal(
  targetAgent: AgentRecord,
  sender: string,
  message: ParsedSlackMessage,
  terminals: SpawnedTerminalRegistry,
  outputChannel: vscode.OutputChannel,
): Promise<boolean> {
  let terminal = terminals.get(targetAgent.persona);
  let lookup: TerminalLookupResult | undefined;
  if (!terminal) {
    lookup = await findTerminalByPid(targetAgent.pid);
    if (lookup.terminal) {
      terminals.track(targetAgent.persona, lookup.terminal);
      terminal = lookup.terminal;
    }
  }

  if (!terminal?.sendText) {
    if (!lookup) {
      lookup = await findTerminalByPid(targetAgent.pid);
    }
    outputChannel.appendLine(
      `[agent-comms] could not inject Agent Comms ping prompt for ${targetAgent.persona}; `
      + `no tracked terminal input path; target=${lookup.targetDebug}; terminals=${lookup.terminalsDebug}`,
    );
    return false;
  }

  try {
    await sendTerminalEscape(terminal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    terminal.sendText(buildActiveAgentPromptInput(targetAgent.persona, sender, message), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await sendTerminalEnter(terminal);
    const matchMode = lookup?.matchedBy ? ` via ${lookup.matchedBy}` : '';
    outputChannel.appendLine(`[agent-comms] interrupted and injected Agent Comms ping prompt into terminal for ${targetAgent.persona}${matchMode}`);
    return true;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[agent-comms] failed to inject Agent Comms ping prompt for ${targetAgent.persona}: ${messageText}`);
    return false;
  }
}

function summarizeItems<T>(label: string, items: T[], formatter: (item: T) => string): string {
  return `${label}: ${items.length > 0 ? items.map(formatter).join(', ') : 'none'}`;
}

function formatAgentState(agent: AgentRecord): string {
  if (agent.status === 'idle') {
    return 'idle';
  }

  return agent.activity;
}

function formatProfilesSnapshot(
  registry: AgentRegistry,
  profileStore: AgentProfileStore,
): string {
  registry.releaseExpired();
  const allAgents = registry.listAll();
  const liveActive = allAgents.filter((agent) => !agent.disconnectDeadlineAt && agent.status === 'active');
  const liveIdle = allAgents.filter((agent) => !agent.disconnectDeadlineAt && agent.status === 'idle');
  const disconnected = allAgents.filter((agent) => agent.disconnectDeadlineAt);
  const reservations = registry.listReservations();
  const savedProfiles = profileStore.list();

  return [
    'Profiles snapshot:',
    summarizeItems('Live active', liveActive, (agent) => `${agent.persona} [${formatAgentState(agent)}]${agent.registrationRequired ? ' [re-register]' : ''}${agent.taskId ? ` [task:${agent.taskId}]` : ''}`),
    summarizeItems('Live idle', liveIdle, (agent) => `${agent.persona} [${formatAgentState(agent)}]${agent.registrationRequired ? ' [re-register]' : ''}${agent.taskId ? ` [task:${agent.taskId}]` : ''}`),
    summarizeItems('Disconnected grace', disconnected, (agent) => agent.persona),
    summarizeItems('Pending reservations', reservations, (reservation) => reservation.taskId ? `${reservation.persona} [task:${reservation.taskId}]` : reservation.persona),
    summarizeItems('Saved profiles', savedProfiles, (profile) => `${profile.persona} [id:${profile.profileId.slice(0, 8)}]`),
    summarizeItems('Invalidated profile ids', profileStore.listInvalidatedProfileIds(), (profileId) => profileId.slice(0, 8)),
  ].join('\n');
}

async function clearSpecificPersona(
  persona: string,
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  profileStore: AgentProfileStore,
  outputChannel: vscode.OutputChannel,
): Promise<string> {
  registry.releaseExpired();
  const liveAgent = registry.get(persona);
  const reservationReleased = registry.releaseReservation(persona);
  const savedProfilesRemoved = await profileStore.deletePersona(persona);
  const trackedTerminal = terminals.get(persona);
  let terminalDisposed = false;
  let sessionDropped = false;

  if (trackedTerminal) {
    terminalDisposed = terminals.disposeTracked(persona);
  }

  if (liveAgent) {
    try {
      liveAgent.socket.close(4000, 'profile_cleared');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[agent-comms] failed to close socket for ${persona}: ${message}`);
    }
    registry.dropImmediately(persona);
    sessionDropped = true;
  }

  if (!reservationReleased && savedProfilesRemoved === 0 && !sessionDropped) {
    return `No saved, reserved, or live profile matched ${persona}. Run \`@Agent Comms see profiles\` first to inspect the current occupancy.`;
  }

  return [
    `Cleared ${persona}.`,
    `Saved profiles removed: ${savedProfilesRemoved}.`,
    `Pending reservations released: ${reservationReleased ? 1 : 0}.`,
    `Live sessions dropped: ${sessionDropped ? 1 : 0}.`,
    `Tracked terminal disposed: ${terminalDisposed ? 'yes' : 'no'}.`,
  ].join(' ');
}

async function invalidateAllProfiles(
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  wsGateway: WsGateway,
  profileStore: AgentProfileStore,
  outputChannel: vscode.OutputChannel,
): Promise<string> {
  registry.releaseExpired();
  const profileIdsToInvalidate = new Set<string>();
  for (const profile of profileStore.list()) {
    profileIdsToInvalidate.add(profile.profileId);
  }
  for (const reservation of registry.listReservations()) {
    profileIdsToInvalidate.add(reservation.profileId);
  }
  for (const agent of registry.listAll()) {
    if (agent.profileId) {
      profileIdsToInvalidate.add(agent.profileId);
    }
  }

  const savedProfilesCleared = await profileStore.clear();
  const invalidatedProfileCount = await profileStore.invalidateProfileIds([...profileIdsToInvalidate]);
  const releasedReservations = registry.listReservations()
    .map((reservation) => reservation.persona)
    .filter((persona) => registry.releaseReservation(persona));
  const droppedDisconnected = registry.listAll()
    .filter((agent) => agent.disconnectDeadlineAt)
    .map((agent) => agent.persona);
  for (const persona of droppedDisconnected) {
    registry.dropImmediately(persona);
  }

  const invalidatedLive: string[] = [];
  for (const liveAgent of registry.list()) {
    const invalidated = registry.invalidateRegistration(liveAgent.persona);
    await renameTrackedTerminalPersona(
      invalidated.previousPersona,
      invalidated.agent.persona,
      invalidated.agent.pid,
      terminals,
      outputChannel,
    );
    wsGateway.resetSessionProfile(invalidated.agent, invalidated.previousPersona);
    invalidatedLive.push(`${invalidated.previousPersona} -> ${invalidated.agent.persona}`);
  }

  return [
    'Profile invalidation complete.',
    `Saved profiles cleared: ${savedProfilesCleared}.`,
    `Profile ids invalidated: ${invalidatedProfileCount}.`,
    `Pending reservations released: ${releasedReservations.length}.`,
    `Disconnected grace occupants dropped: ${droppedDisconnected.length}.`,
    `Live agents forced to re-register: ${invalidatedLive.length > 0 ? invalidatedLive.join(', ') : 'none'}.`,
  ].join(' ');
}

function clearDisconnectedProfiles(
  registry: AgentRegistry,
): string {
  registry.releaseExpired();
  const disconnected = registry.listAll()
    .filter((agent) => agent.disconnectDeadlineAt)
    .map((agent) => agent.persona);
  for (const persona of disconnected) {
    registry.dropImmediately(persona);
  }

  return `Disconnected profiles cleared: ${disconnected.length > 0 ? disconnected.join(', ') : 'none'}.`;
}

async function clearInvalidatedAndTemporaryProfiles(
  registry: AgentRegistry,
  profileStore: AgentProfileStore,
): Promise<string> {
  registry.releaseExpired();

  const invalidatedProfileIds = profileStore.listInvalidatedProfileIds();
  await profileStore.clearInvalidatedProfileIds(invalidatedProfileIds);

  const savedUnregistered = profileStore.list()
    .filter((profile) => profile.persona.startsWith('unregistered-'))
    .map((profile) => profile.persona);
  let savedUnregisteredRemoved = 0;
  for (const persona of savedUnregistered) {
    savedUnregisteredRemoved += await profileStore.deletePersona(persona);
  }

  const releasedReservations = registry.listReservations()
    .filter((reservation) => reservation.persona.startsWith('unregistered-'))
    .map((reservation) => reservation.persona)
    .filter((persona) => registry.releaseReservation(persona));

  const droppedDisconnected = registry.listAll()
    .filter((agent) => agent.disconnectDeadlineAt && agent.persona.startsWith('unregistered-'))
    .map((agent) => agent.persona);
  for (const persona of droppedDisconnected) {
    registry.dropImmediately(persona);
  }

  const stillLive = registry.list()
    .filter((agent) => agent.persona.startsWith('unregistered-'))
    .map((agent) => agent.persona);

  return [
    'Invalidated cleanup complete.',
    `Invalidated profile ids cleared: ${invalidatedProfileIds.length}.`,
    `Saved unregistered profiles removed: ${savedUnregisteredRemoved}.`,
    `Unregistered reservations released: ${releasedReservations.length}.`,
    `Disconnected unregistered profiles dropped: ${droppedDisconnected.length}.`,
    `Still live unregistered sessions: ${stillLive.length > 0 ? stillLive.join(', ') : 'none'}.`,
  ].join(' ');
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

function extractHumanRelayRecipients(text: string): string[] {
  const matches = text.matchAll(/(?:^|[\s(])@(?<recipient>(?:ALL|NICK|[a-z0-9][a-z0-9-]{1,63}))(?=$|[\s,.:;!?)])/gimu);
  const recipients = new Set<string>();
  for (const match of matches) {
    const raw = match.groups?.recipient;
    if (!raw) {
      continue;
    }

    const upper = raw.toUpperCase();
    recipients.add(upper === 'ALL' || upper === 'NICK' ? upper : raw.toLowerCase());
  }

  return [...recipients];
}

function buildHumanRelayMessageForRecipients(text: string, recipients: string[]): ParsedSlackMessage | null {
  const stripped = stripSlackUserMentions(text);
  if (!stripped || recipients.length === 0) {
    return null;
  }

  return parsedSlackMessageSchema.parse({
    from: 'NICK',
    recipients,
    body: stripped,
    asks: [],
  });
}

function resolveLiveRecipient(recipient: string, livePersonas: string[]): string | null {
  return resolveRecipientAlias(recipient, livePersonas);
}

function resolveOutboundSenderPersona(payloadPersona: string, bodyPersona: string, livePersonas: string[]): string {
  const resolvedPayloadPersona = resolveLiveRecipient(payloadPersona, livePersonas) ?? payloadPersona;
  const resolvedBodyPersona = resolveLiveRecipient(bodyPersona, livePersonas) ?? bodyPersona;
  if (resolvedBodyPersona !== resolvedPayloadPersona) {
    throw createRouteError('schema_invalid', 'Body sender does not match outbound persona', {
      bodyFrom: bodyPersona,
      persona: payloadPersona,
      resolvedBodyFrom: resolvedBodyPersona,
      resolvedPersona: resolvedPayloadPersona,
    });
  }

  return resolvedPayloadPersona;
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

function buildActiveAgentAttentionNotice(
  target: string,
  sender: string,
  message: ParsedSlackMessage,
): string {
  const task = message.taskId ? ` (${message.taskId})` : '';
  return `Agent Comms: ${sender} pinged ${target}${task}.`;
}

function buildDeliveryTraceSummary(options: {
  deliveryId: string;
  sender: string;
  target: string;
  slackTs: string;
  taskId?: string;
}): string {
  return `delivery=${options.deliveryId} ${options.sender}->${options.target} slack_ts=${options.slackTs}${options.taskId ? ` task=${options.taskId}` : ''}`;
}

function formatEventAckSummary(ack: Awaited<ReturnType<WsGateway['waitForEventAck']>>): string {
  if (!ack) {
    return 'bridge_ack=timeout';
  }

  const action = ack.surface_action ? ` action=${ack.surface_action}` : '';
  const handling = ack.surface_handling ? ` handling=${ack.surface_handling}` : '';
  const summary = ack.surface_summary ? ` summary=${JSON.stringify(ack.surface_summary)}` : '';
  const elapsedMs = ack.surface_elapsed_ms != null ? ` elapsed_ms=${ack.surface_elapsed_ms}` : '';
  return `bridge_ack=${ack.surface_mechanism}:${ack.surface_status}${action}${handling}${summary}${elapsedMs} logging=${ack.logging_status}`;
}

async function handleHumanAppMention(
  event: SlackAppMentionEvent,
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  wsGateway: WsGateway,
  slack: ReturnType<typeof createSlackBoltRuntime>,
  env: ReturnType<typeof loadAgentCommsEnv>,
  outputChannel: vscode.OutputChannel,
  operatorControlState: OperatorControlState,
  operatorSettingsStore: OperatorSettingsStore,
  profileStore: AgentProfileStore,
): Promise<void> {
  const ack = await handleAuthorizedHumanControl(
    event.user,
    event.text,
    event.ts,
    registry,
    terminals,
    wsGateway,
    env,
    outputChannel,
    operatorControlState,
    operatorSettingsStore,
    profileStore,
  );
  if (!ack) {
    return;
  }

  await postSlackMessage({
    client: slack.client,
    channel: env.SLACK_CHANNEL_ID,
    text: ack,
    threadTs: event.thread_ts ?? event.ts,
  });
}

async function handleAuthorizedHumanControl(
  user: string,
  text: string,
  auditTs: string,
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  wsGateway: WsGateway,
  env: ReturnType<typeof loadAgentCommsEnv>,
  outputChannel: vscode.OutputChannel,
  operatorControlState: OperatorControlState,
  operatorSettingsStore: OperatorSettingsStore,
  profileStore: AgentProfileStore,
): Promise<string | null> {
  if (user !== env.SLACK_OPERATOR_USER_ID) {
    outputChannel.appendLine(
      `[agent-comms] ignored operator control from unauthorized Slack user ${user} at ${auditTs}`,
    );
    return null;
  }

  const parsed = parseHumanSlackControl(text);
  if (parsed.command === 'ignore') {
    return null;
  }

  switch (parsed.command) {
    case 'stop':
    case 'stop_kill': {
      const mode = parsed.command === 'stop_kill' ? 'kill' : 'interrupt';
      return buildHumanControlAck(
        parsed.command === 'stop_kill' ? 'stop kill' : 'stop',
        await interruptOrKillLiveAgents(registry, terminals, mode),
      );
    }
    case 'listen':
      operatorControlState.listenEnabled = true;
      await operatorSettingsStore.setListenEnabled(true);
      return 'LISTEN enabled. Nick channel messages now relay at high priority. Explicit `@persona` or `@ALL` routing is honored; otherwise the hub defaults to all currently active agents until you send `@Agent Comms unlisten` or `/agent-comms unlisten`.';
    case 'unlisten':
      operatorControlState.listenEnabled = false;
      await operatorSettingsStore.setListenEnabled(false);
      return 'LISTEN disabled. Human Slack messages are back to ignore-only mode except for `stop` and `stop kill`.';
    case 'clear_profiles': {
      operatorControlState.clearProfilesAwaitingConfirm = 'safe';
      return `${formatProfilesSnapshot(registry, profileStore)}\n\nReply with \`@Agent Comms clear profiles confirm\` or run \`/agent-comms clear profiles confirm\` to erase saved profiles, pending reservations, and disconnected grace-period occupants. Active live agents are left alone and can be removed individually with \`clear profile <persona>\`.`;
    }
    case 'clear_profiles_confirm': {
      if (operatorControlState.clearProfilesAwaitingConfirm !== 'safe') {
        return 'No profile-clear request is pending. Send `@Agent Comms clear profiles` or `/agent-comms clear profiles` first if you want a confirmation prompt.';
      }

      operatorControlState.clearProfilesAwaitingConfirm = null;
      const savedProfilesCleared = await profileStore.clear();
      const releasedReservations = registry.listReservations()
        .map((reservation) => reservation.persona)
        .filter((persona) => registry.releaseReservation(persona));
      const droppedDisconnected = registry.listAll()
        .filter((agent) => agent.disconnectDeadlineAt)
        .map((agent) => agent.persona);
      for (const persona of droppedDisconnected) {
        registry.dropImmediately(persona);
      }
      const stillLive = registry.list().map((agent) => agent.persona);
      return [
        'Profile reset complete.',
        `Saved profiles cleared: ${savedProfilesCleared}.`,
        `Pending reservations released: ${releasedReservations.length}.`,
        `Disconnected grace occupants dropped: ${droppedDisconnected.length}.`,
        `Still live and occupying names: ${stillLive.length > 0 ? stillLive.join(', ') : 'none'}.`,
      ].join(' ');
    }
    case 'clear_profiles_all': {
      operatorControlState.clearProfilesAwaitingConfirm = 'all';
      return `${formatProfilesSnapshot(registry, profileStore)}\n\nReply with \`@Agent Comms clear profiles all confirm\` or run \`/agent-comms clear profiles all confirm\` to invalidate every profile id, including live connected agents, without killing terminals. Live agents will be renamed to temporary \`unregistered-*\` personas and must re-register before their next Slack send.`;
    }
    case 'clear_profiles_all_confirm': {
      if (operatorControlState.clearProfilesAwaitingConfirm !== 'all') {
        return 'No all-profile invalidation request is pending. Send `@Agent Comms clear profiles all` or `/agent-comms clear profiles all` first if you want to force every agent to re-register.';
      }

      operatorControlState.clearProfilesAwaitingConfirm = null;
      return invalidateAllProfiles(registry, terminals, wsGateway, profileStore, outputChannel);
    }
    case 'see_profiles':
      return formatProfilesSnapshot(registry, profileStore);
    case 'clear_disconnected':
      return clearDisconnectedProfiles(registry);
    case 'clear_invalidated':
      return clearInvalidatedAndTemporaryProfiles(registry, profileStore);
    case 'clear_profile':
      return clearSpecificPersona(parsed.persona, registry, terminals, profileStore, outputChannel);
  }
}

async function handleHumanSlashCommand(
  event: SlackSlashCommandEvent,
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  wsGateway: WsGateway,
  env: ReturnType<typeof loadAgentCommsEnv>,
  outputChannel: vscode.OutputChannel,
  operatorControlState: OperatorControlState,
  operatorSettingsStore: OperatorSettingsStore,
  profileStore: AgentProfileStore,
): Promise<string> {
  const ack = await handleAuthorizedHumanControl(
    event.user,
    event.text,
    event.ts,
    registry,
    terminals,
    wsGateway,
    env,
    outputChannel,
    operatorControlState,
    operatorSettingsStore,
    profileStore,
  );
  return ack ?? 'Unknown Agent Comms command. Use `/agent-comms listen`, `/agent-comms unlisten`, `/agent-comms see profiles`, `/agent-comms clear disconnected`, `/agent-comms clear invalidated`, `/agent-comms clear profile <persona>`, `/agent-comms clear profiles`, `/agent-comms clear profiles confirm`, `/agent-comms clear profiles all`, `/agent-comms clear profiles all confirm`, `/agent-comms stop`, or `/agent-comms stop kill`.';
}

async function handleInboundAgentMessage(
  event: SlackChannelMessageEvent,
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
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
    terminals,
    wsGateway,
    outputChannel,
    logger,
  );
}

async function handleHumanChannelMessage(
  event: SlackChannelMessageEvent,
  env: ReturnType<typeof loadAgentCommsEnv>,
  operatorControlState: OperatorControlState,
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  wsGateway: WsGateway,
  outputChannel: vscode.OutputChannel,
  recentlyDeliveredSlackTs: RecentlyDeliveredSlackTs,
  logger?: Logger,
): Promise<void> {
  if (event.user !== env.SLACK_OPERATOR_USER_ID || !operatorControlState.listenEnabled) {
    return;
  }

  if (recentlyDeliveredSlackTs.has(event.ts)) {
    return;
  }

  const mentionedRecipients = extractHumanRelayRecipients(event.text);
  const activeRecipients = registry.list()
    .filter((agent) => agent.status === 'active')
    .map((agent) => agent.persona);
  const relayMessage = buildHumanRelayMessageForRecipients(
    event.text,
    mentionedRecipients.length > 0 ? mentionedRecipients : activeRecipients,
  );
  if (!relayMessage) {
    return;
  }

  await deliverParsedAgentMessage(
    relayMessage,
    {
      slackTs: event.ts,
      threadTs: event.thread_ts ?? event.ts,
    },
    registry,
    terminals,
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
  terminals: SpawnedTerminalRegistry,
  wsGateway: WsGateway,
  outputChannel: vscode.OutputChannel,
  logger?: Logger,
): Promise<void> {
  const sender = message.from;
  const requiresImmediateAttention = sender === 'NICK';
  const { targets } = resolveEventTargets(registry, message.recipients, sender);
  await Promise.allSettled(targets.map(async (target) => {
    const deliveryId = randomUUID();
    const targetAgent = registry.get(target);
    const wasIdle = targetAgent?.status === 'idle';
    const traceSummary = buildDeliveryTraceSummary({
      deliveryId,
      sender,
      target,
      slackTs: eventMeta.slackTs,
      taskId: message.taskId,
    });
    const delivered = wsGateway.sendEvent({
      type: 'event',
      delivery_id: deliveryId,
      from_persona: sender,
      to_persona: target,
      thread_ts: eventMeta.threadTs,
      task_id: message.taskId,
      body_raw: message.body,
      body_parsed: message,
      slack_ts: eventMeta.slackTs,
    });

    if (!delivered) {
      outputChannel.appendLine(`[agent-comms] ${traceSummary} local delivery skipped before bridge receipt`);
      return;
    }

    outputChannel.appendLine(`[agent-comms] ${traceSummary} ws event delivered to live bridge socket`);

    if (!targetAgent) {
      return;
    }

    registry.noteInboundMessage(target, {
      fromPersona: sender,
      urgent: requiresImmediateAttention,
      receivedAt: new Date().toISOString(),
      taskId: message.taskId,
      threadTs: eventMeta.threadTs,
    });

    if (!wasIdle && targetAgent.activity === 'working') {
      const eventAck = await wsGateway.waitForEventAck(deliveryId, 250);
      const prompted = targetAgent.kind === 'codex'
        ? await promptTrackedAgentTerminal(targetAgent, sender, message, terminals, outputChannel)
        : false;
      void vscode.window.showInformationMessage(buildActiveAgentAttentionNotice(target, sender, message));
      outputChannel.appendLine(
        requiresImmediateAttention
          ? `[agent-comms] ${traceSummary} high-priority active-working branch ${formatEventAckSummary(eventAck)}${prompted ? ' prompt=ok' : ' prompt=skip'}`
          : `[agent-comms] ${traceSummary} active-working branch ${formatEventAckSummary(eventAck)}${prompted ? ' prompt=ok' : ' prompt=skip'}`,
      );
      return;
    }

    if (!wasIdle) {
      const eventAck = await wsGateway.waitForEventAck(deliveryId, 800);
      const prompted = targetAgent.kind === 'codex'
        ? await promptTrackedAgentTerminal(targetAgent, sender, message, terminals, outputChannel)
        : false;
      void vscode.window.showInformationMessage(buildActiveAgentAttentionNotice(target, sender, message));
      outputChannel.appendLine(
        `[agent-comms] ${traceSummary} active-waiting branch ${formatEventAckSummary(eventAck)}${prompted ? ' prompt=ok' : targetAgent.kind === 'codex' ? ' prompt=skip' : ''}`,
      );
      return;
    }

    const eventAck = await wsGateway.waitForEventAck(deliveryId, 800);
    registry.markResume(target, message.taskId);
    const prompted = targetAgent.kind === 'codex'
      ? await promptTrackedAgentTerminal(targetAgent, sender, message, terminals, outputChannel)
      : false;
    void vscode.window.showInformationMessage(buildActiveAgentAttentionNotice(target, sender, message));
    outputChannel.appendLine(
      `[agent-comms] ${traceSummary} idle branch ${formatEventAckSummary(eventAck)} resume=ok${prompted ? ' prompt=ok' : targetAgent.kind === 'codex' ? ' prompt=skip' : ''}`,
    );
  }));
}

async function handleOutboundRequest(
  payload: OutboundRequest,
  registry: AgentRegistry,
  terminals: SpawnedTerminalRegistry,
  profileStore: AgentProfileStore,
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
    logger?.warn(
      { persona: payload.persona, taskId: payload.task_id, bodyLength: payload.body.length, parseError: validation.error.message },
      'outbound body failed schema validation',
    );
    throw createRouteError('schema_invalid', 'Outbound Slack body failed validation', validation.error.message);
  }

  const parsedBody = validation.data;
  const livePersonas = registry.list().map((agent) => agent.persona);
  const senderPersona = resolveOutboundSenderPersona(payload.persona, parsedBody.from, livePersonas);
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

  const senderAgent = registry.get(senderPersona);
  if (senderAgent?.registrationRequired) {
    throw createRouteError(
      'schema_invalid',
      'Persona must be re-registered before sending Slack messages',
      { persona: senderPersona },
    );
  }
  const senderKind = senderAgent?.kind ?? parseAutomaticPersona(senderPersona)?.kind;
  if (!senderKind) {
    throw createRouteError('schema_invalid', 'Unable to resolve sender kind', { persona: senderPersona });
  }

  const posted = await postPersonaMessage({
    client: slack.client,
    channel: env.SLACK_CHANNEL_ID,
    persona: senderPersona,
    kind: senderKind,
    text: payload.body,
    threadTs: payload.thread_ts ?? null,
    clientMsgId: payload.client_msg_id,
    iconsBaseUrl: slackIconsBaseUrl,
    iconUrl: slackIconsBaseUrl ? undefined : null,
  });

  await profileStore.noteAgent({
    profileId: senderAgent?.profileId,
    persona: senderPersona,
    kind: senderKind,
    cwd: senderAgent?.cwd ?? '',
    taskId: payload.task_id,
  });
  if (senderAgent) {
    registry.clearPendingMessages(senderPersona);
  }
  recentlyDeliveredSlackTs.note(posted.slackTs);
  await deliverParsedAgentMessage(
    parsedBody,
    {
      slackTs: posted.slackTs,
      threadTs: posted.threadTs,
    },
    registry,
    terminals,
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
  profileStore: AgentProfileStore,
  outputChannel: vscode.OutputChannel,
): Promise<{ persona: string; previous_persona: string }> {
  const renamed = registry.rename({
    persona: request.persona,
    projectName: request.project_name ?? null,
    customName: request.custom_name ?? null,
    personaSuffix: request.persona_suffix ?? null,
    instanceNumber: request.instance_number ?? null,
  });

  await renameTrackedTerminalPersona(
    renamed.previousPersona,
    renamed.agent.persona,
    renamed.agent.pid,
    terminals,
    outputChannel,
  );
  wsGateway.renameSessionPersona(renamed.agent.socket, renamed.previousPersona, renamed.agent.persona);
  await profileStore.noteAgent({
    profileId: renamed.agent.profileId,
    persona: renamed.agent.persona,
    kind: renamed.agent.kind,
    cwd: renamed.agent.cwd,
    taskId: renamed.agent.taskId ?? null,
  });
  return {
    persona: renamed.agent.persona,
    previous_persona: renamed.previousPersona,
  };
}

function describeFault(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

export async function bootstrap(
  context: vscode.ExtensionContext,
  options: BootstrapOptions = {},
): Promise<AgentCommsRuntime> {
  const workspaceRoot = getPrimaryWorkspaceRoot();
  await ensureGlobalBridgeLaunchers(context.extensionPath);

  const outputChannel = options.outputChannel ?? vscode.window.createOutputChannel('Agent Comms');
  const ownOutputChannel = !options.outputChannel;
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
    logFilePrefix: 'hub',
  });
  const reportFault = (source: string, error: unknown, showNotification = true): void => {
    const message = describeFault(error);
    outputChannel.appendLine(`[agent-comms][${source}] ${message}`);
    if (showNotification) {
      void vscode.window.showWarningMessage(`Agent Comms issue (${source}). Check the "Agent Comms" output channel.`);
    }
    options.onFault?.({ source, error, message });
  };

  const registry = new AgentRegistry({ logger });
  const profileStore = new AgentProfileStore(context.globalState);
  const operatorSettingsStore = new OperatorSettingsStore(context.globalState);
  const terminals = new SpawnedTerminalRegistry();
  const recentlyDeliveredSlackTs = new RecentlyDeliveredSlackTs();
  const savedOperatorSettings = operatorSettingsStore.get();
  const operatorControlState: OperatorControlState = {
    listenEnabled: savedOperatorSettings.listenEnabled,
    clearProfilesAwaitingConfirm: null,
  };
  outputChannel.appendLine(`[agent-comms] booting hub for ${workspaceRoot} on port ${env.EXTENSION_PORT}`);
  outputChannel.appendLine(`[agent-comms] persistent logs: ${resolveAgentCommsLogDir()}`);
  if (operatorControlState.listenEnabled) {
    outputChannel.appendLine('[agent-comms] restored operator listen mode from saved state');
  }
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
    onFault: (source, error) => reportFault(source, error, false),
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
      terminals,
      profileStore,
      slackRuntime,
      env,
      wsGateway,
      outputChannel,
      recentlyDeliveredSlackTs,
      logger,
      slackIconsBaseUrl,
    ),
    onReadSlack: async (request) => handleReadSlackHistory(slackRuntime, env, request),
    onRename: async (request) => handleRenameRequest(request, registry, terminals, wsGateway, profileStore, outputChannel),
  });

  wsGateway = new WsGateway({
    server: httpGateway.server,
    routerSharedSecret: env.ROUTER_SHARED_SECRET,
    registry,
    logger,
    iconsBaseUrl: localIconsBaseUrl,
    onFault: (source, error) => reportFault(source, error, false),
    resolveSavedPersona: (profileId) => profileStore.get(profileId)?.persona,
    isProfileInvalidated: (profileId) => profileStore.isProfileInvalidated(profileId),
    onAgentConnected: async (agent) => trackTerminalForAgent(agent, terminals),
    onOutbound: async (request) => handleOutboundRequest(
      request,
      registry,
      terminals,
      profileStore,
      slackRuntime,
      env,
      wsGateway,
      outputChannel,
      recentlyDeliveredSlackTs,
      logger,
      slackIconsBaseUrl,
    ),
  });

  slackRuntime = createSlackBoltRuntime({
    env,
    logger,
    onFault: (source, error) => reportFault(source, error, false),
    onAppMention: async (event) => handleHumanAppMention(
      event,
      registry,
      terminals,
      wsGateway,
      slackRuntime,
      env,
      outputChannel,
      operatorControlState,
      operatorSettingsStore,
      profileStore,
    ),
    onChannelMessage: async (event) => handleInboundAgentMessage(
      event,
      registry,
      terminals,
      wsGateway,
      outputChannel,
      recentlyDeliveredSlackTs,
      logger,
    ),
    onHumanChannelMessage: async (event) => handleHumanChannelMessage(
      event,
      env,
      operatorControlState,
      registry,
      terminals,
      wsGateway,
      outputChannel,
      recentlyDeliveredSlackTs,
      logger,
    ),
    onSlashCommand: async (event) => handleHumanSlashCommand(
      event,
      registry,
      terminals,
      wsGateway,
      env,
      outputChannel,
      operatorControlState,
      operatorSettingsStore,
      profileStore,
    ),
  });

  try {
    await httpGateway.start();
    wsGateway.start();
    await slackRuntime.start();
    outputChannel.appendLine(`[agent-comms] hub ready on 127.0.0.1:${env.EXTENSION_PORT}`);
  } catch (error) {
    reportFault('runtime.start', error, true);
    throw error;
  }

  return new AgentCommsRuntimeImpl(
    context,
    workspaceRoot,
    outputChannel,
    ownOutputChannel,
    env,
    registry,
    terminals,
    slackRuntime,
    httpGateway,
    wsGateway,
  );
}
