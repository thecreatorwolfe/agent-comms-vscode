import { describe, expect, it } from 'vitest';
import { loadAgentCommsEnv } from '../env';

describe('loadAgentCommsEnv', () => {
  it('surfaces missing env fields with a readable error', () => {
    expect(() =>
      loadAgentCommsEnv({
        env: {
          SLACK_CHANNEL_ID: 'C0ASSA3BBGC',
          SLACK_OPERATOR_USER_ID: 'U0AK1NV1D43',
          ROUTER_SHARED_SECRET: 'a'.repeat(64),
          EXTENSION_PORT: '47592',
          LOG_LEVEL: 'info',
        },
        envFilePath: '/tmp/agent-comms.env',
      }),
    ).toThrow(
      'Agent Comms env is missing or invalid in /tmp/agent-comms.env. Fix: SLACK_APP_TOKEN, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET',
    );
  });

  it('requires a Slack operator user id for stop controls', () => {
    expect(() =>
      loadAgentCommsEnv({
        env: {
          SLACK_APP_TOKEN: 'xapp-test',
          SLACK_BOT_TOKEN: 'xoxb-test',
          SLACK_SIGNING_SECRET: 'secret',
          SLACK_CHANNEL_ID: 'C0ASSA3BBGC',
          ROUTER_SHARED_SECRET: 'a'.repeat(64),
          EXTENSION_PORT: '47592',
          LOG_LEVEL: 'info',
        },
        envFilePath: '/tmp/agent-comms.env',
      }),
    ).toThrow(
      'Agent Comms env is missing or invalid in /tmp/agent-comms.env. Fix: SLACK_OPERATOR_USER_ID',
    );
  });
});
