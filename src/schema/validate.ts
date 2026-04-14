import { ZodError } from 'zod';
import { anyFrameSchema, type AnyFrame } from './frames';
import { parseAgentSlackMessage, type ParsedSlackMessage } from './slack_message';

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: ZodError | Error };

export function validateFrame(frame: unknown): ValidationResult<AnyFrame> {
  const parsed = anyFrameSchema.safeParse(frame);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: parsed.error };
}

export function validateSlackMessageText(text: string): ValidationResult<ParsedSlackMessage> {
  try {
    return { ok: true, data: parseAgentSlackMessage(text) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
