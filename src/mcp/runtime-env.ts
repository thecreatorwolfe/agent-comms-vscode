import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { AgentCommsLogLevel } from '../env';

/**
 * Deterministic RFC-4122 v5-style UUID derived from the session working
 * directory. Used as a stable profile id when no explicit
 * AGENT_COMMS_PROFILE_ID is provided (i.e. a manually-launched agent, not a
 * hub spawn). Because it is stable across bridge AND hub restarts, the hub can
 * persist and auto-reclaim the persona keyed by session dir. Spawned agents
 * always receive an explicit AGENT_COMMS_PROFILE_ID and never hit this path,
 * so there is no collision with spawn-managed ids. (B8)
 */
export function deriveStableProfileId(cwd: string): string {
  const hex = crypto.createHash('sha1').update(`agent-comms-profile:${cwd}`).digest('hex').slice(0, 32).split('');
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
