import type { Mock } from "vitest";

/**
 * Test-only view of "which `openclaw config set` assignments did the route
 * make", across both forms the route uses.
 *
 * The configure route writes most of its config through
 * `runOpenclawConfigSetBatch`, which sends N assignments in one CLI invocation
 * because on a Jetson each invocation costs ~8 s of Node start-up (TASK-483).
 * A handful of one-off writes still go through `runOpenclawConfigSet`. The
 * assertions in these suites are about the assignments, not about how many
 * processes carried them, so this flattens both mocks back into one ordered
 * list of `[path, value, ...flags]` argvs.
 *
 * Ordering across the two mocks comes from vitest's `invocationCallOrder`, so
 * the list is in the order the route actually issued the writes.
 */
export interface ConfigSetCall {
  /** The config path, e.g. `agents.defaults.model.primary`. */
  path: string;
  /** The value exactly as the route passed it (JSON text when `json` is true). */
  value: string;
  /** Whether the assignment carried `--json`. */
  json: boolean;
  /** `config set <path> <value>[ --json]` — the form these suites assert on. */
  command: string;
  /** The raw argv, minus the leading `config set`. */
  args: string[];
}

function toCall(args: string[]): ConfigSetCall {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const json = args.includes("--json");
  return {
    path: positional[0] ?? "",
    value: positional[1] ?? "",
    json,
    command: ["config", "set", ...args].join(" "),
    args,
  };
}

export function configSetCalls(single: Mock, batch: Mock): ConfigSetCall[] {
  const ordered: { order: number; args: string[] }[] = [];
  single.mock.calls.forEach((call, i) => {
    ordered.push({
      order: single.mock.invocationCallOrder[i] ?? 0,
      args: (call[0] as string[] | undefined) ?? [],
    });
  });
  batch.mock.calls.forEach((call, i) => {
    const order = batch.mock.invocationCallOrder[i] ?? 0;
    for (const args of ((call[0] as string[][] | undefined) ?? [])) {
      ordered.push({ order, args });
    }
  });
  return ordered
    .sort((a, b) => a.order - b.order)
    .map((entry) => toCall(entry.args));
}

export function configSetCommands(single: Mock, batch: Mock): string[] {
  return configSetCalls(single, batch).map((call) => call.command);
}

export function findConfigSet(single: Mock, batch: Mock, path: string): ConfigSetCall | undefined {
  return configSetCalls(single, batch).find((call) => call.path === path);
}

/**
 * Make both config-set mocks reject for any assignment whose path matches.
 *
 * The route sends most assignments through the batch form, so a test that only
 * stubs `runOpenclawConfigSet` to throw would silently stop exercising the
 * failure it was written for. Batch mode is atomic — a batch containing a
 * matching path fails as a whole — which is what the real CLI does and what
 * `applyConfigSetGroups` then recovers from by re-issuing each group alone.
 */
export function failConfigSetsMatching(
  single: Mock,
  batch: Mock,
  matches: (path: string) => boolean,
  makeError: () => Error,
): void {
  single.mockImplementation(async (args: string[]) => {
    if (matches(args?.[0] ?? "")) throw makeError();
  });
  batch.mockImplementation(async (ops: string[][]) => {
    for (const args of ops ?? []) {
      if (matches(args?.[0] ?? "")) throw makeError();
    }
  });
}
