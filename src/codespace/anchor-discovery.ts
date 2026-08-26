import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ANCHOR_CODESPACE_NAME, ANCHOR_PUBLIC_PORT } from './anchor-config.js';
import {
  anchorTargetStatePath,
  localAnchorTarget,
  type AnchorBackendTarget,
  verifyRemoteBackend,
  writeAnchorTargetAtomic,
} from './anchor-target.js';

const execFileAsync = promisify(execFile);

export type GhRunner = (args: string[]) => Promise<string>;

export interface DiscoverAnchorBackendOptions {
  repository?: string;
  anchorName?: string;
  statePath?: string;
  ghRunner?: GhRunner;
  verify?: (url: string) => Promise<AnchorBackendTarget>;
}

export interface DiscoverAnchorBackendResult {
  status: 'local' | 'remote';
  target: AnchorBackendTarget;
  candidates: string[];
}

interface CodespaceRow {
  name?: unknown;
  repository?: unknown;
  state?: unknown;
}

interface PortRow {
  sourcePort?: unknown;
  visibility?: unknown;
  browseUrl?: unknown;
}

const defaultGhRunner: GhRunner = async (args) => {
  const result = await execFileAsync('gh', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  return result.stdout;
};

function parseJsonArray<T>(text: string): T[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error('ANCHOR_DISCOVERY_INVALID_GH_RESPONSE');
  return parsed as T[];
}

export async function discoverAnchorBackend(options: DiscoverAnchorBackendOptions = {}): Promise<DiscoverAnchorBackendResult> {
  const repository = options.repository ?? process.env.AGENT_CORE_ANCHOR_REPOSITORY ?? 'ainoeviq-oss/Agent-Core';
  const anchorName = options.anchorName ?? process.env.AGENT_CORE_ANCHOR_CODESPACE_NAME ?? ANCHOR_CODESPACE_NAME;
  const statePath = options.statePath ?? anchorTargetStatePath();
  const ghRunner = options.ghRunner ?? defaultGhRunner;
  const verify = options.verify ?? ((url: string) => verifyRemoteBackend(url));

  const rows = parseJsonArray<CodespaceRow>(await ghRunner(['codespace', 'list', '--json', 'name,repository,state']));
  const possible = rows.filter((row): row is { name: string; repository: string; state: string } => (
    typeof row.name === 'string'
      && typeof row.repository === 'string'
      && typeof row.state === 'string'
      && row.name !== anchorName
      && row.repository === repository
      && row.state.toLowerCase() === 'available'
  ));

  const verified: AnchorBackendTarget[] = [];
  for (const candidate of possible) {
    let ports: PortRow[];
    try {
      ports = parseJsonArray<PortRow>(await ghRunner(['codespace', 'ports', '-c', candidate.name, '--json', 'sourcePort,visibility,browseUrl']));
    } catch {
      continue;
    }
    const port = ports.find((entry) => Number(entry.sourcePort) === ANCHOR_PUBLIC_PORT && typeof entry.browseUrl === 'string' && entry.browseUrl.length > 0);
    if (!port || typeof port.browseUrl !== 'string') continue;
    try {
      verified.push(await verify(port.browseUrl.replace(/\/$/, '')));
    } catch {
      // A booting, private, or unhealthy candidate is not eligible for automatic cutover.
    }
  }

  if (verified.length > 1) {
    throw new Error(`ANCHOR_DISCOVERY_AMBIGUOUS:${verified.map((entry) => entry.codespaceName ?? entry.baseUrl).join(',')}`);
  }

  if (verified.length === 1) {
    const target = verified[0]!;
    await writeAnchorTargetAtomic(target, statePath);
    return { status: 'remote', target, candidates: [target.codespaceName ?? target.baseUrl] };
  }

  const target = localAnchorTarget();
  await writeAnchorTargetAtomic(target, statePath);
  return { status: 'local', target, candidates: [] };
}

async function cli(): Promise<void> {
  const result = await discoverAnchorBackend();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: result.status,
    baseUrl: result.target.baseUrl,
    codespaceName: result.target.codespaceName,
    candidates: result.candidates,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'anchor_discovery_failed';
    process.stderr.write(`[agent-core-anchor] ERROR: ${message}\n`);
    process.exitCode = 1;
  });
}
