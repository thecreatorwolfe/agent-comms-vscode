import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  collectPidAncestry,
  collectPidTerminalMatchContext,
  formatPidTerminalMatchContext,
} from '../process-tree';

describe('collectPidAncestry', () => {
  it('returns the process lineage from child to root ancestor', async () => {
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, {
        stdout: '10 1\n20 10\n30 20\n',
        stderr: '',
      });
      return {} as never;
    }) as typeof execFile);

    const lineage = await collectPidAncestry(30);

    expect([...lineage]).toEqual([30, 20, 10, 1]);
  });

  it('collects terminal tty metadata alongside the pid lineage', async () => {
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, {
        stdout: '10 1 30 ttys001\n20 10 30 ttys001\n30 20 30 ttys001\n',
        stderr: '',
      });
      return {} as never;
    }) as typeof execFile);

    const context = await collectPidTerminalMatchContext(30);

    expect([...context.lineage]).toEqual([30, 20, 10, 1]);
    expect([...context.ttys]).toEqual(['ttys001']);
    expect([...context.tpgids]).toEqual([30]);
    expect(formatPidTerminalMatchContext(30, context))
      .toBe('pid=30 lineage=[30 -> 20 -> 10 -> 1] ttys=[ttys001] tpgids=[30]');
  });

  it('falls back to the starting pid when ps lookup fails', async () => {
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      callback(new Error('ps unavailable'));
      return {} as never;
    }) as typeof execFile);

    const lineage = await collectPidAncestry(77);
    const context = await collectPidTerminalMatchContext(77);

    expect([...lineage]).toEqual([77]);
    expect([...context.lineage]).toEqual([77]);
    expect([...context.ttys]).toEqual([]);
    expect([...context.tpgids]).toEqual([]);
  });
});
