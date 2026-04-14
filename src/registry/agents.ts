import type { Logger } from 'pino';
import { PersonaAllocator, type PersonaAllocation } from './allocator';
import type { AgentKind } from '../persona/naming';
import { resolveProjectName } from '../persona/project';

export interface AgentSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export interface ReservationRecord extends PersonaAllocation {
  createdAt: number;
  expiresAt: number;
  briefFilePath: string;
  parentPersona?: string | null;
  taskId: string;
}

export interface AgentRecord extends PersonaAllocation {
  cwd: string;
  pid: number;
  connectedAt: number;
  lastHeartbeatAt: number;
  socket: AgentSocketLike;
  status: 'active' | 'idle';
  taskId?: string;
  parentPersona?: string | null;
  briefFilePath?: string;
  disconnectDeadlineAt?: number;
}

export interface ReserveAgentParams {
  cwd: string;
  kind: AgentKind;
  briefFilePath: string;
  taskId: string;
  customName?: string | null;
  parentPersona?: string | null;
  projectOverride?: string | null;
}

export interface AttachAgentParams {
  cwd: string;
  kind: AgentKind;
  pid: number;
  socket: AgentSocketLike;
  persona?: string | null;
  projectOverride?: string | null;
}

export interface AgentRegistryOptions {
  allocator?: PersonaAllocator;
  reservationTtlMs?: number;
  disconnectGraceMs?: number;
  logger?: Logger;
}

export class AgentRegistry {
  private readonly allocator: PersonaAllocator;
  private readonly reservationTtlMs: number;
  private readonly disconnectGraceMs: number;
  private readonly logger?: Logger;
  private readonly reservations = new Map<string, ReservationRecord>();
  private readonly agents = new Map<string, AgentRecord>();

  constructor(options: AgentRegistryOptions = {}) {
    this.allocator = options.allocator ?? new PersonaAllocator();
    this.reservationTtlMs = options.reservationTtlMs ?? 60_000;
    this.disconnectGraceMs = options.disconnectGraceMs ?? 30_000;
    this.logger = options.logger;
  }

  reserve(params: ReserveAgentParams, now = Date.now()): ReservationRecord {
    const project = resolveProjectName({ cwd: params.cwd, override: params.projectOverride });
    const allocation = this.allocator.reserve(project, params.kind, params.customName);
    const reservation: ReservationRecord = {
      ...allocation,
      createdAt: now,
      expiresAt: now + this.reservationTtlMs,
      briefFilePath: params.briefFilePath,
      parentPersona: params.parentPersona,
      taskId: params.taskId,
    };

    this.reservations.set(reservation.persona, reservation);
    return reservation;
  }

  attach(params: AttachAgentParams, now = Date.now()): AgentRecord {
    this.releaseExpired(now);

    const claimedPersona = params.persona?.trim();
    if (claimedPersona) {
      const existing = this.agents.get(claimedPersona);
      if (existing && existing.disconnectDeadlineAt && existing.disconnectDeadlineAt > now) {
        const resumed: AgentRecord = {
          ...existing,
          socket: params.socket,
          pid: params.pid,
          cwd: params.cwd,
          lastHeartbeatAt: now,
          disconnectDeadlineAt: undefined,
        };

        this.agents.set(resumed.persona, resumed);
        return resumed;
      }

      const reservation = this.reservations.get(claimedPersona);
      if (!reservation) {
        throw new Error(`Missing reservation for persona "${claimedPersona}"`);
      }

      this.reservations.delete(claimedPersona);
      const agent: AgentRecord = {
        ...reservation,
        cwd: params.cwd,
        pid: params.pid,
        socket: params.socket,
        connectedAt: now,
        lastHeartbeatAt: now,
        status: 'active',
        taskId: reservation.taskId,
      };

      this.agents.set(agent.persona, agent);
      return agent;
    }

    const project = resolveProjectName({ cwd: params.cwd, override: params.projectOverride });
    const allocation = this.allocator.reserve(project, params.kind);
    const agent: AgentRecord = {
      ...allocation,
      cwd: params.cwd,
      pid: params.pid,
      socket: params.socket,
      connectedAt: now,
      lastHeartbeatAt: now,
      status: 'active',
    };

    this.agents.set(agent.persona, agent);
    return agent;
  }

  get(persona: string): AgentRecord | undefined {
    return this.agents.get(persona);
  }

  getReservation(persona: string): ReservationRecord | undefined {
    return this.reservations.get(persona);
  }

  list(): AgentRecord[] {
    return [...this.agents.values()].filter((agent) => !agent.disconnectDeadlineAt);
  }

  listReservations(): ReservationRecord[] {
    return [...this.reservations.values()];
  }

  findIdleAgent(project: string, kind: AgentKind): AgentRecord | undefined {
    return [...this.agents.values()].find(
      (agent) =>
        agent.project === project &&
        agent.kind === kind &&
        agent.status === 'idle' &&
        !agent.disconnectDeadlineAt,
    );
  }

  recordHeartbeat(persona: string, now = Date.now()): AgentRecord {
    const agent = this.requireAgent(persona);
    agent.lastHeartbeatAt = now;
    agent.disconnectDeadlineAt = undefined;
    return agent;
  }

  markStandby(persona: string, taskId: string, now = Date.now()): AgentRecord {
    const agent = this.requireAgent(persona);
    agent.status = 'idle';
    agent.taskId = taskId;
    agent.lastHeartbeatAt = now;
    return agent;
  }

  markResume(persona: string, taskId?: string, now = Date.now()): AgentRecord {
    const agent = this.requireAgent(persona);
    agent.status = 'active';
    if (taskId) {
      agent.taskId = taskId;
    }
    agent.lastHeartbeatAt = now;
    return agent;
  }

  markSocketClosed(persona: string, now = Date.now()): AgentRecord | undefined {
    const agent = this.agents.get(persona);
    if (!agent) {
      return undefined;
    }

    agent.disconnectDeadlineAt = now + this.disconnectGraceMs;
    return agent;
  }

  findStaleAgents(timeoutMs: number, now = Date.now()): AgentRecord[] {
    return [...this.agents.values()].filter(
      (agent) => !agent.disconnectDeadlineAt && now - agent.lastHeartbeatAt > timeoutMs,
    );
  }

  releaseExpired(now = Date.now()): void {
    for (const [persona, reservation] of this.reservations.entries()) {
      if (reservation.expiresAt <= now) {
        this.logger?.warn({ persona }, 'reservation expired');
        this.reservations.delete(persona);
        this.allocator.release(reservation);
      }
    }

    for (const [persona, agent] of this.agents.entries()) {
      if (agent.disconnectDeadlineAt && agent.disconnectDeadlineAt <= now) {
        this.logger?.warn({ persona }, 'disconnect grace elapsed');
        this.agents.delete(persona);
        this.allocator.release(agent);
      }
    }
  }

  dropImmediately(persona: string): void {
    const agent = this.agents.get(persona);
    if (!agent) {
      return;
    }

    this.agents.delete(persona);
    this.allocator.release(agent);
  }

  private requireAgent(persona: string): AgentRecord {
    const agent = this.agents.get(persona);
    if (!agent) {
      throw new Error(`Unknown persona "${persona}"`);
    }

    return agent;
  }
}
