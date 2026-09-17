import { describe, expect, it, vi } from 'vitest';
import {
  CodexThreadIndex,
  deliverViaQueue,
  parseQueuedMessageId,
  parseSessionMeta,
  resolveThreadForAgent,
  transcriptHasDelivery,
  type QueueDeliveryDeps,
} from '../codex/queue-delivery';

const CWD = '/Users/nick/work/project';

function sessionMetaLine(threadId: string, cwd: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'session_meta',
    payload: { session_id: threadId, id: threadId, cwd, timestamp, originator: 'codex_cli_rs' },
  });
}

function userItemLine(text: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
}

function makeDeps(overrides: Partial<QueueDeliveryDeps> = {}): QueueDeliveryDeps {
  return {
    listRolloutFiles: vi.fn(async () => []),
    readFirstLine: vi.fn(async () => ''),
    readText: vi.fn(async () => ''),
    runCodexQueue: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    now: () => 1_000,
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('parseSessionMeta', () => {
  it('reads the thread id, cwd and start time from the first transcript line', () => {
    const meta = parseSessionMeta(
      `${sessionMetaLine('01a0b039-38c7-7712-8709-298f0c1f96e6', CWD, '2026-09-17T16:35:35.240Z')}\n{"other":true}`,
    );

    expect(meta).toEqual({
      threadId: '01a0b039-38c7-7712-8709-298f0c1f96e6',
      cwd: CWD,
      startedAtMs: Date.parse('2026-09-17T16:35:35.240Z'),
    });
  });

  it('returns null for a transcript head that is not session metadata', () => {
    expect(parseSessionMeta('not json')).toBeNull();
    expect(parseSessionMeta('{"timestamp":"2026-09-17T16:35:35.240Z","payload":{}}')).toBeNull();
  });

  it('reads metadata that carries the full base instructions', () => {
    // Real transcripts embed the session's base instructions on this line, so it
    // runs well past any fixed-size read window.
    const fat = JSON.stringify({
      timestamp: '2026-09-17T17:06:44.295Z',
      type: 'session_meta',
      payload: {
        session_id: '01a0b055-bd60-7c41-a069-05a5b860da7a',
        cwd: CWD,
        timestamp: '2026-09-17T17:06:44.194Z',
        base_instructions: 'x'.repeat(40_000),
      },
    });

    expect(fat.length).toBeGreaterThan(8_192);
    expect(parseSessionMeta(fat)?.threadId).toBe('01a0b055-bd60-7c41-a069-05a5b860da7a');
  });

  it('returns null when the metadata line was truncated mid-read', () => {
    const truncated = sessionMetaLine('thread-x', CWD, '2026-09-17T16:35:35.240Z').slice(0, 120);
    expect(parseSessionMeta(truncated)).toBeNull();
  });
});

describe('resolveThreadForAgent', () => {
  const older = '/sessions/2026/09/17/rollout-a.jsonl';
  const newer = '/sessions/2026/09/17/rollout-b.jsonl';
  const otherCwd = '/sessions/2026/09/17/rollout-c.jsonl';

  const heads: Record<string, string> = {
    [older]: sessionMetaLine('thread-old', CWD, '2026-09-17T16:00:00.000Z'),
    [newer]: sessionMetaLine('thread-new', CWD, '2026-09-17T16:30:00.000Z'),
    [otherCwd]: sessionMetaLine('thread-other', '/somewhere/else', '2026-09-17T16:40:00.000Z'),
  };

  const deps = makeDeps({
    listRolloutFiles: vi.fn(async () => [older, newer, otherCwd]),
    readFirstLine: vi.fn(async (path: string) => heads[path] ?? ''),
  });

  it('picks the newest session started in the agent working directory', async () => {
    const resolved = await resolveThreadForAgent(
      { cwd: CWD, notBeforeMs: Date.parse('2026-09-17T15:59:00.000Z'), sessionsRoot: '/sessions' },
      deps,
    );

    expect(resolved?.threadId).toBe('thread-new');
    expect(resolved?.rolloutPath).toBe(newer);
  });

  it('ignores sessions that started before the agent registered', async () => {
    const resolved = await resolveThreadForAgent(
      { cwd: CWD, notBeforeMs: Date.parse('2026-09-17T18:00:00.000Z'), sessionsRoot: '/sessions' },
      deps,
    );

    expect(resolved).toBeNull();
  });
});

describe('transcriptHasDelivery', () => {
  const queuedAt = Date.parse('2026-09-17T16:36:17.000Z');
  const marker = 'Agent Comms ping from alfred-1 to codex-2';

  it('accepts an entry written after the message was queued', () => {
    const transcript = userItemLine(`${marker}. Stop and check Slack now.`, '2026-09-17T16:36:17.700Z');
    expect(transcriptHasDelivery(transcript, marker, queuedAt)).toBe(true);
  });

  it('rejects an identical ping from an earlier delivery', () => {
    const transcript = userItemLine(`${marker}. Stop and check Slack now.`, '2026-09-17T16:20:00.000Z');
    expect(transcriptHasDelivery(transcript, marker, queuedAt)).toBe(false);
  });

  it('rejects a transcript with no matching entry', () => {
    const transcript = userItemLine('unrelated work', '2026-09-17T16:36:18.000Z');
    expect(transcriptHasDelivery(transcript, marker, queuedAt)).toBe(false);
  });
});

describe('parseQueuedMessageId', () => {
  it('reads the id the CLI reports', () => {
    expect(parseQueuedMessageId('Queued message 01a0b039-d5c9-79b1-b580-5caf6c492ab6 for thread 01a0b039.'))
      .toBe('01a0b039-d5c9-79b1-b580-5caf6c492ab6');
  });

  it('tolerates output without an id', () => {
    expect(parseQueuedMessageId('')).toBeUndefined();
  });
});

describe('deliverViaQueue', () => {
  const base = {
    cliPath: 'codex',
    threadId: 'thread-new',
    rolloutPath: '/sessions/rollout-b.jsonl',
    message: 'Agent Comms ping from alfred-1 to codex-2. Stop and check Slack now.',
    marker: 'Agent Comms ping from alfred-1 to codex-2',
  };

  it('confirms delivery once the ping appears in the transcript', async () => {
    let clock = 10_000;
    let reads = 0;
    const deps = makeDeps({
      runCodexQueue: vi.fn(async () => ({
        code: 0,
        stdout: 'Queued message 01a0b039-d5c9-79b1-b580-5caf6c492ab6 for thread thread-new.',
        stderr: '',
      })),
      readText: vi.fn(async () => {
        reads += 1;
        return reads < 2 ? '' : userItemLine(base.message, new Date(clock + 500).toISOString());
      }),
      now: () => clock,
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
      }),
    });

    const outcome = await deliverViaQueue(base, deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.queuedMessageId).toBe('01a0b039-d5c9-79b1-b580-5caf6c492ab6');
  });

  it('reports failure when the CLI exits non-zero', async () => {
    const deps = makeDeps({
      runCodexQueue: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such thread\n' })),
    });

    const outcome = await deliverViaQueue(base, deps);

    expect(outcome).toEqual({ ok: false, reason: 'codex queue exit 1: no such thread' });
  });

  it('reports failure when the CLI claims success but nothing lands', async () => {
    let clock = 0;
    const deps = makeDeps({
      runCodexQueue: vi.fn(async () => ({ code: 0, stdout: 'Queued message abcdef12 for thread thread-new.', stderr: '' })),
      readText: vi.fn(async () => ''),
      now: () => clock,
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
      }),
    });

    const outcome = await deliverViaQueue({ ...base, confirmTimeoutMs: 1_000, confirmPollMs: 250 }, deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('unconfirmed');
    expect(outcome.queuedMessageId).toBe('abcdef12');
  });
});

describe('CodexThreadIndex', () => {
  const head = sessionMetaLine('thread-new', CWD, '2026-09-17T16:30:00.000Z');
  const owner = {
    persona: 'codex-2',
    cwd: CWD,
    pid: 4242,
    connectedAt: Date.parse('2026-09-17T16:29:00.000Z'),
  };

  it('resolves once and reuses the answer for the same agent process', async () => {
    const listRolloutFiles = vi.fn(async () => ['/sessions/rollout-b.jsonl']);
    const deps = makeDeps({ listRolloutFiles, readFirstLine: vi.fn(async () => head) });
    const index = new CodexThreadIndex();

    const first = await index.lookup(owner, deps, '/sessions');
    const second = await index.lookup(owner, deps, '/sessions');

    expect(first?.threadId).toBe('thread-new');
    expect(second?.threadId).toBe('thread-new');
    expect(listRolloutFiles).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after the agent reconnects under a new pid', async () => {
    const listRolloutFiles = vi.fn(async () => ['/sessions/rollout-b.jsonl']);
    const deps = makeDeps({ listRolloutFiles, readFirstLine: vi.fn(async () => head) });
    const index = new CodexThreadIndex();

    await index.lookup(owner, deps, '/sessions');
    await index.lookup({ ...owner, pid: 5555 }, deps, '/sessions');

    expect(listRolloutFiles).toHaveBeenCalledTimes(2);
  });

  it('forgets a persona whose session cannot be found', async () => {
    const deps = makeDeps({ listRolloutFiles: vi.fn(async () => []) });
    const index = new CodexThreadIndex();

    expect(await index.lookup(owner, deps, '/sessions')).toBeNull();
    expect(index.size).toBe(0);
  });
});
