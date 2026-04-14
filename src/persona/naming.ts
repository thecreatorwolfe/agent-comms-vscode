import { z } from 'zod';

export const agentKindSchema = z.enum(['claude', 'codex']);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const personaKindByAgentKind: Record<AgentKind, 'alfred' | 'codex'> = {
  claude: 'alfred',
  codex: 'codex',
};

export const personaPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const personaSchema = z.string().regex(personaPattern);

export function sanitizeProjectName(input: string): string {
  const sanitized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!sanitized) {
    throw new Error(`Invalid project name: "${input}"`);
  }

  return sanitized;
}

export function validateCustomPersona(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!personaPattern.test(trimmed)) {
    throw new Error(`Invalid custom persona: "${name}"`);
  }

  return trimmed;
}

export function buildAutomaticPersona(project: string, kind: AgentKind, instanceNumber: number): string {
  const projectName = sanitizeProjectName(project);
  if (instanceNumber < 1 || !Number.isInteger(instanceNumber)) {
    throw new Error(`Instance number must be a positive integer. Received: ${instanceNumber}`);
  }

  return `${projectName}-${personaKindByAgentKind[kind]}-${instanceNumber}`;
}

export function parseAutomaticPersona(persona: string):
  | { project: string; kind: AgentKind; instanceNumber: number }
  | null {
  const match = /^(?<project>[a-z0-9][a-z0-9-]*)-(?<kind>alfred|codex)-(?<instance>\d+)$/.exec(persona);
  if (!match?.groups) {
    return null;
  }

  const kind = match.groups.kind === 'alfred' ? 'claude' : 'codex';
  return {
    project: match.groups.project,
    kind,
    instanceNumber: Number(match.groups.instance),
  };
}
