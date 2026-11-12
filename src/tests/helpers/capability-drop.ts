import fs from "fs";
import path from "path";
import { vi } from "vitest";
import type * as CapabilityDrop from "@/lib/capability-drop";

/**
 * The settings production-server.js puts into its own environment
 * (`process.env.NAME = …`), read from its source. The suites pin the helper
 * programs' environment against this list rather than a copy of the module's.
 */
export const WEB_SERVER_SETTINGS: readonly string[] = [
  ...fs
    .readFileSync(path.resolve(__dirname, "../../../production-server.js"), "utf-8")
    .matchAll(/^\s*process\.env\.([A-Z][A-Z0-9_]*) = /gm),
].map((m) => m[1]);

/** Give each of them a value of its own for this test (`vi.unstubAllEnvs()` undoes it). */
export function stubWebServerSettings(): void {
  if (WEB_SERVER_SETTINGS.length === 0) throw new Error("no settings found in production-server.js");
  for (const key of WEB_SERVER_SETTINGS) vi.stubEnv(key, `test-value-of-${key}`);
}

/** `env` without them, worked out here and not by the code under test. */
export function withoutThem(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !WEB_SERVER_SETTINGS.includes(key)));
}

export interface DropState {
  /** true: a host whose web server holds ambient capabilities, with setpriv and every program present. */
  wrap: boolean;
  /** What each site asked the gate: (bin, argv, opts). */
  calls: unknown[][];
}

/**
 * The capability drop as a site suite sees it: the REAL gate, with only its
 * two host probes decided by `state`. A bare name resolves to the first PATH
 * entry, so a wrapped case sets PATH.
 */
export function realGate(real: typeof CapabilityDrop, state: DropState): typeof CapabilityDrop {
  return {
    ...real,
    withCapabilityDrop: (bin, argv, opts) => {
      state.calls.push([bin, argv, opts]);
      return real.withCapabilityDrop(bin, argv, {
        ...opts,
        probes: {
          readStatus: () => `CapAmb:\t${state.wrap ? "0000000000003400" : "0000000000000000"}\n`,
          isExecutable: () => true,
        },
      });
    },
  };
}
