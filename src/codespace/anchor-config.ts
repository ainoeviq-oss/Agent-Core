export const ANCHOR_CODESPACE_NAME = 'ominous-xylophone-69xxp4v76vv93xq64';
export const ANCHOR_PUBLIC_BASE_URL = `https://${ANCHOR_CODESPACE_NAME}.app.github.dev`;
export const ANCHOR_PUBLIC_PORT = 8765;
export const ANCHOR_LOCAL_BACKEND_PORT = 8766;

export type CodespaceAnchorRole = 'anchor' | 'backend';

export function resolveCodespaceAnchorRole(codespaceName: string | undefined): CodespaceAnchorRole {
  return codespaceName === ANCHOR_CODESPACE_NAME ? 'anchor' : 'backend';
}
