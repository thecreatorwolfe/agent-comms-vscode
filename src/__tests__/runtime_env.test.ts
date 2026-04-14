import { describe, expect, it } from 'vitest';
import { resolveBridgeEnv } from '../mcp/runtime-env';

describe('resolveBridgeEnv', () => {
  it('prefers explicit Agent Comms process env values', () => {
    const resolved = resolveBridgeEnv({
      AGENT_COMMS_PORT: '47592',
      ROUTER_SHARED_SECRET: 'a'.repeat(64),
      AGENT_COMMS_PERSONA: 'demo-codex-1',
      LOG_LEVEL: 'debug',
    }, {});

    expect(resolved).toEqual({
      port: 47592,
      secret: 'a'.repeat(64),
      claimedPersona: 'demo-codex-1',
      logLevel: 'debug',
    });
  });

  it('accepts EXTENSION_PORT as the fallback bridge port key', () => {
    const resolved = resolveBridgeEnv({
      EXTENSION_PORT: '47592',
      ROUTER_SHARED_SECRET: 'b'.repeat(64),
    }, {});

    expect(resolved.port).toBe(47592);
    expect(resolved.secret).toBe('b'.repeat(64));
  });

  it('throws a readable error when no port is available', () => {
    expect(() =>
      resolveBridgeEnv({
        ROUTER_SHARED_SECRET: 'c'.repeat(64),
      }, {}),
    ).toThrow('Missing Agent Comms port.');
  });
});
