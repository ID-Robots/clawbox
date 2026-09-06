import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// TASK-668 — "can this box run any model from provider X?", answered from the
// count the catalog route's own enumeration recorded, and from nothing else.
//
// Every case here is about the ONE rule this file exists to keep: only a
// definite, CURRENT count decides anything. No record, an unreadable record, a
// stamp too old to be a fact — all of them are UNKNOWN, and unknown shows the
// row. Hiding a provider on an answer nobody gave would delete a working
// provider from the only screen that can fix it.

let dataDir = "";
vi.mock("@/lib/config-store", () => ({
  get DATA_DIR() { return dataDir; },
  setMany: vi.fn(),
  get: vi.fn(),
}));

const recordFile = () => path.join(dataDir, "catalog-cache", "_enumerations.json");

function writeRecord(providers: Record<string, { models: number; atMs: number }>) {
  mkdirSync(path.dirname(recordFile()), { recursive: true });
  writeFileSync(recordFile(), JSON.stringify({ providers }), "utf8");
}

function readRecord(): Record<string, { models: number }> {
  return JSON.parse(readFileSync(recordFile(), "utf8")).providers;
}

async function load() {
  return import("@/lib/provider-runnable");
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "clawbox-runnable-unit-"));
  vi.resetModules();
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("the recorded model count", () => {
  it("says `some` for a provider that enumerated rows and `none` for a clean zero", async () => {
    writeRecord({ google: { models: 0, atMs: Date.now() }, anthropic: { models: 9, atMs: Date.now() } });
    const { readProviderRunnable } = await load();

    const verdicts = await readProviderRunnable();

    expect(verdicts.get("google")).toBe("none");
    expect(verdicts.get("anthropic")).toBe("some");
  });

  it("says nothing at all about a provider with no record", async () => {
    const { providerRunnable } = await load();

    expect(await providerRunnable("google")).toBe("unknown");
  });

  it("expires a count older than the catalogue's refresh interval", async () => {
    writeRecord({ google: { models: 0, atMs: Date.now() - 7 * 60 * 60_000 } });
    const { providerRunnable } = await load();

    expect(await providerRunnable("google")).toBe("unknown");
  });

  it("treats an unusable timestamp as expired, not as fresh", async () => {
    writeRecord({ google: { models: 0, atMs: Number.NaN } });
    const { providerRunnable } = await load();

    expect(await providerRunnable("google")).toBe("unknown");
  });

  it("reads a corrupt record as nothing known, rather than throwing", async () => {
    mkdirSync(path.dirname(recordFile()), { recursive: true });
    writeFileSync(recordFile(), "{not json", "utf8");
    const { readProviderRunnable } = await load();

    expect([...(await readProviderRunnable())]).toEqual([]);
  });

  it("keeps the other providers when one is forgotten", async () => {
    // What a provider-set change does: the box moved under that ONE count.
    writeRecord({ google: { models: 0, atMs: Date.now() }, openai: { models: 2, atMs: Date.now() } });
    const { forgetProviderEnumeration, readProviderRunnable } = await load();

    await forgetProviderEnumeration("google");

    expect(readRecord().google).toBeUndefined();
    expect((await readProviderRunnable()).get("openai")).toBe("some");
  });

  it("forgets every count when the mode that gave them meaning changed", async () => {
    writeRecord({ google: { models: 0, atMs: Date.now() }, openai: { models: 2, atMs: Date.now() } });
    const { forgetProviderEnumerations, readProviderRunnable } = await load();

    await forgetProviderEnumerations();

    expect([...(await readProviderRunnable())]).toEqual([]);
  });

  it("does not lose a write to a write that started beside it", async () => {
    // Two enumerations can finish in the same tick — the main one and the
    // subscription-surface one — and a read-modify-write pair interleaved with
    // another would drop the loser's provider.
    const { recordProviderEnumeration } = await load();

    await Promise.all([
      recordProviderEnumeration("google", 0),
      recordProviderEnumeration("anthropic", 9),
      recordProviderEnumeration("openai", 2),
    ]);

    expect(Object.keys(readRecord()).sort()).toEqual(["anthropic", "google", "openai"]);
  });

  it("keeps working when there is no data directory to write to", async () => {
    // The module is imported by the Providers strip, which is imported by
    // routes: a throw at import time would take them down, and the honest
    // answer to "where is the store" is the same as to a missing file.
    dataDir = "";
    vi.resetModules();
    const { recordProviderEnumeration, providerRunnable } = await load();

    await expect(recordProviderEnumeration("google", 0)).resolves.toBeUndefined();
    expect(await providerRunnable("google")).toBe("unknown");
  });
});
