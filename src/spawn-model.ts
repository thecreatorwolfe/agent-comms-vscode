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
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const;

// Codex takes any model name its config knows (`codex -m <model>`); the hub
// cannot enumerate those, so it only guards the string against characters a
// command line cannot carry. Verified against codex-cli 0.153.3 `-m, --model`.
export const CODEX_MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

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
export function normalizeSpawnModel(model: string, kind: 'claude' | 'codex' = 'claude'): string {
  if (kind === 'codex') {
    const raw = model.trim();
    if (!CODEX_MODEL_PATTERN.test(raw)) {
      throw new Error(`Unsupported codex model "${model}": only letters, digits, . _ : - are accepted.`);
    }
    return raw;
  }
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
  if (value.kind === 'codex') {
    if (!CODEX_MODEL_PATTERN.test(value.model.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: `Unsupported codex model "${value.model}": only letters, digits, . _ : - are accepted.`,
      });
    }
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
  'Optional model for the spawned session. '
  + `kind='claude': an alias (${SPAWN_MODEL_ALIASES.join(', ')}) or a full model id `
  + `(${SPAWN_MODEL_FULL_IDS.join(', ')}). kind='codex': a model name passed to codex -m. `
  + 'Omit to use the CLI default.';

// ── Reasoning effort (added 0.2.49) ─────────────────────────────────────────
// Verified 2026-09-05: `claude --effort <level>` (2.1.261; levels low|medium|
// high|xhigh|max) and codex-cli 0.153.3 `-c model_reasoning_effort=<v>` with
// documented values minimal|low|medium|high|xhigh. One vocabulary at the tool
// surface; the two edges each CLI lacks are mapped rather than refused.
export const SPAWN_EFFORT_CLAUDE = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const SPAWN_EFFORT_CODEX = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const SPAWN_EFFORT_ALIASES: Record<'claude' | 'codex', Record<string, string>> = {
  claude: { minimal: 'low' },
  codex: { max: 'xhigh' },
};

export function normalizeSpawnEffort(kind: 'claude' | 'codex', effort: string): string {
  const candidate = effort.trim().toLowerCase();
  const mapped = SPAWN_EFFORT_ALIASES[kind][candidate] ?? candidate;
  const allowed: readonly string[] = kind === 'claude' ? SPAWN_EFFORT_CLAUDE : SPAWN_EFFORT_CODEX;
  if (!allowed.includes(mapped)) {
    throw new Error(`Unsupported effort "${effort}" for kind='${kind}'. Accepted values: ${allowed.join(', ')}.`);
  }
  return mapped;
}

export function isSupportedSpawnEffort(kind: 'claude' | 'codex', effort: string): boolean {
  try {
    normalizeSpawnEffort(kind, effort);
    return true;
  } catch {
    return false;
  }
}

export function refineSpawnEffort(
  value: { kind: 'claude' | 'codex'; effort?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.effort == null) {
    return;
  }
  if (!isSupportedSpawnEffort(value.kind, value.effort)) {
    const allowed = value.kind === 'claude' ? SPAWN_EFFORT_CLAUDE : SPAWN_EFFORT_CODEX;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effort'],
      message: `Unsupported effort "${value.effort}" for kind='${value.kind}'. Accepted values: ${allowed.join(', ')}.`,
    });
  }
}

export const SPAWN_EFFORT_PARAM_DESCRIPTION =
  'Optional reasoning effort for the spawned session. '
  + `kind='claude': ${SPAWN_EFFORT_CLAUDE.join(', ')} (claude --effort). `
  + `kind='codex': ${SPAWN_EFFORT_CODEX.join(', ')} (model_reasoning_effort; max maps to xhigh). `
  + 'Omit for the CLI default.';
