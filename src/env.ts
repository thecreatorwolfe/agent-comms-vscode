import fs from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import { ZodError, z } from 'zod';
import { DEFAULT_AGENT_COMMS_ENV_TEMPLATE, resolvePathTemplate } from './global';

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export const agentCommsEnvSchema = z.object({
  SLACK_APP_TOKEN: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_CHANNEL_ID: z.string().regex(/^C[A-Z0-9]+$/),
  SLACK_OPERATOR_USER_ID: z.string().regex(/^[UW][A-Z0-9]+$/),
  ROUTER_SHARED_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
  EXTENSION_PORT: z.coerce.number().int().min(1).max(65535).default(47592),
  LOG_LEVEL: logLevelSchema.default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
});

export type AgentCommsEnv = z.infer<typeof agentCommsEnvSchema>;
export type AgentCommsLogLevel = z.infer<typeof logLevelSchema>;

export interface LoadAgentCommsEnvOptions {
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
  workspaceRoot?: string;
  extensionPath?: string;
  userHome?: string;
}

export function resolveEnvFilePath(
  template: string | undefined,
  options: Pick<LoadAgentCommsEnvOptions, 'workspaceRoot' | 'extensionPath' | 'userHome'> = {},
): string | undefined {
  return resolvePathTemplate(template ?? DEFAULT_AGENT_COMMS_ENV_TEMPLATE, options);
}

export function loadAgentCommsEnv(options: LoadAgentCommsEnvOptions = {}): AgentCommsEnv {
  const inputEnv = options.env ?? process.env;
  const resolvedEnvFilePath = resolveEnvFilePath(options.envFilePath, {
    workspaceRoot: options.workspaceRoot,
    extensionPath: options.extensionPath,
    userHome: options.userHome,
  });

  let fileValues: Record<string, string> = {};
  if (resolvedEnvFilePath && fs.existsSync(resolvedEnvFilePath)) {
    fileValues = parseDotenv(fs.readFileSync(resolvedEnvFilePath, 'utf8'));
  }

  try {
    return agentCommsEnvSchema.parse({
      ...fileValues,
      ...inputEnv,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const fields = [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'unknown')))];
      const sourceLabel = resolvedEnvFilePath ?? 'process environment';
      throw new Error(
        `Agent Comms env is missing or invalid in ${sourceLabel}. Fix: ${fields.join(', ')}`,
      );
    }

    throw error;
  }
}
