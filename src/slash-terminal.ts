import * as vscode from 'vscode';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constantTimeSecretEquals } from './gateway/auth';

const exec = promisify(execFile);
export function validateSlashCommand(command: unknown): command is string {
  return typeof command === 'string' && command.length <= 2000
    && /^\/[a-zA-Z][a-zA-Z0-9_:-]*(?: [^\x00-\x1f\x7f-\x9f\u2028\u2029]*)?$/.test(command);
}

export interface ProcessRow { pid: number; ppid: number; pgid: number; tpgid: number; command: string }
export function parseProcesses(text: string): ProcessRow[] {
  return text.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/);
    return m ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], tpgid: +m[4], command: m[5] }] : [];
  });
}
export function foregroundAgent(root: number, rows: ProcessRow[]) {
  const foregroundGroup = rows.find(row => row.pid === root)?.tpgid;
  if (!foregroundGroup || foregroundGroup <= 0) return null;
  const descendants = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
      descendants.add(row.pid); changed = true;
    }
  }
  const matches = rows.filter(row => descendants.has(row.pid) && row.pgid === foregroundGroup && row.tpgid === foregroundGroup)
    .flatMap(row => {
      const name = path.basename(row.command);
      const kind = /^(codex|claude)$/.exec(name)?.[1];
      return kind ? [{ pid: row.pid, kind }] : [];
    });
  return matches.length === 1 ? matches[0] : null;
}

/** A separate bridge per window: the Slack hub's single port cannot enumerate other windows. */
export async function startSlashTerminalBridge(log: (text: string) => void, options: {
  directory?: string; readProcesses?: () => Promise<ProcessRow[]>;
} = {}) {
  const windowId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const dir = options.directory ?? path.join(os.homedir(), '.agent-comms', 'terminal-windows');
  const manifest = path.join(dir, `${windowId}.json`);
  const targets = new Map<string, vscode.Terminal>();
  const ids = new WeakMap<vscode.Terminal, string>();
  let sending = false;
  const rows = options.readProcesses ?? (async () => parseProcesses((await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,comm='], { maxBuffer: 4 * 1024 * 1024, timeout: 3000 })).stdout));
  const snapshot = async () => {
    const processes = await rows();
    for (const [id, terminal] of targets) if (!vscode.window.terminals.includes(terminal)) targets.delete(id);
    return Promise.all(vscode.window.terminals.map(async terminal => {
      let id = ids.get(terminal);
      if (!id) { id = randomUUID(); ids.set(terminal, id); targets.set(id, terminal); }
      const pid = await terminal.processId;
      const agent = pid ? foregroundAgent(pid, processes) : null;
      return { target_id: `${windowId}:${id}`, name: terminal.name, terminal_pid: pid ?? null,
        agent_pid: agent?.pid ?? null, kind: agent?.kind ?? null, can_submit: !!agent };
    }));
  };
  const server = http.createServer(async (req, res) => {
    let textAttempted = false;
    let enterAttempted = false;
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (!constantTimeSecretEquals(secret, req.headers.authorization?.replace(/^Bearer /, ''))) { reply(401, { error: 'unauthorized' }); return; }
    try {
      if (req.method === 'GET' && req.url === '/targets') {
        reply(200, { window_id: windowId, workspace: vscode.workspace.name ?? '(empty window)',
          folders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [], targets: await snapshot() }); return;
      }
      if (req.method !== 'POST' || !['/slash-command', '/reveal'].includes(req.url ?? '')) { reply(404, { error: 'not_found' }); return; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) { reply(413, { error: 'payload_too_large' }); return; } }
      let input;
      try { input = JSON.parse(body); } catch { reply(400, { error: 'invalid_json' }); return; }
      if (req.url === '/reveal') {
        const target = (await snapshot()).find(t => t.target_id === input?.target_id);
        const terminal = target && targets.get(target.target_id.split(':')[1]);
        if (!terminal) { reply(409, { error: 'target_closed; list targets again' }); return; }
        await vscode.commands.executeCommand('workbench.action.focusWindow');
        terminal.show(false);
        reply(200, { status: 'revealed', target_id: target.target_id, name: target.name,
          note: 'Inspect the visible terminal. Revealing does not establish idle/empty input readiness.' }); return;
      }
      if (!input || !validateSlashCommand(input.command) || input.ready_for_input !== true || typeof input.target_id !== 'string' || !Number.isInteger(input.agent_pid)) {
        reply(400, { error: 'Specify target_id, current agent_pid, one single-line /command, and ready_for_input:true after checking an empty idle prompt.' }); return;
      }
      if (sending) { reply(409, { error: 'window_busy' }); return; }
      sending = true;
      try {
        const target = (await snapshot()).find(t => t.target_id === input.target_id);
        if (!target || !target.can_submit || target.agent_pid !== input.agent_pid) { reply(409, { error: 'target_closed_or_agent_changed; list targets again' }); return; }
        const terminal = targets.get(input.target_id.split(':')[1]);
        if (!terminal || !vscode.window.terminals.includes(terminal)) { reply(409, { error: 'target_closed' }); return; }
        terminal.show(true);
        // CLI paste-burst detection treats an immediate Enter as part of the paste.
        // Keep both writes bound to this Terminal object, never the active terminal.
        textAttempted = true;
        terminal.sendText(input.command, false);
        await new Promise(resolve => setTimeout(resolve, 350));
        const beforeEnter = (await snapshot()).find(t => t.target_id === input.target_id);
        if (!vscode.window.terminals.includes(terminal) || beforeEnter?.agent_pid !== input.agent_pid) {
          reply(409, { error: 'target_changed_after_text; text may be present but Enter was not sent. Inspect before retrying.' }); return;
        }
        enterAttempted = true;
        terminal.sendText('\r', false);
        const receipt = { status: 'submitted', target_id: target.target_id, name: target.name, kind: target.kind,
          agent_pid: target.agent_pid, command: input.command, at: new Date().toISOString(),
          execution_verified: false, note: 'Input submitted once. Inspect the terminal for completion, unsupported commands, or a menu/confirmation. Do not retry automatically.' };
        log(`slash command submitted target=${target.target_id} agent=${target.agent_pid} command=${input.command.split(' ')[0]}`);
        reply(200, receipt);
      } finally { sending = false; }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const phase = enterAttempted ? 'Submission outcome unknown; Enter may have been sent. Inspect before retrying. '
        : textAttempted ? 'Input text may be present; Enter was not attempted. Inspect before retrying. ' : '';
      reply(500, { error: phase + detail });
    }
  });
  server.requestTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No terminal bridge port');
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(manifest, JSON.stringify({ window_id: windowId, port: address.port, secret }), { mode: 0o600, flag: 'wx' });
  } catch (error) { server.close(); throw error; }
  log(`terminal slash-command bridge ready window=${windowId}`);
  return { dispose: () => { server.close(); void fs.unlink(manifest).catch(() => {}); } };
}
