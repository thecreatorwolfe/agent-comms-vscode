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
import { MAX_BODY_LENGTH } from '../schema/slack_message';
import { resolveBridgeEnv } from './runtime-env';
import { AgentCommsWsClient } from './ws-client';
import { refineSpawnEffort, refineSpawnModel, SPAWN_MODEL_PARAM_DESCRIPTION , SPAWN_EFFORT_PARAM_DESCRIPTION } from '../spawn-model';

function buildChannelContent(frame: { from_persona: string; task_id?: string; body_raw: string }): string {
  const priorityPrefix = frame.from_persona === 'NICK' ? '[PRIORITY:HIGH]\n' : '';
  const taskPrefix = frame.task_id ? `[TASK:${frame.task_id}] ` : '';
  return `${priorityPrefix}${taskPrefix}${frame.from_persona}\n\n${frame.body_raw}`;
}

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
    logFilePrefix: 'claude-bridge',
  });

  const { port, secret, claimedPersona, profileId } = bridgeEnv;

  const server = new McpServer(
    { name: 'agent-comms-claude-channel', version: '0.0.1' },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
        },
        logging: {},
        tools: {},
      },
      instructions:
        'Messages arrive as <channel ...>. Treat them as coordination input. Connected sessions default to active waiting/listening. Use agent_comms_resume({ taskId: "..." }) only when you are actively working and want pings to interrupt the session. Use agent_comms_standby({ taskId: "..." }) only when you intentionally want reusable idle/standby behavior. Preferred minimal send: agent_comms_reply({ recipients: ["jarvis-1"], body: "Need review." }). Omit subject, taskId, and threadTs unless they materially help. If agent_comms_status reports Registration required: yes, call agent_comms_rename({ customName: "your-persona" }) first or include customName/projectName/personaSuffix/instanceNumber in that same structured reply call so the hub renames you before the first visible Slack post. Messages relayed from NICK are high priority and should be checked promptly.',
    },
  );

  const client = new AgentCommsWsClient({
    kind: 'claude',
    port,
    secret,
    cwd: cwd(),
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
      }, 'received claude agent-comms event');
      const results = await Promise.allSettled([
        server.server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: buildChannelContent(frame),
            meta: {
              from_persona: frame.from_persona,
              to_persona: frame.to_persona,
              task_id: frame.task_id ?? '',
              thread_ts: frame.thread_ts,
              slack_ts: frame.slack_ts,
            },
          },
        }),
        server.server.sendLoggingMessage({
          level: 'info',
          logger: 'agent-comms',
          data: buildEventLogMessage(frame),
        }),
      ]);
      const [notificationResult, loggingResult] = results;
      logger.info({
        deliveryId: frame.delivery_id,
        notification: notificationResult?.status ?? 'unknown',
        logging: loggingResult?.status ?? 'unknown',
      }, 'claude agent-comms event surfaced to client');
      try {
        client.sendEventAck({
          delivery_id: frame.delivery_id,
          surface_status: notificationResult?.status === 'fulfilled' ? 'ok' : 'failed',
          surface_mechanism: 'claude_channel',
          logging_status: loggingResult?.status === 'fulfilled' ? 'ok' : 'failed',
        });
      } catch (error) {
        logger.warn({ err: error, deliveryId: frame.delivery_id }, 'failed to send claude event ack to hub');
      }
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn({ err: result.reason }, 'failed to surface claude agent-comms event');
        }
      }
    },
  });

  server.registerTool(
    'agent_comms_spawn',
    {
      description: "Request that the local Agent Comms hub spawn a new Claude or Codex peer in VS Code. This is local-only and does not go through Slack. Parent spawns must assign the child persona up front with customName or with personaSuffix/instanceNumber (optionally plus projectName). The terminal opens under that persona immediately. Pass `model` to choose the spawned session's model (claude alias/id, or a codex model name) and `effort` to set its reasoning effort.",
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
        effort: z.string().min(1).optional().describe(SPAWN_EFFORT_PARAM_DESCRIPTION),
      }).refine(
        (value) => (
          value.customName !== undefined
          || value.personaSuffix !== undefined
          || value.instanceNumber !== undefined
        ),
        'Parent spawns must provide customName, personaSuffix, or instanceNumber so the child terminal is named deterministically.',
      ).superRefine((value, ctx) => refineSpawnModel(value, ctx)),
    },
    async ({ kind, briefFilePath, taskId, customName, projectName, personaSuffix, instanceNumber, reuseIdle, model, effort }) => {
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
          effort: effort ?? null,
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
      description: 'Send a Slack message through the local Agent Comms hub. Preferred usage: agent_comms_reply({ recipients: ["alfred-2"], body: "Need review." }). The tool auto-builds the protocol header and can rename your persona inline before sending. recipients may name any persona (live locally, on a peer hub, or NICK) — unknown names are posted to the shared channel, not rejected. @-mentions inside body are literal text unless they match a live persona. body is capped at 4000 characters. Put text in body; the raw `message` field is an advanced escape hatch for a full pre-built protocol string only.',
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

      if (typeof body === 'string' && body.length > MAX_BODY_LENGTH) {
        throw new Error(
          `Message body is ${body.length} characters; the limit is ${MAX_BODY_LENGTH}. `
          + 'Shorten it, or split it across multiple agent_comms_reply calls '
          + '(e.g. prefix each with "(1/2) …" and "(2/2) …").',
        );
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

      const warningSuffix = posted.warning ? `\nWarning: ${posted.warning}` : '';
      return {
        content: [
          {
            type: 'text',
            text: `Sent outbound Slack message to the Agent Comms hub at ${posted.slackTs}.${warningSuffix}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'agent_comms_status',
    {
      description: 'Read the live Agent Comms registry entry for this Claude session so you can confirm whether you are idle, active-working, or active-waiting, whether inbound pings are pending, and whether this session still needs persona registration before its first Slack post.',
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
      description: 'Mark this Claude agent idle and reusable while still reachable for future Slack messages.',
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
      description: 'Mark this Claude agent active again. Connected sessions already default to active waiting/listening. Pass `taskId` only when you are actively working on a task and want pings to interrupt the session. Omit `taskId` when you want to stay active-waiting at the prompt without prompt injection.',
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
  console.error('[agent-comms-claude-channel] fatal', error);
  process.exit(1);
});
