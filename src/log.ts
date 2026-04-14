import pino, { type Logger, type LoggerOptions } from 'pino';
import type { AgentCommsLogLevel } from './env';

export interface CreateLoggerOptions {
  level?: AgentCommsLogLevel;
  pretty?: boolean;
  name?: string;
  destination?: 'stdout' | 'stderr';
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { level = 'info', pretty = false, name = 'agent-comms', destination = 'stdout' } = options;

  const loggerOptions: LoggerOptions = {
    name,
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  const stream = pino.destination(destination === 'stderr' ? 2 : 1);

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
