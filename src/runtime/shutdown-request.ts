import { access, rm } from 'node:fs/promises';

export interface ShutdownRequestWatcherOptions {
  pollIntervalMs?: number;
}

export interface ShutdownRequestWatcher {
  close(): void;
}

export function watchShutdownRequest(
  requestPath: string,
  onRequest: () => Promise<void> | void,
  options: ShutdownRequestWatcherOptions = {},
): ShutdownRequestWatcher {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!requestPath.trim()) throw new Error('SHUTDOWN_REQUEST_PATH_REQUIRED');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 5) {
    throw new Error('SHUTDOWN_REQUEST_POLL_INTERVAL_INVALID');
  }

  let closed = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (closed || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        await access(requestPath);
      } catch {
        inFlight = false;
        return;
      }

      try {
        await onRequest();
        await rm(requestPath, { force: true });
        closed = true;
        clearInterval(timer);
      } catch {
        // Keep the request file in place so a transient close failure can be retried.
      } finally {
        inFlight = false;
      }
    })();
  }, pollIntervalMs);
  timer.unref();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(timer);
    },
  };
}
