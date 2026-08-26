import type { GitHubConfig } from '../config.js';
import type { GitHubCredentialProvider } from './credentials.js';
import { GitHubFabricError, type GitHubErrorCode } from './errors.js';
import { assertSafeCallerHeaders, resolveGitHubApiEndpoint } from './safety.js';

export interface GitHubApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint: string;
  query?: Record<string, string | number | boolean | null>;
  body?: unknown;
  headers?: Record<string, string>;
  credential?: 'github' | 'packages';
}

export interface GitHubApiResultHeaders {
  requestId?: string;
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  next?: string;
}

export interface GitHubApiResult {
  ok: boolean;
  status: number;
  method: string;
  endpoint: string;
  headers: GitHubApiResultHeaders;
  data: unknown;
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nextLink(value: string | null): string | undefined {
  if (!value) return undefined;
  for (const segment of value.split(',')) {
    const match = segment.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"/i);
    if (match?.[2]?.toLowerCase() === 'next') return match[1];
  }
  return undefined;
}

async function responseData(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('json')) {
    try { return JSON.parse(text) as unknown; }
    catch { return text; }
  }
  return text;
}

function safeMessage(data: unknown): string {
  if (data && typeof data === 'object' && 'message' in data) {
    const value = (data as { message?: unknown }).message;
    if (typeof value === 'string') return value;
  }
  if (typeof data === 'string') return data;
  return 'GitHub API request failed';
}

function classifyStatus(status: number, remaining: number | undefined): GitHubErrorCode {
  if (status === 401) return 'GITHUB_API_AUTH_FAILED';
  if (status === 429 || (status === 403 && remaining === 0)) return 'GITHUB_API_RATE_LIMITED';
  if (status === 403) return 'GITHUB_API_FORBIDDEN';
  if (status === 404) return 'GITHUB_API_NOT_FOUND';
  if (status === 422) return 'GITHUB_API_VALIDATION_FAILED';
  return 'GITHUB_API_ERROR';
}

export class GitHubApiService {
  constructor(
    private readonly config: GitHubConfig,
    private readonly credentials: GitHubCredentialProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly userAgent = 'Agent-Core/0.5.2',
  ) {}

  async request(input: GitHubApiRequest): Promise<GitHubApiResult> {
    assertSafeCallerHeaders(input.headers);
    const url = resolveGitHubApiEndpoint(this.config.apiBaseUrl, input.endpoint);
    if (input.query) {
      for (const [name, value] of Object.entries(input.query)) {
        if (value === null) continue;
        url.searchParams.set(name, String(value));
      }
    }

    const credentialKind = input.credential ?? 'github';
    const token = await this.credentials.read(credentialKind);
    const headers = new Headers(input.headers ?? {});
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', this.config.apiVersion);
    headers.set('User-Agent', this.userAgent);

    const init: RequestInit = {
      method: input.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    };
    if (input.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(input.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.href, init);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = this.credentials.redact(raw, [token]);
      throw new GitHubFabricError('GITHUB_API_ERROR', message, { endpoint: url.pathname, method: input.method });
    }

    const requestId = response.headers.get('x-github-request-id') ?? undefined;
    const rateLimitLimit = numberHeader(response.headers, 'x-ratelimit-limit');
    const rateLimitRemaining = numberHeader(response.headers, 'x-ratelimit-remaining');
    const rateLimitReset = numberHeader(response.headers, 'x-ratelimit-reset');
    const next = nextLink(response.headers.get('link'));
    const normalizedHeaders: GitHubApiResultHeaders = {
      ...(requestId ? { requestId } : {}),
      ...(rateLimitLimit !== undefined ? { rateLimitLimit } : {}),
      ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
      ...(rateLimitReset !== undefined ? { rateLimitReset } : {}),
      ...(next ? { next } : {}),
    };

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirected = new URL(location, url);
        const baseOrigin = new URL(this.config.apiBaseUrl).origin;
        if (redirected.origin !== baseOrigin || redirected.username || redirected.password) {
          throw new GitHubFabricError(
            'GITHUB_ENDPOINT_NOT_ALLOWED',
            `GitHub API redirect left configured origin ${baseOrigin}`,
            { status: response.status, requestId },
          );
        }
      }
      throw new GitHubFabricError(
        'GITHUB_API_ERROR',
        `GitHub API returned redirect status ${response.status}; use the explicit same-origin endpoint`,
        { status: response.status, requestId },
      );
    }

    const data = await responseData(response);
    if (!response.ok) {
      const code = classifyStatus(response.status, rateLimitRemaining);
      const rawMessage = safeMessage(data);
      const message = this.credentials.redact(rawMessage, [token]);
      throw new GitHubFabricError(
        code,
        `GitHub API ${response.status}: ${message}`,
        {
          status: response.status,
          method: input.method,
          endpoint: url.pathname,
          ...(requestId ? { requestId } : {}),
          ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
          ...(rateLimitReset !== undefined ? { rateLimitReset } : {}),
        },
      );
    }

    return {
      ok: true,
      status: response.status,
      method: input.method,
      endpoint: input.endpoint,
      headers: normalizedHeaders,
      data,
    };
  }
}
