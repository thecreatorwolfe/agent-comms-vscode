import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { AgentCommsLogLevel } from './env';

export interface CreateLoggerOptions {
  level?: AgentCommsLogLevel;
  pretty?: boolean;
  name?: string;
  destination?: 'stdout' | 'stderr';
  logFilePrefix?: string;
  logDir?: string;
}

export function resolveAgentCommsLogDir(logDir?: string): string {
  const resolved = logDir ?? path.join(os.homedir(), '.agent-comms', 'logs');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function sanitizeLogFilePrefix(prefix: string): string {
  return prefix.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'agent-comms';
}

function pruneAgentCommsLogFiles(logDir: string, keep = 40): void {
  const entries = fs.readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
    .map((entry) => {
      const filePath = path.join(logDir, entry.name);
      return {
        filePath,
        modifiedAt: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  for (const entry of entries.slice(keep)) {
    try {
      fs.unlinkSync(entry.filePath);
    } catch {
      // Ignore retention cleanup failures; logging should still proceed.
    }
  }
}

export function createAgentCommsLogFilePath(prefix: string, logDir?: string, now = new Date()): string {
  const resolvedDir = resolveAgentCommsLogDir(logDir);
  pruneAgentCommsLogFiles(resolvedDir);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(resolvedDir, `${sanitizeLogFilePrefix(prefix)}-${timestamp}-${process.pid}.log`);
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const {
    level = 'info',
    pretty = false,
    name = 'agent-comms',
    destination = 'stdout',
    logFilePrefix,
    logDir,
  } = options;

  const loggerOptions: LoggerOptions = {
    name,
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  const streams: Array<{ stream: DestinationStream }> = [
    { stream: pino.destination(destination === 'stderr' ? 2 : 1) as unknown as DestinationStream },
  ];
  if (logFilePrefix) {
    const logFilePath = createAgentCommsLogFilePath(logFilePrefix, logDir);
    streams.push({
      stream: fs.createWriteStream(logFilePath, { flags: 'a' }) as unknown as DestinationStream,
    });
  }
  const stream: DestinationStream = streams.length === 1 ? streams[0].stream : pino.multistream(streams);

  if (!pretty) {
    return pino(loggerOptions, stream);
  }

  try {
    const pretty = require('pino-pretty') as (options: {
      colorize: boolean;
      translateTime: string;
    }) => NodeJS.WritableStream;

    return pino(
      loggerOptions,
      pretty({
        colorize: false,
        translateTime: 'SYS:standard',
      }),
    );
  } catch {
    return pino(loggerOptions, stream);
  }
}
