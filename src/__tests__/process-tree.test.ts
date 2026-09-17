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

/**
 * Answers each `ps` invocation according to the columns it asked for, and
 * records the argument lists so a test can assert which listings were run.
 */
function mockPsCalls(options: { parents: string; terminals?: string; terminalsError?: Error }): string[][] {
  const calls: string[][] = [];
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push(args);
    const wantsTty = args.join(' ').includes('tty=');
    if (wantsTty && options.terminalsError) {
      callback(options.terminalsError);
      return {} as never;
    }

    callback(null, { stdout: wantsTty ? options.terminals ?? '' : options.parents, stderr: '' });
    return {} as never;
  }) as typeof execFile);

  return calls;
}

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
    mockPsCalls({
      parents: '10 1\n20 10\n30 20\n',
      terminals: '10 30 ttys001\n20 30 ttys001\n30 30 ttys001\n',
    });

    const context = await collectPidTerminalMatchContext(30);

    expect([...context.lineage]).toEqual([30, 20, 10, 1]);
    expect([...context.ttys]).toEqual(['ttys001']);
    expect([...context.tpgids]).toEqual([30]);
    expect(formatPidTerminalMatchContext(30, context))
      .toBe('pid=30 lineage=[30 -> 20 -> 10 -> 1] ttys=[ttys001] tpgids=[30]');
  });

  it('never asks for the tty column when only the lineage is wanted', async () => {
    // Listing tty can wedge on a stale terminal device, so ancestry must not
    // pay for it. This is what made the hub hang while matching terminals.
    const calls = mockPsCalls({ parents: '10 1\n20 10\n30 20\n', terminals: '' });

    const lineage = await collectPidAncestry(30);

    expect([...lineage]).toEqual([30, 20, 10, 1]);
    expect(calls.map((args) => args.join(' '))).toEqual(['-Ao pid=,ppid=']);
  });

  it('still returns the lineage when the tty listing stalls', async () => {
    mockPsCalls({ parents: '10 1\n20 10\n30 20\n', terminalsError: new Error('timed out') });

    const context = await collectPidTerminalMatchContext(30);

    expect([...context.lineage]).toEqual([30, 20, 10, 1]);
    expect([...context.ttys]).toEqual([]);
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
