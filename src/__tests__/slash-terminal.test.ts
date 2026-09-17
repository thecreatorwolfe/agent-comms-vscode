import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ terminals: [] as any[] }));
vi.mock('vscode', () => ({ window: state, commands: { executeCommand: vi.fn() }, workspace: { name: 'fixture', workspaceFolders: [] } }));
import { foregroundAgent, parseProcesses, startSlashTerminalBridge, validateSlashCommand } from '../slash-terminal';

describe('slash command terminal bridge', () => {
  it('accepts slash commands and arguments but never multi-line/control sequences or shell input', () => {
    for (const command of ['/compact', '/compact preserve recent decisions', '/plugin:command arg', '/model']) expect(validateSlashCommand(command)).toBe(true);
    for (const command of ['', 'ls', '/compact\n', '/compact\r/exit', '/compact\u001b', '/compact \u0085', '/compact\u2028x', '/tmp/script.sh', '/a'.repeat(2000)]) expect(validateSlashCommand(command)).toBe(false);
  });
  it('requires exactly one foreground CLI in this terminal ancestry and excludes helper processes', () => {
    const rows = parseProcesses('10 1 10 20 /bin/zsh\n20 10 20 20 /path with spaces/codex\n21 20 21 20 /bin/codex-code-mode-host\n30 1 30 30 /bin/claude');
    expect(foregroundAgent(10, rows)).toEqual({ pid: 20, kind: 'codex' });
    expect(foregroundAgent(30, rows)).toEqual({ pid: 30, kind: 'claude' });
    expect(foregroundAgent(99, rows)).toBe(null);
    expect(foregroundAgent(10, parseProcesses('10 1 10 10 zsh\n20 10 20 20 codex'))).toBe(null);
    expect(foregroundAgent(10, [...rows, { pid: 22, ppid: 20, pgid: 20, tpgid: 20, command: 'claude' }])).toBe(null);
    expect(foregroundAgent(10, rows.map(r => ({ ...r, tpgid: 10 })))).toBe(null);
  });
  it('routes one request to the exact terminal and rejects unauthenticated, changed, closed, and malformed targets', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slash-bridge-'));
    const a = { name: 'same-name', processId: Promise.resolve(10), sendText: vi.fn(), show: vi.fn() };
    const b = { name: 'same-name', processId: Promise.resolve(30), sendText: vi.fn(), show: vi.fn() };
    state.terminals = [a, b];
    let rows = parseProcesses('10 1 10 20 zsh\n20 10 20 20 codex\n30 1 30 40 zsh\n40 30 40 40 claude');
    const bridge = await startSlashTerminalBridge(() => {}, { directory, readProcesses: async () => rows });
    try {
      const file = (await fs.readdir(directory))[0];
      expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
      const m = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
      const call = (route: string, body?: unknown, auth = true) => fetch(`http://127.0.0.1:${m.port}${route}`, {
        method: body ? 'POST' : 'GET', headers: { ...(auth ? { Authorization: `Bearer ${m.secret}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect((await call('/targets', undefined, false)).status).toBe(401);
      const listing = await (await call('/targets')).json();
      expect(listing.targets).toHaveLength(2);
      expect((await call('/reveal', { target_id: listing.targets[1].target_id })).status).toBe(200);
      expect(b.show).toHaveBeenCalledWith(false);
      expect(b.sendText).not.toHaveBeenCalled();
      const input = { target_id: listing.targets[1].target_id, agent_pid: 40, command: '/compact', ready_for_input: true };
      const response = await call('/slash-command', input);
      expect(await response.json()).toMatchObject({ status: 'submitted', execution_verified: false, kind: 'claude' });
      expect(a.sendText).not.toHaveBeenCalled();
      expect(b.sendText).toHaveBeenCalledTimes(2);
      expect(b.sendText).toHaveBeenNthCalledWith(1, '/compact', false);
      expect(b.sendText).toHaveBeenNthCalledWith(2, '\r', false);
      for (const bad of [{ ...input, command: 'echo bad' }, { ...input, ready_for_input: false }, { ...input, command: '/compact\n/exit' }]) expect((await call('/slash-command', bad)).status).toBe(400);
      rows = rows.filter(r => r.pid !== 40);
      expect((await call('/slash-command', input)).status).toBe(409);
      state.terminals = [a];
      expect((await call('/slash-command', input)).status).toBe(409);
      expect(b.sendText).toHaveBeenCalledTimes(2);
    } finally { bridge.dispose(); state.terminals = []; await fs.rm(directory, { recursive: true, force: true }); }
  });
});
