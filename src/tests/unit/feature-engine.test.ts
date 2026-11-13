/**
 * src/lib/feature-engine.ts — which engine answers the box's own AI features
 * (Prime Radiant, picture descriptions) and Memory Shard's cloud question
 * (TASK-2501 PR-C).
 *
 * Pinned: a signed-in box keeps ClawBox AI, exactly as before; the local-only
 * AI lock sends every feature to the box's own engine and never falls back to
 * the cloud; a box without ClawBox AI uses its own engine when it has one;
 * neither is "none", with the reason a route words its refusal by.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
/** `unreadable`: the store is there and cannot be read (getKnown says so); `throws`: the reader itself rejects. */
const storeFails = { unreadable: false, throws: false };
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => store.get(key),
  getKnown: async (key: string) => {
    if (storeFails.throws) throw new Error("no tri-state reader");
    return storeFails.unreadable ? { value: undefined, known: false } : { value: store.get(key), known: true };
  },
  set: async (key: string, value: unknown) => {
    store.set(key, value);
  },
}));

const token = vi.fn(async (): Promise<string | null> => "claw_test");
vi.mock("@/lib/harness/credentials", () => ({ resolveClawaiToken: () => token() }));

const LOCAL = {
  kind: "llamacpp",
  model: "gemma4-e2b-it-q4_0",
  modelRef: "llamacpp/gemma4-e2b-it-q4_0",
  chatUrl: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1/chat/completions",
  authorization: "Bearer local",
  contextTokens: 32768,
  maxOutputTokens: 8192,
  parallel: 1,
  imageInput: false,
};
const localEngine = vi.fn(async (): Promise<typeof LOCAL | null> => LOCAL);
vi.mock("@/lib/local-engine", () => ({ resolveLocalEngine: () => localEngine() }));

import { CLOUD_AI_LOCK_KEY, cloudAiLockOn, resolveFeatureEngine } from "@/lib/feature-engine";

beforeEach(() => {
  store.clear();
  storeFails.unreadable = false;
  storeFails.throws = false;
  token.mockReset().mockResolvedValue("claw_test");
  localEngine.mockReset().mockResolvedValue(LOCAL);
});

describe("the local-only AI lock, as the store holds it", () => {
  it("is on for true and for pinned, off for anything else", async () => {
    for (const [value, on] of [[true, true], ["pinned", true], [false, false], ["true", false], [1, false], [undefined, false]] as const) {
      store.set(CLOUD_AI_LOCK_KEY, value);
      expect(await cloudAiLockOn(), String(value)).toBe(on);
    }
  });

  it("reads as ON when the store is there but cannot be read: never the cloud on a read failure (PR-A's rule)", async () => {
    storeFails.unreadable = true;
    expect(await cloudAiLockOn()).toBe(true);
    // Signed in, with a model on the box: the box's own engine, not ClawBox AI.
    expect(await resolveFeatureEngine()).toEqual({ kind: "local", engine: LOCAL });
    expect(token).not.toHaveBeenCalled();
  });

  it("reads as ON when the reader itself rejects: no answer is never \"off\"", async () => {
    storeFails.throws = true;
    expect(await cloudAiLockOn()).toBe(true);
    expect(await resolveFeatureEngine()).toEqual({ kind: "local", engine: LOCAL });
  });
});

describe("which engine answers", () => {
  it("is ClawBox AI on a signed-in box, with a model of its own beside it", async () => {
    expect(await resolveFeatureEngine()).toEqual({ kind: "clawbox-ai" });
    expect(localEngine).not.toHaveBeenCalled();
  });

  it("is the box's own engine on a box that holds no ClawBox AI credential", async () => {
    token.mockResolvedValue(null);
    expect(await resolveFeatureEngine()).toEqual({ kind: "local", engine: LOCAL });
  });

  it("is the box's own engine under the lock, even signed in, and the credential is never asked", async () => {
    store.set(CLOUD_AI_LOCK_KEY, true);
    expect(await resolveFeatureEngine()).toEqual({ kind: "local", engine: LOCAL });
    expect(token).not.toHaveBeenCalled();
  });

  it("is none under the lock without a model on the box: never the cloud", async () => {
    store.set(CLOUD_AI_LOCK_KEY, "pinned");
    localEngine.mockResolvedValue(null);
    expect(await resolveFeatureEngine()).toEqual({ kind: "none", reason: "cloud_ai_locked" });
  });

  it("is none, for want of a credential, on a box with neither", async () => {
    token.mockResolvedValue(null);
    localEngine.mockResolvedValue(null);
    expect(await resolveFeatureEngine()).toEqual({ kind: "none", reason: "no_credential" });
  });

  it("never throws: a credential or an engine that cannot be read is none", async () => {
    token.mockRejectedValue(new Error("boom"));
    localEngine.mockRejectedValue(new Error("boom"));
    expect(await resolveFeatureEngine()).toEqual({ kind: "none", reason: "no_credential" });
  });
});
