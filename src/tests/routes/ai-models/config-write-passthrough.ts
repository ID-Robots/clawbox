/**
 * The config-write-transaction exports of `@/lib/openclaw-config`, for the
 * suites that replace that module wholesale.
 *
 * The configure route opens a transaction around its openclaw.json writes and
 * wraps every write it treats as non-fatal in `configWriteBoundary` (TASK-1535).
 * These suites mock `runOpenclawConfigSet` / `…SetBatch` / `…Unset` and assert
 * on what the route asked for, so they get the module's behaviour OUTSIDE a
 * transaction: no transaction ever opens, every write runs as it is made, and a
 * boundary is the plain `try`/`catch` it stands for — a mock that rejects lands
 * in the route's own handler, exactly as before. What a transaction does with
 * those writes is `openclaw-config-write-transaction.test.ts`'s business, and
 * where the route commits it is `configure-config-transaction.test.ts`'s.
 *
 * Spread into a factory: `vi.mock("@/lib/openclaw-config", async () => ({
 * ...(await import("./config-write-passthrough")).configWritePassthrough, … }))`.
 */

interface Handlers {
  onError?: (err: unknown) => void | Promise<void>;
  onApplied?: () => void | Promise<void>;
}

export const configWritePassthrough = {
  withConfigWriteScope: async <T>(body: () => Promise<T>): Promise<T> => body(),
  beginConfigWriteTransaction: (label: string) => ({
    label,
    isOpen: false,
    pending: 0,
    committedAs: null,
    commit: async () => {},
    flush: async () => {},
    abandon: () => {},
  }),
  configWriteBoundary: async (handlers: Handlers, body: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (err) {
      if (!handlers.onError) throw err;
      await handlers.onError(err);
      return;
    }
    await handlers.onApplied?.();
  },
  flushConfigWrites: async () => {},
  inConfigWriteTransaction: () => false,
};
