import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const port = Number(process.env.AGENT_COMMS_PORT ?? process.argv[2] ?? '47592');
const secret = process.env.ROUTER_SHARED_SECRET ?? process.argv[3];

if (!secret) {
  console.error('Usage: AGENT_COMMS_PORT=47592 ROUTER_SHARED_SECRET=... node scripts/ws-probe.ts');
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      type: 'auth',
      secret,
      agent_kind: 'codex',
      pid: process.pid,
      cwd: process.cwd(),
      persona: '',
    }),
  );
});

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString()) as { type: string; persona?: string };
  console.log('received', frame);

  if (frame.type === 'auth.ack') {
    ws.send(
      JSON.stringify({
        type: 'outbound',
        persona: frame.persona,
        thread_ts: null,
        task_id: 'ws-probe',
        body: 'not a protocol message',
        client_msg_id: randomUUID(),
      }),
    );
    return;
  }

  if (frame.type === 'outbound.error' || frame.type === 'error') {
    ws.close();
  }
});

ws.on('close', () => {
  process.exit(0);
});
