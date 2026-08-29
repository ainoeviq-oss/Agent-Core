export const RELEASE_FORMAT = 'agent-core-stable-release-v2';
export const PRESENTATION_BRIDGE_ROOT = 'SubProject/Presentation-Bridge/';

export const RUNTIME_RELEASE_ITEMS = Object.freeze([
  '.env.example',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'Start-Agent-Core.bat',
  'src',
  'dist',
  'scripts',
  'plugin/agent-core/README.md',
  'plugin/agent-core/skills',
  'docs/README.md',
  'docs/deterministic-memory.md',
  'docs/local-agent-continuity.md',
  'docs/deterministic-execution-fabric.md',
  'docs/multi-command-wake-workflow.md',
  'docs/github.md',
  'docs/codespaces.md',
  'docs/stability.md',
  'docs/windows-installation-cutover.md',
  'docs/roadmap',
  'docs/diagrams',
  'tunnel-client/agent-core.example.yaml',
]);

const PRESENTATION_BRIDGE_EXCLUDED_PREFIXES = Object.freeze([
  'runtime/',
  'secrets/',
  'node_modules/',
  'dist/',
  'release/',
  'corpus/generated/',
]);

export function normalizeArchivePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isPresentationBridgeSourcePath(value) {
  const normalized = normalizeArchivePath(value);
  if (!normalized.startsWith(PRESENTATION_BRIDGE_ROOT)) return false;
  const relative = normalized.slice(PRESENTATION_BRIDGE_ROOT.length);
  if (!relative || relative === '.env') return false;
  return !PRESENTATION_BRIDGE_EXCLUDED_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

export function releaseAssetNames(version, presentationBridgeVersion) {
  return {
    runtimeZip: `agent-core-windows-v${version}-stable.zip`,
    pluginZip: `agent-core-plugin-v${version}-stable.zip`,
    presentationBridgeZip: `presentation-bridge-v${presentationBridgeVersion}-source.zip`,
    npmTarball: `rendevouz999-agent-core-plugin-${version}.tgz`,
    manifest: 'release-manifest.json',
    checksums: 'SHA256SUMS.txt',
  };
}

export const RELEASE_EXCLUSIONS = Object.freeze([
  'secrets',
  'runtime',
  'data',
  'logs',
  'capabilities',
  'node_modules',
  '.env',
  'local tunnel credentials',
  'raw execution evidence',
  'Presentation Bridge runtime jobs',
  'Presentation Bridge generated corpus',
]);
