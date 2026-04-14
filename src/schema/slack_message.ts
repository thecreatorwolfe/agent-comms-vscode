import { z } from 'zod';
import { personaSchema } from '../persona/naming';

const routingTokenSchema = z.string().regex(/^(?:ALL|NICK|[a-z0-9][a-z0-9-]{0,63})$/);
const fromTokenSchema = z.union([personaSchema, z.literal('NICK')]);
const isoTimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Invalid ISO 8601 timestamp',
});

export const taskIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const slackAskSchema = z.object({
  recipient: routingTokenSchema,
  resolved: z.boolean(),
  text: z.string().min(1),
});

export const slackStatusSchema = z.object({
  written: z.boolean(),
  called: z.boolean(),
  deployed: z.boolean(),
  traced: z.boolean(),
});

export const parsedSlackMessageSchema = z.object({
  from: fromTokenSchema,
  recipients: z.array(routingTokenSchema).min(1),
  taskId: taskIdSchema.optional(),
  utc: isoTimestampSchema.optional(),
  subject: z.string().min(1).max(100).optional(),
  body: z.string().min(1).max(3500),
  asks: z.array(slackAskSchema),
  status: slackStatusSchema.optional(),
});

export type ParsedSlackMessage = z.infer<typeof parsedSlackMessageSchema>;
export type SlackAsk = z.infer<typeof slackAskSchema>;
export type SlackStatus = z.infer<typeof slackStatusSchema>;

const statusLinePattern =
  /^Written (?<written>[✓✗]) · Called (?<called>[✓✗]) · Deployed (?<deployed>[✓✗]) · Traced (?<traced>[✓✗])$/;

function parseRecipients(rawRecipients: string): string[] {
  return rawRecipients
    .split(',')
    .map((recipient) => {
      const normalized = recipient.trim().replace(/^@+/, '');
      const upper = normalized.toUpperCase();
      if (upper === 'ALL' || upper === 'NICK') {
        return upper;
      }

      return normalized.toLowerCase();
    })
    .filter(Boolean);
}

function extractInlineRecipients(text: string): string[] {
  const matches = text.matchAll(/(?:^|[\s(])@(?<recipient>(?:ALL|NICK|[a-z0-9][a-z0-9-]{1,63}))(?=$|[\s,.:;!?)])/gimu);
  const recipients = new Set<string>();
  for (const match of matches) {
    const raw = match.groups?.recipient;
    if (!raw) {
      continue;
    }

    const upper = raw.toUpperCase();
    recipients.add(upper === 'ALL' || upper === 'NICK' ? upper : raw.toLowerCase());
  }

  return [...recipients];
}

function parseAsksBlock(block: string): SlackAsk[] {
  if (!block.trim()) {
    return [];
  }

  return block.split('\n').map((line) => {
    const match = /^- \[(?<done>[ x])\] (?<recipient>[A-Z0-9a-z-]+): (?<text>.+)$/.exec(line.trim());
    if (!match?.groups) {
      throw new Error(`Invalid ask line: "${line}"`);
    }

    return slackAskSchema.parse({
      recipient: match.groups.recipient,
      resolved: match.groups.done.toLowerCase() === 'x',
      text: match.groups.text.trim(),
    });
  });
}

function parseStatusLine(line: string): SlackStatus {
  const match = statusLinePattern.exec(line.trim());
  if (!match?.groups) {
    throw new Error(`Invalid STATUS line: "${line}"`);
  }

  return {
    written: match.groups.written === '✓',
    called: match.groups.called === '✓',
    deployed: match.groups.deployed === '✓',
    traced: match.groups.traced === '✓',
  };
}

export function parseAgentSlackMessage(text: string): ParsedSlackMessage {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const newlineIndex = normalized.indexOf('\n');
  const headerLine = newlineIndex >= 0 ? normalized.slice(0, newlineIndex) : normalized;
  const headerRest = newlineIndex >= 0 ? normalized.slice(newlineIndex + 1) : '';
  const headerMatch = /^\[(?<from>[^→\]\n]+)→(?<recipients>[^\]\n]+)\](?: (?<metadata>[^\n]+))?$/u.exec(headerLine);

  if (!headerMatch?.groups) {
    throw new Error('Slack message does not match the protocol header');
  }

  let taskId: string | undefined;
  let utc: string | undefined;
  if (headerMatch.groups.metadata) {
    const metadataMatch = /^TASK:(?<taskId>[a-z0-9-]+) \| UTC:(?<utc>.+)$/u.exec(headerMatch.groups.metadata.trim());
    if (!metadataMatch?.groups) {
      throw new Error('Slack message has invalid protocol metadata');
    }

    taskId = metadataMatch.groups.taskId;
    utc = metadataMatch.groups.utc.trim();
  }

  let remainder = headerRest;
  let subject: string | undefined;
  if (remainder.startsWith('SUBJECT: ')) {
    const subjectNewline = remainder.indexOf('\n');
    if (subjectNewline < 0) {
      throw new Error('Slack message is missing a body after SUBJECT');
    }

    subject = remainder.slice('SUBJECT: '.length, subjectNewline).trim();
    remainder = remainder.slice(subjectNewline + 1);
  }

  if (remainder.startsWith('\n')) {
    remainder = remainder.slice(1);
  }

  let status: SlackStatus | undefined;

  const statusIndex = remainder.lastIndexOf('\n\nSTATUS: ');
  if (statusIndex >= 0) {
    const statusLine = remainder.slice(statusIndex + '\n\nSTATUS: '.length);
    status = parseStatusLine(statusLine);
    remainder = remainder.slice(0, statusIndex);
  }

  let body = remainder;
  let asks: SlackAsk[] = [];
  const asksIndex = remainder.indexOf('\n\nASKS:\n');
  if (asksIndex >= 0) {
    body = remainder.slice(0, asksIndex);
    asks = parseAsksBlock(remainder.slice(asksIndex + '\n\nASKS:\n'.length));
  }

  const normalizedRecipients = [...new Set([
    ...parseRecipients(headerMatch.groups.recipients),
    ...extractInlineRecipients(remainder),
  ])];

  return parsedSlackMessageSchema.parse({
    from: headerMatch.groups.from.trim(),
    recipients: normalizedRecipients,
    taskId,
    utc,
    subject,
    body: body.trimEnd(),
    asks,
    status,
  });
}
