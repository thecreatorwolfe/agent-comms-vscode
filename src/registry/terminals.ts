export interface ManagedTerminalLike {
  readonly name: string;
  show(preserveFocus?: boolean): void;
  sendText?(text: string, shouldExecute?: boolean): void;
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

  renamePersona(previousPersona: string, nextPersona: string): boolean {
    const terminal = this.terminals.get(previousPersona);
    if (!terminal) {
      return false;
    }

    this.terminals.delete(previousPersona);
    this.terminals.set(nextPersona, terminal);
    return true;
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
