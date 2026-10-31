import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Logger } from 'pino';
import type { AgentCommsWsClient } from './ws-client';

/** Tie the bridge to its MCP input, independently of hub reconnects. */
export async function connectStdioBridge(
  server: McpServer,
  client: AgentCommsWsClient,
  logger: Logger,
): Promise<void> {
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ reason }, 'bridge shutting down');

    // Keep this timer referenced: even a stuck MCP close must end the process.
    const deadline = setTimeout(() => {
      logger.error({ reason }, 'bridge shutdown deadline exceeded');
      process.exit(1);
    }, 2_000);
    try {
      // stop() waits for the hub socket to close, so process.exit cannot cut
      // off the close frame that releases this bridge's persona.
      await client.stop(reason);
      await server.close();
    } catch (error) {
      logger.error({ err: error, reason }, 'bridge shutdown failed');
      exitCode = 1;
    } finally {
      clearTimeout(deadline);
      process.exit(exitCode);
    }
  };

  // Install before starting the transport: EOF can arrive during startup.
  process.stdin.once('end', () => { void shutdown('stdin_end'); });
  process.stdin.once('close', () => { void shutdown('stdin_close'); });
  process.stdin.on('error', () => { void shutdown('stdin_error', 1); });
  process.stdout.on('error', () => { void shutdown('stdout_error', 1); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  server.server.onclose = () => { void shutdown('mcp_closed'); };

  if (process.stdin.readableEnded || process.stdin.destroyed) {
    await shutdown('stdin_already_closed');
    return;
  }

  await server.connect(new StdioServerTransport());
  if (!shuttingDown) {
    await client.start();
  }
}
