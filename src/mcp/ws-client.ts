import { WebSocket } from 'ws';
import type { Logger } from 'pino';
import {
  extensionToPluginFrameSchema,
  type AuthAckFrame,
  type EventAckFrame,
  type EventFrame,
  type OutboundFrame,
} from '../schema/frames';
import type { AgentKind } from '../persona/naming';

export interface AgentCommsWsClientOptions {
  kind: AgentKind;
  port: number;
  secret: string;
  cwd: string;
  pid?: number;
  persona?: string;
  profileId?: string;
  logger?: Logger;
  onAuth?: (frame: AuthAckFrame) => Promise<void> | void;
  onEvent?: (frame: EventFrame) => Promise<void> | void;
}

export interface AgentCommsWsConnectionSnapshot {
  state: 'connecting' | 'connected' | 'reconnecting' | 'stopped';
  persona?: string;
  authenticated: boolean;
  personaSource?: AuthAckFrame['persona_source'];
  registrationRequired?: boolean;
  lastError?: string;
}

function stringifyErrorDetails(details: unknown): string | undefined {
  if (details == null) {
    return undefined;
  }
  if (typeof details === 'string') {
    return details.trim() || undefined;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

/**
 * Build a self-describing outbound error message for the agent (the tool user).
 * Names the offending reason, includes the hub's detail payload, and appends a
 * concrete remedy so the agent can fix and retry without guessing. (B5)
 */
export function formatOutboundErrorMessage(
  reason: 'schema_invalid' | 'unknown_recipient' | 'slack_api_error',
  details: unknown,
): string {
  const detailText = stringifyErrorDetails(details);
  const remedy = reason === 'schema_invalid'
    ? 'Fix: send with recipients + body (not raw message). Keep the body under 4000 characters and omit protocol headers — the tool builds them.'
    : reason === 'unknown_recipient'
      ? 'Fix: name a live persona in recipients (see agent_comms_status), or send to NICK. Unknown names are not failed anymore; if you still see this, the persona token itself was malformed.'
      : 'Fix: this is a Slack API error, not a validation problem — retry shortly; if it persists, check the hub Agent Comms output channel.';
  return [
    `Agent Comms outbound error [${reason}]`,
    detailText ? `: ${detailText}` : '',
    ` — ${remedy}`,
  ].join('');
}

export class AgentCommsWsClient {
  private readonly options: AgentCommsWsClientOptions;
  private ws: WebSocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly pendingOutbound = new Map<
    string,
    {
      resolve: (result: { slackTs: string; threadTs: string; warning?: string }) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private pendingStandby:
    | {
      taskId: string;
      resolve: (result: { persona: string; taskId: string; status: 'idle'; activity: 'waiting' }) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
    | undefined;
  private pendingResume:
    | {
      resolve: (result: { persona: string; taskId?: string; status: 'active'; activity: 'working' | 'waiting' }) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
    | undefined;
  private stopped = false;
  private authenticated = false;
  private persona: string | undefined;
  private lastConnectionError: string | undefined;
  private connectionState: AgentCommsWsConnectionSnapshot['state'] = 'connecting';
  private personaSource: AuthAckFrame['persona_source'] | undefined;
  private registrationRequired = false;
  private hasAuthenticatedOnce = false;
  private disconnectNoticeShown = false;

  constructor(options: AgentCommsWsClientOptions) {
    this.options = options;
    this.persona = options.persona;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(reason = 'client_shutdown'): Promise<void> {
    this.stopped = true;
    this.connectionState = 'stopped';
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN && this.persona) {
      this.sendJson({
        type: 'close',
        persona: this.persona,
        reason,
      });
    }

    this.ws?.close(1000, reason);
  }

  getCurrentPersona(): string | undefined {
    return this.persona;
  }

  setCurrentPersona(
    persona: string,
    options?: {
      personaSource?: AuthAckFrame['persona_source'];
      registrationRequired?: boolean;
    },
  ): void {
    this.persona = persona;
    if (options?.personaSource) {
      this.personaSource = options.personaSource;
    }
    if (typeof options?.registrationRequired === 'boolean') {
      this.registrationRequired = options.registrationRequired;
    }
  }

  getConnectionSnapshot(): AgentCommsWsConnectionSnapshot {
    return {
      state: this.connectionState,
      persona: this.persona,
      authenticated: this.authenticated,
      personaSource: this.personaSource,
      registrationRequired: this.registrationRequired,
      lastError: this.lastConnectionError,
    };
  }

  sendOutbound(frame: Omit<OutboundFrame, 'type' | 'persona'>): void {
    if (!this.persona) {
      throw new Error('Cannot send outbound frame before auth.ack');
    }

    this.sendJson({
      type: 'outbound',
      persona: this.persona,
      ...frame,
    });
  }

  async sendOutboundAndWait(
    frame: Omit<OutboundFrame, 'type' | 'persona'>,
    timeoutMs = 15_000,
  ): Promise<{ slackTs: string; threadTs: string; warning?: string }> {
    if (!this.persona) {
      throw new Error('Cannot send outbound frame before auth.ack');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingOutbound.delete(frame.client_msg_id);
        reject(new Error(`Timed out waiting ${timeoutMs}ms for outbound ack`));
      }, timeoutMs);
      timeout.unref?.();

      this.pendingOutbound.set(frame.client_msg_id, {
        resolve,
        reject,
        timeout,
      });

      try {
        this.sendOutbound(frame);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingOutbound.delete(frame.client_msg_id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  sendStandby(taskId: string): void {
    if (!this.persona) {
      throw new Error('Cannot send standby before auth.ack');
    }

    this.sendJson({
      type: 'standby',
      persona: this.persona,
      task_id: taskId,
    });
  }

  async sendStandbyAndWait(
    taskId: string,
    timeoutMs = 5_000,
  ): Promise<{ persona: string; taskId: string; status: 'idle'; activity: 'waiting' }> {
    if (!this.persona) {
      throw new Error('Cannot send standby before auth.ack');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingStandby = undefined;
        reject(new Error(`Timed out waiting ${timeoutMs}ms for standby ack`));
      }, timeoutMs);
      timeout.unref?.();

      this.pendingStandby = {
        taskId,
        resolve,
        reject,
        timeout,
      };

      try {
        this.sendStandby(taskId);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingStandby = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  sendResume(taskId?: string): void {
    if (!this.persona) {
      throw new Error('Cannot send resume before auth.ack');
    }

    this.sendJson({
      type: 'resume',
      persona: this.persona,
      task_id: taskId,
    });
  }

  sendEventAck(frame: Omit<EventAckFrame, 'type' | 'persona'>): void {
    if (!this.persona) {
      throw new Error('Cannot send event.ack before auth.ack');
    }

    this.sendJson({
      type: 'event.ack',
      persona: this.persona,
      ...frame,
    });
  }

  async sendResumeAndWait(
    taskId?: string,
    timeoutMs = 5_000,
  ): Promise<{ persona: string; taskId?: string; status: 'active'; activity: 'working' | 'waiting' }> {
    if (!this.persona) {
      throw new Error('Cannot send resume before auth.ack');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResume = undefined;
        reject(new Error(`Timed out waiting ${timeoutMs}ms for resume ack`));
      }, timeoutMs);
      timeout.unref?.();

      this.pendingResume = {
        resolve,
        reject,
        timeout,
      };

      try {
        this.sendResume(taskId);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingResume = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async waitForAuth(timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.authenticated && this.persona) {
        return this.persona;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(this.lastConnectionError ?? `Timed out waiting ${timeoutMs}ms for Agent Comms WebSocket auth`);
  }

  private connect(): void {
    this.lastConnectionError = undefined;
    this.connectionState = this.hasAuthenticatedOnce ? 'reconnecting' : 'connecting';
    this.ws = new WebSocket(`ws://127.0.0.1:${this.options.port}/ws`);

    this.ws.on('open', () => {
      this.sendJson({
        type: 'auth',
        secret: this.options.secret,
        agent_kind: this.options.kind,
        persona: this.persona ?? '',
        profile_id: this.options.profileId ?? null,
        pid: this.options.pid ?? process.pid,
        cwd: this.options.cwd,
      });
    });

    this.ws.on('message', (raw) => {
      void this.handleIncoming(raw.toString()).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.lastConnectionError = message;
        this.options.logger?.error({ err: error }, 'agent-comms ws message handler failed');
      });
    });

    this.ws.on('close', () => {
      this.authenticated = false;
      this.stopHeartbeat();
      this.rejectPendingOutbound(new Error('Agent Comms WebSocket closed before outbound response'));
      this.rejectPendingStateTransitions(new Error('Agent Comms WebSocket closed before standby/resume response'));
      if (!this.stopped && !this.lastConnectionError) {
        this.lastConnectionError = 'Agent Comms WebSocket closed before auth.ack';
      }
      if (!this.stopped) {
        this.connectionState = 'reconnecting';
        if (this.hasAuthenticatedOnce && !this.disconnectNoticeShown) {
          this.disconnectNoticeShown = true;
          this.options.logger?.info(`Hub connection lost. Reconnecting to 127.0.0.1:${this.options.port}.`);
        }
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error) => {
      this.lastConnectionError = error.message;
      this.connectionState = this.stopped ? 'stopped' : 'reconnecting';
      this.options.logger?.error({ err: error }, 'agent-comms ws client error');
    });
  }

  private async handleIncoming(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.options.logger?.warn({ err: error, raw }, 'invalid ws payload');
      return;
    }

    const validation = extensionToPluginFrameSchema.safeParse(parsed);
    if (!validation.success) {
      this.options.logger?.warn({ raw, error: validation.error.message }, 'invalid extension frame');
      return;
    }

    const frame = validation.data;
    switch (frame.type) {
      case 'auth.ack':
        this.authenticated = true;
        this.connectionState = 'connected';
        this.persona = frame.persona;
        this.personaSource = frame.persona_source;
        this.registrationRequired = frame.registration_required;
        this.lastConnectionError = undefined;
        this.startHeartbeat();
        if (this.hasAuthenticatedOnce || this.disconnectNoticeShown) {
          this.options.logger?.info(`Hub connected as ${frame.persona}.`);
        }
        this.hasAuthenticatedOnce = true;
        this.disconnectNoticeShown = false;
        await this.options.onAuth?.(frame);
        return;
      case 'event':
        await this.options.onEvent?.(frame);
        return;
      case 'heartbeat.ack':
        return;
      case 'outbound.ack': {
        const pending = this.pendingOutbound.get(frame.client_msg_id);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingOutbound.delete(frame.client_msg_id);
        pending.resolve({
          slackTs: frame.slack_ts,
          threadTs: frame.thread_ts,
          warning: frame.warning,
        });
        return;
      }
      case 'auth.error':
        this.lastConnectionError = `Agent Comms auth failed: ${frame.reason}`;
        this.connectionState = 'reconnecting';
        this.options.logger?.warn({ frame }, 'extension returned an auth error frame');
        this.options.logger?.warn(`Hub auth failed: ${frame.reason}. Reconnecting.`);
        return;
      case 'profile.reset':
        this.persona = frame.persona;
        this.personaSource = 'generated';
        this.registrationRequired = frame.registration_required;
        this.lastConnectionError = undefined;
        this.options.logger?.info(`Profile reset as ${frame.persona}. Re-register before the next Slack send.`);
        return;
      case 'outbound.error': {
        const message = formatOutboundErrorMessage(frame.reason, frame.details);
        this.lastConnectionError = message;
        const pending = frame.client_msg_id ? this.pendingOutbound.get(frame.client_msg_id) : undefined;
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingOutbound.delete(frame.client_msg_id as string);
          pending.reject(new Error(message));
        }
        this.options.logger?.warn({ frame }, 'extension returned an outbound error frame');
        return;
      }
      case 'standby.ack': {
        if (!this.pendingStandby) {
          return;
        }

        clearTimeout(this.pendingStandby.timeout);
        const pending = this.pendingStandby;
        this.pendingStandby = undefined;
        pending.resolve({
          persona: frame.persona,
          taskId: frame.task_id,
          status: frame.status,
          activity: frame.activity,
        });
        return;
      }
      case 'resume.ack': {
        if (!this.pendingResume) {
          return;
        }

        clearTimeout(this.pendingResume.timeout);
        const pending = this.pendingResume;
        this.pendingResume = undefined;
        pending.resolve({
          persona: frame.persona,
          taskId: frame.task_id,
          status: frame.status,
          activity: frame.activity,
        });
        return;
      }
      case 'error':
        this.lastConnectionError = `Agent Comms extension error: ${frame.reason}`;
        this.options.logger?.warn({ frame }, 'extension returned an error frame');
        if (frame.reason === 'persona_mismatch' && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.close(4009, 'persona_mismatch');
        }
        return;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.persona) {
        return;
      }

      this.sendJson({
        type: 'heartbeat',
        persona: this.persona,
        ts: new Date().toISOString(),
      });
    }, 25_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) {
        this.connect();
      }
    }, 2_000);
    this.reconnectTimer.unref?.();
  }

  private rejectPendingOutbound(error: Error): void {
    for (const [clientMsgId, pending] of this.pendingOutbound.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingOutbound.delete(clientMsgId);
    }
  }

  private rejectPendingStateTransitions(error: Error): void {
    if (this.pendingStandby) {
      clearTimeout(this.pendingStandby.timeout);
      this.pendingStandby.reject(error);
      this.pendingStandby = undefined;
    }

    if (this.pendingResume) {
      clearTimeout(this.pendingResume.timeout);
      this.pendingResume.reject(error);
      this.pendingResume = undefined;
    }
  }

  private sendJson(payload: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    this.ws.send(JSON.stringify(payload));
  }
}
