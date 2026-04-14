import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

export function normalizeTtyName(raw: string): string | undefined {
  const normalized = raw.trim();
  if (!normalized || normalized === '?' || normalized === '??') {
    return undefined;
  }

  return normalized;
}

async function resolveProcessTtyWithPs(pid: number): Promise<string | undefined> {
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'tty=']);
  return normalizeTtyName(stdout);
}

export async function wakeProcessTty(
  pid: number,
  options: {
    logger?: Logger;
    resolveProcessTty?: (pid: number) => Promise<string | undefined>;
    writeFile?: (filePath: string, data: string) => Promise<void>;
  } = {},
): Promise<boolean> {
  const resolveProcessTty = options.resolveProcessTty ?? resolveProcessTtyWithPs;
  const writeFile = options.writeFile ?? fs.writeFile;

  try {
    const tty = await resolveProcessTty(pid);
    if (!tty) {
      options.logger?.warn({ pid }, 'could not resolve tty for idle agent wake');
      return false;
    }

    const devicePath = path.join('/dev', tty);
    await writeFile(devicePath, '\u001b');
    options.logger?.info({ pid, tty }, 'sent tty escape to wake idle agent');
    return true;
  } catch (error) {
    options.logger?.warn({ err: error, pid }, 'failed to wake idle agent via tty');
    return false;
  }
}
