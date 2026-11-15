// Soph telling a running lane something, in Nick's own words.
//
// THE GAP THIS CLOSES. Slack pings reach a Codex lane as one fixed sentence:
// "Agent Comms ping from X — go read Slack." There was no way to hand a lane
// arbitrary text mid-flight, so "tell Astra to skip the migration" meant
// killing the lane and respawning it with an amended brief, which throws away
// everything it had worked out. That happened twice in one day.
//
// WHY THIS REUSES `codex queue` AND NOT KEYSTROKES. The CLI owns an inbound
// channel for exactly this (`codex queue --thread <id> --message <text>`, CLI
// 0.155.1). The session consumes it itself: idle lanes take it at once, busy
// lanes at the next turn boundary. Typing into the terminal instead lands
// bytes in the middle of whatever the agent was composing, which is what made
// the old injection path drop and garble messages. The transport, the thread
// resolution and the transcript confirmation are all the shipped queue-delivery
// module; this adds the envelope and the honest reporting on top.
//
// WHAT IT REFUSES TO PRETEND. `codex queue` returning 0 means the CLI accepted
// the message, not that the agent read it, and a transcript entry means the
// agent received it, not that it acted on it. Those are three different facts
// and the result keeps them apart.

import {
  buildRelayEnvelope,
  deliverViaQueue,
  type CodexThreadIndex,
  type QueueDeliveryDeps,
} from './queue-delivery';

export class AgentNotFoundError extends Error {
  override name = 'AgentNotFoundError';
}
export class AgentUnreachableError extends Error {
  override name = 'AgentUnreachableError';
}
export class UnsupportedRuntimeError extends Error {
  override name = 'UnsupportedRuntimeError';
}

/** Just enough of an AgentRecord to find and address a lane. */
export interface RelayTargetAgent {
  persona: string;
  kind: string;
  cwd: string;
  pid: number;
  connectedAt: number;
  activity: string;
}

export interface RelayTextInput {
  persona: string;
  text: string;
  sender?: string | null;
  confirmTimeoutMs?: number | null;
}

export interface RelayTextResult {
  persona: string;
  kind: string;
  activity: string;
  delivery: 'confirmed' | 'queued';
  transport: 'codex_queue';
  thread_id: string;
  delivery_id: string;
  /** Length of the caller's text, so a relay can be reported without echoing it. */
  text_chars: number;
  queued_message_id?: string;
  confirmed_in_ms?: number;
  execution_verified: false;
  note: string;
}

export interface RelayTextDeps {
  /** The live agent registry entry for this persona, or undefined. */
  findAgent(persona: string): RelayTargetAgent | undefined;
  threadIndex: Pick<CodexThreadIndex, 'lookup' | 'forget'>;
  queueDeps: QueueDeliveryDeps;
  sessionsRoot: string;
  cliPath: string;
  defaultSender: string;
  newDeliveryId(): string;
}

// Measured 2026-09-21 against codex-cli 0.155.1, from four session rollouts:
// a queued message enters the transcript AT THE TURN BOUNDARY, not on arrival.
// A lane counting 1..8 completed that turn untouched (…26.770) and the relay
// appeared 32ms later (…26.802) as the next turn.
//
// So a confirmation proves the lane has TAKEN the text, and how long it takes
// is set by how long the current turn has left to run — not by the CLI. On a
// lane with a long turn in flight the default confirm window will expire and
// the honest answer is `queued`, which is what this returns. Do not shorten
// the window to make confirmations look faster; it would only relabel the
// same delivery.
const CONFIRMED_NOTE =
  'The lane has taken this text: it is in the session transcript. Taken is not read and read is not done — ask '
  + 'the lane, or watch what it does, before reporting that it complied.';

const QUEUED_NOTE =
  'The CLI accepted this text for the lane, and the lane has not taken it yet. That is the ordinary answer for a '
  + 'lane with a long turn in flight: Codex hands a queued message over at the turn boundary, however long that '
  + 'takes. Do not resend — a second copy would arrive alongside the first. Check the lane again shortly.';

/**
 * Hands free-form text to one running lane.
 *
 * Never sends to a lane it cannot name exactly: a persona with no live
 * registry entry is a 404 rather than a guess at the nearest match, and a
 * Codex session whose thread cannot be resolved is a refusal rather than a
 * broadcast. Delivering to the wrong agent is worse than not delivering.
 */
export async function relayTextToAgent(
  input: RelayTextInput,
  deps: RelayTextDeps,
): Promise<RelayTextResult> {
  const agent = deps.findAgent(input.persona);
  if (!agent) {
    throw new AgentNotFoundError(
      `No live agent named ${input.persona}. List the fleet again; personas change when a lane is respawned.`,
    );
  }

  if (agent.kind !== 'codex') {
    throw new UnsupportedRuntimeError(
      `${agent.persona} is a ${agent.kind} lane. This route delivers over the Codex CLI message queue; `
      + `${agent.kind} lanes receive messages over their bridge socket.`,
    );
  }

  const thread = await deps.threadIndex.lookup(
    { persona: agent.persona, cwd: agent.cwd, pid: agent.pid, connectedAt: agent.connectedAt },
    deps.queueDeps,
    deps.sessionsRoot,
  );

  if (!thread) {
    throw new AgentUnreachableError(
      `Could not identify the Codex session behind ${agent.persona}. Nothing was sent. `
      + 'This happens when the lane has exited, or when two Codex sessions share a directory and the '
      + 'process tree cannot be read — delivering to the wrong one is worse than not delivering.',
    );
  }

  const envelope = buildRelayEnvelope({
    sender: input.sender?.trim() || deps.defaultSender,
    text: input.text,
    deliveryId: deps.newDeliveryId(),
  });

  const outcome = await deliverViaQueue(
    {
      cliPath: deps.cliPath,
      threadId: thread.threadId,
      rolloutPath: thread.rolloutPath,
      message: envelope.message,
      marker: envelope.marker,
      ...(typeof input.confirmTimeoutMs === 'number' ? { confirmTimeoutMs: input.confirmTimeoutMs } : {}),
    },
    deps.queueDeps,
  );

  const base = {
    persona: agent.persona,
    kind: agent.kind,
    activity: agent.activity,
    transport: 'codex_queue' as const,
    thread_id: thread.threadId,
    delivery_id: envelope.deliveryId,
    text_chars: input.text.length,
    execution_verified: false as const,
  };

  if (outcome.ok) {
    return {
      ...base,
      delivery: 'confirmed',
      ...(outcome.queuedMessageId ? { queued_message_id: outcome.queuedMessageId } : {}),
      confirmed_in_ms: outcome.confirmedInMs,
      note: CONFIRMED_NOTE,
    };
  }

  // The CLI would not take it, so nothing is pending anywhere. Forget the
  // cached thread: the usual cause is that the session behind it is gone.
  if (outcome.stage === 'queue') {
    deps.threadIndex.forget(agent.persona);
    throw new AgentUnreachableError(`Nothing was sent to ${agent.persona}: ${outcome.reason}`);
  }

  // Accepted but not yet visible. Reported as a send, because a resend here is
  // how a lane ends up reading the same instruction twice.
  return {
    ...base,
    delivery: 'queued',
    ...(outcome.queuedMessageId ? { queued_message_id: outcome.queuedMessageId } : {}),
    note: QUEUED_NOTE,
  };
}
