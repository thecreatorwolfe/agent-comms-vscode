import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  isSupportedSpawnModel,
  ledgerClaudeModelIds,
  normalizeSpawnModel,
  refineSpawnModel,
  SPAWN_MODEL_FULL_IDS,
  SPAWN_MODELS_FILE_ENV,
  spawnModelValues,
} from '../spawn-model';

// The hub's model ledger file extends the Claude allowlist without a rebuild.
describe('spawn model ledger file', () => {
  let dir: string;
  let file: string;
  const saved = process.env[SPAWN_MODELS_FILE_ENV];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-models-'));
    file = path.join(dir, 'spawn-models.json');
    process.env[SPAWN_MODELS_FILE_ENV] = file;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[SPAWN_MODELS_FILE_ENV];
    else process.env[SPAWN_MODELS_FILE_ENV] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (body: unknown, mtime: number) => {
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    fs.utimesSync(file, mtime, mtime);
  };

  it('accepts the 5.5 generation from the built-in list with no file present', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(SPAWN_MODEL_FULL_IDS).toContain(id);
      expect(normalizeSpawnModel(id)).toBe(id);
    }
    expect(ledgerClaudeModelIds()).toEqual([]);
  });

  it('accepts a Claude id the ledger lists and the built-in list does not', () => {
    expect(isSupportedSpawnModel('claude-opus-6')).toBe(false);
    write({ claude: ['claude-opus-6', 'claude-opus-5-5'], source: 'test' }, 1000);
    expect(isSupportedSpawnModel('claude-opus-6')).toBe(true);
    expect(normalizeSpawnModel(' Claude-Opus-6 ')).toBe('claude-opus-6');
    expect(spawnModelValues().filter((v) => v === 'claude-opus-5-5')).toHaveLength(1);
  });

  it('re-reads the file when it changes, with no restart', () => {
    write({ claude: ['claude-opus-6'] }, 1000);
    expect(isSupportedSpawnModel('claude-sonnet-6')).toBe(false);
    write({ claude: ['claude-opus-6', 'claude-sonnet-6'] }, 2000);
    expect(isSupportedSpawnModel('claude-sonnet-6')).toBe(true);
  });

  it('ignores a malformed file and ids that are not command-line-safe Claude ids', () => {
    write('{not json', 1000);
    expect(ledgerClaudeModelIds()).toEqual([]);
    write({ claude: ['gpt-7', 'claude-x; rm -rf /', "claude-a'b", 42, 'claude-ok-1'] }, 2000);
    expect(ledgerClaudeModelIds()).toEqual(['claude-ok-1']);
    expect(() => normalizeSpawnModel('gpt-7')).toThrow(/Unsupported model/);
  });

  it('the shared zod refinement accepts a ledger id for kind=claude', () => {
    write({ claude: ['claude-opus-6'] }, 1000);
    const schema = z.object({ kind: z.enum(['claude', 'codex']), model: z.string().optional() })
      .superRefine((value, ctx) => refineSpawnModel(value, ctx));
    expect(schema.safeParse({ kind: 'claude', model: 'claude-opus-6' }).success).toBe(true);
    expect(schema.safeParse({ kind: 'claude', model: 'claude-opus-7' }).success).toBe(false);
  });
});
