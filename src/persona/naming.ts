import { z } from 'zod';

export const agentKindSchema = z.enum(['claude', 'codex']);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const personaKindByAgentKind: Record<AgentKind, 'alfred' | 'codex'> = {
  claude: 'alfred',
  codex: 'codex',
};

export const personaPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const personaSchema = z.string().regex(personaPattern);

function normalizePersonaToken(input: string): string {
  return input.trim().replace(/^@+/, '').toLowerCase();
}

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
  const trimmed = normalizePersonaToken(name);
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

export function buildProjectScopedPersona(project: string, suffix: string): string {
  return `${sanitizeProjectName(project)}-${validateCustomPersona(suffix)}`;
}

export function buildUnregisteredPersona(kind: AgentKind, seed?: string): string {
  const suffix = (seed ?? Math.random().toString(36).slice(2, 12)).replace(/[^a-z0-9]+/g, '').slice(0, 10) || 'pending';
  return `unregistered-${personaKindByAgentKind[kind]}-${suffix}`;
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

export function extractPersonaSuffix(persona: string, project: string): string {
  const normalizedProject = sanitizeProjectName(project);
  const prefix = `${normalizedProject}-`;
  if (persona.startsWith(prefix)) {
    return persona.slice(prefix.length);
  }

  return persona;
}

export function resolveRecipientAlias(recipient: string, livePersonas: string[]): string | null {
  const normalizedRecipient = normalizePersonaToken(recipient);
  if (livePersonas.includes(normalizedRecipient)) {
    return normalizedRecipient;
  }

  const match = /^(?<kind>alfred|claude|codex)-?(?<instance>\d+)$/.exec(normalizedRecipient);
  if (!match?.groups) {
    const suffixMatches = livePersonas.filter((persona) => persona.endsWith(`-${normalizedRecipient}`));
    return suffixMatches.length === 1 ? suffixMatches[0] : null;
  }

  const targetKind: AgentKind = match.groups.kind === 'codex' ? 'codex' : 'claude';
  const targetInstance = Number(match.groups.instance);
  const matches = livePersonas.filter((persona) => {
    const parsed = parseAutomaticPersona(persona);
    if (parsed?.kind === targetKind && parsed.instanceNumber === targetInstance) {
      return true;
    }

    const compactMatch = /-(?<kind>alfred|codex)-?(?<instance>\d+)$/.exec(persona);
    if (!compactMatch?.groups) {
      return false;
    }

    const liveKind: AgentKind = compactMatch.groups.kind === 'codex' ? 'codex' : 'claude';
    return liveKind === targetKind && Number(compactMatch.groups.instance) === targetInstance;
  });

  return matches.length === 1 ? matches[0] : null;
}
