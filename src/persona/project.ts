import path from 'node:path';
import { sanitizeProjectName } from './naming';

export const PROJECT_OVERRIDE_KEY = 'agentComms.projectOverride';

export function deriveProjectNameFromPath(cwd: string): string {
  return sanitizeProjectName(path.basename(cwd));
}

export function resolveProjectName(options: { cwd: string; override?: string | null }): string {
  if (options.override) {
    return sanitizeProjectName(options.override);
  }

  return deriveProjectNameFromPath(options.cwd);
}
