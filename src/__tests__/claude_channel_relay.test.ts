import { describe, expect, it, vi } from 'vitest';
import { eventFrameSchema, type EventAckFrame, type EventFrame } from '../schema/frames';
import type { QueueDeliveryDeps } from '../codex/queue-delivery';
import {
  relayTextToAgent,
  AgentUnreachableError,
  type RelayTargetAgent,
} from '../codex/agent-message';
import {
  locateClaudeSession,
  locateTranscript,
  projectSlug,
  type ClaudeChannelDeps,
} from '../claude/channel-delivery';

const HOME = '/home/.claude';
const LANE: RelayTargetAgent = {
  persona: 'soph-vera-091122',
  kind: 'claude',
  cwd: '/repo/x',
  pid: 5001, // the bridge process
  connectedAt: 1_000,
  activity: 'working',
};
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SESSION_FILE = `${HOME}/sessions/5000.json`;
const TRANSCRIPT = `${HOME}/projects/${projectSlug('/repo/x')}/${SESSION_ID}.jsonl`;
const EVENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type Files = Record<string, string>;

function claudeHarness(options: {
  files?: Files;
  push?: boolean;
  ack?: Partial<EventAckFrame> | null;
  /** Called on every transcript read after the push; returns what the transcript now says. */
  transcriptAfterPush?: (marker: string, reads: number) => string;
  ancestors?: number[];
} = {}) {
  const files: Files = {
    [SESSION_FILE]: JSON.stringify({ pid: 5000, sessionId: SESSION_ID, cwd: '/repo/x', name: LANE.persona }),
    [TRANSCRIPT]: '{"type":"user"}\n',
    ...options.files,
  };
  const pushed: EventFrame[] = [];
  let pushedAt = -1;
  let reads = 0;
  let clock = 0;
  const deps: ClaudeChannelDeps = {
    pushEvent: vi.fn((frame: EventFrame) => {
      pushed.push(frame);
      if (options.push === false) return false;
      pushedAt = clock;
      return true;
    }),
    waitForAck: vi.fn(async (deliveryId: string) => (options.ack === null
      ? undefined
      : {
        type: 'event.ack', persona: LANE.persona, delivery_id: deliveryId, surface_status: 'ok',
        surface_mechanism: 'claude_channel', logging_status: 'ok', ...options.ack,
      } as EventAckFrame)),
    ancestorPids: async () => options.ancestors ?? [5001, 5000, 1],
    readText: async (p: string) => {
      if (p === TRANSCRIPT && pushedAt >= 0 && options.transcriptAfterPush) {
        reads += 1;
        const marker = String((pushed[0]?.body_parsed as { marker?: string })?.marker ?? '');
        return options.transcriptAfterPush(marker, reads);
      }
      return p in files ? files[p] : null;
    },
    listDir: async (dir: string) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]);
      if (!names.size) throw new Error('ENOENT');
      return [...names];
    },
    mtimeMs: async (p: string) => (p in files ? clock : null),
    claudeHome: HOME,
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
  };

  const runCodexQueue = vi.fn();
  const call = (text: string, extra: Record<string, unknown> = {}) => relayTextToAgent(
    { persona: LANE.persona, text, ...extra },
    {
      findAgent: () => LANE,
      threadIndex: { lookup: vi.fn(), forget: vi.fn() } as never,
      queueDeps: { runCodexQueue } as unknown as QueueDeliveryDeps,
      sessionsRoot: '/codex',
      cliPath: 'codex',
      defaultSender: 'Nick, relayed by Soph',
      newDeliveryId: () => 'cafe1234',
      newEventId: () => EVENT_ID,
      claude: deps,
    },
  );
  return { call, deps, pushed, runCodexQueue };
}

describe('Claude lane relay over the bridge socket', () => {
  it('writes exactly one valid event frame carrying the text verbatim, and confirms it from the transcript', async () => {
    const text = 'Skip the migration.\n\nUse `--dry-run` and "quote" it — then stop. $HOME';
    const { call, pushed, runCodexQueue } = claudeHarness({
      transcriptAfterPush: (marker, reads) => (reads >= 3 ? `{"type":"user"}\n{"content":"x ${marker} y"}\n` : '{"type":"user"}\n'),
    });
    const result = await call(text);

    expect(pushed).toHaveLength(1);
    expect(eventFrameSchema.safeParse(pushed[0]).success).toBe(true);
    expect(pushed[0].to_persona).toBe(LANE.persona);
    expect(pushed[0].delivery_id).toBe(EVENT_ID);
    expect(pushed[0].body_raw).toContain(text);
    expect(pushed[0].body_raw).toContain('[relay cafe1234]');
    expect(pushed[0].from_persona).toBe('Nick, relayed by Soph');
    expect(runCodexQueue).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      persona: LANE.persona,
      kind: 'claude',
      activity: 'working',
      transport: 'claude_channel',
      delivery: 'confirmed',
      session_id: SESSION_ID,
      delivery_id: 'cafe1234',
      text_chars: text.length,
      execution_verified: false,
    });
    expect(result.thread_id).toBeUndefined();
  });

  it('reports queued, not failed, when a busy lane has not taken the text inside the window', async () => {
    const { call, pushed } = claudeHarness({ transcriptAfterPush: () => '{"type":"user"}\n' });
    const result = await call('hold that thought', { confirmTimeoutMs: 1_000 });
    expect(pushed).toHaveLength(1);
    expect(result.delivery).toBe('queued');
    expect(result.note).toMatch(/Do not resend/);
    expect(result.execution_verified).toBe(false);
  });

  it('refuses with nothing sent when the lane has no live bridge socket', async () => {
    const { call, pushed } = claudeHarness({ push: false });
    await expect(call('hello')).rejects.toBeInstanceOf(AgentUnreachableError);
    await expect(call('hello')).rejects.toThrow(/no live bridge socket/);
    expect(pushed.length).toBeGreaterThan(0); // attempted, and the gateway said it did not write
  });

  it('reports unacknowledged, never a retry, when the bridge does not ack', async () => {
    const { call, pushed, deps } = claudeHarness({ ack: null });
    const result = await call('hello');
    expect(pushed).toHaveLength(1);
    expect(deps.pushEvent).toHaveBeenCalledTimes(1);
    expect(result.delivery).toBe('unacknowledged');
    expect(result.note).toMatch(/Do not resend/);
  });

  it('treats a failed surface ack as not delivered', async () => {
    const { call } = claudeHarness({ ack: { surface_status: 'failed' } });
    await expect(call('hello')).rejects.toThrow(/did not accept the channel notification/);
  });

  it('with no session record, confirms from the one fresh transcript in the lane folder that carries the marker', async () => {
    const { call, pushed } = claudeHarness({
      files: { [SESSION_FILE]: 'not json' },
      ancestors: [5001],
      transcriptAfterPush: (marker) => `{"content":"${marker}"}\n`,
    });
    const result = await call('hello');
    expect(pushed).toHaveLength(1);
    expect(result.delivery).toBe('confirmed');
    expect(result.session_id).toBe(SESSION_ID);
  });

  it('still delivers when the session cannot be identified; it just cannot confirm', async () => {
    const { call, pushed } = claudeHarness({ files: { [SESSION_FILE]: 'not json' }, ancestors: [5001] });
    const result = await call('hello');
    expect(pushed).toHaveLength(1);
    expect(result.delivery).toBe('queued');
    expect(result.session_id).toBeUndefined();
  });
});

describe('locating the Claude session behind a bridge', () => {
  const base = (files: Files, ancestors: number[]) => ({
    claudeHome: HOME,
    ancestorPids: async () => ancestors,
    readText: async (p: string) => (p in files ? files[p] : null),
    listDir: async (dir: string) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]),
  });

  it('prefers the process tree over the name', async () => {
    const files = {
      [`${HOME}/sessions/5000.json`]: JSON.stringify({ sessionId: 'by-pid', cwd: '/a', name: 'other' }),
      [`${HOME}/sessions/7000.json`]: JSON.stringify({ sessionId: 'by-name', cwd: '/a', name: LANE.persona }),
    };
    expect((await locateClaudeSession(LANE.persona, 5001, base(files, [5001, 5000])))?.sessionId).toBe('by-pid');
  });

  it('never adopts a Claude session further up the tree than the bridge\'s parent', async () => {
    const files = { [`${HOME}/sessions/9000.json`]: JSON.stringify({ sessionId: 'grandparent', cwd: '/a', name: 'other' }) };
    expect(await locateClaudeSession(LANE.persona, 5001, base(files, [5001, 5000, 9000]))).toBeNull();
  });

  it('falls back to the launch name, and only when exactly one session carries it', async () => {
    const one = { [`${HOME}/sessions/7000.json`]: JSON.stringify({ sessionId: 'by-name', cwd: '/a', name: LANE.persona }) };
    expect((await locateClaudeSession(LANE.persona, 5001, base(one, [5001])))?.sessionId).toBe('by-name');
    const two = { ...one, [`${HOME}/sessions/7001.json`]: JSON.stringify({ sessionId: 'twin', cwd: '/a', name: LANE.persona }) };
    expect(await locateClaudeSession(LANE.persona, 5001, base(two, [5001]))).toBeNull();
  });

  it('finds a transcript under the cwd slug, else by scanning, else the expected path', async () => {
    const session = { sessionId: 's1', cwd: '/Users/n/My Repo_x', pid: 1 };
    expect(projectSlug(session.cwd)).toBe('-Users-n-My-Repo-x');
    const direct = base({ [`${HOME}/projects/-Users-n-My-Repo-x/s1.jsonl`]: '' }, []);
    expect(await locateTranscript(session, direct)).toBe(`${HOME}/projects/-Users-n-My-Repo-x/s1.jsonl`);
    const moved = base({ [`${HOME}/projects/elsewhere/s1.jsonl`]: '' }, []);
    expect(await locateTranscript(session, moved)).toBe(`${HOME}/projects/elsewhere/s1.jsonl`);
  });
});
