import { access, readFile } from 'node:fs/promises';
import type { GitHubConfig } from '../config.js';
import { GitHubFabricError } from './errors.js';
import type { GitHubCredentialKind, GitHubCredentialStatus } from './types.js';

const REDACTED = '[REDACTED_GITHUB_CREDENTIAL]';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class GitHubCredentialProvider {
  constructor(private readonly config: GitHubConfig) {}

  async status(): Promise<GitHubCredentialStatus> {
    const [githubTokenConfigured, packagesTokenConfigured] = await Promise.all([
      exists(this.config.tokenFile),
      exists(this.config.packagesTokenFile),
    ]);
    return {
      githubTokenConfigured,
      packagesTokenConfigured,
      githubTokenPath: this.config.tokenFile,
      packagesTokenPath: this.config.packagesTokenFile,
    };
  }

  async read(kind: GitHubCredentialKind): Promise<string> {
    const filePath = kind === 'github' ? this.config.tokenFile : this.config.packagesTokenFile;
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new GitHubFabricError(
          'GITHUB_CREDENTIAL_MISSING',
          `GitHub ${kind} credential file is missing: ${filePath}`,
          { kind, path: filePath },
        );
      }
      throw new GitHubFabricError(
        'GITHUB_CREDENTIAL_MISSING',
        `GitHub ${kind} credential file could not be read: ${filePath}`,
        { kind, path: filePath, causeCode: code ?? 'UNKNOWN' },
      );
    }

    const token = raw.trim();
    if (!token) {
      throw new GitHubFabricError(
        'GITHUB_CREDENTIAL_EMPTY',
        `GitHub ${kind} credential file is empty: ${filePath}`,
        { kind, path: filePath },
      );
    }
    return token;
  }

  redact(value: string, secrets: string[]): string {
    let output = value;
    const unique = [...new Set(secrets.filter(Boolean))].sort((left, right) => right.length - left.length);
    for (const secret of unique) output = output.split(secret).join(REDACTED);
    return output;
  }
}

export { REDACTED as GITHUB_CREDENTIAL_REDACTION_MARKER };
