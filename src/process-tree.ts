import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export interface ProcessMatchContext {
  lineage: Set<number>;
  ttys: Set<string>;
  tpgids: Set<number>;
}

// Listing the tty column can wedge indefinitely when the machine holds a stale
// terminal device, and it took the hub's terminal matching down with it. Parent
// lookups therefore never ask for tty, and the terminal query is both separate
// and time-boxed so a stall degrades to "no terminal data" instead of a hang.
const PARENT_PS_TIMEOUT_MS = 4_000;
const TERMINAL_PS_TIMEOUT_MS = 2_000;
const PS_MAX_BUFFER = 1024 * 1024;

async function readParentByPid(): Promise<Map<number, number>> {
  const parentByPid = new Map<number, number>();
  try {
    const { stdout } = await execFile('ps', ['-Ao', 'pid=,ppid='], {
      encoding: 'utf8',
      maxBuffer: PS_MAX_BUFFER,
      timeout: PARENT_PS_TIMEOUT_MS,
    });

    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const [pidText, parentText] = line.split(/\s+/, 2);
      const childPid = Number(pidText);
      const parentPid = Number(parentText);
      if (Number.isInteger(childPid) && childPid > 0 && Number.isInteger(parentPid) && parentPid > 0) {
        parentByPid.set(childPid, parentPid);
      }
    }
  } catch {
    // No process listing available; callers fall back to the pid they were given.
  }

  return parentByPid;
}

async function readTerminalByPid(): Promise<{ ttyByPid: Map<number, string>; tpgidByPid: Map<number, number> }> {
  const ttyByPid = new Map<number, string>();
  const tpgidByPid = new Map<number, number>();
  try {
    const { stdout } = await execFile('ps', ['-Ao', 'pid=,tpgid=,tty='], {
      encoding: 'utf8',
      maxBuffer: PS_MAX_BUFFER,
      timeout: TERMINAL_PS_TIMEOUT_MS,
    });

    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const [pidText, tpgidText, ttyText] = line.split(/\s+/, 3);
      const childPid = Number(pidText);
      const terminalProcessGroupId = Number(tpgidText);
      if (!Number.isInteger(childPid) || childPid <= 0) {
        continue;
      }

      if (Number.isInteger(terminalProcessGroupId) && terminalProcessGroupId > 0) {
        tpgidByPid.set(childPid, terminalProcessGroupId);
      }

      if (ttyText && ttyText !== '?' && ttyText !== '??') {
        ttyByPid.set(childPid, ttyText);
      }
    }
  } catch {
    // A wedged tty device times out here rather than blocking the caller.
  }

  return { ttyByPid, tpgidByPid };
}

function walkLineage(pid: number, parentByPid: Map<number, number>): number[] {
  const lineage: number[] = [];
  const seen = new Set<number>();
  let currentPid = pid;

  while (Number.isInteger(currentPid) && currentPid > 0 && !seen.has(currentPid)) {
    seen.add(currentPid);
    lineage.push(currentPid);
    const parentPid = parentByPid.get(currentPid);
    if (!parentPid || parentPid === currentPid) {
      break;
    }

    currentPid = parentPid;
  }

  return lineage;
}

async function collectPidMatchContext(pid: number, withTerminal: boolean): Promise<ProcessMatchContext> {
  const lineage = new Set<number>();
  const ttys = new Set<string>();
  const tpgids = new Set<number>();
  if (!Number.isInteger(pid) || pid <= 0) {
    return { lineage, ttys, tpgids };
  }

  lineage.add(pid);

  const parentByPid = await readParentByPid();
  const walked = walkLineage(pid, parentByPid);
  for (const ancestor of walked) {
    lineage.add(ancestor);
  }

  if (!withTerminal) {
    return { lineage, ttys, tpgids };
  }

  const { ttyByPid, tpgidByPid } = await readTerminalByPid();
  for (const ancestor of walked) {
    const tty = ttyByPid.get(ancestor);
    if (tty) {
      ttys.add(tty);
    }

    const tpgid = tpgidByPid.get(ancestor);
    if (tpgid) {
      tpgids.add(tpgid);
    }
  }

  return { lineage, ttys, tpgids };
}

export async function collectPidAncestry(pid: number): Promise<Set<number>> {
  return (await collectPidMatchContext(pid, false)).lineage;
}

export async function collectPidTerminalMatchContext(pid: number): Promise<ProcessMatchContext> {
  return collectPidMatchContext(pid, true);
}

export function formatPidTerminalMatchContext(pid: number, context: ProcessMatchContext): string {
  const lineage = [...context.lineage].join(' -> ');
  const ttys = [...context.ttys].join(', ');
  const tpgids = [...context.tpgids].join(', ');
  return `pid=${pid} lineage=[${lineage || 'none'}] ttys=[${ttys || 'none'}] tpgids=[${tpgids || 'none'}]`;
}
