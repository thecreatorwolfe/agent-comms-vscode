import { buildAutomaticPersona, validateCustomPersona, type AgentKind } from '../persona/naming';

export interface PersonaAllocation {
  persona: string;
  project: string;
  kind: AgentKind;
  instanceNumber?: number;
  customName?: string;
}

function buildKey(project: string, kind: AgentKind): string {
  return `${project}:${kind}`;
}

export class PersonaAllocator {
  private readonly occupiedNames = new Set<string>();
  private readonly occupiedNumbers = new Map<string, Set<number>>();

  reserve(project: string, kind: AgentKind, customName?: string | null): PersonaAllocation {
    if (customName) {
      const persona = validateCustomPersona(customName);
      if (this.occupiedNames.has(persona)) {
        throw new Error(`Persona collision: "${persona}" is already occupied`);
      }

      this.occupiedNames.add(persona);
      return { persona, project, kind, customName: persona };
    }

    const key = buildKey(project, kind);
    const numbers = this.occupiedNumbers.get(key) ?? new Set<number>();
    let next = 1;
    while (numbers.has(next)) {
      next += 1;
    }

    numbers.add(next);
    this.occupiedNumbers.set(key, numbers);
    const persona = buildAutomaticPersona(project, kind, next);
    this.occupiedNames.add(persona);
    return { persona, project, kind, instanceNumber: next };
  }

  release(allocation: PersonaAllocation): void {
    this.occupiedNames.delete(allocation.persona);
    if (allocation.instanceNumber) {
      const key = buildKey(allocation.project, allocation.kind);
      const numbers = this.occupiedNumbers.get(key);
      if (!numbers) {
        return;
      }

      numbers.delete(allocation.instanceNumber);
      if (numbers.size === 0) {
        this.occupiedNumbers.delete(key);
      }
    }
  }

  isOccupied(persona: string): boolean {
    return this.occupiedNames.has(persona);
  }
}
