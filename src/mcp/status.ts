export interface AgentCommsLiveStatus {
  persona: string;
  kind: 'claude' | 'codex';
  status: 'active' | 'idle';
  taskId?: string | null;
  connectedAt: string;
}

interface RegistryResponse {
  agents?: Array<{
    persona: string;
    kind: 'claude' | 'codex';
    status: 'active' | 'idle';
    task_id?: string | null;
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
    taskId: agent.task_id ?? null,
    connectedAt: agent.connected_at,
  };
}

export function formatAgentStatus(status: AgentCommsLiveStatus): string {
  return [
    `Persona: ${status.persona}`,
    `Kind: ${status.kind}`,
    `Status: ${status.status}`,
    `Task: ${status.taskId ?? 'unknown'}`,
    `Connected: ${status.connectedAt}`,
  ].join('\n');
}
