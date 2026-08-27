import { isAbsolute, normalize, sep } from 'node:path';
import { BridgeError, ErrorCode } from './errors.js';

export function validateZipEntryPath(name: string): void {
  const unix = name.replaceAll('\\', '/');
  if (unix.startsWith('/') || /^[A-Za-z]:\//.test(unix) || isAbsolute(name)) {
    throw new BridgeError(ErrorCode.SOURCE_PATH_TRAVERSAL, `Absolute ZIP entry is not allowed: ${name}`);
  }
  const parts = unix.split('/').filter(Boolean);
  if (parts.includes('..')) {
    throw new BridgeError(ErrorCode.SOURCE_PATH_TRAVERSAL, `Parent traversal ZIP entry is not allowed: ${name}`);
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalize(root).replace(/[\\/]+$/, '') + sep;
  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate.startsWith(normalizedRoot);
}
