import * as vscode from 'vscode';
import { getGlobalBridgeInstallStatus, installGlobalBridgeConfig } from './global';
import { bootstrap, type AgentCommsRuntime } from './main';
import { PROJECT_OVERRIDE_KEY } from './persona/project';

let runtime: AgentCommsRuntime | undefined;

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function getErrorMessage(error: unknown): string {
  if (getErrorCode(error) === 'EADDRINUSE') {
    return 'Agent Comms is already running in another VS Code window or process on this port. Stop that hub or change agentComms.port before starting here.';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function withCommandErrors(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    vscode.window.showErrorMessage(getErrorMessage(error));
  }
}

async function setProjectOverride(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    throw new Error('Open a local workspace before setting an Agent Comms project override.');
  }

  const current = context.workspaceState.get<string | undefined>(PROJECT_OVERRIDE_KEY);
  const next = await vscode.window.showInputBox({
    prompt: 'Project name override. Leave blank to clear.',
    value: current ?? '',
  });

  if (next === undefined) {
    return;
  }

  await context.workspaceState.update(PROJECT_OVERRIDE_KEY, next.trim() || undefined);
  vscode.window.showInformationMessage(
    next.trim() ? `Agent Comms project set to "${next.trim()}"` : 'Agent Comms project override cleared',
  );
}

async function promptInstallGlobalBridges(context: vscode.ExtensionContext): Promise<void> {
  const status = await getGlobalBridgeInstallStatus();
  if (status.codexConfigured && status.claudeConfigured) {
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    'Agent Comms still needs user-level Claude/Codex bridge config. Install or update ~/.claude.json and ~/.codex/config.toml now?',
    'Install Now',
  );

  if (choice !== 'Install Now') {
    throw new Error('Global bridge config is missing. Run "Agent Comms: Install Global Bridges" before starting agents.');
  }

  const installed = await installGlobalBridgeConfig(context.extensionPath);
  vscode.window.showInformationMessage(
    `Agent Comms bridge config installed. Claude: ${installed.claudeConfigPath} | Codex: ${installed.codexConfigPath}`,
  );
}

async function ensureRuntime(context: vscode.ExtensionContext): Promise<AgentCommsRuntime> {
  if (runtime) {
    return runtime;
  }

  await promptInstallGlobalBridges(context);
  runtime = await bootstrap(context);
  vscode.window.showInformationMessage('Agent Comms hub started in this workspace.');
  return runtime;
}

async function stopRuntime(): Promise<void> {
  if (!runtime) {
    vscode.window.showInformationMessage('Agent Comms is not running in this window.');
    return;
  }

  await runtime.dispose();
  runtime = undefined;
  vscode.window.showInformationMessage('Agent Comms hub stopped in this workspace.');
}

async function installGlobalBridges(context: vscode.ExtensionContext): Promise<void> {
  const installed = await installGlobalBridgeConfig(context.extensionPath);
  vscode.window.showInformationMessage(
    `Agent Comms bridge config installed. Claude: ${installed.claudeConfigPath} | Codex: ${installed.codexConfigPath}`,
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentComms.start', async () => {
      await withCommandErrors(async () => {
        await ensureRuntime(context);
      });
    }),
    vscode.commands.registerCommand('agentComms.stop', async () => {
      await withCommandErrors(async () => {
        await stopRuntime();
      });
    }),
    vscode.commands.registerCommand('agentComms.installGlobalBridges', async () => {
      await withCommandErrors(async () => {
        await installGlobalBridges(context);
      });
    }),
    vscode.commands.registerCommand('agentComms.setProject', async () => {
      await withCommandErrors(async () => {
        await setProjectOverride(context);
      });
    }),
    vscode.commands.registerCommand('agentComms.showRegistry', async () => {
      await withCommandErrors(async () => {
        if (!runtime) {
          throw new Error('Agent Comms is not running in this window. Start the hub first.');
        }

        runtime.showRegistry();
      });
    }),
    vscode.commands.registerCommand('agentComms.spawn', async () => {
      await withCommandErrors(async () => {
        const activeRuntime = await ensureRuntime(context);
        await activeRuntime.spawnFromPalette();
      });
    }),
    {
      dispose: () => {
        void runtime?.dispose();
        runtime = undefined;
      },
    },
  );
}

export async function deactivate(): Promise<void> {
  await runtime?.dispose();
  runtime = undefined;
}
