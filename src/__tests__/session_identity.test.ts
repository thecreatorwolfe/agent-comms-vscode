import { describe, expect, it, vi } from 'vitest';
import {
  deriveSessionProfileId,
  deriveStableProfileId,
  resolveBridgeProfileId,
  resolveSessionAnchor,
} from '../mcp/runtime-env';

const REPO = '/Users/nick/work/override_agency_project';

/** pid ppid comm, the shape `ps -Ao pid=,ppid=,comm=` prints. */
const PROCESS_TABLE = [
  '1 0 launchd',
  '500 1 Code Helper',
  '600 500 zsh',
  '700 600 codex',
  '800 700 node',            // the agent-comms bridge inside that codex session
  '900 600 claude',
  '950 900 node',            // a bridge inside a claude session, same directory
].join('\n');

function psStub(overrides: { table?: string; lstart?: Record<number, string>; fail?: boolean } = {}) {
  return vi.fn(async (args: string[]) => {
    if (overrides.fail) {
      throw new Error('ps unavailable');
    }

    if (args.includes('lstart=')) {
      const pid = Number(args[args.indexOf('-p') + 1]);
      return overrides.lstart?.[pid] ?? 'Wed Sep 17 18:13:20 2026';
    }

    return overrides.table ?? PROCESS_TABLE;
  });
}

describe('resolveSessionAnchor', () => {
  it('finds the codex process that owns a bridge', async () => {
    const anchor = await resolveSessionAnchor(800, psStub());

    expect(anchor).toEqual({ pid: 700, startedAt: 'Wed Sep 17 18:13:20 2026' });
  });

  it('finds the claude process that owns a bridge', async () => {
    const anchor = await resolveSessionAnchor(950, psStub());

    expect(anchor?.pid).toBe(900);
  });

  it('returns null when no agent process is in the ancestry', async () => {
    const anchor = await resolveSessionAnchor(600, psStub());

    expect(anchor).toBeNull();
  });

  it('returns null rather than throwing when the process listing fails', async () => {
    const anchor = await resolveSessionAnchor(800, psStub({ fail: true }));

    expect(anchor).toBeNull();
  });

  it('never asks for the tty column, which can hang for minutes', async () => {
    const ps = psStub();

    await resolveSessionAnchor(800, ps);

    for (const call of ps.mock.calls) {
      expect(call[0].join(' ')).not.toContain('tty');
    }
  });

  it('stops walking instead of looping on a cyclic parent chain', async () => {
    const anchor = await resolveSessionAnchor(10, psStub({ table: '10 20 node\n20 10 node' }));

    expect(anchor).toBeNull();
  });
});

describe('deriveSessionProfileId', () => {
  it('gives two sessions in one directory different ids', async () => {
    const codexSession = await resolveSessionAnchor(800, psStub());
    const claudeSession = await resolveSessionAnchor(950, psStub({
      lstart: { 900: 'Wed Sep 17 18:14:07 2026' },
    }));

    const first = deriveSessionProfileId(REPO, codexSession);
    const second = deriveSessionProfileId(REPO, claudeSession);

    // This is the whole point: the old directory-only id made these identical,
    // so the two sessions fought over one saved persona.
    expect(first).not.toBe(second);
    expect(first).not.toBe(deriveStableProfileId(REPO));
  });

  it('is stable for the same session across bridge restarts', () => {
    const anchor = { pid: 700, startedAt: 'Wed Sep 17 18:13:20 2026' };

    expect(deriveSessionProfileId(REPO, anchor)).toBe(deriveSessionProfileId(REPO, anchor));
  });

  it('separates the same pid reused at a different start time', () => {
    const before = deriveSessionProfileId(REPO, { pid: 700, startedAt: 'Wed Sep 17 18:13:20 2026' });
    const after = deriveSessionProfileId(REPO, { pid: 700, startedAt: 'Wed Sep 17 19:02:11 2026' });

    expect(before).not.toBe(after);
  });

  it('falls back to the directory id when the owning process is unknown', () => {
    expect(deriveSessionProfileId(REPO, null)).toBe(deriveStableProfileId(REPO));
  });

  it('produces a uuid-shaped id', () => {
    expect(deriveSessionProfileId(REPO, { pid: 700, startedAt: 'x' }))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('resolveBridgeProfileId', () => {
  it('uses the id a hub spawn supplied', async () => {
    const id = await resolveBridgeProfileId({ AGENT_COMMS_PROFILE_ID: 'spawn-assigned-id' }, REPO);

    expect(id).toBe('spawn-assigned-id');
  });

  it('derives one per session when there is no spawn id', async () => {
    const id = await resolveBridgeProfileId({}, REPO);

    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });
});
