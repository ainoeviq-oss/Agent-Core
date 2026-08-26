import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { ANCHOR_PUBLIC_BASE_URL, ANCHOR_PUBLIC_PORT } from './anchor-config.js';
import { createAnchorProxy } from './anchor-proxy.js';
import { anchorTargetStatePath, readAnchorTarget } from './anchor-target.js';

export interface AnchorServerOptions {
  host?: string;
  port?: number;
  publicBaseUrl?: string;
  statePath?: string;
  log?: (message: string) => void;
}

export async function startAnchorServer(options: AnchorServerOptions = {}) {
  const host = options.host ?? process.env.AGENT_CORE_ANCHOR_PROXY_HOST?.trim() ?? '0.0.0.0';
  const configuredPort = Number.parseInt(process.env.AGENT_CORE_ANCHOR_PROXY_PORT ?? '', 10);
  const port = options.port ?? (Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : ANCHOR_PUBLIC_PORT);
  const publicBaseUrl = options.publicBaseUrl ?? process.env.AGENT_CORE_ANCHOR_PUBLIC_BASE_URL?.trim() ?? ANCHOR_PUBLIC_BASE_URL;
  const statePath = options.statePath ?? anchorTargetStatePath();
  const log = options.log ?? ((message: string) => process.stdout.write(`[agent-core-anchor] ${message}\n`));

  const server = createAnchorProxy({
    publicBaseUrl,
    resolveTarget: () => readAnchorTarget(statePath),
    log,
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    host,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try {
    const service = await startAnchorServer();
    process.stdout.write(`[agent-core-anchor] listening on http://${service.host}:${service.port}\n`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await service.close();
    };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
  } catch (error) {
    process.stderr.write(`[agent-core-anchor] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
