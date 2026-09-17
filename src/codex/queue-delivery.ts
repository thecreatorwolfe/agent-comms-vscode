// Inbound delivery for Codex agents that does not depend on the terminal.
//
// `codex queue --thread <id> --message <text>` hands a message to a running
// Codex session through the CLI itself. An idle session picks it up right away;
// a busy session consumes it at the next turn boundary. Neither path needs the
// VS Code terminal to accept synthetic keystrokes, which is what made the older
// prompt-injection path drop messages.
//
// The CLI reports success even when no session is listening, so every delivery
// is confirmed against the target session's rollout transcript before it counts.

import { execFile } from 'node:child_process';
import { readdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexSessionMeta {
  threadId: string;
  cwd: string;
  startedAtMs: number;
}

export interface QueueRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface QueueDeliveryDeps {
  listRolloutFiles(sessionsRoot: string): Promise<string[]>;
  /**
   * The whole first line of a transcript. It carries the session's base
   * instructions, so it routinely runs past 8KB and must not be read with a
   * fixed-size window.
   */
  readFirstLine(path: string): Promise<string>;
  readText(path: string): Promise<string>;
  runCodexQueue(input: { cliPath: string; threadId: string; message: string }): Promise<QueueRunResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ResolveThreadInput {
  cwd: string;
  /** Epoch ms the agent registered; sessions older than this are not the agent's. */
  notBeforeMs: number;
  sessionsRoot: string;
  /** Clock skew allowance between agent registration and session start. */
  toleranceMs?: number;
}

export interface ResolvedThread {
  threadId: string;
  rolloutPath: string;
  startedAtMs: number;
}

export interface DeliverInput {
  cliPath: string;
  threadId: string;
  rolloutPath: string;
  message: string;
  /** Substring that must appear in the transcript for the delivery to count. */
  marker: string;
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
}

export type DeliveryOutcome =
  | { ok: true; queuedMessageId?: string; confirmedInMs: number }
  | { ok: false; reason: string; queuedMessageId?: string };

const DEFAULT_TOLERANCE_MS = 120_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 8_000;
const DEFAULT_CONFIRM_POLL_MS = 400;
const FIRST_LINE_CHUNK_BYTES = 65_536;
const FIRST_LINE_MAX_BYTES = 4_194_304;

export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim().length > 0 ? env.CODEX_HOME : join(homedir(), '.codex');
  return join(home, 'sessions');
}

/** A rollout's first line is its `session_meta` record. */
export function parseSessionMeta(headText: string): CodexSessionMeta | null {
  const firstLine = headText.split('\n').find((line) => line.trim().length > 0);
  if (!firstLine) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const row = parsed as { timestamp?: unknown; payload?: unknown };
  const payload = (typeof row.payload === 'object' && row.payload !== null ? row.payload : {}) as {
    session_id?: unknown;
    id?: unknown;
    cwd?: unknown;
    timestamp?: unknown;
  };

  const threadId = typeof payload.session_id === 'string'
    ? payload.session_id
    : typeof payload.id === 'string' ? payload.id : undefined;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  if (!threadId || !cwd) {
    return null;
  }

  const stamp = typeof payload.timestamp === 'string'
    ? payload.timestamp
    : typeof row.timestamp === 'string' ? row.timestamp : undefined;
  const startedAtMs = stamp ? Date.parse(stamp) : Number.NaN;

  return {
    threadId,
    cwd,
    startedAtMs: Number.isNaN(startedAtMs) ? 0 : startedAtMs,
  };
}

/**
 * Finds the newest Codex session started in the agent's working directory at or
 * after the agent registered. Sessions are keyed by cwd because that is the only
 * identifier shared between what the extension spawns and what Codex records.
 */
export async function resolveThreadForAgent(
  input: ResolveThreadInput,
  deps: QueueDeliveryDeps,
): Promise<ResolvedThread | null> {
  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const floor = input.notBeforeMs - tolerance;
  const files = await deps.listRolloutFiles(input.sessionsRoot);

  // Transcript names carry their start time, so newest-first ordering lets the
  // first match win. Metadata lines are large; reading every one of them to
  // sort properly would cost megabytes per lookup.
  const newestFirst = [...files].sort().reverse();

  for (const file of newestFirst) {
    let head: string;
    try {
      head = await deps.readFirstLine(file);
    } catch {
      continue;
    }

    const meta = parseSessionMeta(head);
    if (!meta || meta.cwd !== input.cwd || meta.startedAtMs < floor) {
      continue;
    }

    return { threadId: meta.threadId, rolloutPath: file, startedAtMs: meta.startedAtMs };
  }

  return null;
}

export function parseQueuedMessageId(stdout: string): string | undefined {
  const match = /Queued message ([0-9a-fA-F-]{8,})/.exec(stdout);
  return match ? match[1] : undefined;
}

/**
 * True once the transcript holds an entry that carries the marker and is not
 * older than the moment the message was queued. Timestamp gating keeps a repeat
 * ping from being confirmed by the previous one.
 */
export function transcriptHasDelivery(transcript: string, marker: string, queuedAtMs: number): boolean {
  for (const line of transcript.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.includes(marker)) {
      continue;
    }

    let row: { timestamp?: unknown };
    try {
      row = JSON.parse(trimmed) as { timestamp?: unknown };
    } catch {
      continue;
    }

    const stamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN;
    if (Number.isNaN(stamp) || stamp + 2_000 >= queuedAtMs) {
      return true;
    }
  }

  return false;
}

/** Queues the message, then waits for the transcript to prove it landed. */
export async function deliverViaQueue(
  input: DeliverInput,
  deps: QueueDeliveryDeps,
): Promise<DeliveryOutcome> {
  const queuedAtMs = deps.now();

  let run: QueueRunResult;
  try {
    run = await deps.runCodexQueue({
      cliPath: input.cliPath,
      threadId: input.threadId,
      message: input.message,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `codex queue failed to run: ${detail}` };
  }

  if (run.code !== 0) {
    const detail = (run.stderr || run.stdout || '').trim().split('\n')[0] ?? '';
    return { ok: false, reason: `codex queue exit ${run.code}${detail ? `: ${detail}` : ''}` };
  }

  const queuedMessageId = parseQueuedMessageId(run.stdout);
  const timeout = input.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const poll = input.confirmPollMs ?? DEFAULT_CONFIRM_POLL_MS;
  const deadline = queuedAtMs + timeout;

  for (;;) {
    let transcript = '';
    try {
      transcript = await deps.readText(input.rolloutPath);
    } catch {
      transcript = '';
    }

    if (transcriptHasDelivery(transcript, input.marker, queuedAtMs)) {
      return { ok: true, queuedMessageId, confirmedInMs: deps.now() - queuedAtMs };
    }

    if (deps.now() >= deadline) {
      return {
        ok: false,
        reason: `queued but unconfirmed after ${timeout}ms; session may not be running`,
        queuedMessageId,
      };
    }

    await deps.sleep(poll);
  }
}

async function listRolloutFilesOnDisk(sessionsRoot: string): Promise<string[]> {
  const dayDirs: string[] = [];
  const years = await safeReaddir(sessionsRoot);
  for (const year of years) {
    const months = await safeReaddir(join(sessionsRoot, year));
    for (const month of months) {
      const days = await safeReaddir(join(sessionsRoot, year, month));
      for (const day of days) {
        dayDirs.push(join(sessionsRoot, year, month, day));
      }
    }
  }

  // Sessions relevant to a live agent are always among the most recent days.
  dayDirs.sort();
  const recent = dayDirs.slice(-3);

  const files: string[] = [];
  for (const dir of recent) {
    for (const entry of await safeReaddir(dir)) {
      if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
        files.push(join(dir, entry));
      }
    }
  }

  return files;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readFirstLineOnDisk(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(FIRST_LINE_CHUNK_BYTES);
    let collected = '';
    let position = 0;

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_CHUNK_BYTES, position);
      if (bytesRead === 0) {
        return collected;
      }

      position += bytesRead;
      collected += buffer.subarray(0, bytesRead).toString('utf8');

      const newlineIndex = collected.indexOf('\n');
      if (newlineIndex !== -1) {
        return collected.slice(0, newlineIndex);
      }

      if (position >= FIRST_LINE_MAX_BYTES) {
        return collected;
      }
    }
  } finally {
    await handle.close();
  }
}

function runCodexQueueOnDisk(input: {
  cliPath: string;
  threadId: string;
  message: string;
}): Promise<QueueRunResult> {
  return new Promise((resolve) => {
    execFile(
      input.cliPath,
      ['queue', '--thread', input.threadId, '--message', input.message],
      { timeout: 30_000, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error ? 1 : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

export interface CodexThreadOwner {
  persona: string;
  cwd: string;
  pid: number;
  connectedAt: number;
}

/**
 * Remembers which Codex thread belongs to which persona. A persona keeps its
 * thread until the agent reconnects under a new pid or registration, at which
 * point the old thread is stale and is looked up again.
 */
export class CodexThreadIndex {
  private readonly entries = new Map<string, { pid: number; connectedAt: number; thread: ResolvedThread }>();

  async lookup(
    owner: CodexThreadOwner,
    deps: QueueDeliveryDeps,
    sessionsRoot: string,
  ): Promise<ResolvedThread | null> {
    const cached = this.entries.get(owner.persona);
    if (cached && cached.pid === owner.pid && cached.connectedAt === owner.connectedAt) {
      return cached.thread;
    }

    const thread = await resolveThreadForAgent(
      { cwd: owner.cwd, notBeforeMs: owner.connectedAt, sessionsRoot },
      deps,
    );

    if (thread) {
      this.entries.set(owner.persona, { pid: owner.pid, connectedAt: owner.connectedAt, thread });
    } else {
      this.entries.delete(owner.persona);
    }

    return thread;
  }

  forget(persona: string): void {
    this.entries.delete(persona);
  }

  get size(): number {
    return this.entries.size;
  }
}

export function createQueueDeliveryDeps(): QueueDeliveryDeps {
  return {
    listRolloutFiles: listRolloutFilesOnDisk,
    readFirstLine: readFirstLineOnDisk,
    readText: (path) => readFile(path, 'utf8'),
    runCodexQueue: runCodexQueueOnDisk,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
