export type GitHubErrorCode =
  | 'GITHUB_CREDENTIAL_MISSING'
  | 'GITHUB_CREDENTIAL_EMPTY'
  | 'GITHUB_API_AUTH_FAILED'
  | 'GITHUB_API_FORBIDDEN'
  | 'GITHUB_API_NOT_FOUND'
  | 'GITHUB_API_RATE_LIMITED'
  | 'GITHUB_API_VALIDATION_FAILED'
  | 'GITHUB_API_ERROR'
  | 'GITHUB_GIT_NOT_FOUND'
  | 'GITHUB_GIT_AUTH_FAILED'
  | 'GITHUB_GIT_NON_FAST_FORWARD'
  | 'GITHUB_GIT_CONFLICT'
  | 'GITHUB_GIT_FAILED'
  | 'GITHUB_PACKAGE_AUTH_FAILED'
  | 'GITHUB_PACKAGE_FAILED'
  | 'GITHUB_DESTRUCTIVE_CONFIRMATION_REQUIRED'
  | 'GITHUB_ENDPOINT_NOT_ALLOWED';

export class GitHubFabricError extends Error {
  constructor(
    public readonly code: GitHubErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GitHubFabricError';
  }
}
