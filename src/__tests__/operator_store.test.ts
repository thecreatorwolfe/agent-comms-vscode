import { describe, expect, it } from 'vitest';
import { OperatorSettingsStore } from '../operator-store';

class MemoryMemento {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

describe('OperatorSettingsStore', () => {
  it('defaults listen mode to disabled', () => {
    const store = new OperatorSettingsStore(new MemoryMemento() as never);

    expect(store.get()).toEqual({ listenEnabled: false });
  });

  it('persists listen mode across reloads', async () => {
    const state = new MemoryMemento();
    const writer = new OperatorSettingsStore(state as never);
    await writer.setListenEnabled(true);

    const reader = new OperatorSettingsStore(state as never);
    expect(reader.get()).toEqual({ listenEnabled: true });
  });
});
