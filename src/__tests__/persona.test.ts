import { describe, expect, it } from 'vitest';
import { resolveIconUrl, resolveIconVariant } from '../persona/icons';
import {
  buildAutomaticPersona,
  buildProjectScopedPersona,
  extractPersonaSuffix,
  parseAutomaticPersona,
  resolveRecipientAlias,
  sanitizeProjectName,
} from '../persona/naming';
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

  it('builds project-scoped personas and extracts suffixes', () => {
    expect(buildProjectScopedPersona('Client Alpha', 'Alfred-30')).toBe('client-alpha-alfred-30');
    expect(extractPersonaSuffix('client-alpha-alfred-30', 'client-alpha')).toBe('alfred-30');
    expect(extractPersonaSuffix('audit-reviewer', 'client-alpha')).toBe('audit-reviewer');
  });

  it('resolves explicit project overrides', () => {
    expect(resolveProjectName({ cwd: '/tmp/security-audit', override: 'Client Alpha' })).toBe('client-alpha');
  });

  it('resolves short runtime aliases onto live personas', () => {
    const live = [
      'override-agency-project-codex-1',
      'override-agency-project-alfred-2',
      'bosa-phase0-codex2',
      'checkout-flow-design-lead',
    ];

    expect(resolveRecipientAlias('codex-1', live)).toBe('override-agency-project-codex-1');
    expect(resolveRecipientAlias('claude-2', live)).toBe('override-agency-project-alfred-2');
    expect(resolveRecipientAlias('alfred-2', live)).toBe('override-agency-project-alfred-2');
    expect(resolveRecipientAlias('codex-2', live)).toBe('bosa-phase0-codex2');
    expect(resolveRecipientAlias('codex2', live)).toBe('bosa-phase0-codex2');
    expect(resolveRecipientAlias('@design-lead', live)).toBe('checkout-flow-design-lead');
  });
});
