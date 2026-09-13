/**
 * One object per PROCESS, however many times a bundler compiles this module.
 *
 * WHY THIS EXISTS. Module-level `let` is the obvious home for a cache, and on
 * this device it is not a safe one. Next compiles `src/instrumentation.ts` —
 * the boot hook — in a layer of its own, so `require("./lib/coding-agent")`
 * there and `import "@/lib/coding-agent"` in a route handler resolve to two
 * DIFFERENT modules inside the one web-server process. Read off the production
 * build of 2026-09-13: `src/lib/coding-agent.ts` is emitted twice, as module id
 * 79687 in the chunk `instrumentation.js` loads and as 26377 in the chunk every
 * app route loads; Turbopack's module cache is keyed by that id, so each copy
 * evaluates its own top-level state. `src/lib/config-store.ts` is duplicated the
 * same way, and so is everything else the boot hook reaches. It is not two
 * processes — one `clawbox-web` — and no amount of `pgrep` would have shown it.
 *
 * A module whose copies must agree — because they hold the handles on live
 * work, or because both of them WRITE the same file — keeps its mutable state
 * here instead. `Symbol.for` and `globalThis` are the only two things in the
 * language that are genuinely per process rather than per module instance.
 *
 * The KEY is the thing the state belongs to, not the module: the runs store is
 * keyed by the path of the file it caches, so two copies pointing at one file
 * share one cache and a test pointing its own `CLAWBOX_ROOT` somewhere else
 * gets its own. Callers decide their key; nothing here interprets it.
 */

const REGISTRY = Symbol.for("clawbox.process-store");

type Registry = Map<string, unknown>;

function registry(): Registry {
  const holder = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
  const existing = holder[REGISTRY];
  if (existing) return existing;
  const made: Registry = new Map();
  holder[REGISTRY] = made;
  return made;
}

/**
 * The one object this process keeps under `key`, made on first ask.
 *
 * `create` is called at most once per key per process, so it may safely hold
 * timers, child handles and anything else that must not be duplicated.
 */
export function processStore<T extends object>(key: string, create: () => T): T {
  const map = registry();
  const existing = map.get(key);
  if (existing !== undefined) return existing as T;
  const made = create();
  map.set(key, made);
  return made;
}
