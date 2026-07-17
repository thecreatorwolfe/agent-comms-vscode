import { describe, expect, it, vi } from 'vitest';
import { ChannelInboundPoller } from '../slack/channel-poller';

function makeSlack(seedTs: string | undefined, pollMessages: Array<Record<string, unknown>>) {
  const history = vi.fn(async (args: { limit?: number }) => {
    if (args.limit === 1) {
      return { ok: true, messages: seedTs ? [{ ts: seedTs }] : [] };
    }
    return { ok: true, messages: pollMessages };
  });
  return { slack: { client: { conversations: { history } } } as never, history };
}

describe('ChannelInboundPoller', () => {
  it('delivers only agent-protocol messages newer than the seeded cursor', async () => {
    const { slack } = makeSlack('100.000', [
      { ts: '101.000', text: '[peer-alfred-1→alfred-fps]\n\nping' }, // protocol, newer -> deliver
      { ts: '102.000', text: 'just human chatter, no header' }, // not protocol -> skip
      { ts: '100.000', text: '[old→x]\n\nalready seen' }, // == cursor (inclusive) -> skip
    ]);
    const delivered: string[] = [];
    const poller = new ChannelInboundPoller(slack, 'C1', 10 ** 9, async (e) => { delivered.push(e.ts); });

    await poller.start();
    await poller.poll();

    expect(delivered).toEqual(['101.000']);
    poller.stop();
  });

  it('does not re-deliver messages across repeated polls (cursor advances past non-protocol msgs too)', async () => {
    const batch = [
      { ts: '201.000', text: '[peer-alfred-1→alfred-fps]\n\nfirst' },
      { ts: '202.000', text: 'human noise' },
      { ts: '203.000', text: '[peer-alfred-1→alfred-fps]\n\nsecond' },
    ];
    const { slack } = makeSlack('200.000', batch);
    const delivered: string[] = [];
    const poller = new ChannelInboundPoller(slack, 'C1', 10 ** 9, async (e) => { delivered.push(e.ts); });

    await poller.start();
    await poller.poll();
    await poller.poll(); // same batch returned; everything is <= cursor now

    expect(delivered).toEqual(['201.000', '203.000']);
    poller.stop();
  });

  it('passes the addressed protocol message through with its ts and thread', async () => {
    const { slack } = makeSlack('300.000', [
      { ts: '301.000', thread_ts: '299.000', user: 'U0ATHGZ4MQQ', text: '[alfred-prime→alfred-fps]\n\nNUDGE' },
    ]);
    const events: Array<{ ts: string; thread?: string }> = [];
    const poller = new ChannelInboundPoller(slack, 'C1', 10 ** 9, async (e) => {
      events.push({ ts: e.ts, thread: e.thread_ts });
    });

    await poller.start();
    await poller.poll();

    expect(events).toEqual([{ ts: '301.000', thread: '299.000' }]);
    poller.stop();
  });
});
