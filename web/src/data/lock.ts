export const SYNC_LOCK = "family-tab-sync";
const tails = new Map<string, Promise<unknown>>();

export function withSyncLock<T>(task: () => Promise<T>, locks: LockManager | null = globalThis.navigator?.locks ?? null): Promise<T> {
  if (locks) return locks.request(SYNC_LOCK, task);
  const previous = tails.get(SYNC_LOCK) ?? Promise.resolve();
  const result = previous.then(task, task);
  const tail = result.catch(() => undefined);
  tails.set(SYNC_LOCK, tail);
  return result.finally(() => {
    if (tails.get(SYNC_LOCK) === tail) tails.delete(SYNC_LOCK);
  });
}
