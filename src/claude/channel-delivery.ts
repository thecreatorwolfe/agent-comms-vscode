// Soph telling a running Claude lane something, over the lane's own bridge socket.
//
// WHY THE BRIDGE SOCKET. Every Claude lane is launched with the agent-comms
// channel (`--dangerously-load-development-channels server:agent-comms`). Its
// bridge holds a WebSocket to this gateway, and an `event` frame pushed down
// that socket is surfaced to the session as a `notifications/claude/channel`
// message: the route Slack pings already take into Claude lanes. Claude Code
// queues channel input like any other input, so a lane in the middle of a turn
// is not typed over. It takes the message the way it takes a queued prompt.
//
// WHY NOT CLAUDE CODE'S OWN PEER SOCKET. Claude Code sessions also listen on
// `/tmp/cc-socks/<pid>.sock` for cross-session messages. That protocol is
// internal and unversioned from the outside, it changes with every CLI
// auto-update, and it is keyed by per-session files this gateway has no
// business reading. The bridge socket is ours at both ends.
//
// WHAT IS CLAIMED. Three facts, kept apart as on the Codex path:
//   bridge ack ok   -> the session accepted the notification ('queued')
//   marker in transcript -> the lane has taken the text ('confirmed')
//   execution       -> never claimed
// An ack that never arrives is 'unacknowledged': the frame left this process,
// and whether it surfaced is unknown. Never a resend.

import os from 'node:os';
import path from 'node:path';
import type { EventAckFrame, EventFrame } from '../schema/frames';

export interface ClaudeSessionRecord {
  sessionId: string;
  cwd: string;
  name?: string;
  pid: number;
}

export interface ClaudeChannelDeps {
  /** wsGateway.sendEvent: true when the frame was written to the lane's live bridge socket. */
  pushEvent(frame: EventFrame): boolean;
  /** wsGateway.waitForEventAck: the bridge's surface ack, or undefined on timeout. */
  waitForAck(deliveryId: string, timeoutMs: number): Promise<EventAckFrame | undefined>;
  /** The process and its ancestors, nearest first. The bridge's parent is its Claude session. */
  ancestorPids(pid: number): Promise<number[]>;
  /** File contents, or null when the file does not exist (yet). */
  readText(filePath: string): Promise<string | null>;
  listDir(dirPath: string): Promise<string[]>;
  /** Last-modified time in epoch ms, or null when the file is missing. */
  mtimeMs(filePath: string): Promise<number | null>;
  /** ~/.claude, or CLAUDE_CONFIG_DIR. */
  claudeHome: string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ClaudeDeliverInput {
  persona: string;
  /** The bridge process id the lane registered with. */
  pid: number;
  /** The lane's working directory, as its bridge reported it. */
  cwd: string;
  /** Sender line shown above the text in the lane. */
  sender: string;
  /** Full UUID for the frame (the bridge schema requires one). */
  eventId: string;
  /** Marker written into the text so the transcript can confirm this exact delivery. */
  marker: string;
  /** What the lane reads. Already carries the marker. */
  message: string;
  confirmTimeoutMs?: number;
}

export type ClaudeDeliverOutcome =
  | { stage: 'socket'; reason: string }
  | { stage: 'surface'; reason: string }
  | { stage: 'unacknowledged'; session?: ClaudeSessionRecord }
  | { stage: 'queued'; session?: ClaudeSessionRecord }
  | { stage: 'confirmed'; session: ClaudeSessionRecord; confirmedInMs: number };

// The bridge acks once the MCP notification write settles, normally within a
// few ms. Generous, because a timeout here can only downgrade the answer.
const ACK_TIMEOUT_MS = 3_000;
// Same window as the Codex path. A lane mid-turn takes queued input at its next
// boundary; past this window the honest answer is 'queued', not a failure.
const DEFAULT_CONFIRM_TIMEOUT_MS = 8_000;
const CONFIRM_POLL_MS = 400;

export function claudeHomeDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
}

/** Claude Code names a project's transcript folder after its cwd, every non-alphanumeric as '-'. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function parseSessionRecord(text: string | null, pid: number): ClaudeSessionRecord | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
    return {
      sessionId: raw.sessionId,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      pid: typeof raw.pid === 'number' ? raw.pid : pid,
    };
  } catch {
    return null;
  }
}

/**
 * Which Claude session sits behind a lane's bridge.
 *
 * First by process tree: Claude Code writes `sessions/<pid>.json` for itself,
 * and the bridge is its child. Then, only if that finds nothing, by name: the
 * lane is launched with `-n <persona>`, and exactly one live record must carry
 * it. Used only to confirm, never to address, so a miss costs a confirmation,
 * not a delivery.
 */
export async function locateClaudeSession(
  persona: string,
  pid: number,
  deps: Pick<ClaudeChannelDeps, 'ancestorPids' | 'readText' | 'listDir' | 'claudeHome'>,
): Promise<ClaudeSessionRecord | null> {
  const sessionsDir = path.join(deps.claudeHome, 'sessions');
  let lineage: number[] = [];
  try { lineage = await deps.ancestorPids(pid); } catch { lineage = []; }
  for (const candidate of lineage) {
    const record = parseSessionRecord(await deps.readText(path.join(sessionsDir, `${candidate}.json`)), candidate);
    if (record) return record;
  }

  let files: string[] = [];
  try { files = (await deps.listDir(sessionsDir)).filter((f) => /^\d+\.json$/.test(f)); } catch { files = []; }
  const named: ClaudeSessionRecord[] = [];
  for (const file of files) {
    const record = parseSessionRecord(await deps.readText(path.join(sessionsDir, file)), Number.parseInt(file, 10));
    if (record?.name === persona) named.push(record);
  }
  return named.length === 1 ? named[0] : null;
}

/** The session's transcript: under its cwd's folder, else wherever the session id turns up. */
export async function locateTranscript(
  session: ClaudeSessionRecord,
  deps: Pick<ClaudeChannelDeps, 'listDir' | 'claudeHome'>,
): Promise<string> {
  const projects = path.join(deps.claudeHome, 'projects');
  const file = `${session.sessionId}.jsonl`;
  if (session.cwd) {
    const direct = path.join(projects, projectSlug(session.cwd));
    try { if ((await deps.listDir(direct)).includes(file)) return path.join(direct, file); } catch { /* fall through */ }
  }
  try {
    for (const dir of await deps.listDir(projects)) {
      try { if ((await deps.listDir(path.join(projects, dir))).includes(file)) return path.join(projects, dir, file); } catch { /* not a dir */ }
    }
  } catch { /* no projects folder */ }
  // Not written yet: a fresh session creates it on first input. Poll the expected place.
  return path.join(projects, projectSlug(session.cwd), file);
}

/**
 * Pushes one event frame to a Claude lane and reports how far it provably got.
 * Exactly one frame is ever written; nothing here retries.
 */
export async function deliverViaClaudeChannel(
  input: ClaudeDeliverInput,
  deps: ClaudeChannelDeps,
): Promise<ClaudeDeliverOutcome> {
  // Located before sending: a transcript read after the push could race the
  // marker into the "before" snapshot.
  const session = await locateClaudeSession(input.persona, input.pid, deps);
  const transcriptPath = session ? await locateTranscript(session, deps) : null;
  const before = transcriptPath ? (await deps.readText(transcriptPath)) ?? '' : '';
  if (before.includes(input.marker)) {
    // A marker is fresh per delivery; seeing it already means something is wrong with the id source.
    return { stage: 'socket', reason: 'the delivery marker is already in the lane transcript; refusing to send a duplicate' };
  }

  const frame: EventFrame = {
    type: 'event',
    delivery_id: input.eventId,
    from_persona: input.sender,
    to_persona: input.persona,
    thread_ts: '',
    body_raw: input.message,
    body_parsed: { relay: true, marker: input.marker },
    slack_ts: '',
  };

  const startedAt = deps.now();
  if (!deps.pushEvent(frame)) {
    return { stage: 'socket', reason: 'the lane has no live bridge socket' };
  }

  const ack = await deps.waitForAck(input.eventId, ACK_TIMEOUT_MS);
  if (!ack) return { stage: 'unacknowledged', ...(session ? { session } : {}) };
  if (ack.surface_status !== 'ok') {
    return { stage: 'surface', reason: 'the bridge received it but Claude Code did not accept the channel notification' };
  }

  const deadline = startedAt + (input.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS);
  for (;;) {
    const found = session && transcriptPath
      ? ((await deps.readText(transcriptPath)) ?? '').includes(input.marker) ? session : null
      : await findMarkerInFreshTranscripts(input.cwd, input.marker, startedAt, deps);
    if (found) return { stage: 'confirmed', session: found, confirmedInMs: deps.now() - startedAt };
    if (deps.now() >= deadline) return { stage: 'queued', ...(session ? { session } : {}) };
    await deps.sleep(CONFIRM_POLL_MS);
  }
}

/**
 * Fallback when no session record names the lane (Claude Code does not write
 * one for every session). The marker is fresh per delivery, so it can only
 * appear in the transcript of the session that took it; only transcripts in
 * the lane's own project folder that changed since the push are read.
 */
async function findMarkerInFreshTranscripts(
  cwd: string,
  marker: string,
  sinceMs: number,
  deps: Pick<ClaudeChannelDeps, 'listDir' | 'mtimeMs' | 'readText' | 'claudeHome'>,
): Promise<ClaudeSessionRecord | null> {
  if (!cwd) return null;
  const dir = path.join(deps.claudeHome, 'projects', projectSlug(cwd));
  let names: string[] = [];
  try { names = (await deps.listDir(dir)).filter((n) => n.endsWith('.jsonl')); } catch { return null; }
  const hits: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const mtime = await deps.mtimeMs(file);
    if (mtime === null || mtime < sinceMs - 1_000) continue;
    if (((await deps.readText(file)) ?? '').includes(marker)) hits.push(name);
  }
  return hits.length === 1 ? { sessionId: hits[0].replace(/\.jsonl$/, ''), cwd, pid: 0 } : null;
}
