import { z } from 'zod';
import { personaSchema } from '../persona/naming';

const routingTokenSchema = z.union([personaSchema, z.literal('ALL'), z.literal('NICK')]);
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
  taskId: taskIdSchema,
  utc: isoTimestampSchema,
  subject: z.string().min(1).max(100),
  body: z.string().max(3500),
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
    .map((recipient) => recipient.trim())
    .filter(Boolean);
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
  const headerMatch =
    /^\[(?<from>[^→\]\n]+)→(?<recipients>[^\]\n]+)\] TASK:(?<taskId>[a-z0-9-]+) \| UTC:(?<utc>[^\n]+)\nSUBJECT: (?<subject>[^\n]{1,100})\n\n(?<rest>[\s\S]*)$/u.exec(
      normalized,
    );

  if (!headerMatch?.groups) {
    throw new Error('Slack message does not match the protocol header');
  }

  let remainder = headerMatch.groups.rest;
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

  return parsedSlackMessageSchema.parse({
    from: headerMatch.groups.from.trim(),
    recipients: parseRecipients(headerMatch.groups.recipients),
    taskId: headerMatch.groups.taskId,
    utc: headerMatch.groups.utc.trim(),
    subject: headerMatch.groups.subject.trim(),
    body: body.trimEnd(),
    asks,
    status,
  });
}
