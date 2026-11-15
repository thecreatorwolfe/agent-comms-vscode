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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const SPAWN_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

// claude-*-5-5 verified 2026-11-02 against GET /v1/models on the account's key.
export const SPAWN_MODEL_FULL_IDS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
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

// Claude models released after this build. The alfred-hub model-release watch
// writes every Claude id the account's Anthropic Models API lists to this file
// ({ "claude": ["claude-opus-5-5", ...] }); those ids are accepted alongside
// the built-in list, so a newly shipped model is spawnable without a rebuild.
// Re-read whenever the file's mtime changes; a missing or malformed file adds
// nothing. Only `claude-` ids of command-line-safe characters are taken.
export const SPAWN_MODELS_FILE_ENV = 'AGENT_COMMS_SPAWN_MODELS_FILE';
const LEDGER_CLAUDE_ID = /^claude-[a-z0-9][a-z0-9.-]{0,78}$/;
let ledgerCache: { file: string; mtimeMs: number; ids: string[] } | null = null;

export function spawnModelsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env[SPAWN_MODELS_FILE_ENV] || path.join(os.homedir(), '.agent-comms', 'spawn-models.json');
}

export function ledgerClaudeModelIds(file: string = spawnModelsFile()): string[] {
  try {
    const { mtimeMs } = fs.statSync(file);
    if (ledgerCache && ledgerCache.file === file && ledgerCache.mtimeMs === mtimeMs) {
      return ledgerCache.ids;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = parsed && typeof parsed === 'object' ? (parsed as { claude?: unknown }).claude : undefined;
    const ids = Array.isArray(list)
      ? list.filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim().toLowerCase())
        .filter((v) => LEDGER_CLAUDE_ID.test(v))
      : [];
    ledgerCache = { file, mtimeMs, ids };
    return ids;
  } catch {
    return [];
  }
}

/** Built-in aliases and ids, then any the hub's model ledger adds. */
export function spawnModelValues(): string[] {
  return [...new Set([...SPAWN_MODEL_VALUES, ...ledgerClaudeModelIds()])];
}

export function isSupportedSpawnModel(model: string): boolean {
  const candidate = model.trim().toLowerCase();
  return spawnModelValues().some((value) => value === candidate);
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
  const accepted = spawnModelValues();
  const match = accepted.find((value) => value === candidate);
  if (!match) {
    throw new Error(
      `Unsupported model "${model}". Accepted values: ${accepted.join(', ')}.`,
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
      message: `Unsupported model "${value.model}". Accepted values: ${spawnModelValues().join(', ')}.`,
    });
  }
}

export const SPAWN_MODEL_PARAM_DESCRIPTION =
  'Optional model for the spawned session. '
  + `kind='claude': an alias (${SPAWN_MODEL_ALIASES.join(', ')}) or a full model id `
  + `(${SPAWN_MODEL_FULL_IDS.join(', ')}, or any Claude id listed in ~/.agent-comms/spawn-models.json). kind='codex': a model name passed to codex -m. `
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
