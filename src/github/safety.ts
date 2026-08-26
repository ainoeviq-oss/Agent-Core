import { GitHubFabricError } from './errors.js';

export const GITHUB_DESTRUCTIVE_CONFIRMATION = 'CONFIRM_GITHUB_DESTRUCTIVE_OPERATION';

const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

export function assertDestructiveConfirmation(required: boolean, value?: string): void {
  if (!required) return;
  if (value === GITHUB_DESTRUCTIVE_CONFIRMATION) return;
  throw new GitHubFabricError(
    'GITHUB_DESTRUCTIVE_CONFIRMATION_REQUIRED',
    `This GitHub operation requires destructive confirmation: ${GITHUB_DESTRUCTIVE_CONFIRMATION}`,
  );
}

export function assertSafeCallerHeaders(headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const name of Object.keys(headers)) {
    if (CREDENTIAL_HEADERS.has(name.trim().toLowerCase())) {
      throw new GitHubFabricError(
        'GITHUB_ENDPOINT_NOT_ALLOWED',
        `Caller-controlled credential header is not allowed: ${name}`,
      );
    }
  }
}

export function resolveGitHubApiEndpoint(baseUrl: string, endpoint: string): URL {
  const base = new URL(baseUrl);
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new GitHubFabricError('GITHUB_ENDPOINT_NOT_ALLOWED', 'GitHub API endpoint is required');
  }

  let resolved: URL;
  try {
    if (/^https?:\/\//i.test(trimmed)) resolved = new URL(trimmed);
    else resolved = new URL(`${base.href.replace(/\/+$/g, '')}/${trimmed.replace(/^\/+/, '')}`);
  } catch {
    throw new GitHubFabricError('GITHUB_ENDPOINT_NOT_ALLOWED', 'GitHub API endpoint is invalid');
  }

  if (resolved.origin !== base.origin || resolved.username || resolved.password) {
    throw new GitHubFabricError(
      'GITHUB_ENDPOINT_NOT_ALLOWED',
      `GitHub API endpoint must remain on configured origin ${base.origin}`,
    );
  }
  return resolved;
}
