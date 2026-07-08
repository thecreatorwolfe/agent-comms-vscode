// Owner: agent-comms — optional model selection for spawned Claude sessions.
//
// The `claude` CLI accepts `--model` with either a short alias for the latest
// model (e.g. 'fable', 'opus', 'sonnet', 'haiku') or a model's full name
// (e.g. 'claude-fable-5'). Verified via `claude --help`:
//   --model <model>  Provide an alias for the latest model (e.g. 'fable',
//                    'opus', or 'sonnet') or a model's full name
//                    (e.g. 'claude-fable-5').
// Both forms are accepted by the CLI, so a validated value is passed through
// unchanged (aside from trimming). This module has no `vscode` dependency so it
// can be shared by the stand-alone MCP shims and the extension host.

import { z } from 'zod';

export const SPAWN_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

export const SPAWN_MODEL_FULL_IDS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const;

export const SPAWN_MODEL_VALUES: readonly string[] = [
  ...SPAWN_MODEL_ALIASES,
  ...SPAWN_MODEL_FULL_IDS,
];

export function isSupportedSpawnModel(model: string): boolean {
  const candidate = model.trim().toLowerCase();
  return SPAWN_MODEL_VALUES.some((value) => value === candidate);
}

// Validate a caller-supplied model and return the exact string handed to
// `claude --model`. Aliases and full ids are both accepted by the CLI, so the
// canonical allowlist value (lower-cased, trimmed) is returned unchanged.
// Throws for anything not in the allowlist.
export function normalizeSpawnModel(model: string): string {
  const candidate = model.trim().toLowerCase();
  const match = SPAWN_MODEL_VALUES.find((value) => value === candidate);
  if (!match) {
    throw new Error(
      `Unsupported model "${model}". Accepted values: ${SPAWN_MODEL_VALUES.join(', ')}.`,
    );
  }
  return match;
}

// Shared Zod cross-field validation for the spawn request `model` field:
// model is optional; when present it must be a supported value and is only
// allowed for kind='claude' spawns. Reused by every place the spawn input
// schema is defined so validation stays coherent.
export function refineSpawnModel(
  value: { kind: 'claude' | 'codex'; model?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.model == null) {
    return;
  }
  if (value.kind !== 'claude') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: "Model selection is only supported for kind='claude' spawns.",
    });
    return;
  }
  if (!isSupportedSpawnModel(value.model)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: `Unsupported model "${value.model}". Accepted values: ${SPAWN_MODEL_VALUES.join(', ')}.`,
    });
  }
}

export const SPAWN_MODEL_PARAM_DESCRIPTION =
  "Optional Claude model for the spawned session (kind='claude' only). "
  + `Accepts an alias (${SPAWN_MODEL_ALIASES.join(', ')}) or a full model id `
  + `(${SPAWN_MODEL_FULL_IDS.join(', ')}). Omit to use the hub default.`;
