import { randomUUID } from 'node:crypto';
import { cwd } from 'node:process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AgentCommsLogLevel } from '../env';
import { createLogger } from '../log';
import { agentCommsReplyInputSchema, buildProtocolSlackMessage, normalizeRecipients } from './reply';
import { resolveBridgeEnv } from './runtime-env';
import { AgentCommsWsClient } from './ws-client';

function buildElicitationMessage(frame: {
  from_persona: string;
  to_persona: string;
  task_id?: string;
  thread_ts: string;
  body_raw: string;
}): string {
  const task = frame.task_id ? `Task: ${frame.task_id}\n` : '';
  return `Slack message from ${frame.from_persona} to ${frame.to_persona}\n${task}Thread: ${frame.thread_ts}\n\n${frame.body_raw}`;
}

async function main(): Promise<void> {
  const bridgeEnv = resolveBridgeEnv();
  const logger = createLogger({
    level: bridgeEnv.logLevel ?? (process.env.LOG_LEVEL as AgentCommsLogLevel | undefined) ?? 'info',
    destination: 'stderr',
  });

  const { port, secret, claimedPersona } = bridgeEnv;

  const server = new McpServer(
    { name: 'agent-comms-codex', version: '0.0.1' },
    {
      capabilities: {},
      instructions:
        'Agent Comms delivers Slack coordination messages into this Codex session. Reply with the provided tools when you need to send a protocol-formatted Slack message or mark the session standby.',
    },
  );

  const client = new AgentCommsWsClient({
    kind: 'codex',
    port,
    secret,
    cwd: cwd(),
    persona: claimedPersona,
    logger,
    onEvent: async (frame) => {
      await server.server.elicitInput({
        mode: 'form',
        message: buildElicitationMessage(frame),
        requestedSchema: {
          type: 'object',
          properties: {
            acknowledged: {
              type: 'boolean',
              title: 'Acknowledged',
              description: 'Acknowledge the message so Codex can continue processing it in-session.',
              default: true,
            },
          },
          required: ['acknowledged'],
        },
      });
    },
  });

  server.registerTool(
    'agent_comms_spawn',
    {
      description: 'Request that the local Agent Comms hub spawn a new Claude or Codex peer in VS Code. This is local-only and does not go through Slack.',
      inputSchema: z.object({
        kind: z.enum(['claude', 'codex']),
        briefFilePath: z.string().min(1),
        taskId: z.string().min(1),
        customName: z.string().min(1).optional(),
        reuseIdle: z.boolean().optional(),
      }),
    },
    async ({ kind, briefFilePath, taskId, customName, reuseIdle }) => {
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
          parent_persona: client.getCurrentPersona() ?? claimedPersona ?? null,
          task_id: taskId,
          reuse_idle: reuseIdle ?? null,
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
    'agent_comms_reply',
    {
      description: 'Send a protocol-formatted Slack reply through the local Agent Comms hub.',
      inputSchema: agentCommsReplyInputSchema,
    },
    async ({ message, recipients, subject, body, taskId, threadTs }) => {
      const persona = await client.waitForAuth();
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
    'agent_comms_standby',
    {
      description: 'Mark this Codex agent idle but still reachable for future Slack messages.',
      inputSchema: z.object({
        taskId: z.string().min(1),
      }),
    },
    async ({ taskId }) => {
      await client.waitForAuth();
      client.sendStandby(taskId);
      return {
        content: [{ type: 'text', text: `Marked agent standby for task ${taskId}.` }],
      };
    },
  );

  server.registerTool(
    'agent_comms_resume',
    {
      description: 'Mark this Codex agent active again.',
      inputSchema: z.object({
        taskId: z.string().optional(),
      }),
    },
    async ({ taskId }) => {
      await client.waitForAuth();
      client.sendResume(taskId);
      return {
        content: [{ type: 'text', text: `Marked agent active${taskId ? ` for ${taskId}` : ''}.` }],
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
