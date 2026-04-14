// Owner: Codex
// Spawn logic — given a persona + kind + brief file path, open a new terminal
// panel in the current VS Code window rooted at the workspace, launching
// `claude` or `codex` with the brief as first input.
//
// Consumes registry (persona allocation + reservation) and persona (naming + icon URL).
// See protocol.md §10 for the full spawn flow, including env var conventions
// (AGENT_COMMS_PERSONA, AGENT_COMMS_PORT) passed to the spawned process.

import * as vscode from 'vscode';
import type { Logger } from 'pino';
import { AgentRegistry } from './registry/agents';
import { buildAutomaticPersona, buildProjectScopedPersona } from './persona/naming';
import { resolveProjectName } from './persona/project';

export interface SpawnRequest {
  kind: 'claude' | 'codex';
  briefFilePath: string;
  customName?: string;
  projectName?: string;
  personaSuffix?: string;
  instanceNumber?: number;
  parentPersona?: string | null;
  taskId: string;
  reuseIdle?: boolean | null;
}

export interface SpawnResult {
  persona: string;
  terminalName: string;
  reused: boolean;
}

export class SpawnConflictError extends Error {
  override name = 'SpawnConflictError';
}

export class SpawnPreconditionError extends Error {
  override name = 'SpawnPreconditionError';
}

export interface SpawnAgentDependencies {
  registry: AgentRegistry;
  workspaceRoot: string;
  extensionPort: number;
  routerSharedSecret: string;
  extensionPath: string;
  codexChromeDevtoolsStartupTimeoutSec?: number;
  projectOverride?: string | null;
  trackTerminal?: (persona: string, terminal: vscode.Terminal) => void;
  logger?: Logger;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSpawnCommand(
  kind: 'claude' | 'codex',
  persona: string,
  briefFilePath: string,
  codexChromeDevtoolsStartupTimeoutSec?: number,
): string {
  const quotedBrief = shellQuote(briefFilePath);
  if (kind === 'claude') {
    return `~/.agent-comms/bin/claude-agent-comms -n ${shellQuote(persona)} "$(cat ${quotedBrief})"`;
  }

  const chromeDevtoolsTimeoutArg = Number.isInteger(codexChromeDevtoolsStartupTimeoutSec)
    && (codexChromeDevtoolsStartupTimeoutSec ?? 0) > 0
    ? ` -c ${shellQuote(`mcp_servers.chrome-devtools.startup_timeout_sec=${codexChromeDevtoolsStartupTimeoutSec}`)}`
    : '';

  return `codex${chromeDevtoolsTimeoutArg} "$(cat ${quotedBrief})"`;
}

async function promptReuseExistingPersona(persona: string): Promise<boolean> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: `Reuse ${persona}`, value: true },
      { label: 'Spawn fresh', value: false },
    ],
    { placeHolder: `${persona} is idle. Reuse it or spawn fresh?` },
  );

  return choice?.value ?? false;
}

export async function spawnAgent(req: SpawnRequest, dependencies: SpawnAgentDependencies): Promise<SpawnResult> {
  if (!dependencies.workspaceRoot) {
    throw new SpawnPreconditionError('No local workspace open');
  }

  const project = resolveProjectName({
    cwd: dependencies.workspaceRoot,
    override: req.projectName ?? dependencies.projectOverride,
  });

  let reuseIdle = req.reuseIdle ?? null;
  if (reuseIdle == null) {
    reuseIdle = req.parentPersona ? false : Boolean(dependencies.registry.findIdleAgent(project, req.kind))
      ? await promptReuseExistingPersona(
          dependencies.registry.findIdleAgent(project, req.kind)?.persona ?? '',
        )
      : false;
  }

  if (reuseIdle) {
    const idle = dependencies.registry.findIdleAgent(project, req.kind);
    if (idle) {
      return {
        persona: idle.persona,
        terminalName: idle.persona,
        reused: true,
      };
    }
  }

  let reservation;
  try {
    reservation = dependencies.registry.reserve({
      cwd: dependencies.workspaceRoot,
      kind: req.kind,
      briefFilePath: req.briefFilePath,
      taskId: req.taskId,
      customName: resolveRequestedPersona(req, project),
      personaSuffix: req.personaSuffix,
      instanceNumber: req.instanceNumber,
      parentPersona: req.parentPersona ?? null,
      projectOverride: req.projectName ?? dependencies.projectOverride,
    });
  } catch (error) {
    throw new SpawnConflictError(error instanceof Error ? error.message : String(error));
  }

  const terminal = vscode.window.createTerminal({
    cwd: dependencies.workspaceRoot,
    name: reservation.persona,
    env: {
      AGENT_COMMS_PERSONA: reservation.persona,
      AGENT_COMMS_PORT: String(dependencies.extensionPort),
      ROUTER_SHARED_SECRET: dependencies.routerSharedSecret,
      AGENT_COMMS_BRIEF_FILE: req.briefFilePath,
      AGENT_COMMS_EXTENSION_PATH: dependencies.extensionPath,
    },
  });

  dependencies.trackTerminal?.(reservation.persona, terminal);
  terminal.show(true);
  terminal.sendText(
    buildSpawnCommand(
      req.kind,
      reservation.persona,
      req.briefFilePath,
      dependencies.codexChromeDevtoolsStartupTimeoutSec,
    ),
    true,
  );
  dependencies.logger?.info({ persona: reservation.persona, kind: req.kind }, 'spawned terminal');

  return {
    persona: reservation.persona,
    terminalName: terminal.name,
    reused: false,
  };
}

function resolveRequestedPersona(req: SpawnRequest, project: string): string | undefined {
  if (req.customName?.trim()) {
    return req.customName.trim();
  }

  if (req.personaSuffix?.trim()) {
    return buildProjectScopedPersona(project, req.personaSuffix);
  }

  if (req.instanceNumber != null) {
    return buildAutomaticPersona(project, req.kind, req.instanceNumber);
  }

  return undefined;
}
