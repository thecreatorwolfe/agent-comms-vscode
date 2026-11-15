import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WsGateway } from '../gateway/ws';
import { AgentRegistry } from '../registry/agents';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-lifecycle-'));
const compiled = path.join(scratch, 'dist');
const children: ChildProcessWithoutNullStreams[] = [];
const orphanPids = new Set<number>();
const hubs: Array<{ server: http.Server; gateway: WsGateway }> = [];

async function until(check: () => boolean, description: string, timeout = 4_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const running = (child: ChildProcessWithoutNullStreams) => child.exitCode === null && child.signalCode === null;

beforeAll(() => {
  // Transpile current source into an isolated directory. The normal compile
  // command checks types; these subprocess tests must not use stale dist code.
  const transpileTree = (source: string, target: string): void => {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const input = path.join(source, entry.name);
      if (entry.isDirectory()) {
        transpileTree(input, path.join(target, entry.name));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const output = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        });
        fs.writeFileSync(path.join(target, entry.name.replace(/\.ts$/, '.js')), output.outputText);
      }
    }
  };
  transpileTree(path.join(process.cwd(), 'src'), compiled);
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (running(child)) child.kill('SIGKILL');
    await until(() => !running(child), 'test child cleanup');
  }
  for (const pid of orphanPids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  orphanPids.clear();
  for (const { server, gateway } of hubs.splice(0)) {
    await gateway.stop();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

async function hub(port = 0) {
  const server = http.createServer();
  const registry = new AgentRegistry();
  const gateway = new WsGateway({ server, registry, routerSharedSecret: 'test-secret', onOutbound: vi.fn() });
  gateway.start();
  hubs.push({ server, gateway });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, registry, gateway, port: (server.address() as { port: number }).port };
}

function bridgeEnv(port: number, persona: string) {
  return {
    PATH: process.env.PATH,
    HOME: scratch,
    NODE_PATH: path.join(process.cwd(), 'node_modules'),
    AGENT_COMMS_PORT: String(port), ROUTER_SHARED_SECRET: 'test-secret',
    AGENT_COMMS_PERSONA: persona, AGENT_COMMS_PROFILE_ID: randomUUID(),
  };
}

function launch(kind: string, port: number, persona: string) {
  const file = path.join(compiled, 'mcp', kind === 'codex' ? 'codex-server.js' : 'claude-channel.js');
  const child = spawn(process.execPath, [file], { env: bridgeEnv(port, persona), stdio: 'pipe' });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data.toString(); });
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  return { child, stdout: () => stdout, stderr: () => stderr, file };
}

async function initialized(probe: ReturnType<typeof launch>) {
  probe.child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '1' },
    },
  }) + '\n');
  await until(() => probe.stdout().split('\n').some((line) => {
    try { const message = JSON.parse(line); return message.id === 1 && Boolean(message.result); } catch { return false; }
  }), `MCP initialize response: ${probe.stderr()}`);
}

describe.each(['codex', 'claude'])('%s bridge process lifecycle', (kind) => {
  it('exits on EOF, releases its persona, and leaves a same-directory sibling responsive', async () => {
    const h = await hub();
    const first = launch(kind, h.port, 'lifecycle-first');
    const sibling = launch(kind, h.port, 'lifecycle-sibling');
    await until(() => h.registry.listAll().length === 2, 'both bridges registered');
    await initialized(first);
    first.child.stdin.end();
    await until(() => !running(first.child), 'EOF exit');
    expect(first.child.exitCode, first.stderr()).toBe(0);
    expect(first.stderr().match(/bridge shutting down/g)).toHaveLength(1);
    expect(h.registry.get('lifecycle-first')).toBeUndefined();
    expect(h.registry.get('lifecycle-sibling')?.disconnectDeadlineAt).toBeUndefined();
    await initialized(sibling);

    const replacement = launch(kind, h.port, 'lifecycle-first');
    await until(() => h.registry.get('lifecycle-first')?.pid === replacement.child.pid, 'immediate persona reuse');
    expect(h.registry.get('lifecycle-first')?.registrationRequired).toBe(false);
  });

  it('exits with input already closed at startup', async () => {
    const h = await hub();
    const probe = launch(kind, h.port, 'lifecycle-early');
    probe.child.stdin.end();
    await until(() => !running(probe.child), 'startup EOF exit');
    expect(probe.child.exitCode, probe.stderr()).toBe(0);
    await until(() => h.registry.list().length === 0, 'no live early bridge');
  });

  it('survives a hub restart and releases its persona after reconnecting', async () => {
    const h = await hub();
    const probe = launch(kind, h.port, 'lifecycle-reconnect');
    await until(() => Boolean(h.registry.get('lifecycle-reconnect')), 'initial auth');
    await initialized(probe);
    await h.gateway.stop();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
    expect(running(probe.child)).toBe(true);
    await until(() => Boolean(h.registry.get('lifecycle-reconnect')?.disconnectDeadlineAt), 'disconnect grace retained');
    const restarted = await hub(h.port);
    await until(() => Boolean(restarted.registry.get('lifecycle-reconnect')), 'reauth after restart');
    expect(running(probe.child)).toBe(true);
    probe.child.stdin.end();
    await until(() => !running(probe.child), 'exit after reconnect');
    expect(probe.child.exitCode, probe.stderr()).toBe(0);
    expect(restarted.registry.get('lifecycle-reconnect')).toBeUndefined();
  }, 10_000);

  it('handles simultaneous EOF and SIGTERM only once', async () => {
    const h = await hub();
    const probe = launch(kind, h.port, 'lifecycle-signals');
    await until(() => Boolean(h.registry.get('lifecycle-signals')), 'auth');
    await initialized(probe);
    probe.child.stdin.end();
    probe.child.kill('SIGTERM');
    await until(() => !running(probe.child), 'signal exit');
    expect(probe.child.exitCode, probe.stderr()).toBe(0);
    expect(probe.stderr().match(/bridge shutting down/g)).toHaveLength(1);
    expect(h.registry.get('lifecycle-signals')).toBeUndefined();
  });

  it('exits when its MCP owner is killed without a termination signal to the bridge', async () => {
    const h = await hub();
    const file = path.join(compiled, 'mcp', kind === 'codex' ? 'codex-server.js' : 'claude-channel.js');
    const owner = spawn(process.execPath, ['-e', `
      const {spawn} = require('node:child_process');
      const bridge = spawn(process.execPath, [process.argv[1]], {stdio:['pipe','ignore','ignore']});
      process.stdin.pipe(bridge.stdin);
      console.log(bridge.pid);
    `, file], { env: bridgeEnv(h.port, 'lifecycle-owner'), stdio: 'pipe' });
    children.push(owner);
    let pidText = '';
    owner.stdout.on('data', (data) => { pidText += data.toString(); });
    owner.stderr.resume();
    await until(() => /\d+\n/.test(pidText), 'bridge pid from owner');
    const pid = Number(pidText.trim());
    orphanPids.add(pid);
    await until(() => Boolean(h.registry.get('lifecycle-owner')), 'owned bridge auth');
    owner.kill('SIGKILL');
    await until(() => {
      try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }, 'bridge exits after owner death');
    orphanPids.delete(pid);
    expect(h.registry.get('lifecycle-owner')).toBeUndefined();
  });

  it('exits while the hub WebSocket handshake is stalled', async () => {
    const server = http.createServer();
    const sockets = new Set<Socket>();
    let upgradeReceived = false;
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', () => { upgradeReceived = true; /* deliberately withhold handshake */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const probe = launch(kind, (server.address() as { port: number }).port, 'lifecycle-stalled');
      await initialized(probe);
      await until(() => upgradeReceived, 'hub received WebSocket upgrade');
      probe.child.stdin.end();
      await until(() => !running(probe.child), 'exit during WebSocket handshake', 2_500);
      expect(probe.child.exitCode, probe.stderr()).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('bounds shutdown when the hub does not answer the WebSocket close', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    let authed = false;
    wss.on('connection', (socket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({
          type: 'auth.ack', persona: 'lifecycle-unresponsive', icon_url: 'http://localhost/icon.png',
          persona_source: 'claimed', registration_required: false,
        }));
        socket.pause();
        authed = true;
      });
    });
    try {
      const probe = launch(kind, (wss.address() as { port: number }).port, 'lifecycle-unresponsive');
      await until(() => authed, 'fake hub auth');
      await initialized(probe);
      const started = Date.now();
      probe.child.stdin.end();
      await until(() => !running(probe.child), 'bounded close exit', 2_500);
      expect(probe.child.exitCode, probe.stderr()).toBe(0);
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(probe.stderr()).toContain('Hub socket close timed out; terminating it.');
    } finally {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
