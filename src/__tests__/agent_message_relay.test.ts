import { describe, expect, it, vi } from 'vitest';
import {
  buildRelayEnvelope,
  validateRelayText,
  RELAY_TEXT_MAX_CHARS,
  type QueueDeliveryDeps,
} from '../codex/queue-delivery';
import {
  relayTextToAgent,
  AgentNotFoundError,
  AgentUnreachableError,
  UnsupportedRuntimeError,
  type RelayTargetAgent,
} from '../codex/agent-message';

const AGENT: RelayTargetAgent = {
  persona: 'astra-1',
  kind: 'codex',
  cwd: '/repo',
  pid: 4242,
  connectedAt: 1_000,
  activity: 'idle',
};

const THREAD = { threadId: 'thread-abc', rolloutPath: '/sessions/rollout-1.jsonl', startedAtMs: 1_000 };

/** A transcript line that carries `marker`, stamped now, as Codex would write it. */
function transcriptWith(marker: string): string {
  return `${JSON.stringify({ timestamp: new Date().toISOString(), payload: { text: `hello ${marker} world` } })}\n`;
}

function harness(options: {
  agent?: RelayTargetAgent | undefined;
  thread?: typeof THREAD | null;
  queueResult?: { code: number; stdout: string; stderr: string };
  /** What the transcript reads as; receives the marker actually used. */
  transcript?: (marker: string) => string;
} = {}) {
  const runCodexQueue = vi.fn(async () => options.queueResult ?? { code: 0, stdout: 'Queued message 9f8e7d6c', stderr: '' });
  const forget = vi.fn();
  let usedMarker = '';
  const queueDeps = {
    runCodexQueue,
    readText: async () => (options.transcript ? options.transcript(usedMarker) : ''),
    now: () => Date.now(),
    sleep: async () => {},
  } as unknown as QueueDeliveryDeps;

  const call = (text: string, extra: Record<string, unknown> = {}) => relayTextToAgent(
    { persona: 'astra-1', text, ...extra },
    {
      findAgent: () => ('agent' in options ? options.agent : AGENT),
      threadIndex: { lookup: async () => (options.thread === undefined ? THREAD : options.thread), forget } as never,
      queueDeps,
      sessionsRoot: '/sessions',
      cliPath: 'codex',
      defaultSender: 'Nick, relayed by Soph',
      newDeliveryId: () => 'dead1234',
    },
  );

  // deliverViaQueue builds the marker from the delivery id, which is fixed above.
  usedMarker = '[relay dead1234]';
  return { call, runCodexQueue, forget };
}

describe('free-form relay envelope', () => {
  it('carries the text through verbatim, newlines and quotes included, and tags it for the transcript', () => {
    const text = 'Skip the migration.\n\nUse `--dry-run` and "quote" it — then stop.';
    const envelope = buildRelayEnvelope({ sender: 'Nick, relayed by Soph', text, deliveryId: 'abc12345' });
    expect(envelope.marker).toBe('[relay abc12345]');
    expect(envelope.message).toContain(text);
    expect(envelope.message).toContain(envelope.marker);
    expect(envelope.message.startsWith('Message from Nick, relayed by Soph')).toBe(true);
  });

  it('gives two identical messages different markers so one cannot confirm the other', () => {
    const a = buildRelayEnvelope({ sender: 'S', text: 'same', deliveryId: 'aaaaaaaa' });
    const b = buildRelayEnvelope({ sender: 'S', text: 'same', deliveryId: 'bbbbbbbb' });
    expect(a.marker).not.toBe(b.marker);
  });

  it('accepts multi-line text and rejects blank, NUL-bearing and oversize text', () => {
    expect(validateRelayText('one\ntwo\nthree')).toBe(true);
    for (const bad of ['', '   ', '\n\n', 'has\u0000nul', 'x'.repeat(RELAY_TEXT_MAX_CHARS + 1), 42, null, undefined]) {
      expect(validateRelayText(bad)).toBe(false);
    }
  });
});

describe('relaying free-form text to a running lane', () => {
  it('confirms a delivery it can find in the transcript, and never claims the lane acted on it', async () => {
    const { call, runCodexQueue } = harness({ transcript: (marker) => transcriptWith(marker) });
    const result = await call('Skip the migration.\nUse --dry-run.');

    expect(result.delivery).toBe('confirmed');
    expect(result.transport).toBe('codex_queue');
    expect(result.thread_id).toBe('thread-abc');
    expect(result.execution_verified).toBe(false);
    expect(result.text_chars).toBe('Skip the migration.\nUse --dry-run.'.length);

    // One send, one CLI invocation, and the lane's own text inside it.
    expect(runCodexQueue).toHaveBeenCalledTimes(1);
    const sent = runCodexQueue.mock.calls[0][0] as { threadId: string; message: string };
    expect(sent.threadId).toBe('thread-abc');
    expect(sent.message).toContain('Skip the migration.\nUse --dry-run.');
  });

  it('reports a mid-turn lane as queued rather than failed, and does not resend', async () => {
    // Transcript never shows the marker: the lane is busy and has not taken it.
    const { call, runCodexQueue, forget } = harness({ transcript: () => '' });
    const result = await call('Stop after this file.', { confirmTimeoutMs: 500 });

    expect(result.delivery).toBe('queued');
    expect(result.execution_verified).toBe(false);
    expect(result.note).toMatch(/turn boundary/i);
    expect(result.note).toMatch(/Do not resend/i);
    expect(runCodexQueue).toHaveBeenCalledTimes(1);
    // The thread is still good; only a CLI-level failure invalidates it.
    expect(forget).not.toHaveBeenCalled();
  });

  it('sends nothing when the CLI refuses, and drops the cached thread', async () => {
    const { call, runCodexQueue, forget } = harness({
      queueResult: { code: 1, stdout: '', stderr: 'no such session' },
    });
    await expect(call('anything')).rejects.toBeInstanceOf(AgentUnreachableError);
    expect(runCodexQueue).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith('astra-1');
  });

  it('refuses an unknown persona without touching the CLI', async () => {
    const { call, runCodexQueue } = harness({ agent: undefined });
    await expect(call('hello')).rejects.toBeInstanceOf(AgentNotFoundError);
    expect(runCodexQueue).not.toHaveBeenCalled();
  });

  it('refuses a lane that is not Codex without touching the CLI', async () => {
    const { call, runCodexQueue } = harness({ agent: { ...AGENT, kind: 'claude' } });
    await expect(call('hello')).rejects.toBeInstanceOf(UnsupportedRuntimeError);
    expect(runCodexQueue).not.toHaveBeenCalled();
  });

  it('refuses rather than guessing when the lane’s session cannot be identified', async () => {
    const { call, runCodexQueue } = harness({ thread: null });
    await expect(call('hello')).rejects.toBeInstanceOf(AgentUnreachableError);
    expect(runCodexQueue).not.toHaveBeenCalled();
  });
});
