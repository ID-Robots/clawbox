import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Making a picture with the ClawBox AI proxy.
 *
 * The contract under test was OBSERVED against production from a linked box
 * (2026-08-24), not taken from the OpenAI API it resembles, and the two places
 * it differs from a guess are exactly the two these tests pin:
 *
 *   - the picture comes back as `data[0].b64_json` and there is NO `url` field,
 *     so the bytes have to be written to this box's own media tree;
 *   - the discovery GET is UNAUTHENTICATED, so it can answer "is there an image
 *     service" and can say nothing at all about this device's credential.
 *
 * The second one is why `clawaiImageRouteReachable` is only half of the
 * capability. A test that let it stand for the whole thing would be pinning a
 * button that appears on a box with no token.
 */

let tmpHome: string;
let originalHome: string | undefined;
let originalClawboxRoot: string | undefined;

let generateClawaiImage: typeof import("@/lib/harness/clawai-images").generateClawaiImage;
let clawaiImageRouteReachable: typeof import("@/lib/harness/clawai-images").clawaiImageRouteReachable;
let resetClawaiImageProbe: typeof import("@/lib/harness/clawai-images").resetClawaiImageProbe;
let ClawaiImageError: typeof import("@/lib/harness/clawai-images").ClawaiImageError;
let CLAWBOX_AI_IMAGES_ENDPOINT: string;
let IMAGE_MODEL: string;

/** A real 1×1 PNG: these tests sniff magic bytes, so the fixture has to be one. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6300010000050001",
  "hex",
);

/** The response the proxy actually sends, minus the megabyte of pixels. */
function imageResponse(bytes = PNG) {
  return {
    created: 1787604969,
    background: "opaque",
    output_format: "png",
    quality: "medium",
    size: "1024x1024",
    data: [{ b64_json: bytes.toString("base64") }],
    usage: { input_tokens: 17, output_tokens: 1056, total_tokens: 1073 },
  };
}

/** A `Response` with a real body stream — the module reads it with a byte cap. */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Put the device token in the Hermes store, which is `data/config.json`. */
function linkDevice(token: string | null): void {
  const dataDir = path.join(tmpHome, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify(token === null ? {} : { clawai_token: token }, null, 2),
  );
}

beforeEach(async () => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawai-images-"));
  originalHome = process.env.HOME;
  originalClawboxRoot = process.env.CLAWBOX_ROOT;
  process.env.HOME = tmpHome;
  process.env.CLAWBOX_ROOT = tmpHome;
  // Hermes, so the media root is `<DATA_DIR>/chat-media` — the tree a Hermes
  // box actually has. `~/.openclaw` there holds openclaw.json and nothing else.
  vi.doMock("@/lib/harness", () => ({ getActiveHarness: async () => "hermes" }));
  linkDevice("claw_testtoken0000000000000000000");

  const mod = await import("@/lib/harness/clawai-images");
  generateClawaiImage = mod.generateClawaiImage;
  clawaiImageRouteReachable = mod.clawaiImageRouteReachable;
  resetClawaiImageProbe = mod.resetClawaiImageProbe;
  ClawaiImageError = mod.ClawaiImageError;
  CLAWBOX_AI_IMAGES_ENDPOINT = mod.CLAWBOX_AI_IMAGES_ENDPOINT;
  IMAGE_MODEL = (await import("@/lib/clawbox-ai-models")).CLAWBOX_AI_IMAGE_MODEL_ID;
  resetClawaiImageProbe();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalClawboxRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = originalClawboxRoot;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("CLAWBOX_AI_IMAGES_ENDPOINT", () => {
  /** Re-import the module with a specific proxy override in place. */
  async function endpointFor(proxyUrl: string | undefined): Promise<string> {
    const previous = process.env.CLAWBOX_AI_PROXY_URL;
    if (proxyUrl === undefined) delete process.env.CLAWBOX_AI_PROXY_URL;
    else process.env.CLAWBOX_AI_PROXY_URL = proxyUrl;
    vi.resetModules();
    try {
      return (await import("@/lib/harness/clawai-images")).CLAWBOX_AI_IMAGES_ENDPOINT;
    } finally {
      if (previous === undefined) delete process.env.CLAWBOX_AI_PROXY_URL;
      else process.env.CLAWBOX_AI_PROXY_URL = previous;
    }
  }

  it("appends the path to the default proxy", async () => {
    await expect(endpointFor(undefined)).resolves.toBe(
      "https://clawbox.com/api/ai/images/generations",
    );
  });

  it("does not produce a double slash when the override has a trailing one", async () => {
    // A staging override copied out of a browser bar carries the slash. The
    // proxy answers `//images/generations` with a 404, and because BOTH the
    // discovery probe and the generation call are built from this constant,
    // the box would report "no image service" rather than a bad URL.
    await expect(endpointFor("https://staging.example/api/ai/")).resolves.toBe(
      "https://staging.example/api/ai/images/generations",
    );
    await expect(endpointFor("  https://staging.example/api/ai//  ")).resolves.toBe(
      "https://staging.example/api/ai/images/generations",
    );
  });
});

describe("clawaiImageRouteReachable", () => {
  /** The discovery body, as production answers it. */
  const discovery = {
    status: "ok",
    service: "ClawBox AI Image Generation",
    defaultModel: "gpt-image-1-mini",
    models: ["gpt-image-1-mini", "gpt-image-2"],
    modelTiers: { "gpt-image-1-mini": ["free", "pro", "max"], "gpt-image-2": ["max"] },
    maxImagesPerRequest: 4,
    dailyImageLimits: { free: 1, pro: 5, max: 20 },
    streaming: false,
    onDevice: false,
  };

  it("says yes when the proxy serves the model this box would ask for", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      // A GET at the images endpoint: the proxy's own discovery read, which
      // costs no generation and no daily allowance to ask.
      expect(String(url)).toBe(CLAWBOX_AI_IMAGES_ENDPOINT);
      expect(init?.method).toBe("GET");
      return jsonResponse({ ...discovery, models: [IMAGE_MODEL] });
    });
    await expect(clawaiImageRouteReachable(fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("says no when the route is up but no longer serves that model", async () => {
    // Not a hypothetical: the proxy matches the BARE id against an allowlist and
    // answers a miss with 400 "Model not supported for image generation". A
    // route that is up and serving something else is a dead button just as
    // surely as one that is down.
    const fetchImpl = vi.fn(async () => jsonResponse({ ...discovery, models: ["some-other-model"] }));
    await expect(clawaiImageRouteReachable(fetchImpl)).resolves.toBe(false);
  });

  it("falls back to defaultModel for a proxy too old to list them", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "ok", defaultModel: IMAGE_MODEL }));
    await expect(clawaiImageRouteReachable(fetchImpl)).resolves.toBe(true);
  });

  it("fails closed on every way the ask can go wrong", async () => {
    // A wrong `true` here is an offer to draw that ends in an error bubble, so
    // anything short of a clean, parseable, model-listing 200 is a no.
    const failures: Array<() => Promise<Response>> = [
      // The uplink is down.
      async () => { throw new Error("getaddrinfo ENOTFOUND"); },
      // The proxy is unwell.
      async () => jsonResponse({}, 503),
      // Something in front of it answered HTML.
      async () => new Response("<html>gateway</html>", { status: 200 }),
      // A 200 that is not an object at all.
      async () => jsonResponse("ok"),
    ];
    for (const respond of failures) {
      resetClawaiImageProbe();
      await expect(clawaiImageRouteReachable(vi.fn(respond))).resolves.toBe(false);
    }
  });

  it("asks once and reuses the answer, so opening the chat twice costs one round trip", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...discovery, models: [IMAGE_MODEL] }));
    // Concurrent callers share the in-flight promise rather than racing several
    // requests at the proxy — the state a box is in while it boots.
    const [a, b] = await Promise.all([
      clawaiImageRouteReachable(fetchImpl),
      clawaiImageRouteReachable(fetchImpl),
    ]);
    expect([a, b]).toEqual([true, true]);
    await expect(clawaiImageRouteReachable(fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cannot be read as proof the credential works", async () => {
    // Verified against production: the discovery GET returns the same 200 with
    // no token and with a wrong one. So a `true` here says the SERVICE is
    // there, and the token half of the answer has to come from somewhere else
    // (`hasClawaiToken`). Pinned because collapsing the two is the tempting
    // simplification, and it would put the button on an unlinked box.
    linkDevice(null);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      // No Authorization header is sent, because none is needed or wanted.
      expect(init?.headers).toBeUndefined();
      return jsonResponse({ ...discovery, models: [IMAGE_MODEL] });
    });
    await expect(clawaiImageRouteReachable(fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("generateClawaiImage", () => {
  it("posts the observed request shape and writes the picture to disk", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return jsonResponse(imageResponse());
    });
    const result = await generateClawaiImage("a red maple leaf", { fetchImpl });

    const { url, init } = sent[0];
    expect(url).toBe(CLAWBOX_AI_IMAGES_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      model: IMAGE_MODEL,
      prompt: "a red maple leaf",
      n: 1,
      size: "1024x1024",
    });

    // The bytes really landed, and under the media root the reader serves from.
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.readFileSync(result.path)).toEqual(PNG);
    expect(result.path).toContain(path.join("chat-media", "chat-generated"));
    // And the ref is the one a bubble and a transcript record both hold.
    expect(result.media).toBe(
      `/setup-api/chat/media?path=${encodeURIComponent(result.path)}`,
    );
  });

  it("names the file from its magic, not from what the response claims", async () => {
    // `output_format` is a claim ABOUT the bytes, and the extension it would
    // pick decides the Content-Type `/setup-api/chat/media` later serves the
    // file under. Sniffing keeps those two answers from disagreeing.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ...imageResponse(jpeg), output_format: "png" }),
    );
    const result = await generateClawaiImage("anything", { fetchImpl });
    expect(path.extname(result.path)).toBe(".jpg");
  });

  it("keeps the customer's words out of the filename", async () => {
    // The prompt is the least redacted thing in the exchange, and the path ends
    // up in a query string the browser keeps in its history.
    const fetchImpl = vi.fn(async () => jsonResponse(imageResponse()));
    const result = await generateClawaiImage("my home address is 12 Example Street", { fetchImpl });
    expect(path.basename(result.path)).toMatch(/^[0-9a-f-]{36}\.png$/);
  });

  it("refuses a format the media reader could not serve", async () => {
    const notAnImage = Buffer.from("%PDF-1.7\nthis is not a picture");
    const fetchImpl = vi.fn(async () => jsonResponse(imageResponse(notAnImage)));
    await expect(generateClawaiImage("x", { fetchImpl })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("format this box cannot show"),
    });
  });

  it("says so, actionably, when the box was never linked", async () => {
    linkDevice(null);
    const fetchImpl = vi.fn();
    await expect(generateClawaiImage("x", { fetchImpl })).rejects.toMatchObject({ status: 503 });
    // And nothing was sent: there is no credential to send it with.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("translates the proxy's own failures without quoting them", async () => {
    // The upstream body is allowed to echo the request that caused it, and that
    // request carried a bearer token — the same reason the transcription route
    // relays a status and never a body. The `code` values here are the ones
    // production actually answers with.
    const cases: Array<{ upstream: number; body: unknown; status: number; says: RegExp }> = [
      {
        upstream: 403,
        body: { error: { message: "Invalid token", type: "auth_error", code: "invalid_token" } },
        status: 503,
        says: /Re-link the device/,
      },
      {
        upstream: 401,
        body: { error: { code: "missing_token" } },
        status: 503,
        says: /Re-link the device/,
      },
      {
        upstream: 400,
        body: {
          error: {
            message: "Model not supported for image generation: x. Use gpt-image-1-mini or gpt-image-2.",
            code: "model_not_supported",
          },
        },
        status: 400,
        says: /could not draw that/,
      },
      {
        upstream: 429,
        body: { error: { message: "daily limit" } },
        status: 429,
        says: /today's ClawBox AI pictures/,
      },
      { upstream: 502, body: {}, status: 502, says: /Generating the picture failed/ },
    ];
    for (const c of cases) {
      // Each case is its own box: the 401/403 arms leave a remembered refusal
      // behind (see "stops asking once the proxy has refused…"), and the point
      // here is what each STATUS is translated to.
      resetClawaiImageProbe();
      const fetchImpl = vi.fn(async () => jsonResponse(c.body, c.upstream));
      const err = await generateClawaiImage("x", { fetchImpl }).catch((e) => e);
      expect(err).toBeInstanceOf(ClawaiImageError);
      expect(err.status).toBe(c.status);
      expect(err.message).toMatch(c.says);
      // Whatever the proxy said, we did not repeat it.
      expect(err.message).not.toContain("Invalid token");
      expect(err.message).not.toContain("gpt-image-1-mini");
    }
  });

  it("stops asking once the proxy has refused this device's credential", async () => {
    // TASK-727. The proxy answers 403 `invalid_token` to a credential it no
    // longer accepts, and that answer cannot change while the credential does
    // not: nothing the box can do makes the next identical request succeed.
    // Beta asked anyway, on every trigger, forever — 6,554 refused POSTs from
    // one box in twelve hours and ~68 per e2e-install run, all of them
    // guaranteed 403 before they were sent.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "Invalid token", code: "invalid_token" } }, 403),
    );
    await expect(generateClawaiImage("x", { fetchImpl })).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Every later attempt still FAILS, with the same actionable sentence — the
    // customer is told the truth each time. What must not happen is another
    // request going out to be refused again.
    for (let i = 0; i < 20; i++) {
      await expect(generateClawaiImage("x", { fetchImpl })).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("Re-link the device"),
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps asking when the 403 did not come from the proxy", async () => {
    // The false-failure guard, and the reason the memo reads `error.code` at
    // all. An edge rule, a rate-limit page or an interception proxy can answer
    // 403 to a box whose credential is perfectly good — remembering one of
    // those would hide the picture button and tell that customer to re-pair a
    // working device. Only the proxy's own `invalid_token` / `missing_token`
    // is proof, so anything else costs a retry rather than a feature.
    const edge = vi.fn(async () => new Response("<html>403 Forbidden</html>", { status: 403 }));
    for (let i = 0; i < 3; i++) {
      await expect(generateClawaiImage("x", { fetchImpl: edge })).rejects.toMatchObject({ status: 503 });
    }
    expect(edge).toHaveBeenCalledTimes(3);

    // A 403 the proxy DID attribute to the credential still stops the loop,
    // and a plan gate that answers some other code still does not.
    const gated = vi.fn(async () => jsonResponse({ error: { code: "model_not_allowed" } }, 403));
    await expect(generateClawaiImage("x", { fetchImpl: gated })).rejects.toMatchObject({ status: 503 });
    await expect(generateClawaiImage("x", { fetchImpl: gated })).rejects.toMatchObject({ status: 503 });
    expect(gated).toHaveBeenCalledTimes(2);
  });

  it("asks again the moment the device is re-linked", async () => {
    // The other half, and the reason this is a memory of ONE credential rather
    // than a flag on the box: re-linking is the fix the error tells the
    // customer to apply, so it has to work without a restart and without
    // waiting out any timer.
    const refuse = vi.fn(async () => jsonResponse({ error: { code: "invalid_token" } }, 403));
    await expect(generateClawaiImage("x", { fetchImpl: refuse })).rejects.toMatchObject({ status: 503 });
    await expect(generateClawaiImage("x", { fetchImpl: refuse })).rejects.toMatchObject({ status: 503 });
    expect(refuse).toHaveBeenCalledTimes(1);

    linkDevice("claw_freshtoken000000000000000000");
    const accept = vi.fn(async () => jsonResponse(imageResponse()));
    const result = await generateClawaiImage("x", { fetchImpl: accept });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(result.media).toContain("/setup-api/chat/media");
  });

  it("stops offering the picture button while the credential is refused", async () => {
    // The capability is `route is up` AND `credential works`, and beta could
    // only ever answer the first half, so a box with a dead token kept showing
    // a button whose every press ends in the same error bubble.
    const refuse = vi.fn(async () => jsonResponse({ error: { code: "invalid_token" } }, 403));
    await expect(generateClawaiImage("x", { fetchImpl: refuse })).rejects.toMatchObject({ status: 503 });

    const probe = vi.fn(async () =>
      jsonResponse({ status: "ok", models: [IMAGE_MODEL], defaultModel: IMAGE_MODEL }),
    );
    await expect(clawaiImageRouteReachable(probe)).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();

    // And it comes back with a working credential, without a restart.
    linkDevice("claw_freshtoken000000000000000000");
    await expect(clawaiImageRouteReachable(probe)).resolves.toBe(true);
  });

  it("gives up rather than hanging, and says which kind of failure it was", async () => {
    // The point of the whole task in one assertion: a request for a picture used
    // to sit until the agent's own 600-second turn timeout. The distinction
    // between the two arms matters to the customer — "try again" versus "check
    // your internet".
    const timedOut = vi.fn(async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    });
    await expect(generateClawaiImage("x", { fetchImpl: timedOut })).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("took too long"),
    });

    const unreachable = vi.fn(async () => { throw new Error("ENOTFOUND"); });
    await expect(generateClawaiImage("x", { fetchImpl: unreachable })).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("Could not reach ClawBox AI"),
    });
  });

  it("reports a stop as a stop, so it never becomes a red bubble", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(
      generateClawaiImage("x", { fetchImpl, signal: controller.signal }),
    ).rejects.toMatchObject({ status: 499 });
  });

  it("refuses a 200 that carried no picture", async () => {
    // A success with an empty `data` would otherwise end the wait with an empty
    // bubble, which reads as "the box drew nothing" rather than as a fault.
    for (const body of [{ data: [] }, { data: [{}] }, {}, { data: [{ b64_json: "" }] }]) {
      const fetchImpl = vi.fn(async () => jsonResponse(body));
      await expect(generateClawaiImage("x", { fetchImpl })).rejects.toMatchObject({
        status: 502,
        message: expect.stringContaining("no picture"),
      });
    }
  });

  it("refuses an unreadable body rather than throwing a parser error at the customer", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 200 }));
    await expect(generateClawaiImage("x", { fetchImpl })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("unreadable"),
    });
  });
});
