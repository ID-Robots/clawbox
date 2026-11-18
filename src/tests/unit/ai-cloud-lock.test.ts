import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The local-only AI lock (TASK-2501): the one switch every cloud AI path asks.
 *
 * What is pinned here is the contract the guards build on — how the stored
 * value reads, which model refs and endpoints count as "on the box or the
 * owner's network", the refusal every guard answers with, and the split of the
 * ClawBox credential into "linked" (kept under the lock) and "for AI" (null
 * under it). Each guard has its own case beside its own route or module.
 */

const store = vi.hoisted(() => ({ map: new Map<string, unknown>(), failReads: false }));
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => {
    if (store.failReads) throw new Error("EACCES");
    return store.map.get(key);
  },
  getKnown: async (key: string) => (store.failReads ? { value: undefined, known: false } : { value: store.map.get(key), known: true }),
  set: async (key: string, value: unknown) => {
    if (value === undefined) store.map.delete(key);
    else store.map.set(key, value);
  },
  setMany: vi.fn(),
}));

const readConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openclaw-config", () => ({ readConfig: () => readConfig() }));
vi.mock("@/lib/edition-source", () => ({ readEdition: () => "openclaw" }));

beforeEach(() => {
  store.map.clear();
  store.failReads = false;
  readConfig.mockReset();
});

describe("the stored value", () => {
  it("reads true as locked and \"pinned\" as locked and pinned", async () => {
    const { cloudAiLockFrom } = await import("@/lib/ai-cloud-lock-shared");
    expect(cloudAiLockFrom(true)).toEqual({ locked: true, pinned: false });
    expect(cloudAiLockFrom("pinned")).toEqual({ locked: true, pinned: true });
  });

  it("reads everything else as unlocked, the state every box ships in", async () => {
    const { cloudAiLockFrom } = await import("@/lib/ai-cloud-lock-shared");
    for (const value of [undefined, null, false, "true", "on", 1, {}, []]) {
      expect(cloudAiLockFrom(value)).toEqual({ locked: false, pinned: false });
    }
  });

  it("stores unlocked as the key's absence, and round-trips the other two", async () => {
    const { cloudAiLockFrom, storedCloudAiLock } = await import("@/lib/ai-cloud-lock-shared");
    expect(storedCloudAiLock({ locked: false, pinned: false })).toBeUndefined();
    // Pinned means nothing without the lock.
    expect(storedCloudAiLock({ locked: false, pinned: true })).toBeUndefined();
    for (const state of [{ locked: true, pinned: false }, { locked: true, pinned: true }]) {
      expect(cloudAiLockFrom(storedCloudAiLock(state))).toEqual(state);
    }
  });
});

describe("what counts as local", () => {
  it("takes on-box engines and the External engine, and nothing in the cloud", async () => {
    const { isLocalAiModelRef } = await import("@/lib/ai-cloud-lock-shared");
    for (const ref of ["llamacpp/gemma-4-e2b", "ollama/qwen3:4b", "clawlocal/gemma-4", "clawext/qwen3-32b", "  llamacpp/gemma  "]) {
      expect(isLocalAiModelRef(ref)).toBe(true);
    }
    for (const ref of ["clawai/flash", "deepseek/deepseek-v4-flash", "anthropic/claude-sonnet-4-5", "openai/gpt-5", "llamacpp", "llamacpp/", "/gemma", "", null, undefined, 42]) {
      expect(isLocalAiModelRef(ref)).toBe(false);
    }
    // A provider id that merely starts like a local one is not local.
    expect(isLocalAiModelRef("llamacpp-cloud/model")).toBe(false);
  });

  it("keeps only the local part of a fallback chain, in order", async () => {
    const { localOnlyFallbacks } = await import("@/lib/ai-cloud-lock-shared");
    expect(localOnlyFallbacks(["clawai/flash", " llamacpp/gemma ", "anthropic/claude", "clawext/qwen"]))
      .toEqual(["llamacpp/gemma", "clawext/qwen"]);
    expect(localOnlyFallbacks("llamacpp/gemma")).toEqual([]);
    expect(localOnlyFallbacks(undefined)).toEqual([]);
  });

  it("calls an endpoint local only on the box or the owner's own network, and fails closed", async () => {
    const { isLocalAiBaseUrl } = await import("@/lib/ai-cloud-lock-shared");
    const local = [
      "http://127.0.0.1:8080/v1",
      "http://localhost:11434",
      "http://api.localhost/v1",
      "http://10.0.0.5:8000/v1", // public-hygiene: allow a made-up address that tests the private-range classifier
      "http://172.16.4.2/v1", // public-hygiene: allow a made-up address that tests the private-range classifier
      "http://172.31.255.1/v1", // public-hygiene: allow a made-up address that tests the private-range classifier
      "http://192.168.1.20:1234/v1", // public-hygiene: allow a made-up address that tests the private-range classifier
      "http://169.254.10.10/v1",
      "http://100.64.0.7:8000/v1",
      "http://[::1]:8080/v1",
      "http://[fe80::1]/v1", // public-hygiene: allow a made-up address that tests the private-range classifier
      "http://[fd12:3456::1]/v1", // public-hygiene: allow a made-up address that tests the private-range classifier
      "http://workstation.local:8000/v1",
      "http://gpu.lan/v1",
      "http://box.internal/v1",
      "http://desk.home.arpa/v1",
      "http://workstation:8000/v1",
    ];
    for (const url of local) expect(isLocalAiBaseUrl(url), url).toBe(true);
    const cloud = [
      "https://api.openai.com/v1",
      "https://clawbox.com/api/ai",
      "http://8.8.8.8/v1",
      "http://172.32.0.1/v1",
      "http://100.128.0.1/v1",
      "http://192.169.0.1/v1",
      "http://[2001:db8::1]/v1",
      "http://999.1.1.1/v1",
      "not a url",
      "",
      "   ",
      null,
      undefined,
      42,
    ];
    for (const url of cloud) expect(isLocalAiBaseUrl(url), String(url)).toBe(false);
  });
});

describe("the server half", () => {
  it("reads the store per call, so a flip takes effect at once", async () => {
    const { isCloudAiLocked, readCloudAiLock, writeCloudAiLock, AI_CLOUD_LOCK_KEY } = await import("@/lib/ai-cloud-lock");
    expect(await isCloudAiLocked()).toBe(false);
    await writeCloudAiLock({ locked: true, pinned: false });
    expect(store.map.get(AI_CLOUD_LOCK_KEY)).toBe(true);
    expect(await isCloudAiLocked()).toBe(true);
    await writeCloudAiLock({ locked: true, pinned: true });
    expect(store.map.get(AI_CLOUD_LOCK_KEY)).toBe("pinned");
    expect(await readCloudAiLock()).toEqual({ locked: true, pinned: true });
    await writeCloudAiLock({ locked: false, pinned: false });
    expect(store.map.has(AI_CLOUD_LOCK_KEY)).toBe(false);
    expect(await isCloudAiLocked()).toBe(false);
  });

  it("fails closed on a store that is there and cannot be read", async () => {
    const { isCloudAiLocked, readCloudAiLock } = await import("@/lib/ai-cloud-lock");
    store.failReads = true;
    expect(await isCloudAiLocked()).toBe(true);
    expect(await readCloudAiLock()).toEqual({ locked: true, pinned: false });
    // And the credential is withheld from AI use with it.
    readConfig.mockResolvedValue({ models: { providers: { deepseek: { apiKey: "claw_device_token" } } } });
    const credentials = await import("@/lib/harness/credentials");
    expect(await credentials.resolveClawaiToken()).toBeNull();
    // Once it reads again, an absent key is unlocked again.
    store.failReads = false;
    expect(await isCloudAiLocked()).toBe(false);
  });

  it("refuses with one code, and the route form is a no-store 409", async () => {
    const lock = await import("@/lib/ai-cloud-lock");
    await expect(lock.assertCloudAiUnlocked()).resolves.toBeUndefined();
    store.map.set(lock.AI_CLOUD_LOCK_KEY, true);
    const refused = await lock.assertCloudAiUnlocked("No pictures leave the box.").then(() => null, (err: unknown) => err);
    expect(refused).toBeInstanceOf(lock.CloudAiLockedError);
    expect(lock.isCloudAiLockedError(refused)).toBe(true);
    expect((refused as Error).message).toBe("No pictures leave the box.");
    expect((refused as { code: string }).code).toBe(lock.CLOUD_AI_LOCKED_CODE);
    // Anything carrying the code is the lock's refusal, whatever class threw it.
    expect(lock.isCloudAiLockedError({ code: "cloud_ai_locked" })).toBe(true);
    expect(lock.isCloudAiLockedError(new Error("cloud_ai_locked"))).toBe(false);

    const res = lock.cloudAiLockedResponse();
    expect(res.status).toBe(409);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: lock.CLOUD_AI_LOCKED_MESSAGE, code: "cloud_ai_locked" });
  });
});

describe("the ClawBox credential under the lock", () => {
  function linkedOpenclawBox() {
    readConfig.mockResolvedValue({ models: { providers: { deepseek: { apiKey: "claw_device_token" } } } });
  }

  it("is withheld from every AI use while locked", async () => {
    linkedOpenclawBox();
    store.map.set("ai_cloud_lock", true);
    const credentials = await import("@/lib/harness/credentials");
    expect(await credentials.resolveClawaiToken()).toBeNull();
    expect(await credentials.hasClawaiToken()).toBe(false);
  });

  it("still proves the box is linked — heartbeat, plan, store, sign-out", async () => {
    linkedOpenclawBox();
    store.map.set("ai_cloud_lock", "pinned");
    const credentials = await import("@/lib/harness/credentials");
    expect(await credentials.resolveClawaiEntitlementToken()).toBe("claw_device_token");
    expect(await credentials.hasClawaiEntitlementToken()).toBe(true);
  });

  it("is the same token for both uses while unlocked — behaviour unchanged", async () => {
    linkedOpenclawBox();
    const credentials = await import("@/lib/harness/credentials");
    expect(await credentials.resolveClawaiToken()).toBe("claw_device_token");
    expect(await credentials.resolveClawaiEntitlementToken()).toBe("claw_device_token");
    expect(await credentials.hasClawaiToken()).toBe(true);
  });
});

describe("the speech config as a locked box may use it", () => {
  const CLOUD_AND_LOCAL = {
    tts: {
      provider: "openai",
      providers: {
        openai: { apiKey: "claw_device_token", baseUrl: "https://clawbox.com/api/ai" },
        elevenlabs: { apiKey: "el-owner-key" },
        "tts-local-cli": { type: "command", command: "/usr/local/bin/clawbox-tts" },
      },
    },
    models: { providers: { openai: { apiKey: "sk-owner", baseUrl: "https://api.openai.com/v1" }, llamacpp: { baseUrl: "http://127.0.0.1:8080/v1" } } },
  };

  it("leaves out every cloud voice, so no cloud speech target remains", async () => {
    const { withoutCloudVoices, cloudSpeechTarget } = await import("@/lib/voice-output");
    expect(cloudSpeechTarget(CLOUD_AND_LOCAL)).not.toBeNull();
    const locked = withoutCloudVoices(CLOUD_AND_LOCAL);
    expect(cloudSpeechTarget(locked)).toBeNull();
    expect(Object.keys(locked.tts?.providers as object)).toEqual(["tts-local-cli"]);
    // The chat's own model providers are not the voice's to remove — only the
    // cloud voice's fallback credential is.
    expect(Object.keys(locked.models?.providers ?? {})).toEqual(["llamacpp"]);
    // The file's view is copied, never edited in place.
    expect(Object.keys(CLOUD_AND_LOCAL.tts.providers)).toHaveLength(3);
  });

  it("also clears the pre-2026.8 home", async () => {
    const { withoutCloudVoices } = await import("@/lib/voice-output");
    const legacy = { messages: { tts: { provider: "elevenlabs", providers: { elevenlabs: { apiKey: "k" }, piper: {} } } } };
    expect(Object.keys(withoutCloudVoices(legacy).messages?.tts?.providers as object)).toEqual(["piper"]);
  });

  it("hands a config with no cloud voice back as it was", async () => {
    const { withoutCloudVoices } = await import("@/lib/voice-output");
    const localOnly = { tts: { provider: "tts-local-cli", providers: { "tts-local-cli": { type: "command" } } } };
    expect(withoutCloudVoices(localOnly)).toBe(localOnly);
  });
});

describe("the browser half", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reads only an owner's 200 as known", async () => {
    const { cloudAiLockViewFrom } = await import("@/lib/ai-cloud-lock-client");
    expect(cloudAiLockViewFrom(200, { cloud_ai_locked: true, pinned: false })).toMatchObject({ locked: true, pinned: false, known: true });
    expect(cloudAiLockViewFrom(200, { cloud_ai_locked: "yes" })).toMatchObject({ locked: false, known: true });
    // Another user, a route that is not there yet, a broken body: unknown, unlocked.
    for (const [status, body] of [[403, { cloud_ai_locked: true }], [404, null], [200, null], [200, "locked"]] as const) {
      expect(cloudAiLockViewFrom(status, body)).toEqual({ locked: false, pinned: false, known: false, report: null });
    }
  });

  it("asks once and hands every caller the answer", async () => {
    const client = await import("@/lib/ai-cloud-lock-client");
    client.resetCloudAiLockCache();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cloud_ai_locked: true, pinned: true }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const view = await client.refreshCloudAiLock();
    expect(view).toMatchObject({ locked: true, pinned: true, known: true });
    expect(fetchMock).toHaveBeenCalledWith(client.CLOUD_AI_LOCK_ROUTE, { cache: "no-store" });
  });

  it("drops a load that comes back after a newer answer was published", async () => {
    const client = await import("@/lib/ai-cloud-lock-client");
    client.resetCloudAiLockCache();
    let answer!: (res: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;
    const slow = client.refreshCloudAiLock();
    // The switch moved, and its POST's answer is handed round first.
    client.publishCloudAiLock(200, { cloud_ai_locked: true, pinned: false });
    answer(new Response(JSON.stringify({ cloud_ai_locked: false, pinned: false }), { status: 200 }));
    expect(await slow).toMatchObject({ locked: true, known: true });
    // A fresh refresh after it is news again.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ cloud_ai_locked: false }), { status: 200 })) as unknown as typeof fetch;
    expect(await client.refreshCloudAiLock()).toMatchObject({ locked: false, known: true });
  });

  it("reads a network failure as unknown, never as locked", async () => {
    const client = await import("@/lib/ai-cloud-lock-client");
    client.resetCloudAiLockCache();
    globalThis.fetch = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    expect(await client.refreshCloudAiLock()).toMatchObject({ locked: false, known: false });
  });
});
