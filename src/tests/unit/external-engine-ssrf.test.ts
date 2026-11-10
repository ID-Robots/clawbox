import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The external AI engine's outbound request, bounded (TASK-2376; the CodeQL
 * request-forgery, file-to-http and http-to-file alerts on
 * src/lib/external-engine.ts). The feature IS a request to an address the
 * owner types — their own server on this machine, the LAN or the internet —
 * so what is proven here is everything around that:
 *
 *   - only http(s), no credentials, no query or fragment, never the box's own
 *     /setup-api/, never link-local / cloud-metadata / unspecified targets in
 *     any spelling, nor a NAME that resolves to one — while loopback, private
 *     LAN and public addresses stay allowed;
 *   - one GET, redirects never followed (proven against real servers: the
 *     redirect target is never contacted, so the key never reaches it);
 *   - at most 2 MB of the answer is read;
 *   - only bounded, printable model ids (at most 50) or an error code and a
 *     sentence of ours come back — never any other text of the engine's.
 */

vi.mock("@/lib/config-store", () => ({ get: vi.fn(async () => undefined), resolveConfigRoot: () => "/nonexistent" }));

import {
  normalizeExternalBaseUrl,
  refusedEngineHost,
  validateExternalEngineInput,
} from "@/lib/external-engine-shared";
import { PROBE_MAX_BODY_BYTES, probeExternalEngine } from "@/lib/external-engine";

const KEY = "sk-test-external-engine-placeholder-0123456789";
const MODEL = "Qwen/Qwen3-32B";

describe("the base-URL rule", () => {
  it.each([
    ["ftp://192.0.2.10/v1"],
    ["file:///etc/passwd"],
    ["javascript:alert(1)"],
    ["ws://192.0.2.10:8000/v1"],
    ["gopher://192.0.2.10:70/"],
    ["data:text/plain,hi"],
  ])("refuses a scheme that is not http(s): %s", (url) => {
    expect(normalizeExternalBaseUrl(url)).toBeNull();
    expect(validateExternalEngineInput({ baseUrl: url, modelId: MODEL })).toMatchObject({ ok: false, code: "invalid_base_url" });
  });

  it.each([
    ["http://user:pass@192.0.2.10/v1"],
    ["http://user@192.0.2.10/v1"],
    ["http://192.0.2.10/v1?key=x"],
    ["http://192.0.2.10/v1#frag"],
    ["http://127.0.0.1/setup-api/local-ai/llamacpp/v1"],
    ["http://192.0.2.10/setup-api/anything"],
  ])("refuses credentials, a query, a fragment and the box's own setup-api: %s", (url) => {
    expect(normalizeExternalBaseUrl(url)).toBeNull();
    expect(validateExternalEngineInput({ baseUrl: url, modelId: MODEL })).toMatchObject({ ok: false, code: "invalid_base_url" });
  });

  it.each([
    ["http://169.254.169.254/latest"],
    ["http://169.254.0.1:8000/v1"],
    ["http://2852039166/v1"],
    ["http://0xa9.0xfe.0xa9.0xfe/v1"],
    ["http://0251.0376.0251.0376/v1"],
    ["http://[fe80::1]/v1"], // public-hygiene: allow link-local test vector: the engine address rule must refuse it
    ["http://[febf::1]:8000/v1"], // public-hygiene: allow link-local test vector: the engine address rule must refuse it
    ["http://[::ffff:169.254.169.254]/v1"],
    ["http://[64:ff9b::a9fe:a9fe]/v1"],
    ["http://0.0.0.0:8000/v1"],
    ["http://0/v1"],
    ["http://[::]/v1"],
    ["http://metadata.google.internal/computeMetadata/v1"],
    ["http://metadata.google.internal./v1"],
  ])("refuses a link-local, metadata or unspecified target: %s", (url) => {
    expect(normalizeExternalBaseUrl(url)).toBeNull();
    expect(validateExternalEngineInput({ baseUrl: url, modelId: MODEL })).toMatchObject({ ok: false, code: "address_refused", field: "baseUrl" });
  });

  it.each([
    ["http://127.0.0.1:8000/v1"],
    ["http://localhost:8000/v1"],
    ["http://[::1]:8000/v1"],
    ["http://10.0.0.5:8000/v1"], // public-hygiene: allow LAN/private test vector: the engine address rule must keep it allowed
    ["http://172.16.4.2/v1"], // public-hygiene: allow LAN/private test vector: the engine address rule must keep it allowed
    ["http://192.168.1.20:30000/v1"], // public-hygiene: allow LAN/private test vector: the engine address rule must keep it allowed
    ["http://[fd00::5]:8000/v1"], // public-hygiene: allow LAN/private test vector: the engine address rule must keep it allowed
    ["http://[fec0::1]/v1"],
    ["http://169.255.0.1/v1"],
    ["https://engine.example.com/v1"],
    ["http://inference-cluster.lan:8000/v1"],
  ])("keeps the owner's own server allowed — loopback, LAN, private, public: %s", (url) => {
    expect(normalizeExternalBaseUrl(url)).not.toBeNull();
    expect(validateExternalEngineInput({ baseUrl: url, modelId: MODEL }).ok).toBe(true);
  });

  it("names why a host is refused", () => {
    expect(refusedEngineHost("169.254.169.254")).toMatch(/link-local/);
    expect(refusedEngineHost("[fe80::1]")).toMatch(/link-local/); // public-hygiene: allow link-local test vector: the engine address rule must refuse it
    expect(refusedEngineHost("0.0.0.0")).toMatch(/unspecified/);
    expect(refusedEngineHost("192.168.1.20")).toBeNull(); // public-hygiene: allow LAN/private test vector: the engine address rule must keep it allowed
  });
});

describe("the probe's own checks, before any request", () => {
  const ok = () => new Response(JSON.stringify({ data: [{ id: MODEL }] }), { status: 200 });

  it("refuses a literal link-local base handed to it directly, without a request", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const r = await probeExternalEngine({ baseUrl: "http://169.254.169.254/v1", apiKey: KEY, modelId: MODEL, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "address_refused" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a NAME that resolves to a link-local or unspecified address, without a request", async () => {
    for (const address of ["169.254.169.254", "fe80::1", "::ffff:169.254.169.254", "0.0.0.0"]) { // public-hygiene: allow link-local test vector: the engine address rule must refuse it
      const fetchImpl = vi.fn(async () => ok());
      const lookupImpl = vi.fn(async () => [{ address }]);
      const r = await probeExternalEngine({
        baseUrl: "http://engine.example.test/v1", apiKey: KEY, modelId: MODEL,
        fetchImpl: fetchImpl as unknown as typeof fetch, lookupImpl,
      });
      expect(r, address).toMatchObject({ ok: false, code: "address_refused" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });

  it("lets a name that resolves to the LAN through, and asks it exactly once", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const lookupImpl = vi.fn(async () => [{ address: "192.168.1.20" }]); // public-hygiene: allow LAN/private test vector: the engine address rule must keep it allowed
    const r = await probeExternalEngine({
      baseUrl: "http://inference-cluster.lan:8000/v1", apiKey: KEY, modelId: MODEL,
      fetchImpl: fetchImpl as unknown as typeof fetch, lookupImpl,
    });
    expect(r).toMatchObject({ ok: true, models: [MODEL] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://inference-cluster.lan:8000/v1/models");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
  });
});

describe("the probe against real servers", () => {
  const servers: http.Server[] = [];
  const listen = (handler: http.RequestListener) => new Promise<string>((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it("never follows a redirect: the target is never contacted and never sees the key", async () => {
    const seen: (string | undefined)[] = [];
    const target = await listen((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    });
    for (const status of [301, 302, 303, 307, 308]) {
      const origin = await listen((_req, res) => {
        res.writeHead(status, { Location: `${target}/v1/models` });
        res.end();
      });
      const r = await probeExternalEngine({ baseUrl: `${origin}/v1`, apiKey: KEY, modelId: MODEL });
      expect(r, String(status)).toMatchObject({ ok: false, code: "bad_response", status });
    }
    expect(seen).toEqual([]);
  });

  it("reads at most 2 MB of the answer, declared or streamed", async () => {
    const big = JSON.stringify({ data: [{ id: MODEL }], pad: "x".repeat(PROBE_MAX_BODY_BYTES) });
    const declared = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(big) });
      res.end(big);
    });
    expect(await probeExternalEngine({ baseUrl: `${declared}/v1`, apiKey: null, modelId: MODEL }))
      .toMatchObject({ ok: false, code: "bad_response" });
    const streamed = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // No Content-Length: chunked, so only the running count can stop it.
      const chunk = "x".repeat(64 * 1024);
      res.write(`{"data":[{"id":"${MODEL}"}],"pad":"`);
      for (let i = 0; i < 64; i++) res.write(chunk);
      res.end('"}');
    });
    expect(await probeExternalEngine({ baseUrl: `${streamed}/v1`, apiKey: null, modelId: MODEL }))
      .toMatchObject({ ok: false, code: "bad_response" });
  });

  it("answers only bounded, printable model ids — never any other text of the engine's", async () => {
    const long = "m".repeat(5_000);
    const ids = Array.from({ length: 300 }, (_, i) => `model-${i}`);
    const server = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        note: "UPSTREAM-ONLY-TEXT",
        data: [{ id: long }, { id: "bad\u0000id" }, { id: "line\nbreak" }, ...ids.map((id) => ({ id, secret: "UPSTREAM-ONLY-TEXT" })), { id: MODEL }],
      }));
    });
    const r = await probeExternalEngine({ baseUrl: `${server}/v1`, apiKey: null, modelId: MODEL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r).sort()).toEqual(["latencyMs", "models", "ok"]);
    expect(r.models).toHaveLength(50);
    expect(r.models.every((id) => id.length <= 200 && !/[\u0000-\u001f]/.test(id))).toBe(true);
    expect(JSON.stringify(r)).not.toContain("UPSTREAM-ONLY-TEXT");
    expect(JSON.stringify(r)).not.toContain(long);

    const missing = await probeExternalEngine({ baseUrl: `${server}/v1`, apiKey: null, modelId: "not-there" });
    expect(missing).toMatchObject({ ok: false, code: "model_not_listed" });
    if (!missing.ok) {
      expect(missing.models).toHaveLength(50);
      expect(JSON.stringify(missing)).not.toContain("UPSTREAM-ONLY-TEXT");
    }
  });

  it("an error answer is a code and a sentence of ours, not the engine's body", async () => {
    for (const status of [400, 404, 500, 502]) {
      const server = await listen((_req, res) => {
        res.writeHead(status, { "Content-Type": "text/html" });
        res.end("<html>UPSTREAM-ONLY-TEXT</html>");
      });
      const r = await probeExternalEngine({ baseUrl: `${server}/v1`, apiKey: KEY, modelId: MODEL });
      expect(r).toMatchObject({ ok: false, code: "bad_response", status });
      expect(JSON.stringify(r)).not.toContain("UPSTREAM-ONLY-TEXT");
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });
});
