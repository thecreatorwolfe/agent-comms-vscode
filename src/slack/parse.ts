import { parseAgentSlackMessage, type ParsedSlackMessage } from '../schema/slack_message';

export interface StopControlParseResult {
  command: 'stop';
}

export interface StopKillControlParseResult {
  command: 'stop_kill';
}

export interface ListenControlParseResult {
  command: 'listen';
}

export interface UnlistenControlParseResult {
  command: 'unlisten';
}

export interface ClearProfilesControlParseResult {
  command: 'clear_profiles';
}

export interface ClearProfilesConfirmControlParseResult {
  command: 'clear_profiles_confirm';
}

export interface ClearProfilesAllControlParseResult {
  command: 'clear_profiles_all';
}

export interface ClearProfilesAllConfirmControlParseResult {
  command: 'clear_profiles_all_confirm';
}

export interface SeeProfilesControlParseResult {
  command: 'see_profiles';
}

export interface ClearDisconnectedControlParseResult {
  command: 'clear_disconnected';
}

export interface ClearInvalidatedControlParseResult {
  command: 'clear_invalidated';
}

export interface ClearProfileControlParseResult {
  command: 'clear_profile';
  persona: string;
}

export interface IgnoreControlParseResult {
  command: 'ignore';
  normalized: string;
}

export type HumanControlParseResult =
  | StopControlParseResult
  | StopKillControlParseResult
  | ListenControlParseResult
  | UnlistenControlParseResult
  | ClearProfilesControlParseResult
  | ClearProfilesConfirmControlParseResult
  | ClearProfilesAllControlParseResult
  | ClearProfilesAllConfirmControlParseResult
  | SeeProfilesControlParseResult
  | ClearDisconnectedControlParseResult
  | ClearInvalidatedControlParseResult
  | ClearProfileControlParseResult
  | IgnoreControlParseResult;

export interface AgentHeaderInboundParseResult {
  route: 'agent_header';
  message: ParsedSlackMessage;
  raw: string;
}

export interface InvalidAgentInboundParseResult {
  route: 'invalid_protocol';
  raw: string;
  error: Error;
}

export interface UnroutedInboundParseResult {
  route: 'unrouted';
  raw: string;
}

export type AgentInboundParseResult =
  | AgentHeaderInboundParseResult
  | InvalidAgentInboundParseResult
  | UnroutedInboundParseResult;

export function stripSlackUserMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeHumanControl(text: string): string {
  return stripSlackUserMentions(text)
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .trim();
}

export function parseHumanSlackControl(text: string): HumanControlParseResult {
  const normalized = normalizeHumanControl(text);
  if (normalized === 'stop') {
    return { command: 'stop' };
  }

  if (normalized === 'stop kill') {
    return { command: 'stop_kill' };
  }

  if (normalized === 'listen') {
    return { command: 'listen' };
  }

  if (normalized === 'unlisten') {
    return { command: 'unlisten' };
  }

  if (normalized === 'clear profiles') {
    return { command: 'clear_profiles' };
  }

  if (normalized === 'clear profiles confirm') {
    return { command: 'clear_profiles_confirm' };
  }

  if (normalized === 'clear profiles all') {
    return { command: 'clear_profiles_all' };
  }

  if (normalized === 'clear profiles all confirm') {
    return { command: 'clear_profiles_all_confirm' };
  }

  if (normalized === 'see profiles' || normalized === 'list profiles') {
    return { command: 'see_profiles' };
  }

  if (normalized === 'clear disconnected') {
    return { command: 'clear_disconnected' };
  }

  if (normalized === 'clear invalidated') {
    return { command: 'clear_invalidated' };
  }

  const clearProfileMatch = /^clear profiles? (?<persona>[a-z0-9][a-z0-9-]{1,63})$/.exec(normalized);
  if (clearProfileMatch?.groups?.persona) {
    return {
      command: 'clear_profile',
      persona: clearProfileMatch.groups.persona,
    };
  }

  return {
    command: 'ignore',
    normalized,
  };
}

export function parseAgentSlackEventText(text: string): AgentInboundParseResult {
  const stripped = stripSlackUserMentions(text);
  if (!stripped || !stripped.startsWith('[')) {
    return {
      route: 'unrouted',
      raw: stripped,
    };
  }

  try {
    return {
      route: 'agent_header',
      message: parseAgentSlackMessage(stripped),
      raw: stripped,
    };
  } catch (error) {
    return {
      route: 'invalid_protocol',
      raw: stripped,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
