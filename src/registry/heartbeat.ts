import type { Logger } from 'pino';
import { AgentRegistry, type AgentRecord } from './agents';

export interface HeartbeatMonitorOptions {
  registry: AgentRegistry;
  logger?: Logger;
  intervalMs?: number;
  timeoutMs?: number;
  onStaleAgent?: (agent: AgentRecord) => void;
}

export class HeartbeatMonitor {
  private readonly registry: AgentRegistry;
  private readonly logger?: Logger;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly onStaleAgent?: (agent: AgentRecord) => void;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: HeartbeatMonitorOptions) {
    this.registry = options.registry;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs ?? 25_000;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onStaleAgent = options.onStaleAgent;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(now = Date.now()): void {
    for (const agent of this.registry.findStaleAgents(this.timeoutMs, now)) {
      this.logger?.warn({ persona: agent.persona }, 'heartbeat timeout');
      this.onStaleAgent?.(agent);
      this.registry.markSocketClosed(agent.persona, now);
    }

    this.registry.releaseExpired(now);
  }
}
