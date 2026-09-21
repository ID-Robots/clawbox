/**
 * One critical section at a time, within this process.
 *
 * WHY. Several settings are stored as "read the file, change one field, write
 * the file back" — the voice state, the owner's disabled-provider list. Two
 * of those landing together (a check finishing while the owner picks a
 * language; two switches flipped from two tabs) each read the same base and
 * the second write silently drops the first. The store's own write is atomic
 * (temp file + rename), which protects the FILE, not the update.
 *
 * The house pattern is a module-level `writeChain` promise (hermes-env.ts,
 * login-rate-limit.ts); this is that pattern with a name, so a route can wrap
 * exactly its read-modify-write and nothing else. A task that throws still
 * releases the lock — the queue must not stay poisoned by one bad write — and
 * the caller sees the rejection as its own.
 */
export type SerialLock = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerialLock(): SerialLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    // Run after whatever is queued, whether or not that one succeeded.
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
