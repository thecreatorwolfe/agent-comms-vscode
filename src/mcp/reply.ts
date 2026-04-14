import { z } from 'zod';

const recipientsSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const agentCommsReplyInputSchema = z.object({
  message: z.string().min(1).optional(),
  recipients: recipientsSchema.optional(),
  subject: z.string().min(1).max(100).optional(),
  body: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  threadTs: z.string().optional(),
}).superRefine((value, ctx) => {
  const hasRawMessage = typeof value.message === 'string' && value.message.length > 0;
  const hasStructuredPayload = value.recipients !== undefined && value.subject !== undefined && value.body !== undefined;

  if (!hasRawMessage && !hasStructuredPayload) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide either message, or recipients + subject + body.',
      path: ['message'],
    });
  }
});

export type AgentCommsReplyInput = z.infer<typeof agentCommsReplyInputSchema>;

export function normalizeRecipients(raw: string | string[]): string[] {
  return (Array.isArray(raw) ? raw : raw.split(','))
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

export function buildProtocolSlackMessage(options: {
  from: string;
  recipients: string[];
  taskId: string;
  subject: string;
  body: string;
  utc?: string;
}): string {
  const utc = options.utc ?? new Date().toISOString();
  return `[${options.from}→${options.recipients.join(', ')}] TASK:${options.taskId} | UTC:${utc}\nSUBJECT: ${options.subject}\n\n${options.body}`;
}
