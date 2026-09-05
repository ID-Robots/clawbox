import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * TASK-583 — `verified` is present on every provider row and null on all of
 * them, so "connected" still means "a key is on disk". These pin the rules that
 * make it mean something without a probe: what counts as evidence, what a
 * credential change does to it, and what the store may cost on the settle path
 * of a turn a customer is waiting on.
 */

const store = new Map<string, unknown>();
const getMock = vi.hoisted(() => vi.fn());
const setMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/config-store", () => ({ get: getMock, set: setMock }));

let lib: typeof import("@/lib/provider-verified");
let hermesHome: string;

/** Hermes' pooled credential store, written at `at`. */
function writeAuthStore(at: Date): void {
  const file = path.join(hermesHome, "auth.json");
  writeFileSync(file, "{}");
  utimesSync(file, at, at);
}

afterEach(() => {
  delete process.env.HERMES_HOME;
  rmSync(hermesHome, { recursive: true, force: true });
});

beforeEach(async () => {
  hermesHome = mkdtempSync(path.join(tmpdir(), "clawbox-verified-hermes-"));
  process.env.HERMES_HOME = hermesHome;
  store.clear();
  getMock.mockReset();
  setMock.mockReset();
  getMock.mockImplementation(async (key: string) => store.get(key));
  setMock.mockImplementation(async (key: string, value: unknown) => { store.set(key, value); });
  vi.resetModules();
  lib = await import("@/lib/provider-verified");
});

describe("provider-verified", () => {
  it("remembers a provider that served a turn, with when", async () => {
    await lib.recordProviderVerified("openai-codex", new Date("2026-09-02T19:53:34.000Z"));

    expect(await lib.readProviderVerified())
      .toEqual({ "openai-codex": "2026-09-02T19:53:34.000Z" });
  });

  it("does not rewrite the store for every turn of a busy conversation", async () => {
    // A write is a read, a serialise and a rename of the WHOLE config store,
    // and "it answered at 19:53" is not made truer by being restated at 19:54.
    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T19:00:00.000Z"));
    setMock.mockClear();

    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T19:30:00.000Z"));

    expect(setMock).not.toHaveBeenCalled();
    // ...and it does write again once the mark has genuinely aged.
    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T21:00:00.000Z"));
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it("forgets a provider whose credential has just been written", async () => {
    // A rotated key inherits nothing from the one it replaced: the row goes
    // back to "not checked", never to "not connected".
    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T19:00:00.000Z"));

    await lib.forgetProviderVerified("anthropic");

    expect(await lib.readProviderVerified()).toEqual({});
    // ...and the very next turn may mark it again at once, rather than being
    // held off by a debounce that outlived the mark it was debouncing.
    setMock.mockClear();
    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T19:05:00.000Z"));
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the store bounded, dropping the oldest marks first", async () => {
    for (let i = 0; i < lib.MAX_VERIFIED_PROVIDERS + 3; i += 1) {
      await lib.recordProviderVerified(`p${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)));
    }

    const marks = await lib.readProviderVerified();
    expect(Object.keys(marks)).toHaveLength(lib.MAX_VERIFIED_PROVIDERS);
    expect(marks).not.toHaveProperty("p0");
    expect(marks).toHaveProperty(`p${lib.MAX_VERIFIED_PROVIDERS + 2}`);
  });

  it("ignores a mark that is not a usable instant, and one that is not a provider id", async () => {
    // Shipping either would put "verified at Invalid Date" on the panel.
    store.set(lib.PROVIDER_VERIFIED_KEY, {
      anthropic: "not a date",
      "../etc": "2026-09-02T19:00:00.000Z",
      openai: 1756843200000,
      google: "2026-09-02T19:00:00.000Z",
    });

    expect(await lib.readProviderVerified())
      .toEqual({ google: "2026-09-02T19:00:00.000Z" });
  });

  it("never throws over a store it cannot read or write", async () => {
    // This runs on the settle path of a turn and on a credential save: losing a
    // status mark must never cost the answer or the save.
    getMock.mockRejectedValue(new Error("EACCES"));
    setMock.mockRejectedValue(new Error("EACCES"));

    await expect(lib.readProviderVerified()).resolves.toEqual({});
    await expect(lib.recordProviderVerified("anthropic")).resolves.toBeUndefined();
    await expect(lib.forgetProviderVerified("anthropic")).resolves.toBeUndefined();
  });

  it("refuses an id that is not a provider slug", async () => {
    await lib.recordProviderVerified("../../etc/passwd");
    await lib.recordProviderVerified("");

    expect(setMock).not.toHaveBeenCalled();
  });

  it("drops a mark older than the last write to Hermes' own credential store", async () => {
    // ClawBox is not the only writer: a key pasted into Hermes' own dashboard,
    // or `hermes auth add` from the Terminal, never passes through this
    // process. Without this the flag would outlive the credential it describes
    // — a fact captured once and treated as current for the life of the box.
    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T19:00:00.000Z"));
    writeAuthStore(new Date("2026-09-03T08:00:00.000Z"));

    expect(await lib.readProviderVerified()).toEqual({});
  });

  it("keeps a mark earned after that write", async () => {
    writeAuthStore(new Date("2026-09-03T08:00:00.000Z"));
    await lib.recordProviderVerified("anthropic", new Date("2026-09-03T09:00:00.000Z"));

    expect(await lib.readProviderVerified())
      .toEqual({ anthropic: "2026-09-03T09:00:00.000Z" });
  });

  it("keeps every mark when the credential store cannot be asked", async () => {
    // A box with no pooled credentials yet has nothing to invalidate, and "we
    // could not look" must not read as "everything is stale".
    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T19:00:00.000Z"));

    expect(await lib.readProviderVerified())
      .toEqual({ anthropic: "2026-09-02T19:00:00.000Z" });
  });

  it("refuses a KIND that is not a real provider slug", async () => {
    // `auto` and `custom` are kinds as well as words: a mark under either
    // matches no row, describes no credential, and takes one of the slots.
    await lib.recordProviderVerified("auto");
    await lib.recordProviderVerified("custom");
    await lib.recordProviderVerified("Anthropic");

    expect(setMock).not.toHaveBeenCalled();
  });

  it("never moves a mark backwards when the clock is behind", async () => {
    // A Jetson's RTC lags until NTP settles, and rewriting the mark with the
    // earlier reading would make the panel's "verified <when>" older than the
    // truth.
    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T19:00:00.000Z"));
    setMock.mockClear();

    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T17:00:00.000Z"));

    expect(setMock).not.toHaveBeenCalled();
    expect(await lib.readProviderVerified())
      .toEqual({ anthropic: "2026-09-02T19:00:00.000Z" });
  });

  it("does not let a concurrent record write a forget back into the store", async () => {
    // Both writers are read-modify-writes of one map. Unserialised, the record
    // writes back the snapshot it read before the delete and the forget is
    // silently undone — the same reason provider-enablement serialises its own
    // list.
    await lib.recordProviderVerified("anthropic", new Date("2026-09-02T19:00:00.000Z"));

    await Promise.all([
      lib.forgetProviderVerified("anthropic"),
      lib.recordProviderVerified("openai-codex", new Date("2026-09-02T21:00:00.000Z")),
    ]);

    expect(await lib.readProviderVerified())
      .toEqual({ "openai-codex": "2026-09-02T21:00:00.000Z" });
  });
});
