import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The owner's own OpenAI-compatible speech server (TASK-2501 PR-D):
// loopback or private LAN only, checked when it is saved AND on every
// recording, never following a redirect, never relaying a body.

import {
  endpointHostRefusal,
  isLanAddress,
  normalizeSttEndpointUrl,
  probeSttEndpoint,
  readSttEndpointKey,
  sttEndpointFromValue,
  transcribeAtEndpoint,
  validateSttEndpointInput,
  writeSttEndpointKey,
  deleteSttEndpointKey,
  STT_ENDPOINT_DEFAULT_MODEL,
} from "@/lib/stt-endpoint";

const RECORD = { baseUrl: "http://192.168.1.20:8000/v1", model: "whisper-1" }; // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
const AUDIO = { file: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), name: "recording.webm" };
const lanLookup = async () => [{ address: "192.168.1.20" }]; // public-hygiene: allow a private-range address the test needs to exercise the local-only rule

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("isLanAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.7.3", "100.64.0.7", "::1", "fd00::1", "::ffff:192.168.1.2"])( // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
    "admits %s",
    (ip) => expect(isLanAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "1.1.1.1", "169.254.169.254", "fe80::1", "0.0.0.0", "224.0.0.1", "ff02::1", "2606:4700::1", "::ffff:8.8.8.8", "not-an-ip"])( // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
    "refuses %s",
    (ip) => expect(isLanAddress(ip)).toBe(false),
  );
});

describe("normalizeSttEndpointUrl and validation", () => {
  it("keeps a LAN or loopback address, without its trailing slash", () => {
    expect(normalizeSttEndpointUrl("http://192.168.1.20:8000/v1/")).toBe("http://192.168.1.20:8000/v1"); // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
    expect(normalizeSttEndpointUrl("https://[fd00::5]:9000/v1")).toBe("https://[fd00::5]:9000/v1"); // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
    // A name is resolved when it is used.
    expect(normalizeSttEndpointUrl("http://asr.lan:8000/v1")).toBe("http://asr.lan:8000/v1");
  });

  it("refuses a public or metadata literal, credentials, a query and other schemes", () => {
    for (const raw of ["http://8.8.8.8/v1", "http://169.254.169.254/v1", "http://u:p@10.0.0.2/v1", "http://10.0.0.2/v1?x=1", "ftp://10.0.0.2/v1", ""]) { // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
      expect(normalizeSttEndpointUrl(raw)).toBeNull();
    }
  });

  it("names a public address as refused, a malformed one as invalid, and defaults the model", () => {
    expect(validateSttEndpointInput({ baseUrl: "http://8.8.8.8/v1" })).toMatchObject({ ok: false, code: "address_refused" });
    expect(validateSttEndpointInput({ baseUrl: "nonsense" })).toMatchObject({ ok: false, code: "invalid_base_url" });
    expect(validateSttEndpointInput({ baseUrl: "http://10.0.0.2/v1", model: "a\nb" })).toMatchObject({ ok: false, code: "invalid_model" }); // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
    expect(validateSttEndpointInput({ baseUrl: "http://10.0.0.2/v1", apiKey: "two words" })).toMatchObject({ ok: false, code: "invalid_api_key" }); // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
    expect(validateSttEndpointInput({ baseUrl: "http://10.0.0.2/v1", model: "", apiKey: " k " })).toEqual({ // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
      ok: true,
      value: { baseUrl: "http://10.0.0.2/v1", model: STT_ENDPOINT_DEFAULT_MODEL }, // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
      apiKey: "k",
      clearApiKey: false,
    });
  });

  it("reads back only a record ClawBox could have written", () => {
    expect(sttEndpointFromValue(RECORD)).toEqual(RECORD);
    expect(sttEndpointFromValue({ baseUrl: "http://8.8.8.8/v1", model: "m" })).toBeNull();
    expect(sttEndpointFromValue({ baseUrl: RECORD.baseUrl })).toBeNull();
    expect(sttEndpointFromValue("x")).toBeNull();
  });
});

describe("endpointHostRefusal (at use)", () => {
  it("admits loopback names and LAN literals without a lookup", async () => {
    const lookup = vi.fn();
    expect(await endpointHostRefusal("http://localhost:9000/v1", lookup)).toBeNull();
    expect(await endpointHostRefusal("http://10.0.0.4/v1", lookup)).toBeNull(); // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves outside the network, even once", async () => {
    expect(await endpointHostRefusal("http://asr.example/v1", async () => [{ address: "192.168.1.5" }, { address: "93.184.216.34" }])) // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
      .toMatch(/outside the local network/);
    expect(await endpointHostRefusal("http://asr.example/v1", async () => [{ address: "192.168.1.5" }])).toBeNull(); // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
  });

  it("fails closed on a name that does not resolve and on a metadata name", async () => {
    expect(await endpointHostRefusal("http://asr.example/v1", async () => { throw new Error("ENOTFOUND"); })).toMatch(/does not resolve/);
    expect(await endpointHostRefusal("http://asr.example/v1", async () => [])).toMatch(/does not resolve/);
    expect(await endpointHostRefusal("http://metadata.google.internal/v1", lanLookup)).toMatch(/never be/);
  });
});

describe("transcribeAtEndpoint", () => {
  it("posts the recording with the model and key and answers the text", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: "hello" }));
    const out = await transcribeAtEndpoint(RECORD, "k1", AUDIO, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ ok: true, text: "hello" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${RECORD.baseUrl}/audio/transcriptions`);
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k1");
    expect((init.body as FormData).get("model")).toBe("whisper-1");
  });

  it("sends no Authorization header without a key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: "" }));
    await transcribeAtEndpoint(RECORD, null, AUDIO, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("sends nothing to a host that resolves outside the network", async () => {
    const fetchImpl = vi.fn();
    const out = await transcribeAtEndpoint({ ...RECORD, baseUrl: "http://asr.example/v1" }, null, AUDIO, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl: async () => [{ address: "93.184.216.34" }],
    });
    expect(out).toMatchObject({ ok: false, code: "address_refused", status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a refused key, a server error, a redirect, no text and a dead host", async () => {
    const call = (res: Response | Error) => transcribeAtEndpoint(RECORD, null, AUDIO, {
      fetchImpl: (async () => { if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch,
    });
    expect(await call(new Response("no", { status: 401 }))).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await call(new Response("echo of the key", { status: 500 }))).toMatchObject({ ok: false, code: "bad_response", status: 502 });
    expect(await call(new Response(null, { status: 302, headers: { location: "http://8.8.8.8/" } }))).toMatchObject({ ok: false, code: "bad_response" });
    expect(await call(jsonResponse({ nope: 1 }))).toMatchObject({ ok: false, code: "bad_response" });
    expect(await call(new Response("not json"))).toMatchObject({ ok: false, code: "bad_response" });
    expect(await call(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })))
      .toMatchObject({ ok: false, code: "unreachable", status: 504, detail: expect.stringContaining("ECONNREFUSED") });
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(await call(timeout)).toMatchObject({ ok: false, code: "unreachable", error: expect.stringMatching(/in time/) });
  });

  it("never relays the server's error body", async () => {
    const out = await transcribeAtEndpoint(RECORD, "secret-key", AUDIO, {
      fetchImpl: (async () => new Response("Bearer secret-key", { status: 500 })) as unknown as typeof fetch,
    });
    expect(JSON.stringify(out)).not.toContain("secret-key");
  });
});

describe("probeSttEndpoint", () => {
  it("accepts any answer but a refused key or a redirect", async () => {
    const probe = (res: Response) => probeSttEndpoint(RECORD, null, { fetchImpl: (async () => res) as unknown as typeof fetch });
    expect(await probe(jsonResponse({ data: [] }))).toMatchObject({ ok: true });
    expect(await probe(new Response("", { status: 404 }))).toMatchObject({ ok: true });
    expect(await probe(new Response("", { status: 403 }))).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await probe(new Response(null, { status: 307 }))).toMatchObject({ ok: false, code: "bad_response" });
  });

  it("names an unreachable host and a refused address", async () => {
    expect(await probeSttEndpoint(RECORD, null, { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch }))
      .toMatchObject({ ok: false, code: "unreachable" });
    expect(await probeSttEndpoint({ ...RECORD, baseUrl: "http://asr.example/v1" }, null, { lookupImpl: async () => [{ address: "1.1.1.1" }] }))
      .toMatchObject({ ok: false, code: "address_refused" });
  });
});

describe("the key file", () => {
  let root: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CLAWBOX_ROOT;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "stt-endpoint-key-"));
    process.env.CLAWBOX_ROOT = root;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAWBOX_ROOT;
    else process.env.CLAWBOX_ROOT = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is written 0600, read back trimmed, and removed", () => {
    expect(readSttEndpointKey()).toBeNull();
    writeSttEndpointKey("k-123");
    const file = path.join(root, "data", ".stt-endpoint-key");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readSttEndpointKey()).toBe("k-123");
    deleteSttEndpointKey();
    deleteSttEndpointKey();
    expect(readSttEndpointKey()).toBeNull();
  });
});

describe("lanFetch — the address checked is the address dialled", () => {
  let server: import("http").Server;
  let port = 0;
  let hits: { url?: string; host?: string; body: string }[];

  beforeEach(async () => {
    const http = await import("http");
    hits = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        hits.push({ url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString("latin1") });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://93.184.216.34/" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "heard" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as import("net").AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("dials the checked address of a name, sending the form and keeping the Host", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1" }]);
    const out = await transcribeAtEndpoint(
      { baseUrl: `http://asr.lan:${port}/v1`, model: "m1" },
      "k",
      AUDIO,
      { lookupImpl: lookup },
    );
    expect(out).toEqual({ ok: true, text: "heard" });
    expect(hits[0].host).toBe(`asr.lan:${port}`);
    expect(hits[0].body).toContain('name="model"\r\n\r\nm1');
  });

  it("never connects when the name answers outside the network at connect time", async () => {
    // Rebinding: whatever the check saw, the connection's own lookup is the one that counts.
    const fetchImpl = (await import("@/lib/stt-endpoint")).lanFetch(async () => [{ address: "93.184.216.34" }]);
    await expect(fetchImpl(`http://asr.lan:${port}/v1/models`)).rejects.toThrow();
    expect(hits).toHaveLength(0);
  });

  it("answers a redirect as it is and never follows it", async () => {
    const fetchImpl = (await import("@/lib/stt-endpoint")).lanFetch(async () => [{ address: "127.0.0.1" }]);
    const res = await fetchImpl(`http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBe(302);
    expect(hits).toHaveLength(1);
  });
});
