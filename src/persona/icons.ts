import type { AgentKind } from './naming';
import { parseAutomaticPersona } from './naming';

const DEFAULT_ICONS_BASE_URL = 'https://override-agency.github.io/agent-comms-vscode/icons';

export interface ResolveIconUrlOptions {
  persona: string;
  kind: AgentKind;
  iconsBaseUrl?: string;
}

export function resolveIconVariant(persona: string): number {
  const parsed = parseAutomaticPersona(persona);
  if (!parsed) {
    return 1;
  }

  return ((parsed.instanceNumber - 1) % 4) + 1;
}

export function resolveIconUrl(options: ResolveIconUrlOptions): string {
  const baseUrl = (options.iconsBaseUrl ?? DEFAULT_ICONS_BASE_URL).replace(/\/+$/, '');
  return `${baseUrl}/${options.kind}-${resolveIconVariant(options.persona)}.png`;
}
