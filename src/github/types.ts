export type GitHubCredentialKind = 'github' | 'packages';

export interface GitHubCredentialStatus {
  githubTokenConfigured: boolean;
  packagesTokenConfigured: boolean;
  githubTokenPath: string;
  packagesTokenPath: string;
}
