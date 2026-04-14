export interface ManagedTerminalLike {
  readonly name: string;
  dispose(): void;
}

export class SpawnedTerminalRegistry {
  private readonly terminals = new Map<string, ManagedTerminalLike>();

  track(persona: string, terminal: ManagedTerminalLike): void {
    this.terminals.set(persona, terminal);
  }

  get(persona: string): ManagedTerminalLike | undefined {
    return this.terminals.get(persona);
  }

  untrackPersona(persona: string): void {
    this.terminals.delete(persona);
  }

  untrackTerminal(terminal: ManagedTerminalLike): string | undefined {
    for (const [persona, tracked] of this.terminals.entries()) {
      if (tracked === terminal || tracked.name === terminal.name) {
        this.terminals.delete(persona);
        return persona;
      }
    }

    return undefined;
  }

  listTrackedPersonas(): string[] {
    return [...this.terminals.keys()];
  }

  disposeTracked(persona: string): boolean {
    const terminal = this.terminals.get(persona);
    if (!terminal) {
      return false;
    }

    this.terminals.delete(persona);
    terminal.dispose();
    return true;
  }
}
