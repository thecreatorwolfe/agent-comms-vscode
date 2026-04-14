import { z } from 'zod';

const recipientsSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

function normalizeRecipientToken(recipient: string): string {
  const normalized = recipient.trim().replace(/^@+/, '');
  const upper = normalized.toUpperCase();
  if (upper === 'ALL' || upper === 'NICK') {
    return upper;
  }

  return normalized.toLowerCase();
}

export const agentCommsReplyInputSchema = z.object({
  message: z.string().min(1).optional(),
  recipients: recipientsSchema.optional(),
  subject: z.string().min(1).max(100).optional(),
  body: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  threadTs: z.string().optional(),
}).superRefine((value, ctx) => {
  const hasRawMessage = typeof value.message === 'string' && value.message.length > 0;
  const hasStructuredPayload = value.recipients !== undefined && value.body !== undefined;

  if (!hasRawMessage && !hasStructuredPayload) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide either message, or recipients + body.',
      path: ['message'],
    });
  }
});

export type AgentCommsReplyInput = z.infer<typeof agentCommsReplyInputSchema>;
export const agentCommsReadSlackInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  threadTs: z.string().min(1).optional(),
});

export interface SlackHistoryEntry {
  ts: string;
  threadTs?: string | null;
  user?: string;
  botId?: string;
  text: string;
}

export function normalizeRecipients(raw: string | string[]): string[] {
  return (Array.isArray(raw) ? raw : raw.split(','))
    .map((recipient) => normalizeRecipientToken(recipient))
    .filter(Boolean);
}

export function buildProtocolSlackMessage(options: {
  from: string;
  recipients: string[];
  taskId?: string;
  subject?: string;
  body: string;
  utc?: string;
}): string {
  if (!options.taskId && !options.subject) {
    return `[${options.from}→${options.recipients.join(', ')}]\n\n${options.body}`;
  }

  const utc = options.utc ?? new Date().toISOString();
  return `[${options.from}→${options.recipients.join(', ')}] TASK:${options.taskId ?? 'agent-comms'} | UTC:${utc}\nSUBJECT: ${options.subject ?? 'Agent Comms message'}\n\n${options.body}`;
}

export function formatSlackHistoryTranscript(messages: SlackHistoryEntry[]): string {
  if (messages.length === 0) {
    return 'No Slack messages found for the requested scope.';
  }

  return messages
    .map((message) => {
      const author = message.user ?? message.botId ?? 'unknown';
      const threadSuffix = message.threadTs && message.threadTs !== message.ts ? ` thread:${message.threadTs}` : '';
      return `[${message.ts}] ${author}${threadSuffix}\n${message.text}`;
    })
    .join('\n\n');
}
