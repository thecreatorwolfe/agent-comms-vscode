import { randomUUID } from 'node:crypto';
import { cwd } from 'node:process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AgentCommsLogLevel } from '../env';
import { createLogger } from '../log';
import {
  agentCommsReadSlackInputSchema,
  agentCommsReplyInputSchema,
  buildRegistrationRequiredMessage,
  buildProtocolSlackMessage,
  formatSlackHistoryTranscript,
  hasPersonaOverride,
  normalizeRecipients,
  renamePersonaForReply,
} from './reply';
import { fetchSelfAgentStatus, formatAgentConnectionSnapshot, formatAgentStatus } from './status';
import { resolveBridgeEnv } from './runtime-env';
import { AgentCommsWsClient } from './ws-client';
import { refineSpawnModel, SPAWN_MODEL_PARAM_DESCRIPTION } from '../spawn-model';

function buildEventLogMessage(frame: {
  delivery_id: string;
  from_persona: string;
  to_persona: string;
  task_id?: string;
  body_raw: string;
}): string {
  const task = frame.task_id ? ` task=${frame.task_id}` : '';
  return `agent-comms delivery=${frame.delivery_id} ping from ${frame.from_persona} to ${frame.to_persona}${task}: ${frame.body_raw}`;
}

async function main(): Promise<void> {
  const bridgeEnv = resolveBridgeEnv();
  const logger = createLogger({
    level: bridgeEnv.logLevel ?? (process.env.LOG_LEVEL as AgentCommsLogLevel | undefined) ?? 'info',
    destination: 'stderr',
    logFilePrefix: 'codex-bridge',
  });

  const { port, secret, claimedPersona, profileId, pid } = bridgeEnv;

  const server = new McpServer(
    { name: 'agent-comms-codex', version: '0.0.1' },
    {
      capabilities: { logging: {} },
      instructions:
        'Agent Comms delivers Slack coordination messages into this Codex session. Connected sessions default to active waiting/listening. Use agent_comms_resume({ taskId: "..." }) only when you are actively working and want pings to interrupt the session. Use agent_comms_standby({ taskId: "..." }) only when you intentionally want reusable idle/standby behavior. Preferred minimal send: agent_comms_reply({ recipients: ["alfred-2"], body: "Need review." }). Omit subject, taskId, and threadTs unless they materially help. If agent_comms_status reports Registration required: yes, call agent_comms_rename({ customName: "your-persona" }) first or include customName/projectName/personaSuffix/instanceNumber in that same structured reply call so the hub renames you before the first visible Slack post. Messages relayed from NICK are high priority and should be checked promptly.',
    },
  );

  const client = new AgentCommsWsClient({
    kind: 'codex',
    port,
    secret,
    cwd: cwd(),
    pid,
    persona: claimedPersona,
    profileId,
    logger,
    onEvent: async (frame) => {
      logger.info({
        deliveryId: frame.delivery_id,
        fromPersona: frame.from_persona,
        toPersona: frame.to_persona,
        slackTs: frame.slack_ts,
        taskId: frame.task_id,
      }, 'received codex agent-comms event');
      const surfacedStartedAt = Date.now();
      const loggingResult = await server.server.sendLoggingMessage({
        level: 'info',
        logger: 'agent-comms',
        data: buildEventLogMessage(frame),
      }).then(
        () => ({ status: 'fulfilled' as const }),
        (reason) => ({ status: 'rejected' as const, reason }),
      );
      const surfacedElapsedMs = Date.now() - surfacedStartedAt;
      logger.info({
        deliveryId: frame.delivery_id,
        surfacedElapsedMs,
        logging: loggingResult.status,
      }, 'codex agent-comms event logged for terminal wake-up');
      try {
        client.sendEventAck({
          delivery_id: frame.delivery_id,
          surface_status: 'ok',
          surface_mechanism: 'codex_log_only',
          logging_status: loggingResult.status === 'fulfilled' ? 'ok' : 'failed',
          surface_elapsed_ms: surfacedElapsedMs,
        });
      } catch (error) {
        logger.warn({ err: error, deliveryId: frame.delivery_id }, 'failed to send codex event ack to hub');
      }
      if (loggingResult.status === 'rejected') {
        logger.warn({ err: loggingResult.reason }, 'failed to log codex agent-comms event');
      }
    },
  });

  server.registerTool(
    'agent_comms_spawn',
    {
      description: "Request that the local Agent Comms hub spawn a new Claude or Codex peer in VS Code. This is local-only and does not go through Slack. Parent spawns must assign the child persona up front with customName or with personaSuffix/instanceNumber (optionally plus projectName). The terminal opens under that persona immediately. Pass `model` to choose the spawned Claude session's model (kind='claude' only).",
      inputSchema: z.object({
        kind: z.enum(['claude', 'codex']),
        briefFilePath: z.string().min(1).describe('Absolute path to the child brief file to feed into the new terminal session.'),
        taskId: z.string().min(1).describe('Required task id for the spawned child session.'),
        customName: z.string().min(1).optional().describe('Preferred when you want an exact child persona. Example: pricing-pass-codex-2.'),
        projectName: z.string().min(1).optional().describe('Optional project segment override for the child persona.'),
        personaSuffix: z.string().min(1).optional().describe('Optional suffix for project-scoped naming. Example: alfred-2 or reviewer.'),
        instanceNumber: z.number().int().min(1).optional().describe('Optional automatic instance number when you want project-kind numbering.'),
        reuseIdle: z.boolean().optional().describe('Reuse an idle matching peer instead of spawning fresh only when that is intentional.'),
        model: z.string().min(1).optional().describe(SPAWN_MODEL_PARAM_DESCRIPTION),
      }).refine(
        (value) => (
          value.customName !== undefined
          || value.personaSuffix !== undefined
          || value.instanceNumber !== undefined
        ),
        'Parent spawns must provide customName, personaSuffix, or instanceNumber so the child terminal is named deterministically.',
      ).superRefine((value, ctx) => refineSpawnModel(value, ctx)),
    },
    async ({ kind, briefFilePath, taskId, customName, projectName, personaSuffix, instanceNumber, reuseIdle, model }) => {
      await client.waitForAuth();
      const response = await fetch(`http://127.0.0.1:${port}/spawn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Router-Secret': secret,
        },
        body: JSON.stringify({
          kind,
          brief_file_path: briefFilePath,
          custom_name: customName ?? null,
          project_name: projectName ?? null,
          persona_suffix: personaSuffix ?? null,
          instance_number: instanceNumber ?? null,
          parent_persona: client.getCurrentPersona() ?? claimedPersona ?? null,
          task_id: taskId,
          reuse_idle: reuseIdle ?? null,
          model: model ?? null,
        }),
      });

      const payload = await response.json() as {
        persona?: string;
        reused?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === 'string'
            ? payload.error
            : `Spawn request failed with HTTP ${response.status}`,
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Spawn request accepted for ${payload.persona}${payload.reused ? ' (reused idle agent)' : ''}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'agent_comms_rename',
    {
      description: 'Rename this live agent without restarting. Use this before the first Slack post when agent_comms_status shows Registration required: yes. You can change the full persona with customName, or rebuild it with projectName plus personaSuffix/instanceNumber.',
      inputSchema: z.object({
        customName: z.string().min(1).optional().describe('Exact full persona to claim. Example: checkout-flow-codex-3.'),
        projectName: z.string().min(1).optional().describe('Optional project segment override.'),
        personaSuffix: z.string().min(1).optional().describe('Optional persona suffix when using project-scoped naming.'),
        instanceNumber: z.number().int().min(1).optional().describe('Optional automatic instance number when using project-kind numbering.'),
      }).refine(
        (value) => (
          value.customName !== undefined
          || value.projectName !== undefined
          || value.personaSuffix !== undefined
          || value.instanceNumber !== undefined
        ),
        'Provide at least one rename field.',
      ),
    },
    async ({ customName, projectName, personaSuffix, instanceNumber }) => {
      const previousPersona = await client.waitForAuth();
      const response = await fetch(`http://127.0.0.1:${port}/rename`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Router-Secret': secret,
        },
        body: JSON.stringify({
          persona: previousPersona,
          custom_name: customName ?? null,
          project_name: projectName ?? null,
          persona_suffix: personaSuffix ?? null,
          instance_number: instanceNumber ?? null,
        }),
      });

      const payload = await response.json() as {
        persona?: string;
        previous_persona?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === 'string'
            ? payload.error
            : `Rename request failed with HTTP ${response.status}`,
        );
      }

      if (!payload.persona) {
        throw new Error('Rename request did not return a persona');
      }

      client.setCurrentPersona(payload.persona, {
        personaSource: 'claimed',
        registrationRequired: false,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Renamed ${payload.previous_persona ?? previousPersona} to ${payload.persona}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'agent_comms_read_slack',
    {
      description: 'Read recent messages from the configured Agent Comms Slack channel or a specific Slack thread.',
      inputSchema: agentCommsReadSlackInputSchema,
    },
    async ({ limit, threadTs }) => {
      await client.waitForAuth();
      const response = await fetch(`http://127.0.0.1:${port}/slack-history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Router-Secret': secret,
        },
        body: JSON.stringify({
          thread_ts: threadTs ?? null,
          limit: limit ?? 20,
        }),
      });

      const payload = await response.json() as {
        messages?: Array<{
          ts: string;
          thread_ts?: string | null;
          user?: string;
          bot_id?: string;
          text: string;
        }>;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === 'string'
            ? payload.error
            : `Slack history request failed with HTTP ${response.status}`,
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: formatSlackHistoryTranscript(
              (payload.messages ?? []).map((message) => ({
                ts: message.ts,
                threadTs: message.thread_ts ?? null,
                user: message.user,
                botId: message.bot_id,
                text: message.text,
              })),
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'agent_comms_reply',
    {
      description: 'Send a Slack message through the local Agent Comms hub. Preferred minimal usage: agent_comms_reply({ recipients: ["alfred-2"], body: "Need review." }). The tool auto-builds the protocol header and can rename your persona inline before sending.',
      inputSchema: agentCommsReplyInputSchema,
    },
    async ({ message, recipients, subject, body, taskId, threadTs, customName, projectName, personaSuffix, instanceNumber }) => {
      let persona = await client.waitForAuth();
      const connection = client.getConnectionSnapshot();
      const override = { customName, projectName, personaSuffix, instanceNumber };
      if (connection.registrationRequired && !hasPersonaOverride(override)) {
        throw new Error(buildRegistrationRequiredMessage(persona));
      }
      if (hasPersonaOverride(override)) {
        const renamed = await renamePersonaForReply({
          port,
          secret,
          persona,
          override,
        });
        client.setCurrentPersona(renamed.persona, {
          personaSource: 'claimed',
          registrationRequired: false,
        });
        persona = renamed.persona;
      }

      const outboundBody = message ?? buildProtocolSlackMessage({
        from: persona,
        recipients: normalizeRecipients(recipients ?? []),
        taskId: taskId ?? 'agent-comms-reply',
        subject: subject ?? 'Agent Comms reply',
        body: body ?? '',
      });
      const posted = await client.sendOutboundAndWait({
        thread_ts: threadTs ?? null,
        task_id: taskId ?? 'agent-comms-reply',
        body: outboundBody,
        client_msg_id: randomUUID(),
      });

      return {
        content: [
          {
            type: 'text',
            text: `Sent outbound Slack message to the Agent Comms hub at ${posted.slackTs}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'agent_comms_status',
    {
      description: 'Read the live Agent Comms registry entry for this Codex session so you can confirm whether you are idle, active-working, or active-waiting, whether inbound pings are pending, and whether this session still needs persona registration before its first Slack post.',
      inputSchema: z.object({}),
    },
    async () => {
      const connection = client.getConnectionSnapshot();
      if (!connection.authenticated || !connection.persona) {
        return {
          content: [{ type: 'text', text: formatAgentConnectionSnapshot(connection) }],
        };
      }

      try {
        const status = await fetchSelfAgentStatus({
          port,
          secret,
          persona: connection.persona,
        });

        return {
          content: [{
            type: 'text',
            text: `${formatAgentStatus(status)}\n${formatAgentConnectionSnapshot(connection)}`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `${formatAgentConnectionSnapshot(connection)}\nRegistry error: ${message}`,
          }],
        };
      }
    },
  );

  server.registerTool(
    'agent_comms_standby',
    {
      description: 'Mark this Codex agent idle and reusable while still reachable for future Slack messages.',
      inputSchema: z.object({
        taskId: z.string().min(1),
      }),
    },
    async ({ taskId }) => {
      await client.waitForAuth();
      const status = await client.sendStandbyAndWait(taskId);
      return {
        content: [{ type: 'text', text: `Marked ${status.persona} standby for task ${status.taskId}. Status: ${status.status}. Activity: ${status.activity}.` }],
      };
    },
  );

  server.registerTool(
    'agent_comms_resume',
    {
      description: 'Mark this Codex agent active again. Connected sessions already default to active waiting/listening. Pass `taskId` only when you are actively working on a task and want pings to interrupt the session. Omit `taskId` when you want to stay active-waiting at the prompt without prompt injection.',
      inputSchema: z.object({
        taskId: z.string().optional(),
      }),
    },
    async ({ taskId }) => {
      await client.waitForAuth();
      const status = await client.sendResumeAndWait(taskId);
      return {
        content: [{ type: 'text', text: `Marked ${status.persona} active${status.taskId ? ` for ${status.taskId}` : ''}. Status: ${status.status}. Activity: ${status.activity}.` }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await client.start();

  const shutdown = async () => {
    await client.stop();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

void main().catch((error) => {
  console.error('[agent-comms-codex] fatal', error);
  process.exit(1);
});
