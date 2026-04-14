import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_AGENT_COMMS_ENV_TEMPLATE = '${userHome}/.agent-comms/.env';
const AGENT_COMMS_CODEX_SECTION = 'mcp_servers.agent-comms';
const AGENT_COMMS_CLAUDE_SERVER = 'agent-comms';

export interface ResolvePathTemplateOptions {
  workspaceRoot?: string;
  extensionPath?: string;
  userHome?: string;
}

export interface AgentCommsGlobalPaths {
  userHome: string;
  homeDir: string;
  envFilePath: string;
  launchersDir: string;
  codexLauncherPath: string;
  claudeLauncherPath: string;
  codexConfigPath: string;
  claudeConfigPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolvePathTemplate(
  template: string | undefined,
  options: ResolvePathTemplateOptions = {},
): string | undefined {
  if (!template) {
    return undefined;
  }

  const userHome = options.userHome ?? os.homedir();
  let resolved = template.replace(/\$\{userHome\}/g, userHome);

  if (resolved.includes('${workspaceFolder}') && options.workspaceRoot) {
    resolved = resolved.replace(/\$\{workspaceFolder\}/g, options.workspaceRoot);
  }

  if (resolved.includes('${extensionPath}') && options.extensionPath) {
    resolved = resolved.replace(/\$\{extensionPath\}/g, options.extensionPath);
  }

  if (path.isAbsolute(resolved)) {
    return resolved;
  }

  if (options.workspaceRoot) {
    return path.resolve(options.workspaceRoot, resolved);
  }

  return path.resolve(resolved);
}

export function getAgentCommsGlobalPaths(userHome = os.homedir()): AgentCommsGlobalPaths {
  const homeDir = path.join(userHome, '.agent-comms');
  const launchersDir = path.join(homeDir, 'bin');
  return {
    userHome,
    homeDir,
    envFilePath: path.join(homeDir, '.env'),
    launchersDir,
    codexLauncherPath: path.join(launchersDir, 'codex-server.js'),
    claudeLauncherPath: path.join(launchersDir, 'claude-channel.js'),
    codexConfigPath: path.join(userHome, '.codex', 'config.toml'),
    claudeConfigPath: path.join(userHome, '.claude.json'),
  };
}

function buildLauncherSource(targetPath: string): string {
  return `#!/usr/bin/env node\nrequire(${JSON.stringify(targetPath)});\n`;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeLauncherFile(filePath: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buildLauncherSource(targetPath), 'utf8');
  await fs.chmod(filePath, 0o755);
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function replaceOrAppendTomlSection(source: string, sectionName: string, replacement: string): string {
  const lines = source.split(/\r?\n/);
  const header = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === header);

  if (start === -1) {
    const trimmed = source.trimEnd();
    return trimmed ? `${trimmed}\n\n${replacement}` : replacement;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const before = lines.slice(0, start).join('\n').trimEnd();
  const after = lines.slice(end).join('\n').trimStart();

  if (before && after) {
    return `${before}\n\n${replacement}\n\n${after}`;
  }
  if (before) {
    return `${before}\n\n${replacement}`;
  }
  if (after) {
    return `${replacement}\n\n${after}`;
  }
  return replacement;
}

export function upsertCodexConfigToml(source: string, launcherPath: string): string {
  const section = [
    `[${AGENT_COMMS_CODEX_SECTION}]`,
    'command = "node"',
    `args = [${quoteTomlString(launcherPath)}]`,
  ].join('\n');

  return `${replaceOrAppendTomlSection(source, AGENT_COMMS_CODEX_SECTION, section)}\n`;
}

export function upsertClaudeConfigJson(source: string | undefined, launcherPath: string): string {
  const parsed = source?.trim() ? JSON.parse(source) : {};
  if (!isRecord(parsed)) {
    throw new Error('Expected ~/.claude.json to contain a JSON object.');
  }

  const mcpServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  const next = {
    ...parsed,
    mcpServers: {
      ...mcpServers,
      [AGENT_COMMS_CLAUDE_SERVER]: {
        command: 'node',
        args: [launcherPath],
      },
    },
  };

  return `${JSON.stringify(next, null, 2)}\n`;
}

export async function ensureGlobalBridgeLaunchers(
  extensionPath: string,
  userHome = os.homedir(),
): Promise<AgentCommsGlobalPaths> {
  const paths = getAgentCommsGlobalPaths(userHome);
  await fs.mkdir(paths.homeDir, { recursive: true });
  await writeLauncherFile(paths.codexLauncherPath, path.resolve(extensionPath, 'dist/mcp/codex-server.js'));
  await writeLauncherFile(paths.claudeLauncherPath, path.resolve(extensionPath, 'dist/mcp/claude-channel.js'));
  return paths;
}

export async function installGlobalBridgeConfig(
  extensionPath: string,
  userHome = os.homedir(),
): Promise<AgentCommsGlobalPaths> {
  const paths = await ensureGlobalBridgeLaunchers(extensionPath, userHome);

  await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
  const codexExisting = (await readTextIfExists(paths.codexConfigPath)) ?? '';
  await fs.writeFile(paths.codexConfigPath, upsertCodexConfigToml(codexExisting, paths.codexLauncherPath), 'utf8');

  const claudeExisting = await readTextIfExists(paths.claudeConfigPath);
  await fs.writeFile(paths.claudeConfigPath, upsertClaudeConfigJson(claudeExisting, paths.claudeLauncherPath), 'utf8');

  return paths;
}

export async function getGlobalBridgeInstallStatus(
  userHome = os.homedir(),
): Promise<{ paths: AgentCommsGlobalPaths; claudeConfigured: boolean; codexConfigured: boolean }> {
  const paths = getAgentCommsGlobalPaths(userHome);
  const codexExisting = (await readTextIfExists(paths.codexConfigPath)) ?? '';
  const claudeExisting = await readTextIfExists(paths.claudeConfigPath);

  let claudeConfigured = false;
  if (claudeExisting?.trim()) {
    try {
      const parsed = JSON.parse(claudeExisting);
      const serverConfig =
        isRecord(parsed) && isRecord(parsed.mcpServers)
          ? parsed.mcpServers[AGENT_COMMS_CLAUDE_SERVER]
          : undefined;
      claudeConfigured =
        isRecord(serverConfig) &&
        serverConfig.command === 'node' &&
        Array.isArray(serverConfig.args) &&
        serverConfig.args[0] === paths.claudeLauncherPath;
    } catch {
      claudeConfigured = false;
    }
  }

  return {
    paths,
    claudeConfigured,
    codexConfigured:
      codexExisting.includes(`[${AGENT_COMMS_CODEX_SECTION}]`) &&
      codexExisting.includes(quoteTomlString(paths.codexLauncherPath)),
  };
}
