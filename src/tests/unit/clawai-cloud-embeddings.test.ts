/**
 * The ClawBox AI cloud embedder: where it is, and who is allowed to say so.
 *
 * The property pinned here is a security one. The owner's whole memory index
 * becomes the body of a request to this endpoint, so the endpoint may not come
 * out of `data/config.json` — that file is deny-listed for a coding run's own
 * file tools precisely so a prompt-injected run cannot redirect the box. The
 * store gets a SWITCH; the address comes from the environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
// BOTH halves of the store, not just the half this file reads. The credential
// reader behind `@/lib/harness/credentials` takes `get` AND `set` off this
// module, and both of its calls sit inside a catch that answers a DEFAULT — so
// a factory naming only `get` does not fail the suite, it quietly puts every
// case here on the "no refusal on record" branch. That is the hole
// `openclaw-config-mock-completeness` exists to catch. A real Map stands in, so
// a write is visible to the next read.
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => {
    store.set(key, value);
  },
}));
vi.mock("@/lib/harness/credentials", () => ({
  CLAWBOX_AI_PROXY_URL: "https://clawbox.test/api/ai",
  resolveClawaiToken: async () => "claw_test",
}));

import {
  CLAWAI_CLOUD_EMBEDDINGS_KEY,
  cloudEmbeddingsSwitchedOff,
  cloudEmbeddingsUrl,
  embeddingsBaseUrlOf,
  forgetCloudEmbeddingsProbe,
  probeCloudEmbeddings,
} from "@/lib/clawai-cloud-embeddings";

const REAL_URL = process.env.CLAWBOX_AI_EMBEDDINGS_URL;

beforeEach(() => {
  store.clear();
  forgetCloudEmbeddingsProbe();
  delete process.env.CLAWBOX_AI_EMBEDDINGS_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (REAL_URL === undefined) delete process.env.CLAWBOX_AI_EMBEDDINGS_URL;
  else process.env.CLAWBOX_AI_EMBEDDINGS_URL = REAL_URL;
});

function answer(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("cloudEmbeddingsUrl", () => {
  it("is the proxy's own route on a device build", () => {
    expect(cloudEmbeddingsUrl()).toBe("https://clawbox.test/api/ai/embeddings");
  });

  it("takes its address from the environment, which is root's", () => {
    process.env.CLAWBOX_AI_EMBEDDINGS_URL = "https://staging.test/v1/embeddings";
    expect(cloudEmbeddingsUrl()).toBe("https://staging.test/v1/embeddings");
  });

  it("cannot be repointed by anything in the device store", async () => {
    // The whole reason the key holds a word: a host written here would be an
    // exfiltration route for every document the owner has indexed.
    store.set(CLAWAI_CLOUD_EMBEDDINGS_KEY, "https://attacker.test/collect");
    expect(cloudEmbeddingsUrl()).toBe("https://clawbox.test/api/ai/embeddings");
    // And a value that is not the one word it understands is not "off" either.
    expect(await cloudEmbeddingsSwitchedOff()).toBe(false);
  });

  it("hands OpenClaw the base the core appends /embeddings to itself", () => {
    expect(embeddingsBaseUrlOf("https://clawbox.test/api/ai/embeddings")).toBe("https://clawbox.test/api/ai");
    expect(embeddingsBaseUrlOf("https://clawbox.test/api/ai/")).toBe("https://clawbox.test/api/ai");
  });

  it("keeps plain http, which is the LAN staging contract", () => {
    // Deliberately NOT narrowed to loopback: the override exists so a staging
    // image can be pointed at a proxy on a trusted LAN. HTTPS outside that is
    // the operator's to honour — see the trust boundary on `usableEndpoint`.
    process.env.CLAWBOX_AI_EMBEDDINGS_URL = "http://staging.lan:8080/v1/embeddings";
    expect(cloudEmbeddingsUrl()).toBe("http://staging.lan:8080/v1/embeddings");
  });

  it("refuses an override that is not an http(s) address, and falls back to its own account's route", () => {
    // The endpoint is the destination of a request carrying this box's bearer,
    // so a scheme that is not a network fetch, a string that is not a URL, and
    // a length nothing legitimate needs are all treated as "nobody set one".
    for (const bad of [
      "file:///etc/passwd",
      "data:text/plain,collect",
      "javascript:fetch(1)",
      "not a url at all",
      `https://staging.test/${"a".repeat(2100)}`,
    ]) {
      process.env.CLAWBOX_AI_EMBEDDINGS_URL = bad;
      expect(cloudEmbeddingsUrl()).toBe("https://clawbox.test/api/ai/embeddings");
    }
  });
});

describe("probeCloudEmbeddings", () => {
  it("accepts a route that answers a numeric vector", async () => {
    const fetchMock = answer({ data: [{ embedding: [0.1, 0.2] }] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeCloudEmbeddings()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Believed for hours: a second ask costs no request.
    await expect(probeCloudEmbeddings()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a route that has not shipped, and one that answers a shape nothing can read", async () => {
    vi.stubGlobal("fetch", answer({}, 404));
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
    forgetCloudEmbeddingsProbe();
    vi.stubGlobal("fetch", answer({ data: [{ embedding: "not a vector" }] }));
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
  });

  it("never throws at a refused connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
  });

  it("asks nothing at all on a box switched off in the field", async () => {
    store.set(CLAWAI_CLOUD_EMBEDDINGS_KEY, "off");
    const fetchMock = answer({ data: [{ embedding: [1] }] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the box's bearer only to the validated address, and a bounded body", async () => {
    process.env.CLAWBOX_AI_EMBEDDINGS_URL = "https://staging.test/v1/embeddings";
    const fetchMock = answer({ data: [{ embedding: [0.5] }] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeCloudEmbeddings()).resolves.toBe(true);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://staging.test/v1/embeddings");
    // The probe body is a literal and a vetted model id — nothing the owner
    // wrote and nothing read out of a file travels in it. The one file-derived
    // value is the bearer, which is this box's own credential for its own
    // account and is the point of the request.
    expect(JSON.parse(String(init.body))).toEqual({ model: "text-embedding-3-large", input: "clawbox" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer claw_test");
  });
});
