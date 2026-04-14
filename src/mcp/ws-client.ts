import { WebSocket } from 'ws';
import type { Logger } from 'pino';
import {
  extensionToPluginFrameSchema,
  type AuthAckFrame,
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
  logger?: Logger;
  onAuth?: (frame: AuthAckFrame) => Promise<void> | void;
  onEvent?: (frame: EventFrame) => Promise<void> | void;
}

export class AgentCommsWsClient {
  private readonly options: AgentCommsWsClientOptions;
  private ws: WebSocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly pendingOutbound = new Map<
    string,
    {
      resolve: (result: { slackTs: string; threadTs: string }) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private pendingStandby:
    | {
      taskId: string;
      resolve: (result: { persona: string; taskId: string; status: 'idle' }) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
    | undefined;
  private pendingResume:
    | {
      resolve: (result: { persona: string; taskId?: string; status: 'active' }) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
    | undefined;
  private stopped = false;
  private authenticated = false;
  private persona: string | undefined;
  private lastConnectionError: string | undefined;

  constructor(options: AgentCommsWsClientOptions) {
    this.options = options;
    this.persona = options.persona;
  }

  async start(): Promise<void> {
    this.connect();
  }

  async stop(reason = 'client_shutdown'): Promise<void> {
    this.stopped = true;
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

  setCurrentPersona(persona: string): void {
    this.persona = persona;
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
  ): Promise<{ slackTs: string; threadTs: string }> {
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
  ): Promise<{ persona: string; taskId: string; status: 'idle' }> {
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

  async sendResumeAndWait(
    taskId?: string,
    timeoutMs = 5_000,
  ): Promise<{ persona: string; taskId?: string; status: 'active' }> {
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
    this.ws = new WebSocket(`ws://127.0.0.1:${this.options.port}/ws`);

    this.ws.on('open', () => {
      this.sendJson({
        type: 'auth',
        secret: this.options.secret,
        agent_kind: this.options.kind,
        persona: this.persona ?? '',
        pid: this.options.pid ?? process.pid,
        cwd: this.options.cwd,
      });
    });

    this.ws.on('message', (raw) => {
      void this.handleIncoming(raw.toString());
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
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error) => {
      this.lastConnectionError = error.message;
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
        this.persona = frame.persona;
        this.lastConnectionError = undefined;
        this.startHeartbeat();
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
        });
        return;
      }
      case 'auth.error':
        this.lastConnectionError = `Agent Comms auth failed: ${frame.reason}`;
        this.options.logger?.warn({ frame }, 'extension returned an auth error frame');
        return;
      case 'outbound.error': {
        this.lastConnectionError = `Agent Comms outbound error: ${frame.reason}`;
        const pending = frame.client_msg_id ? this.pendingOutbound.get(frame.client_msg_id) : undefined;
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingOutbound.delete(frame.client_msg_id as string);
          pending.reject(new Error(`Agent Comms outbound error: ${frame.reason}`));
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
