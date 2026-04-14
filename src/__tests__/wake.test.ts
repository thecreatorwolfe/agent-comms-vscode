import { describe, expect, it, vi } from 'vitest';
import { normalizeTtyName, wakeProcessTty } from '../wake';

describe('normalizeTtyName', () => {
  it('trims a valid tty name', () => {
    expect(normalizeTtyName(' ttys008 \n')).toBe('ttys008');
  });

  it('rejects unknown tty markers', () => {
    expect(normalizeTtyName('?')).toBeUndefined();
    expect(normalizeTtyName('??')).toBeUndefined();
    expect(normalizeTtyName('   ')).toBeUndefined();
  });
});

describe('wakeProcessTty', () => {
  it('writes an escape sequence to the resolved tty device', async () => {
    const writeFile = vi.fn(async () => undefined);

    const woke = await wakeProcessTty(1234, {
      resolveProcessTty: async () => 'ttys008',
      writeFile,
    });

    expect(woke).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/dev/ttys008', '\u001b');
  });

  it('returns false when the process has no tty', async () => {
    const writeFile = vi.fn(async () => undefined);

    const woke = await wakeProcessTty(1234, {
      resolveProcessTty: async () => undefined,
      writeFile,
    });

    expect(woke).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
