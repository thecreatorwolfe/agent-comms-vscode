import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { AgentCommsLogLevel } from '../env';

/**
 * The agent process a bridge belongs to, identified by pid and start time.
 *
 * Start time matters because pids are reused. Together they stay constant for
 * the life of one session, including across bridge and hub restarts, which is
 * what profile persistence needs.
 */
export interface SessionAnchor {
  pid: number;
  startedAt: string;
}

const AGENT_COMMAND_NAMES = new Set(['codex', 'claude']);
const ANCHOR_PS_TIMEOUT_MS = 4_000;
const ANCHOR_MAX_HOPS = 8;

/**
 * Finds the `codex` or `claude` process that owns this bridge.
 *
 * Never asks `ps` for the tty column: on some machines that listing takes
 * minutes to return, which would stall every bridge at startup.
 */
export async function resolveSessionAnchor(
  startPid: number = process.pid,
  runPs: (args: string[]) => Promise<string> = defaultRunPs,
): Promise<SessionAnchor | null> {
  let table = '';
  try {
    table = await runPs(['-Ao', 'pid=,ppid=,comm=']);
  } catch {
    return null;
  }

  const parents = new Map<number, number>();
  const commands = new Map<number, string>();
  for (const rawLine of table.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    if (Number.isInteger(parentPid) && parentPid > 0) {
      parents.set(pid, parentPid);
    }

    commands.set(pid, match[3].trim().split('/').pop() ?? '');
  }

  const seen = new Set<number>();
  let current = startPid;
  for (let hop = 0; hop < ANCHOR_MAX_HOPS && Number.isInteger(current) && current > 1 && !seen.has(current); hop += 1) {
    seen.add(current);
    const command = commands.get(current);
    if (command && AGENT_COMMAND_NAMES.has(command)) {
      let startedAt = '';
      try {
        startedAt = (await runPs(['-p', String(current), '-o', 'lstart='])).trim();
      } catch {
        startedAt = '';
      }

      return { pid: current, startedAt };
    }

    const parent = parents.get(current);
    if (!parent || parent === current) {
      break;
    }

    current = parent;
  }

  return null;
}

function defaultRunPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: ANCHOR_PS_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout ?? '');
    });
  });
}

function hashToUuid(input: string): string {
  const hex = crypto.createHash('sha1').update(input).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20, 32),
  ].join('-');
}

/**
 * Profile id for a manually-launched session.
 *
 * Keyed on the owning agent process as well as the directory, because several
 * agents routinely run in one repository. Keying on the directory alone gave
 * them all the same id, so they fought over a single saved persona and the
 * losers were left unreachable after a hub restart.
 */
export function deriveSessionProfileId(cwd: string, anchor: SessionAnchor | null): string {
  if (!anchor) {
    return deriveStableProfileId(cwd);
  }

  return hashToUuid(`agent-comms-profile:${cwd}:${anchor.pid}:${anchor.startedAt}`);
}

/**
 * Directory-only profile id. Kept as the last resort for a session whose owning
 * process cannot be identified, and as the shape the hub has always persisted.
 * It is NOT unique when several agents share a directory, which is why
 * `deriveSessionProfileId` is preferred.
 */
export function deriveStableProfileId(cwd: string): string {
  return hashToUuid(`agent-comms-profile:${cwd}`);
}

export interface AgentCommsBridgeEnv {
  port: number;
  secret: string;
  claimedPersona?: string;
  profileId?: string;
  pid?: number;
  logLevel?: AgentCommsLogLevel;
}

function readGlobalEnvFile(): Record<string, string> {
  const filePath = path.join(os.homedir(), '.agent-comms', '.env');
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return parseDotenv(fs.readFileSync(filePath, 'utf8'));
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

function coerceLogLevel(value: string | undefined): AgentCommsLogLevel | undefined {
  if (!value) {
    return undefined;
  }

  switch (value) {
    case 'fatal':
    case 'error':
    case 'warn':
    case 'info':
    case 'debug':
    case 'trace':
    case 'silent':
      return value;
    default:
      return undefined;
  }
}

export function resolveBridgeEnv(
  env: NodeJS.ProcessEnv = process.env,
  fileEnvOverride?: Record<string, string>,
): AgentCommsBridgeEnv {
  const fileEnv = fileEnvOverride ?? readGlobalEnvFile();
  const portValue = firstDefined(env.AGENT_COMMS_PORT, env.EXTENSION_PORT, fileEnv.EXTENSION_PORT);
  const secret = firstDefined(env.ROUTER_SHARED_SECRET, fileEnv.ROUTER_SHARED_SECRET);
  const claimedPersona = firstDefined(env.AGENT_COMMS_PERSONA);
  // Prefer an explicit id (set for hub-spawned agents). Otherwise derive a
  // stable id from the working directory so a manual session keeps the same
  // persona across restarts. (B8)
  const profileId = firstDefined(env.AGENT_COMMS_PROFILE_ID)
    ?? deriveStableProfileId(process.cwd());
  const pidValue = firstDefined(env.AGENT_COMMS_TERMINAL_PID);
  const logLevel = coerceLogLevel(firstDefined(
    env.LOG_LEVEL as AgentCommsLogLevel | undefined,
    fileEnv.LOG_LEVEL as AgentCommsLogLevel | undefined,
  ));

  if (!portValue) {
    throw new Error('Missing Agent Comms port. Set AGENT_COMMS_PORT or EXTENSION_PORT, or populate ~/.agent-comms/.env.');
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Agent Comms port: ${portValue}`);
  }

  if (!secret) {
    throw new Error('Missing ROUTER_SHARED_SECRET. Populate ~/.agent-comms/.env or export it before launch.');
  }

  let pid: number | undefined;
  if (pidValue) {
    const parsedPid = Number(pidValue);
    if (Number.isInteger(parsedPid) && parsedPid > 0) {
      pid = parsedPid;
    }
  }

  return {
    port,
    secret,
    claimedPersona,
    profileId,
    pid,
    logLevel,
  };
}

/**
 * The profile id a bridge should present at auth.
 *
 * A hub spawn supplies its own unique id and always wins. A manual session
 * derives one from its owning agent process so that two sessions in one
 * directory no longer collide.
 */
export async function resolveBridgeProfileId(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string> {
  const explicit = firstDefined(env.AGENT_COMMS_PROFILE_ID);
  if (explicit) {
    return explicit;
  }

  return deriveSessionProfileId(cwd, await resolveSessionAnchor());
}
