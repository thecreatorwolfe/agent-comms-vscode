import { describe, expect, it } from 'vitest';
import { resolveIconUrl, resolveIconVariant } from '../persona/icons';
import { buildAutomaticPersona, parseAutomaticPersona, sanitizeProjectName } from '../persona/naming';
import { resolveProjectName } from '../persona/project';

describe('persona helpers', () => {
  it('sanitizes project names and builds automatic personas', () => {
    expect(sanitizeProjectName(' Security Audit ')).toBe('security-audit');
    expect(buildAutomaticPersona('Security Audit', 'claude', 2)).toBe('security-audit-alfred-2');
  });

  it('parses automatic personas', () => {
    expect(parseAutomaticPersona('security-audit-codex-3')).toEqual({
      project: 'security-audit',
      kind: 'codex',
      instanceNumber: 3,
    });
  });

  it('maps automatic personas onto icon variants', () => {
    expect(resolveIconVariant('security-audit-codex-5')).toBe(1);
    expect(resolveIconUrl({ persona: 'security-audit-codex-2', kind: 'codex' })).toContain('/codex-2.png');
    expect(resolveIconUrl({ persona: 'audit-reviewer', kind: 'codex' })).toContain('/codex-1.png');
  });

  it('resolves explicit project overrides', () => {
    expect(resolveProjectName({ cwd: '/tmp/security-audit', override: 'Client Alpha' })).toBe('client-alpha');
  });
});
