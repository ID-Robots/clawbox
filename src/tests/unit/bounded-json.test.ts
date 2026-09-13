/**
 * The shared bounded JSON reader.
 *
 * The property that matters, and the one the header check alone does NOT give:
 * a request that declares no `Content-Length` — which is every chunked request
 * — is still cut at the cap. Three routes rely on this (`coding-agent/secrets`
 * and the two Vercel ones), and each of them was header-only before, which
 * bounded exactly the callers that were never the problem.
 *
 * Below that: "too long" and "not JSON" stay different answers, because the
 * routes turn them into 413 and 400 and a caller that cannot tell them apart
 * retries the wrong one.
 */
import { describe, expect, it } from "vitest";
import { declaredTooLong, readJsonObject } from "@/lib/bounded-json";

const LIMIT = 1_024;

/** A request whose body is a stream with NO declared length — the chunked case. */
function chunked(text: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      // In pieces, so the meter has to count across reads rather than see one
      // oversized chunk — which is how a real chunked body arrives.
      for (let at = 0; at < bytes.length; at += 64) controller.enqueue(bytes.slice(at, at + 64));
      controller.close();
    },
  });
  return new Request("http://clawbox.local/x", {
    method: "POST",
    body: stream,
    // @ts-expect-error duplex is required by Node's fetch for a stream body and
    // is not in the DOM lib's RequestInit.
    duplex: "half",
  });
}

/** A request with the length declared, the ordinary case. */
function declared(text: string): Request {
  return new Request("http://clawbox.local/x", { method: "POST", body: text });
}

describe("declaredTooLong", () => {
  it("is true only for a length that is actually over the cap", () => {
    const over = new Request("http://clawbox.local/x", { method: "POST", headers: { "content-length": String(LIMIT + 1) }, body: "{}" });
    const under = new Request("http://clawbox.local/x", { method: "POST", headers: { "content-length": String(LIMIT) }, body: "{}" });
    expect(declaredTooLong(over, LIMIT)).toBe(true);
    expect(declaredTooLong(under, LIMIT)).toBe(false);
  });

  it("is false when nothing is declared — a chunked body is the meter's job", () => {
    const none = new Request("http://clawbox.local/x", { method: "POST", body: "{}" });
    none.headers.delete("content-length");
    expect(declaredTooLong(none, LIMIT)).toBe(false);
    const nonsense = new Request("http://clawbox.local/x", { method: "POST", headers: { "content-length": "lots" }, body: "{}" });
    expect(declaredTooLong(nonsense, LIMIT)).toBe(false);
  });
});

describe("readJsonObject", () => {
  it("reads an object inside the cap", async () => {
    expect(await readJsonObject(declared('{"a":1}'), LIMIT)).toEqual({ ok: true, body: { a: 1 } });
  });

  it("refuses a DECLARED oversize before reading a byte", async () => {
    const big = new Request("http://clawbox.local/x", {
      method: "POST",
      headers: { "content-length": String(LIMIT * 100) },
      body: '{"a":1}',
    });
    expect(await readJsonObject(big, LIMIT)).toEqual({ ok: false, reason: "too_long" });
  });

  it("CUTS a chunked body that declares nothing and then sends too much", async () => {
    // The whole point: `Content-Length` says nothing here, so only the meter
    // can stop this.
    const body = `{"a":"${"x".repeat(LIMIT * 4)}"}`;
    const request = chunked(body);
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readJsonObject(request, LIMIT)).toEqual({ ok: false, reason: "too_long" });
  });

  it("lets a chunked body UNDER the cap through", async () => {
    expect(await readJsonObject(chunked('{"name":"VERCEL_TOKEN"}'), LIMIT)).toEqual({
      ok: true,
      body: { name: "VERCEL_TOKEN" },
    });
  });

  it("tells 'not JSON' apart from 'too long' — the routes answer 400 and 413", async () => {
    expect(await readJsonObject(declared("not json at all"), LIMIT)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses an ARRAY and a bare value: `typeof [] === 'object'`", async () => {
    for (const text of ["[1,2,3]", '"a string"', "42", "null"]) {
      expect(await readJsonObject(declared(text), LIMIT), text).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses a request with no body at all rather than inventing an empty one", async () => {
    expect(await readJsonObject(new Request("http://clawbox.local/x"), LIMIT)).toEqual({ ok: false, reason: "invalid" });
  });
});
