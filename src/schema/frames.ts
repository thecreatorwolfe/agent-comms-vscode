import { z } from 'zod';
import { agentKindSchema, personaSchema } from '../persona/naming';
import { taskIdSchema } from './slack_message';

const isoTimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Invalid ISO 8601 timestamp',
});

export const authFrameSchema = z.object({
  type: z.literal('auth'),
  secret: z.string().min(1),
  agent_kind: agentKindSchema,
  persona: z.string().optional().nullable(),
  pid: z.number().int().positive(),
  cwd: z.string().min(1),
});

export const authAckFrameSchema = z.object({
  type: z.literal('auth.ack'),
  persona: personaSchema,
  icon_url: z.string().url(),
});

export const authErrorFrameSchema = z.object({
  type: z.literal('auth.error'),
  reason: z.enum(['invalid_secret', 'malformed', 'persona_conflict', 'reservation_missing']),
});

export const heartbeatFrameSchema = z.object({
  type: z.literal('heartbeat'),
  persona: personaSchema,
  ts: isoTimestampSchema,
});

export const heartbeatAckFrameSchema = z.object({
  type: z.literal('heartbeat.ack'),
  persona: personaSchema,
  ts: isoTimestampSchema,
});

export const outboundFrameSchema = z.object({
  type: z.literal('outbound'),
  persona: personaSchema,
  thread_ts: z.string().nullable(),
  task_id: taskIdSchema,
  body: z.string().min(1),
  client_msg_id: z.string().uuid(),
});

export const outboundAckFrameSchema = z.object({
  type: z.literal('outbound.ack'),
  persona: personaSchema,
  client_msg_id: z.string().uuid(),
  slack_ts: z.string(),
  thread_ts: z.string(),
});

export const outboundErrorFrameSchema = z.object({
  type: z.literal('outbound.error'),
  persona: personaSchema.optional(),
  client_msg_id: z.string().uuid().optional(),
  reason: z.enum(['schema_invalid', 'unknown_recipient', 'slack_api_error']),
  details: z.unknown().optional(),
});

export const standbyFrameSchema = z.object({
  type: z.literal('standby'),
  persona: personaSchema,
  task_id: taskIdSchema,
});

export const resumeFrameSchema = z.object({
  type: z.literal('resume'),
  persona: personaSchema,
  task_id: taskIdSchema.optional(),
});

export const closeFrameSchema = z.object({
  type: z.literal('close'),
  persona: personaSchema,
  reason: z.string().min(1),
});

export const eventFrameSchema = z.object({
  type: z.literal('event'),
  from_persona: z.string().min(1),
  to_persona: personaSchema,
  thread_ts: z.string(),
  task_id: taskIdSchema.optional(),
  body_raw: z.string().min(1),
  body_parsed: z.unknown(),
  slack_ts: z.string(),
});

export const genericErrorFrameSchema = z.object({
  type: z.literal('error'),
  reason: z.string().min(1),
  details: z.unknown().optional(),
});

export const pluginToExtensionFrameSchema = z.discriminatedUnion('type', [
  authFrameSchema,
  heartbeatFrameSchema,
  outboundFrameSchema,
  standbyFrameSchema,
  resumeFrameSchema,
  closeFrameSchema,
]);

export const extensionToPluginFrameSchema = z.discriminatedUnion('type', [
  authAckFrameSchema,
  authErrorFrameSchema,
  heartbeatAckFrameSchema,
  outboundAckFrameSchema,
  outboundErrorFrameSchema,
  eventFrameSchema,
  genericErrorFrameSchema,
]);

export const anyFrameSchema = z.discriminatedUnion('type', [
  authFrameSchema,
  authAckFrameSchema,
  authErrorFrameSchema,
  heartbeatFrameSchema,
  heartbeatAckFrameSchema,
  outboundFrameSchema,
  outboundAckFrameSchema,
  outboundErrorFrameSchema,
  standbyFrameSchema,
  resumeFrameSchema,
  closeFrameSchema,
  eventFrameSchema,
  genericErrorFrameSchema,
]);

export type AuthFrame = z.infer<typeof authFrameSchema>;
export type AuthAckFrame = z.infer<typeof authAckFrameSchema>;
export type HeartbeatFrame = z.infer<typeof heartbeatFrameSchema>;
export type OutboundFrame = z.infer<typeof outboundFrameSchema>;
export type StandbyFrame = z.infer<typeof standbyFrameSchema>;
export type ResumeFrame = z.infer<typeof resumeFrameSchema>;
export type CloseFrame = z.infer<typeof closeFrameSchema>;
export type EventFrame = z.infer<typeof eventFrameSchema>;
export type PluginToExtensionFrame = z.infer<typeof pluginToExtensionFrameSchema>;
export type ExtensionToPluginFrame = z.infer<typeof extensionToPluginFrameSchema>;
export type AnyFrame = z.infer<typeof anyFrameSchema>;
