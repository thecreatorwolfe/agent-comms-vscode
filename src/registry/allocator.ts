import {
  buildAutomaticPersona,
  buildProjectScopedPersona,
  parseAutomaticPersona,
  sanitizeProjectName,
  validateCustomPersona,
  type AgentKind,
} from '../persona/naming';

export interface PersonaAllocation {
  persona: string;
  project: string;
  kind: AgentKind;
  instanceNumber?: number;
  customName?: string;
}

export interface PersonaReservationOptions {
  customName?: string | null;
  personaSuffix?: string | null;
  instanceNumber?: number | null;
}

function buildKey(project: string, kind: AgentKind): string {
  return `${project}:${kind}`;
}

export class PersonaAllocator {
  private readonly occupiedNames = new Set<string>();
  private readonly occupiedNumbers = new Map<string, Set<number>>();

  reserve(project: string, kind: AgentKind, options: PersonaReservationOptions = {}): PersonaAllocation {
    const normalizedProject = sanitizeProjectName(project);

    if (options.customName) {
      return this.reserveExplicitPersona(normalizedProject, kind, validateCustomPersona(options.customName));
    }

    if (options.personaSuffix) {
      return this.reserveExplicitPersona(
        normalizedProject,
        kind,
        buildProjectScopedPersona(normalizedProject, options.personaSuffix),
      );
    }

    if (options.instanceNumber != null) {
      return this.reserveAutomaticPersona(normalizedProject, kind, options.instanceNumber);
    }

    return this.reserveAutomaticPersona(normalizedProject, kind);
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

  private reserveAutomaticPersona(project: string, kind: AgentKind, requestedInstanceNumber?: number): PersonaAllocation {
    const key = buildKey(project, kind);
    const numbers = this.occupiedNumbers.get(key) ?? new Set<number>();
    let next = requestedInstanceNumber ?? 1;
    if (requestedInstanceNumber == null) {
      while (numbers.has(next)) {
        next += 1;
      }
    } else if (numbers.has(next)) {
      throw new Error(`Persona collision: "${buildAutomaticPersona(project, kind, next)}" is already occupied`);
    }

    const persona = buildAutomaticPersona(project, kind, next);
    if (this.occupiedNames.has(persona)) {
      throw new Error(`Persona collision: "${persona}" is already occupied`);
    }

    numbers.add(next);
    this.occupiedNumbers.set(key, numbers);
    this.occupiedNames.add(persona);
    return { persona, project, kind, instanceNumber: next };
  }

  private reserveExplicitPersona(project: string, kind: AgentKind, persona: string): PersonaAllocation {
    const parsed = parseAutomaticPersona(persona);
    if (parsed && parsed.kind !== kind) {
      throw new Error(`Persona "${persona}" is not valid for runtime "${kind}"`);
    }

    if (this.occupiedNames.has(persona)) {
      throw new Error(`Persona collision: "${persona}" is already occupied`);
    }

    const allocationProject = parsed?.project ?? project;
    let instanceNumber: number | undefined;
    if (parsed) {
      const key = buildKey(parsed.project, kind);
      const numbers = this.occupiedNumbers.get(key) ?? new Set<number>();
      if (numbers.has(parsed.instanceNumber)) {
        throw new Error(`Persona collision: "${persona}" is already occupied`);
      }

      numbers.add(parsed.instanceNumber);
      this.occupiedNumbers.set(key, numbers);
      instanceNumber = parsed.instanceNumber;
    }

    this.occupiedNames.add(persona);
    return {
      persona,
      project: allocationProject,
      kind,
      instanceNumber,
      customName: persona,
    };
  }
}
