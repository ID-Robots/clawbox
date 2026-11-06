// Which built-in apps a loaded desktop shows, from what the box saved.
//
// Pure, so the rule is tested on its own (src/tests/unit/desktop-app-merge.test.ts)
// rather than through the desktop page that applies it.
//
// A saved `desktop_apps` list cannot tell a built-in that shipped AFTER it was
// saved from one the owner removed with "Remove from desktop": both are simply
// absent. Auto-adding every absent default therefore put a removed icon back on
// every reload. `desktop_apps_known` is the missing fact — the default built-ins
// this box has already been offered — and only a default NOT in it is new.

export interface DesktopAppMergeInput {
  /** `desktop_apps` as stored (anything; validated here). */
  saved: unknown;
  /** `desktop_apps_known` as stored (anything; validated here). */
  known: unknown;
  /** Every built-in id — the validity filter for both lists. */
  builtIns: readonly string[];
  /** The built-ins that belong on a desktop by default. */
  defaults: readonly string[];
  /** Ids a pending shed takes out of the saved list, or null. */
  shed: ReadonlySet<string> | null;
}

export interface DesktopAppMergeResult {
  /** The list to show, or null when the box saved none (the defaults stand). */
  apps: string[] | null;
  /** The known set to store beside it from now on. */
  known: string[];
}

function idList(value: unknown, builtIns: readonly string[]): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((id): id is string => typeof id === "string" && builtIns.includes(id));
}

export function mergeDesktopApps(input: DesktopAppMergeInput): DesktopAppMergeResult {
  const { builtIns, defaults, shed } = input;
  const storedKnown = idList(input.known, builtIns);
  let saved = idList(input.saved, builtIns);

  // A box that saved a list before the known set existed: every default it has
  // today counts as already offered, so an icon removed before this fix stays
  // removed. Only a default that ships after this load can be new to it.
  const knownBefore = new Set(storedKnown ?? (saved ? defaults : []));

  let apps: string[] | null = null;
  if (saved) {
    if (shed) saved = saved.filter(id => !shed.has(id));
    // Only default-set built-ins are auto-added, so an app that ships off the
    // desktop never appears on a box that never had it.
    const added = defaults.filter(id => !saved!.includes(id) && !knownBefore.has(id));
    apps = added.length > 0 ? [...saved, ...added] : saved;
  }

  // Every default is offered by the end of this load — added just now, already
  // on the desktop, or removed by the owner — so all of them are known after it.
  const known = [...knownBefore];
  for (const id of defaults) if (!knownBefore.has(id)) known.push(id);
  return { apps, known };
}

/** True when `known` differs from what the box stored, so it must be written. */
export function knownSetChanged(stored: unknown, known: readonly string[]): boolean {
  if (!Array.isArray(stored) || stored.length !== known.length) return true;
  return known.some((id, i) => stored[i] !== id);
}
