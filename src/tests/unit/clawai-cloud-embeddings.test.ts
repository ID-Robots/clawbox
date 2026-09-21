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
  CLOUD_EMBEDDING_DIMENSIONS,
  CLOUD_PROBE_MAX_BYTES,
  cloudEmbeddingsSwitchedOff,
  cloudEmbeddingsUrl,
  embeddingsBaseUrlOf,
  forgetCloudEmbeddingsProbe,
  probeCloudEmbeddings,
} from "@/lib/clawai-cloud-embeddings";

const REAL_URL = process.env.CLAWBOX_AI_EMBEDDINGS_URL;
const REAL_INSECURE = process.env.CLAWBOX_AI_EMBEDDINGS_INSECURE;

beforeEach(() => {
  store.clear();
  forgetCloudEmbeddingsProbe();
  delete process.env.CLAWBOX_AI_EMBEDDINGS_URL;
  delete process.env.CLAWBOX_AI_EMBEDDINGS_INSECURE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (REAL_URL === undefined) delete process.env.CLAWBOX_AI_EMBEDDINGS_URL;
  else process.env.CLAWBOX_AI_EMBEDDINGS_URL = REAL_URL;
  if (REAL_INSECURE === undefined) delete process.env.CLAWBOX_AI_EMBEDDINGS_INSECURE;
  else process.env.CLAWBOX_AI_EMBEDDINGS_INSECURE = REAL_INSECURE;
});

function answer(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const encoder = new TextEncoder();

/**
 * A fetch whose answer arrives as a stream this test can watch: `pulls` counts
 * the chunks actually asked for, `cancelled` records the reader letting go. A
 * refusal can then be checked for what it DID as well as what it returned.
 *
 * `highWaterMark: 0` is what makes that possible. A default stream primes
 * itself with one chunk before anybody reads, and "was the body consumed?"
 * stops being an answerable question; at zero, a pull means a read.
 */
function streamedAnswer(
  chunks: string[],
  { headers = {}, breakAfter = false }: { headers?: Record<string, string>; breakAfter?: boolean } = {},
) {
  const seen = { pulls: 0, cancelled: false };
  const fetchMock = vi.fn(async () => {
    let next = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          seen.pulls += 1;
          if (next < chunks.length) {
            controller.enqueue(encoder.encode(chunks[next++]));
            return;
          }
          if (breakAfter) controller.error(new Error("connection reset mid-answer"));
          else controller.close();
        },
        cancel() {
          seen.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });
  });
  return { fetchMock, seen };
}

/** A readable, valid answer that is exactly `bytes` ASCII characters long. */
function payloadOfExactly(bytes: number): string {
  const shell = JSON.stringify({ data: [{ embedding: [0.5] }], pad: "" });
  return JSON.stringify({ data: [{ embedding: [0.5] }], pad: "a".repeat(bytes - shell.length) });
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

  it("refuses plain http off the device, whatever it is pointed at", () => {
    // The request carries this box's `claw_` bearer and the owner's document
    // text as its body, so cleartext leaving the device is CWE-319. The earlier
    // rule accepted any `http:` and left "only on a trusted LAN" to the
    // operator — a promise nothing here could check, over the one failure that
    // cannot be undone once it has happened.
    process.env.CLAWBOX_AI_EMBEDDINGS_URL = "http://staging.lan:8080/v1/embeddings";
    expect(cloudEmbeddingsUrl()).toBe("https://clawbox.test/api/ai/embeddings");
  });

  it("keeps plain http on THIS DEVICE, where it leaves no interface", () => {
    process.env.CLAWBOX_AI_EMBEDDINGS_URL = "http://127.0.0.1:8080/v1/embeddings";
    expect(cloudEmbeddingsUrl()).toBe("http://127.0.0.1:8080/v1/embeddings");
    process.env.CLAWBOX_AI_EMBEDDINGS_URL = "http://localhost:8080/v1/embeddings";
    expect(cloudEmbeddingsUrl()).toBe("http://localhost:8080/v1/embeddings");
  });

  it("keeps the LAN staging lane, but only for an image built to ask for it", () => {
    // The staging contract did not go away; it became explicit, and it lives
    // where the address lives — root's environment, never the device store, so
    // a restored backup or a hand-edited config.json cannot turn cleartext on.
    process.env.CLAWBOX_AI_EMBEDDINGS_URL = "http://staging.lan:8080/v1/embeddings";
    process.env.CLAWBOX_AI_EMBEDDINGS_INSECURE = "1";
    expect(cloudEmbeddingsUrl()).toBe("http://staging.lan:8080/v1/embeddings");
  });

  it("holds the built-in route to the same rule as an override", () => {
    // `CLAWBOX_AI_PROXY_URL` is env-overridable too, so exempting the address
    // every unconfigured box uses would have been the way round the rule above.
    // Nothing usable answers "", which every caller fails closed on.
    delete process.env.CLAWBOX_AI_EMBEDDINGS_URL;
    expect(cloudEmbeddingsUrl()).toBe("https://clawbox.test/api/ai/embeddings");
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

/**
 * The size half of the bound.
 *
 * The probe's timeout says how LONG the far side may take and nothing about how
 * much it may send while taking it: a staging responder on the plain-http hop
 * the endpoint contract allows, or any intermediary on the way, can answer fast
 * and never stop. These pin that the answer is measured as it arrives, refused
 * on its own claimed size where it makes one, and never parsed unless the whole
 * of it landed inside the cap.
 */
describe("probeCloudEmbeddings bounds the answer it will hold", () => {
  const CAP = CLOUD_PROBE_MAX_BYTES;

  it("accepts the full-precision 3,072-number vector the real model answers with", async () => {
    const vector = Array.from({ length: CLOUD_EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(i) / 3);
    const payload = JSON.stringify({
      object: "list",
      model: "text-embedding-3-large",
      data: [{ object: "embedding", index: 0, embedding: vector }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
    // The cap is chosen against exactly this. A real answer, at the length
    // `double`s actually print to, is a fraction of it — if that stops being
    // true it is the cap that is wrong and not this test.
    const size = encoder.encode(payload).length;
    expect(size).toBeGreaterThan(50 * 1024);
    expect(size).toBeLessThan(CAP);

    const third = Math.ceil(payload.length / 3);
    const { fetchMock, seen } = streamedAnswer([
      payload.slice(0, third),
      payload.slice(third, third * 2),
      payload.slice(third * 2),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    // Reassembled across chunk boundaries, and nothing was cancelled: an answer
    // inside the bound is read to the end like it always was.
    await expect(probeCloudEmbeddings()).resolves.toBe(true);
    expect(seen.cancelled).toBe(false);
  });

  it("refuses an answer that admits to being too big, without pulling a byte of it", async () => {
    const { fetchMock, seen } = streamedAnswer([payloadOfExactly(CAP)], {
      headers: { "content-length": String(CAP + 1) },
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
    // The cheap case: a responder that tells the truth about its size costs
    // this box nothing, because the body is dropped before it is read.
    expect(seen.pulls).toBe(0);
    expect(seen.cancelled).toBe(true);
  });

  it("counts the bytes that actually arrive when nothing advertised a length", async () => {
    const chunk = "a".repeat(64 * 1024);
    const { fetchMock, seen } = streamedAnswer(Array.from({ length: 8 }, () => chunk));
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
    // Four chunks is the cap exactly; the fifth crosses it and the read stops
    // there rather than draining the three behind it.
    expect(seen.pulls).toBe(5);
    expect(seen.cancelled).toBe(true);
    // A refusal is remembered like any other: the next ask costs no request.
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not take a small advertised length over the bytes on the wire", async () => {
    // The header is the responder's claim, not a fact. `12` here, megabytes in
    // the stream — which is also the shape a compressed answer has, since the
    // length describes the bytes before this box inflates them.
    const chunk = "a".repeat(64 * 1024);
    const { fetchMock, seen } = streamedAnswer(Array.from({ length: 8 }, () => chunk), {
      headers: { "content-length": "12" },
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
    expect(seen.pulls).toBe(5);
    expect(seen.cancelled).toBe(true);
  });

  it("cancels an oversized answer and never hands it to JSON.parse", async () => {
    // Valid JSON with a usable vector at the front: an unbounded read would
    // answer TRUE here, so the false below is the cap doing the work rather
    // than a parse failure standing in for it.
    const { fetchMock, seen } = streamedAnswer([payloadOfExactly(CAP + 1024)]);
    vi.stubGlobal("fetch", fetchMock);
    const parse = vi.spyOn(JSON, "parse");
    try {
      await expect(probeCloudEmbeddings()).resolves.toBe(false);
      expect(seen.cancelled).toBe(true);
      expect(parse.mock.calls.some(([text]) => typeof text === "string" && text.length > CAP)).toBe(false);
    } finally {
      parse.mockRestore();
    }
  });

  it("accepts an answer that lands exactly on the cap", async () => {
    const exact = payloadOfExactly(CAP);
    expect(encoder.encode(exact).length).toBe(CAP);
    const { fetchMock, seen } = streamedAnswer([exact.slice(0, CAP - 10), exact.slice(CAP - 10)]);
    vi.stubGlobal("fetch", fetchMock);
    // The bound is "more than", not "as much as": the last legal byte is legal.
    await expect(probeCloudEmbeddings()).resolves.toBe(true);
    expect(seen.cancelled).toBe(false);
  });

  it("fails closed on malformed JSON, a stream that breaks, and a body that is not there", async () => {
    const truncated = '{"data":[{"embedding":[0.1,';
    vi.stubGlobal("fetch", streamedAnswer([truncated]).fetchMock);
    await expect(probeCloudEmbeddings()).resolves.toBe(false);

    forgetCloudEmbeddingsProbe();
    // A stream that errors mid-answer rejects its own cancellation, which the
    // probe has to swallow rather than surface as an unhandled rejection.
    vi.stubGlobal("fetch", streamedAnswer([truncated], { breakAfter: true }).fetchMock);
    await expect(probeCloudEmbeddings()).resolves.toBe(false);

    forgetCloudEmbeddingsProbe();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
  });

  it("still asks with the eight-second timeout, which bounds time and not size", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { fetchMock } = streamedAnswer([JSON.stringify({ data: [{ embedding: [0.25] }] })]);
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(probeCloudEmbeddings()).resolves.toBe(true);
      expect(timeout).toHaveBeenCalledWith(8000);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.signal).toBe(timeout.mock.results[0].value);
    } finally {
      timeout.mockRestore();
    }

    forgetCloudEmbeddingsProbe();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }));
    await expect(probeCloudEmbeddings()).resolves.toBe(false);
  });
});
