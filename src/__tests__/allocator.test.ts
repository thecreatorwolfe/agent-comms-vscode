import { describe, expect, it } from 'vitest';
import { PersonaAllocator } from '../registry/allocator';

describe('PersonaAllocator', () => {
  it('allocates the lowest unused positive integer', () => {
    const allocator = new PersonaAllocator();
    const first = allocator.reserve('security-audit', 'codex');
    const second = allocator.reserve('security-audit', 'codex');

    expect(first.persona).toBe('security-audit-codex-1');
    expect(second.persona).toBe('security-audit-codex-2');
  });

  it('reuses a released instance number', () => {
    const allocator = new PersonaAllocator();
    const first = allocator.reserve('security-audit', 'claude');
    const second = allocator.reserve('security-audit', 'claude');

    allocator.release(first);
    const replacement = allocator.reserve('security-audit', 'claude');

    expect(second.persona).toBe('security-audit-alfred-2');
    expect(replacement.persona).toBe('security-audit-alfred-1');
  });

  it('lets custom names skip numeric allocation', () => {
    const allocator = new PersonaAllocator();
    const custom = allocator.reserve('security-audit', 'codex', 'audit-reviewer');
    const firstAuto = allocator.reserve('security-audit', 'codex');

    expect(custom.persona).toBe('audit-reviewer');
    expect(firstAuto.persona).toBe('security-audit-codex-1');
  });

  it('rejects live custom-name collisions', () => {
    const allocator = new PersonaAllocator();
    allocator.reserve('security-audit', 'codex', 'audit-reviewer');

    expect(() => allocator.reserve('security-audit', 'claude', 'audit-reviewer')).toThrow(
      /Persona collision/,
    );
  });
});
