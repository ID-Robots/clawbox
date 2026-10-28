import { beforeEach, describe, expect, it, vi } from "vitest";

// What the box records about models this ACCOUNT cannot run, and how the
// newest-model default reads it: a mark lasts a day, a credential save clears
// it, and the newest default skips a marked model.

const store = vi.hoisted(() => ({ data: {} as Record<string, unknown>, unreadable: false }));
const DATA_DIR = vi.hoisted(() => `/tmp/clawbox-model-availability-test-${process.pid}`);

vi.mock("@/lib/config-store", () => ({
  DATA_DIR,
  getKnown: vi.fn(async (key: string) => (store.unreadable ? { value: undefined, known: false } : { value: store.data[key], known: true })),
  setMany: vi.fn(async (entries: Record<string, unknown>) => { Object.assign(store.data, structuredClone(entries)); }),
}));

import fs from "fs";
import path from "path";
import {
  UNAVAILABLE_MODELS_KEY,
  UNAVAILABLE_TTL_MS,
  forgetUnavailableModels,
  markModelUnavailable,
  readNewestModelId,
  readNewestModelRefs,
  readUnavailableModelIds,
  unavailableMapFrom,
} from "@/lib/provider-model-availability";

const CACHE = path.join(DATA_DIR, "catalog-cache");

function writeLiveCatalog(provider: string, ids: string[], source = "live"): void {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, `${provider}.json`), JSON.stringify({
    provider,
    models: ids.map((id) => ({ id, label: id, contextWindow: 500_000 })),
    defaultModelId: ids[0],
    ...(source ? { source } : {}),
  }));
}

beforeEach(() => {
  store.data = {};
  store.unreadable = false;
  fs.rmSync(CACHE, { recursive: true, force: true });
});

describe("unavailable models", () => {
  it("records a refusal once as news, and lets it expire after a day", async () => {
    const t0 = Date.parse("2026-10-28T12:00:00Z");
    expect(await markModelUnavailable("xai", "grok-4.6", "zero_quota", t0)).toBe(true);
    // A second refusal is not news, and it is fresh evidence: the day restarts.
    const t1 = t0 + 1_000;
    expect(await markModelUnavailable("xai", "grok-4.6", "zero_quota", t1)).toBe(false);
    expect(await readUnavailableModelIds("xai", t1 + 1_000)).toEqual(new Set(["grok-4.6"]));
    expect(await readUnavailableModelIds("xai", t0 + UNAVAILABLE_TTL_MS + 1)).toEqual(new Set(["grok-4.6"]));
    expect(await readUnavailableModelIds("xai", t1 + UNAVAILABLE_TTL_MS + 1)).toEqual(new Set());
    expect(await markModelUnavailable("xai", "grok-4.6", "zero_quota", t1 + UNAVAILABLE_TTL_MS + 1)).toBe(true);
  });

  it("clears a provider's marks when its credential is saved again", async () => {
    await markModelUnavailable("xai", "grok-4.6", "zero_quota");
    await forgetUnavailableModels("xai");
    expect(await readUnavailableModelIds("xai")).toEqual(new Set());
    expect(store.data[UNAVAILABLE_MODELS_KEY]).toEqual({});
  });

  it("refuses ids that are not model ids, and tolerates a hand-edited store", async () => {
    expect(await markModelUnavailable("xai", "../../x", "zero_quota")).toBe(false);
    expect(await markModelUnavailable("__proto__", "grok-4.6", "zero_quota")).toBe(false);
    expect(unavailableMapFrom({ xai: { "grok-4.6": { reason: "nope", at: 1 }, "grok-4.5": { reason: "not_found", at: 5 } }, bad: 3 }))
      .toEqual({ xai: { "grok-4.5": { reason: "not_found", at: 5 } } });
  });

  it("still tells the owner when the store cannot be read", async () => {
    store.unreadable = true;
    expect(await markModelUnavailable("xai", "grok-4.6", "zero_quota")).toBe(true);
    expect(await readUnavailableModelIds("xai")).toEqual(new Set());
  });
});

describe("readNewestModelId", () => {
  it("answers the newest model of the box's live enumeration — a new one included", async () => {
    writeLiveCatalog("xai", ["grok-4.6", "grok-4.8", "grok-4.7"]);
    expect(await readNewestModelId("xai")).toBe("grok-4.8");
    expect(await readNewestModelRefs()).toEqual(new Map([["xai", "xai/grok-4.8"]]));
  });

  it("skips a model this account has a zero limit on", async () => {
    writeLiveCatalog("xai", ["grok-4.7", "grok-4.6"]);
    await markModelUnavailable("xai", "grok-4.7", "zero_quota");
    expect(await readNewestModelId("xai")).toBe("grok-4.6");
  });

  it("falls back to the cold-start list when there is no live enumeration", async () => {
    // An unmarked file: an older build's, or the curated list a failure left.
    writeLiveCatalog("xai", ["grok-9"], "");
    expect(await readNewestModelId("xai")).toBe("grok-4.7");
  });

  it("answers null for a provider whose default does not follow the newest model", async () => {
    expect(await readNewestModelId("anthropic")).toBeNull();
  });
});
