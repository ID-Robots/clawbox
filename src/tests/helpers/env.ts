/**
 * Save environment variables a test is about to change, and hand back the undo.
 *
 * Vitest reuses a worker process across test files, so a variable that is
 * DELETED in `afterEach` instead of restored does not go back to what it was —
 * it goes away, for every file that runs after it in that worker. `HOME` is the
 * one that bites: pointed at a temporary directory that the same `afterEach`
 * then removes, it leaves later files resolving paths under something that no
 * longer exists, and the failure surfaces nowhere near the file that caused it.
 */
export function saveEnv(...keys: string[]): () => void {
  const saved = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
