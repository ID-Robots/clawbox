import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's per-provider switch (src/lib/provider-enablement.ts).
 *
 * The one that matters for the store: the disabled list is read, changed and
 * written back as a whole, and two switches flipped together — two tabs, a
 * fast owner — each read the same list, so the second write silently undid
 * the first. Pinned with a slow store, where the race is deterministic.
 */

const store = vi.hoisted(() => ({ values: {} as Record<string, unknown>, writeDelayMs: 0 }));

vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => store.values[key],
  set: async (key: string, value: unknown) => {
    // A slow write: the second caller's read lands while this one is in flight.
    await new Promise((resolve) => setTimeout(resolve, store.writeDelayMs));
    store.values[key] = value;
  },
}));

vi.mock("@/lib/harness", () => ({ getActiveHarness: async () => "openclaw" }));

vi.mock("@/lib/provider-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provider-status")>();
  return {
    ...actual,
    readProviderStatus: async () => ({
      harness: "openclaw",
      // Nothing hidden here: a provider dropped for running no model is still
      // switchable, and that case has its own assertion below.
      unrunnable: hiddenProviders,
      providers: [
        { id: "anthropic", isDefault: true },
        { id: "openrouter", isDefault: false },
        { id: "gemini", isDefault: false },
      ],
    }),
  };
});

/** Ids `readProviderStatus` dropped from its rows for this test. */
let hiddenProviders: string[] = [];

type Lib = typeof import("@/lib/provider-enablement");
let lib: Lib;

beforeEach(async () => {
  vi.resetModules();
  store.values = {};
  store.writeDelayMs = 0;
  hiddenProviders = [];
  lib = await import("@/lib/provider-enablement");
});

describe("setProviderEnabled", () => {
  it("lands both of two switches flipped together", async () => {
    store.writeDelayMs = 20;
    const [a, b] = await Promise.all([
      lib.setProviderEnabled("openrouter", false),
      lib.setProviderEnabled("gemini", false),
    ]);
    expect(a).toEqual({ ok: true, provider: "openrouter" });
    expect(b).toEqual({ ok: true, provider: "gemini" });
    expect(store.values.ai_disabled_providers).toEqual(["gemini", "openrouter"]);
  });

  it("switches a provider back on", async () => {
    store.values.ai_disabled_providers = ["gemini", "openrouter"];
    expect(await lib.setProviderEnabled("gemini", true)).toEqual({ ok: true, provider: "gemini" });
    expect(store.values.ai_disabled_providers).toEqual(["openrouter"]);
    expect(await lib.isProviderEnabled("gemini")).toBe(true);
    expect(await lib.isProviderEnabled("openrouter")).toBe(false);
  });

  it("refuses to switch off the current default, and writes nothing", async () => {
    const out = await lib.setProviderEnabled("anthropic", false);
    expect(out).toMatchObject({ ok: false, kind: "is_default" });
    expect(store.values.ai_disabled_providers).toBeUndefined();
  });

  it("refuses a provider the status does not know", async () => {
    expect(await lib.setProviderEnabled("nonesuch", false)).toMatchObject({ ok: false, kind: "unknown_provider" });
  });

  it("still flips the switch for a provider the strip hides", async () => {
    // A provider the box can run no model from (TASK-668) is named in
    // `unrunnable` and KEPT in the rows, so its switch is an ordinary one: the
    // strip does the hiding, nothing forgets the provider, and nothing here has
    // to know about the ruling at all. The answer still names the provider from
    // the row rather than re-stating the caller's string.
    hiddenProviders = ["gemini"];
    expect(await lib.setProviderEnabled("gemini", false)).toEqual({ ok: true, provider: "gemini" });
    expect(store.values.ai_disabled_providers).toEqual(["gemini"]);
  });
});
