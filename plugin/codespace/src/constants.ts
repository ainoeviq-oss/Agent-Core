export const BRIDGE_NAME = 'codespace';
export const BRIDGE_VERSION = '0.1.0';

const SECRET_ENV_KEYS = new Set([
  'CONTROL_PLANE_API_KEY',
  'OPENAI_ADMIN_KEY',
]);

export function sanitizeEnvironment(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !SECRET_ENV_KEYS.has(key)),
  );
}
