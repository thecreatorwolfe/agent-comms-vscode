import * as vscode from 'vscode';
import type { AgentKind } from './persona/naming';

const SAVED_AGENT_PROFILES_KEY = 'agentComms.savedProfiles';
const INVALIDATED_AGENT_PROFILE_IDS_KEY = 'agentComms.invalidatedProfileIds';

export interface SavedAgentProfile {
  profileId: string;
  persona: string;
  kind: AgentKind;
  cwd: string;
  lastTaskId?: string | null;
  lastSeenAt: string;
}

function isSavedAgentProfile(value: unknown): value is SavedAgentProfile {
  return typeof value === 'object'
    && value !== null
    && 'profileId' in value
    && typeof value.profileId === 'string'
    && 'persona' in value
    && typeof value.persona === 'string'
    && 'kind' in value
    && (value.kind === 'claude' || value.kind === 'codex')
    && 'cwd' in value
    && typeof value.cwd === 'string'
    && 'lastSeenAt' in value
    && typeof value.lastSeenAt === 'string';
}

export class AgentProfileStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): SavedAgentProfile[] {
    const raw = this.state.get<unknown[]>(SAVED_AGENT_PROFILES_KEY, []);
    return raw.filter(isSavedAgentProfile);
  }

  private async write(profiles: SavedAgentProfile[]): Promise<void> {
    const next = [...profiles];
    next.sort((left, right) => left.persona.localeCompare(right.persona));
    await this.state.update(SAVED_AGENT_PROFILES_KEY, next);
  }

  get(profileId: string): SavedAgentProfile | undefined {
    return this.list().find((profile) => profile.profileId === profileId);
  }

  async save(profile: SavedAgentProfile): Promise<void> {
    const next = this.list().filter((entry) => entry.profileId !== profile.profileId);
    next.push(profile);
    await this.write(next);
    await this.clearInvalidatedProfileIds([profile.profileId]);
  }

  async noteAgent(agent: {
    profileId?: string;
    persona: string;
    kind: AgentKind;
    cwd: string;
    taskId?: string | null;
  }): Promise<void> {
    if (!agent.profileId) {
      return;
    }

    await this.save({
      profileId: agent.profileId,
      persona: agent.persona,
      kind: agent.kind,
      cwd: agent.cwd,
      lastTaskId: agent.taskId ?? null,
      lastSeenAt: new Date().toISOString(),
    });
  }

  async clear(): Promise<number> {
    const count = this.list().length;
    await this.write([]);
    return count;
  }

  async deletePersona(persona: string): Promise<number> {
    const current = this.list();
    const next = current.filter((entry) => entry.persona !== persona);
    const removed = current.length - next.length;
    if (removed > 0) {
      await this.write(next);
    }
    return removed;
  }

  listInvalidatedProfileIds(): string[] {
    const raw = this.state.get<unknown[]>(INVALIDATED_AGENT_PROFILE_IDS_KEY, []);
    return raw.filter((value): value is string => typeof value === 'string');
  }

  isProfileInvalidated(profileId: string): boolean {
    return this.listInvalidatedProfileIds().includes(profileId);
  }

  async invalidateProfileIds(profileIds: string[]): Promise<number> {
    const unique = [...new Set(profileIds.filter((value) => typeof value === 'string' && value.length > 0))];
    if (unique.length === 0) {
      return 0;
    }

    const current = new Set(this.listInvalidatedProfileIds());
    for (const profileId of unique) {
      current.add(profileId);
    }
    await this.state.update(INVALIDATED_AGENT_PROFILE_IDS_KEY, [...current].sort());
    return unique.length;
  }

  async clearInvalidatedProfileIds(profileIds: string[]): Promise<void> {
    if (profileIds.length === 0) {
      return;
    }

    const cleared = new Set(profileIds);
    const next = this.listInvalidatedProfileIds().filter((profileId) => !cleared.has(profileId));
    await this.state.update(INVALIDATED_AGENT_PROFILE_IDS_KEY, next);
  }
}
