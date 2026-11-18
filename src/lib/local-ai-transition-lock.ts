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
const state = processStore("clawbox.local-ai-transition-lock", () => ({ chain: Promise.resolve() as Promise<void> }));

export function withLocalAiTransitionLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = state.chain.then(fn, fn);
  // Never a rejected head: the next transition must not inherit this one's failure.
  state.chain = run.then(() => undefined, () => undefined);
  return run;
}
