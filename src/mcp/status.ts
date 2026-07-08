export interface AgentCommsLiveStatus {
  persona: string;
  kind: 'claude' | 'codex';
  status: 'active' | 'idle';
  activity: 'working' | 'waiting';
  taskId?: string | null;
  registrationRequired: boolean;
  pendingMessageCount: number;
  pendingUrgentMessageCount: number;
  lastInboundFrom?: string | null;
  lastInboundAt?: string | null;
  lastInboundTaskId?: string | null;
  lastInboundThreadTs?: string | null;
  connectedAt: string;
}

export interface AgentCommsConnectionSnapshot {
  state: 'connecting' | 'connected' | 'reconnecting' | 'stopped';
  persona?: string;
  authenticated: boolean;
  personaSource?: 'saved' | 'claimed' | 'generated';
  registrationRequired?: boolean;
  lastError?: string;
}

interface RegistryResponse {
  agents?: Array<{
    persona: string;
    kind: 'claude' | 'codex';
    status: 'active' | 'idle';
    activity?: 'working' | 'waiting' | null;
    task_id?: string | null;
    registration_required?: boolean | null;
    pending_message_count?: number | null;
    pending_urgent_message_count?: number | null;
    last_inbound_from?: string | null;
    last_inbound_at?: string | null;
    last_inbound_task_id?: string | null;
    last_inbound_thread_ts?: string | null;
    connected_at: string;
  }>;
}

export async function fetchSelfAgentStatus(options: {
  port: number;
  secret: string;
  persona: string;
}): Promise<AgentCommsLiveStatus> {
  const response = await fetch(`http://127.0.0.1:${options.port}/registry`, {
    headers: {
      'X-Router-Secret': options.secret,
    },
  });

  const payload = await response.json() as RegistryResponse & { error?: string };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Registry request failed with HTTP ${response.status}`,
    );
  }

  const agent = (payload.agents ?? []).find((entry) => entry.persona === options.persona);
  if (!agent) {
    throw new Error(`Live registry did not contain persona ${options.persona}`);
  }

  return {
    persona: agent.persona,
    kind: agent.kind,
    status: agent.status,
    activity: agent.activity ?? 'waiting',
    taskId: agent.task_id ?? null,
    registrationRequired: agent.registration_required ?? false,
    pendingMessageCount: agent.pending_message_count ?? 0,
    pendingUrgentMessageCount: agent.pending_urgent_message_count ?? 0,
    lastInboundFrom: agent.last_inbound_from ?? null,
    lastInboundAt: agent.last_inbound_at ?? null,
    lastInboundTaskId: agent.last_inbound_task_id ?? null,
    lastInboundThreadTs: agent.last_inbound_thread_ts ?? null,
    connectedAt: agent.connected_at,
  };
}

export function formatAgentStatus(status: AgentCommsLiveStatus): string {
  return [
    `Persona: ${status.persona}`,
    `Kind: ${status.kind}`,
    `Status: ${status.status}`,
    `Activity: ${status.status === 'idle' ? 'idle' : status.activity}`,
    `Task: ${status.taskId ?? 'unknown'}`,
    `Registration required: ${status.registrationRequired ? 'yes' : 'no'}`,
    `Pending pings: ${status.pendingMessageCount}`,
    `Urgent pings: ${status.pendingUrgentMessageCount}`,
    `Last inbound from: ${status.lastInboundFrom ?? 'none'}`,
    `Last inbound at: ${status.lastInboundAt ?? 'none'}`,
    `Last inbound task: ${status.lastInboundTaskId ?? 'none'}`,
    `Connected: ${status.connectedAt}`,
  ].join('\n');
}

export function formatAgentConnectionSnapshot(snapshot: AgentCommsConnectionSnapshot): string {
  return [
    `Connection: ${snapshot.state}`,
    `Persona: ${snapshot.persona ?? 'unknown'}`,
    `Authenticated: ${snapshot.authenticated ? 'yes' : 'no'}`,
    `Persona source: ${snapshot.personaSource ?? 'unknown'}`,
    `Registration required: ${snapshot.registrationRequired == null ? 'unknown' : snapshot.registrationRequired ? 'yes' : 'no'}`,
    `Last error: ${snapshot.lastError ?? 'none'}`,
  ].join('\n');
}
