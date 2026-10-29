import { beforeEach, describe, expect, it, vi } from "vitest";

// What the box records about models this ACCOUNT cannot run, and how the
// newest-model default reads it: a mark lasts an hour, holds for the account
// it was proved on and no other, a credential save clears it, and the newest
// default skips a marked model.

const store = vi.hoisted(() => ({ data: {} as Record<string, unknown>, unreadable: false }));
const DATA_DIR = vi.hoisted(() => `/tmp/clawbox-model-availability-test-${process.pid}`);

// The gateway's auth store, as the account digest reads it: no store unless a
// test puts one there. Fingerprints only — this module never sees a key.
const auth = vi.hoisted(() => ({ read: { kind: "no-store" } as unknown }));
vi.mock("@/lib/openclaw-auth-store", () => ({
  readGatewayProviderAuth: vi.fn(() => auth.read),
}));

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
  readProviderAccountKey,
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

/** An auth store holding one xAI API key, by its fingerprint. */
function xaiKey(fingerprint: string, profileId = "xai:default") {
  return {
    kind: "present",
    profiles: [{ profileId, type: "api_key", fingerprint, refreshFingerprint: null, expires: null, fenced: false, fence: null }],
    order: null,
    failures: {},
  };
}

beforeEach(() => {
  store.data = {};
  store.unreadable = false;
  auth.read = { kind: "no-store" };
  fs.rmSync(CACHE, { recursive: true, force: true });
});

describe("unavailable models", () => {
  it("keeps a refusal for an hour, then lets the model be asked again", async () => {
    expect(UNAVAILABLE_TTL_MS).toBe(60 * 60_000);
    const t0 = Date.parse("2026-10-28T16:15:00Z");
    await markModelUnavailable("xai", "grok-4.6", "zero_quota", t0);
    // 17:00:45 — the moment the fallback chose Grok 4.6 on the test box: still marked.
    expect(await readUnavailableModelIds("xai", Date.parse("2026-10-28T17:00:45Z"))).toEqual(new Set(["grok-4.6"]));
    // Past the hour the mark no longer counts: the model is asked again.
    expect(await readUnavailableModelIds("xai", t0 + 61 * 60_000)).toEqual(new Set());
  });

  it("records a refusal once as news, and lets it expire after the TTL", async () => {
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
      .toEqual({ xai: { "grok-4.5": { reason: "not_found", at: 5, account: null } } });
    // An account that is not a digest is no account.
    expect(unavailableMapFrom({ xai: { "grok-4.5": { reason: "zero_quota", at: 5, account: "../x" } } }))
      .toEqual({ xai: { "grok-4.5": { reason: "zero_quota", at: 5, account: null } } });
  });

  it("still tells the owner when the store cannot be read", async () => {
    store.unreadable = true;
    expect(await markModelUnavailable("xai", "grok-4.6", "zero_quota")).toBe(true);
    expect(await readUnavailableModelIds("xai")).toEqual(new Set());
  });
});

describe("per account", () => {
  it("names the account by a digest of the stored credentials' fingerprints — never a credential", () => {
    expect(readProviderAccountKey("xai")).toBeNull();
    auth.read = xaiKey("fp-account-a");
    const a = readProviderAccountKey("xai");
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(a).not.toContain("fp-account-a");
    auth.read = xaiKey("fp-account-b");
    expect(readProviderAccountKey("xai")).not.toBe(a);
    // A sign-in is the same account across token refreshes: named by its id.
    auth.read = { ...xaiKey("access-1"), profiles: [{ ...xaiKey("access-1").profiles[0], type: "oauth" }] };
    const signedIn = readProviderAccountKey("xai");
    auth.read = { ...xaiKey("access-2"), profiles: [{ ...xaiKey("access-2").profiles[0], type: "oauth" }] };
    expect(readProviderAccountKey("xai")).toBe(signedIn);
    // A fenced profile holds no credential, and an unreadable store is no account.
    auth.read = { ...xaiKey("x"), profiles: [{ ...xaiKey("x").profiles[0], fenced: true, fence: "failed" }] };
    expect(readProviderAccountKey("xai")).toBeNull();
    auth.read = { kind: "unreadable" };
    expect(readProviderAccountKey("xai")).toBeNull();
  });

  it("keeps a model from the account that was refused on it, and from no other", async () => {
    const now = Date.parse("2026-10-28T17:00:00Z");
    auth.read = xaiKey("fp-account-a");
    await markModelUnavailable("xai", "grok-4.6", "zero_quota", now);
    expect(await readUnavailableModelIds("xai", now + 1_000)).toEqual(new Set(["grok-4.6"]));
    // Another key: another xAI account, whose models nobody has tried yet.
    auth.read = xaiKey("fp-account-b");
    expect(await readUnavailableModelIds("xai", now + 1_000)).toEqual(new Set());
    // A refusal on that account replaces the first account's marks.
    expect(await markModelUnavailable("xai", "grok-4.7", "zero_quota", now + 2_000)).toBe(true);
    expect(await readUnavailableModelIds("xai", now + 3_000)).toEqual(new Set(["grok-4.7"]));
    const stored = (store.data[UNAVAILABLE_MODELS_KEY] as Record<string, Record<string, unknown>>).xai;
    expect(Object.keys(stored)).toEqual(["grok-4.7"]);
    // The account is given explicitly where the caller already knows it.
    expect(await readUnavailableModelIds("xai", now + 3_000, null)).toEqual(new Set());
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
