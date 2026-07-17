import { describe, expect, it } from 'vitest';
import { deriveStableProfileId, resolveBridgeEnv } from '../mcp/runtime-env';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveBridgeEnv', () => {
  it('prefers explicit Agent Comms process env values and derives a stable profile id', () => {
    const resolved = resolveBridgeEnv({
      AGENT_COMMS_PORT: '47592',
      ROUTER_SHARED_SECRET: 'a'.repeat(64),
      AGENT_COMMS_PERSONA: 'demo-codex-1',
      LOG_LEVEL: 'debug',
    }, {});

    expect(resolved).toMatchObject({
      port: 47592,
      secret: 'a'.repeat(64),
      claimedPersona: 'demo-codex-1',
      logLevel: 'debug',
    });
    // Without AGENT_COMMS_PROFILE_ID, a stable id is derived from the cwd (B8).
    expect(resolved.profileId).toMatch(UUID_PATTERN);
  });

  it('prefers an explicit AGENT_COMMS_PROFILE_ID over the cwd-derived fallback', () => {
    const explicit = 'c3d2e1f0-1111-4222-8333-444455556666';
    const resolved = resolveBridgeEnv({
      AGENT_COMMS_PORT: '47592',
      ROUTER_SHARED_SECRET: 'a'.repeat(64),
      AGENT_COMMS_PROFILE_ID: explicit,
    }, {});

    expect(resolved.profileId).toBe(explicit);
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

describe('deriveStableProfileId', () => {
  it('is deterministic for the same working directory', () => {
    expect(deriveStableProfileId('/Users/x/repo')).toBe(deriveStableProfileId('/Users/x/repo'));
  });

  it('differs for different working directories', () => {
    expect(deriveStableProfileId('/Users/x/repo-a')).not.toBe(deriveStableProfileId('/Users/x/repo-b'));
  });

  it('produces a valid v5-style UUID accepted by the auth frame schema', () => {
    expect(deriveStableProfileId('/Users/x/repo')).toMatch(UUID_PATTERN);
  });
});
