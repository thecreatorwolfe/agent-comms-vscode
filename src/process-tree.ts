import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export interface ProcessMatchContext {
  lineage: Set<number>;
  ttys: Set<string>;
  tpgids: Set<number>;
}

async function collectPidMatchContext(pid: number): Promise<ProcessMatchContext> {
  const lineage = new Set<number>();
  const ttys = new Set<string>();
  const tpgids = new Set<number>();
  if (!Number.isInteger(pid) || pid <= 0) {
    return { lineage, ttys, tpgids };
  }

  lineage.add(pid);

  try {
    const { stdout } = await execFile('ps', ['-Ao', 'pid=,ppid=,tpgid=,tty='], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const parentByPid = new Map<number, number>();
    const ttyByPid = new Map<number, string>();
    const tpgidByPid = new Map<number, number>();
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const [pidText, parentText, tpgidText, ttyText] = line.split(/\s+/, 4);
      const childPid = Number(pidText);
      const parentPid = Number(parentText);
      const terminalProcessGroupId = Number(tpgidText);
      if (Number.isInteger(childPid) && childPid > 0 && Number.isInteger(parentPid) && parentPid > 0) {
        parentByPid.set(childPid, parentPid);
      }
      if (Number.isInteger(childPid) && childPid > 0 && Number.isInteger(terminalProcessGroupId) && terminalProcessGroupId > 0) {
        tpgidByPid.set(childPid, terminalProcessGroupId);
      }
      if (Number.isInteger(childPid) && childPid > 0 && ttyText && ttyText !== '?' && ttyText !== '??') {
        ttyByPid.set(childPid, ttyText);
      }
    }

    let currentPid = pid;
    const seen = new Set<number>();
    while (Number.isInteger(currentPid) && currentPid > 0 && !seen.has(currentPid)) {
      seen.add(currentPid);
      lineage.add(currentPid);
      const tty = ttyByPid.get(currentPid);
      if (tty) {
        ttys.add(tty);
      }
      const tpgid = tpgidByPid.get(currentPid);
      if (tpgid) {
        tpgids.add(tpgid);
      }
      const parentPid = parentByPid.get(currentPid);
      if (!parentPid || parentPid === currentPid) {
        break;
      }
      currentPid = parentPid;
    }
  } catch {
    // Fall back to the original pid only if process listing is unavailable.
  }

  return { lineage, ttys, tpgids };
}

export async function collectPidAncestry(pid: number): Promise<Set<number>> {
  return (await collectPidMatchContext(pid)).lineage;
}

export async function collectPidTerminalMatchContext(pid: number): Promise<ProcessMatchContext> {
  return collectPidMatchContext(pid);
}

export function formatPidTerminalMatchContext(pid: number, context: ProcessMatchContext): string {
  const lineage = [...context.lineage].join(' -> ');
  const ttys = [...context.ttys].join(', ');
  const tpgids = [...context.tpgids].join(', ');
  return `pid=${pid} lineage=[${lineage || 'none'}] ttys=[${ttys || 'none'}] tpgids=[${tpgids || 'none'}]`;
}
