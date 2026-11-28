import { processStore } from "@/lib/process-store";

/**
 * One Local AI transition at a time (TASK-2376): saving or removing the
 * external AI engine, and switching Local-only mode. Each of them reads the
 * other's state first and writes its own last — Local-only refuses while an
 * engine is selected, a save refuses while Local-only is on — so two that
 * overlap could both pass their check and leave the box in a state neither
 * allows. They also share the engine's key file and the Local AI store keys.
 *
 * A chain of promises, like `withProviderChangeLock`, and deliberately a
 * DIFFERENT one: a save ends in chat/model's own POST, which takes the
 * provider-change lock itself, and nothing under this lock is called from
 * under that one. Not reentrant: never call a locked function from inside
 * another.
 */
const state = processStore("clawbox.local-ai-transition-lock", () => ({
  chain: Promise.resolve() as Promise<void>,
  /** Transitions running right now (0 or 1: they run one at a time). */
  running: 0,
  /** Moves whenever a transition starts or ends. */
  generation: 0,
  /** Told when a transition starts (`onLocalAiTransitionStart`). */
  listeners: new Set<() => void>(),
}));

export function withLocalAiTransitionLock<T>(fn: () => Promise<T>): Promise<T> {
  const guarded = async (): Promise<T> => {
    state.running = (state.running ?? 0) + 1;
    state.generation = (state.generation ?? 0) + 1;
    for (const listener of [...(state.listeners ?? [])]) {
      // A reader's problem is not the transition's: a listener that throws, or
      // one that returns a promise that rejects, is let go — never awaited, so
      // nothing it does can hold the queue.
      try {
        const returned: unknown = listener();
        if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
          Promise.resolve(returned).catch(() => {});
        }
      } catch {
        // see above
      }
    }
    try {
      return await fn();
    } finally {
      state.running -= 1;
      state.generation += 1;
    }
  };
  const run = state.chain.then(guarded, guarded);
  // Never a rejected head: the next transition must not inherit this one's failure.
  state.chain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Is a transition running, and a stamp that moves whenever one starts or ends.
 * A reader that does not take the lock — the Cluster view reading the engine's
 * record and its key file (TASK-2670) — takes one mark before its reads and one
 * after: the two belong together only when neither saw a transition running and
 * the stamp did not move, since a save writes the key file before the record.
 */
export function localAiTransitionMark(): { running: boolean; generation: number } {
  return { running: (state.running ?? 0) > 0, generation: state.generation ?? 0 };
}

/**
 * Be told the moment a transition starts — a reader with requests in flight
 * that must not go on once the engine's settings may change under it. Returns
 * the function that stops it.
 */
export function onLocalAiTransitionStart(listener: () => void): () => void {
  state.listeners ??= new Set();
  state.listeners.add(listener);
  return () => {
    state.listeners?.delete(listener);
  };
}
