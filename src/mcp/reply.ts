import { z } from 'zod';

const recipientsSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const slackThreadTsInputSchema = z.union([z.string().min(1), z.number().finite()]).transform((value) => String(value));
const optionalReplyPersonaOverrideSchema = z.object({
  customName: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  personaSuffix: z.string().min(1).optional(),
  instanceNumber: z.number().int().min(1).optional(),
});

function normalizeRecipientToken(recipient: string): string {
  const normalized = recipient.trim().replace(/^@+/, '');
  const upper = normalized.toUpperCase();
  if (upper === 'ALL' || upper === 'NICK') {
    return upper;
  }

  return normalized.toLowerCase();
}

export const agentCommsReplyInputSchema = z.object({
  message: z.string().min(1).optional().describe(
    'Advanced escape hatch: a COMPLETE raw protocol string that already includes the [from→recipients] header. This is NOT a plain-text field — plain text without a header is rejected. Almost always leave this out and use recipients + body instead; the tool builds the header for you.',
  ),
  recipients: recipientsSchema.optional().describe(
    'Preferred structured send target(s). Minimal preferred usage: { recipients: ["alfred-2"], body: "Need review." }. Use a persona like alfred-2 or NICK. The tool stamps your current persona automatically.',
  ),
  subject: z.string().min(1).max(100).optional().describe(
    'Optional subject line for the verbose protocol header. Omit it unless it materially helps.',
  ),
  body: z.string().min(1).optional().describe(
    'Preferred structured message body (max 4000 characters). Keep it as short as possible and actionable. Omit protocol headers; the tool builds them. @-mentions in the body are literal text unless they match a live persona.',
  ),
  taskId: z.string().min(1).optional().describe(
    'Optional task id. Leave it out unless it materially helps routing or later thread lookup.',
  ),
  threadTs: slackThreadTsInputSchema.optional().describe(
    'Optional Slack thread timestamp to reply in-thread. Accepts either a string or numeric-looking timestamp. Leave it out for a new top-level post.',
  ),
  customName: optionalReplyPersonaOverrideSchema.shape.customName.describe(
    'Optional full persona override to apply before sending this structured message. Use this on a fresh unregistered session before the first Slack post.',
  ),
  projectName: optionalReplyPersonaOverrideSchema.shape.projectName.describe(
    'Optional project segment override to apply before sending this structured message.',
  ),
  personaSuffix: optionalReplyPersonaOverrideSchema.shape.personaSuffix.describe(
    'Optional suffix override to apply before sending this structured message.',
  ),
  instanceNumber: optionalReplyPersonaOverrideSchema.shape.instanceNumber.describe(
    'Optional automatic instance number to apply before sending this structured message.',
  ),
}).superRefine((value, ctx) => {
  const hasRawMessage = typeof value.message === 'string' && value.message.length > 0;
  const hasStructuredPayload = value.recipients !== undefined && value.body !== undefined;
  const hasPersonaOverride = Boolean(
    value.customName !== undefined
      || value.projectName !== undefined
      || value.personaSuffix !== undefined
      || value.instanceNumber !== undefined,
  );

  if (!hasRawMessage && !hasStructuredPayload) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide recipients + body (e.g. { recipients: ["alfred-2"], body: "Need review." }). The optional raw `message` field is only for a complete pre-built protocol string with its own [from→to] header.',
      path: ['recipients'],
    });
  }

  if (hasRawMessage && hasPersonaOverride) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'If you want to rename inline, use recipients + body so Agent Comms can stamp the updated persona automatically.',
      path: ['message'],
    });
  }
});

export type AgentCommsReplyInput = z.infer<typeof agentCommsReplyInputSchema>;
export const agentCommsReadSlackInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  threadTs: slackThreadTsInputSchema.optional(),
});

export interface SlackHistoryEntry {
  ts: string;
  threadTs?: string | null;
  user?: string;
  botId?: string;
  text: string;
}

export interface AgentCommsPersonaOverride {
  customName?: string;
  projectName?: string;
  personaSuffix?: string;
  instanceNumber?: number;
}

export function buildRegistrationRequiredMessage(persona?: string): string {
  return [
    `This session is connected under the temporary persona ${persona ?? 'unknown'}.`,
    'Before the first Slack send, pick a real persona with `agent_comms_rename({ customName: "your-persona" })`',
    'or send a structured reply with inline rename fields such as',
    '`agent_comms_reply({ recipients: ["alfred-2"], body: "Need review.", customName: "your-persona" })`.',
    'Raw `message` mode is blocked until registration is complete.',
  ].join(' ');
}

export function normalizeRecipients(raw: string | string[]): string[] {
  let value: string | string[] = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          value = parsed.map((entry) => String(entry));
        }
      } catch {
        // Fall through to comma split below.
      }
    }
  }

  return (Array.isArray(value) ? value : value.split(','))
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

export function hasPersonaOverride(options: AgentCommsPersonaOverride): boolean {
  return Boolean(
    options.customName !== undefined
      || options.projectName !== undefined
      || options.personaSuffix !== undefined
      || options.instanceNumber !== undefined,
  );
}

export async function renamePersonaForReply(options: {
  port: number;
  secret: string;
  persona: string;
  override: AgentCommsPersonaOverride;
}): Promise<{ persona: string; previousPersona: string }> {
  const response = await fetch(`http://127.0.0.1:${options.port}/rename`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Router-Secret': options.secret,
    },
    body: JSON.stringify({
      persona: options.persona,
      custom_name: options.override.customName ?? null,
      project_name: options.override.projectName ?? null,
      persona_suffix: options.override.personaSuffix ?? null,
      instance_number: options.override.instanceNumber ?? null,
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

  return {
    persona: payload.persona,
    previousPersona: payload.previous_persona ?? options.persona,
  };
}
