/**
 * A per-project ON/OFF switch in the config store.
 *
 * Two of these now exist and they must behave identically: the owner's
 * "the assistant may ship this project to production"
 * (`coding_vercel_auto_production`) and "every run in this project goes through
 * the delivery pipeline" (`coding_pipeline_projects`). Both are standing
 * permissions for something that happens while nobody is watching, so both have
 * to fail the same way — towards OFF, on every unreadable value — and both have
 * to store the same shape, or a map that grew a row per project the owner once
 * looked at.
 *
 * THE RULES, AND WHY EACH ONE IS HERE.
 *
 *  - Only an explicit `true` for THAT project is on. An unreadable value, a
 *    map that is not a map, a key that is not there: all off. The reasoning
 *    `clawbox_improvement_program` is written with — every failure of the read
 *    must fail towards the box doing LESS unasked.
 *  - Only the trues are stored. An "off" is the absence of a row, so a box
 *    whose owner has toggled twenty projects keeps at most the ones that are on.
 *  - The map has NO PROTOTYPE. A project scope is `[A-Za-z0-9_-]`, which spells
 *    `__proto__`, and assigning that key on an object literal writes the
 *    accumulator's prototype instead of a row (the reason ./vercel-link's
 *    `emptyLinks` is written the way it is).
 *  - Writes are queued per KEY, because a read-modify-write across an await is
 *    not a write: two switches flipped together would each store the map the
 *    other started from.
 */
import { get as configGet, set as configSet } from "@/lib/config-store";
import { BOX_SCOPE, isValidSecretScope } from "@/lib/project-secrets";

/** One write at a time per config key. */
const writes = new Map<string, Promise<unknown>>();

function queue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writes.get(key) ?? Promise.resolve();
  const mine = previous.then(fn, fn);
  writes.set(key, mine.catch(() => {}));
  return mine;
}

function emptyMap(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/** Is the switch on for this project? Anything but an explicit true is off. */
export async function readProjectSwitch(key: string, scope: string | null | undefined): Promise<boolean> {
  if (typeof scope !== "string" || !scope) return false;
  const raw = await configGet(key);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  if (!Object.prototype.hasOwnProperty.call(raw, scope)) return false;
  return (raw as Record<string, unknown>)[scope] === true;
}

/** Every project the switch is on for, as the settings surfaces list them. */
export async function readProjectSwitches(key: string): Promise<string[]> {
  const raw = await configGet(key);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([scope, value]) => value === true && scope !== BOX_SCOPE && isValidSecretScope(scope))
    .map(([scope]) => scope)
    .sort();
}

/** Turn it on or off for one project. Answers what it now is. */
export function setProjectSwitch(key: string, scope: string, enabled: boolean): Promise<boolean> {
  return queue(key, async () => {
    const raw = await configGet(key);
    const before = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const next = emptyMap();
    for (const [existing, value] of Object.entries(before)) {
      if (existing !== BOX_SCOPE && existing !== scope && isValidSecretScope(existing) && value === true) {
        next[existing] = true;
      }
    }
    if (enabled) next[scope] = true;
    await configSet(key, next);
    return enabled;
  });
}
