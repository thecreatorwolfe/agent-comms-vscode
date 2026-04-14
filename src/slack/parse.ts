import { parseAgentSlackMessage, type ParsedSlackMessage } from '../schema/slack_message';

export interface StopControlParseResult {
  command: 'stop';
}

export interface StopKillControlParseResult {
  command: 'stop_kill';
}

export interface IgnoreControlParseResult {
  command: 'ignore';
  normalized: string;
}

export type HumanControlParseResult =
  | StopControlParseResult
  | StopKillControlParseResult
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
