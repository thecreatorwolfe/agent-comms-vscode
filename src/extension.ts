import * as vscode from 'vscode';
import { installGlobalBridgeConfig } from './global';
import { bootstrap, type AgentCommsRuntime } from './main';
import { PROJECT_OVERRIDE_KEY } from './persona/project';

let runtime: AgentCommsRuntime | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let autoStartTimer: NodeJS.Timeout | undefined;
let autoStartInFlight = false;
let manualStopRequested = false;

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function getErrorMessage(error: unknown): string {
  if (getErrorCode(error) === 'EADDRINUSE') {
    return 'Agent Comms is already running in another VS Code window or process on this port.';
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

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Agent Comms');
  }

  return outputChannel;
}

function appendOutput(message: string): void {
  getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

function clearAutoStartTimer(): void {
  if (autoStartTimer) {
    clearTimeout(autoStartTimer);
    autoStartTimer = undefined;
  }
}

function scheduleAutoStart(context: vscode.ExtensionContext, delayMs: number, reason: string): void {
  if (runtime || autoStartInFlight || autoStartTimer || manualStopRequested) {
    return;
  }

  autoStartTimer = setTimeout(() => {
    autoStartTimer = undefined;
    void attemptAutoStart(context, reason);
  }, delayMs);
  autoStartTimer.unref?.();
}

async function installGlobalBridges(context: vscode.ExtensionContext, announce = true): Promise<void> {
  const installed = await installGlobalBridgeConfig(context.extensionPath);
  appendOutput(`bridge config installed (${installed.claudeConfigPath}, ${installed.codexConfigPath})`);
  if (announce) {
    vscode.window.showInformationMessage(
      `Agent Comms bridge config installed. Claude: ${installed.claudeConfigPath} | Codex: ${installed.codexConfigPath}`,
    );
  }
}

async function ensureRuntime(
  context: vscode.ExtensionContext,
  options: { showStartedMessage?: boolean } = {},
): Promise<AgentCommsRuntime> {
  if (runtime) {
    return runtime;
  }

  clearAutoStartTimer();
  await installGlobalBridges(context, false);
  runtime = await bootstrap(context, {
    outputChannel: getOutputChannel(),
    onFault: ({ source, message }) => {
      appendOutput(`fault ${source}: ${message}`);
    },
  });
  appendOutput('hub started in this workspace');
  if (options.showStartedMessage ?? true) {
    vscode.window.showInformationMessage('Agent Comms hub started in this workspace.');
  }
  return runtime;
}

async function stopRuntime(): Promise<void> {
  manualStopRequested = true;
  clearAutoStartTimer();
  if (!runtime) {
    vscode.window.showInformationMessage('Agent Comms is not running in this window.');
    return;
  }

  await runtime.dispose();
  runtime = undefined;
  appendOutput('hub stopped in this workspace');
  vscode.window.showInformationMessage('Agent Comms hub stopped in this workspace.');
}

async function attemptAutoStart(context: vscode.ExtensionContext, reason: string): Promise<void> {
  if (runtime || autoStartInFlight || manualStopRequested) {
    return;
  }

  autoStartInFlight = true;
  try {
    await ensureRuntime(context, { showStartedMessage: false });
    appendOutput(`auto-start succeeded (${reason})`);
  } catch (error) {
    const message = getErrorMessage(error);
    appendOutput(`auto-start deferred (${reason}): ${message}`);

    const code = getErrorCode(error);
    if (code === 'EADDRINUSE') {
      scheduleAutoStart(context, 15_000, 'retry after port in use');
      return;
    }

    if (error instanceof Error && (
      error.message.includes('requires an open local workspace')
      || error.message.includes('supports only local file-system workspaces')
    )) {
      return;
    }

    scheduleAutoStart(context, 15_000, 'retry after startup error');
  } finally {
    autoStartInFlight = false;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(getOutputChannel());
  context.subscriptions.push(
    vscode.commands.registerCommand('agentComms.start', async () => {
      await withCommandErrors(async () => {
        manualStopRequested = false;
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
        await installGlobalBridges(context, true);
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
        clearAutoStartTimer();
        void runtime?.dispose();
        runtime = undefined;
      },
    },
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!runtime) {
        void attemptAutoStart(context, 'workspace folders changed');
      }
    }),
  );

  void attemptAutoStart(context, 'extension activation');
}

export async function deactivate(): Promise<void> {
  clearAutoStartTimer();
  await runtime?.dispose();
  runtime = undefined;
}
