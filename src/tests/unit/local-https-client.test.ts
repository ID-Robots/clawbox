import { describe, expect, it, vi } from "vitest";

import { LOCAL_HTTPS_HINT_PATH, fetchHint, hintTarget, mayMove, movedUrl, probeLocalHttps } from "@/lib/local-https-client";
import { HOST } from "@/tests/helpers/local-https";

/**
 * src/lib/local-https-client.ts — the browser's half of the move to the
 * secure address: only from plain HTTP off loopback, only to a url in the
 * zone, and only after this browser reached it.
 */

const loc = (over: Partial<Location> = {}) => ({ protocol: "http:", hostname: "192.168.1.20", pathname: "/login", search: "?a=1", hash: "#x", ...over });

describe("mayMove", () => {
  it("considers a page on plain HTTP at a LAN address or .local name", () => {
    expect(mayMove(loc())).toBe(true);
    expect(mayMove(loc({ hostname: "clawbox.local" }))).toBe(true);
  });
  it("never moves an HTTPS page or the kiosk's loopback", () => {
    expect(mayMove(loc({ protocol: "https:" }))).toBe(false);
    for (const hostname of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) expect(mayMove(loc({ hostname }))).toBe(false);
  });
});

describe("hintTarget", () => {
  it("takes only an https url in lan.clawbox.com", () => {
    expect(hintTarget({ url: `https://${HOST}` })).toBe(`https://${HOST}`);
    expect(hintTarget({ url: `https://${HOST}:8443` })).toBe(`https://${HOST}:8443`);
    for (const url of [null, `http://${HOST}`, "https://evil.example.com", `https://${HOST}/path`, `https://${HOST}.evil.test`, "javascript:alert(1)", 42]) {
      expect(hintTarget({ url })).toBeNull();
    }
    expect(hintTarget(null)).toBeNull();
  });
});

describe("movedUrl", () => {
  it("keeps the path, query and fragment", () => {
    expect(movedUrl(`https://${HOST}`, loc())).toBe(`https://${HOST}/login?a=1#x`);
  });
});

describe("probeLocalHttps", () => {
  it("reaches the hint route on the secure address, opaquely and without credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    expect(await probeLocalHttps(`https://${HOST}`, fetchImpl as unknown as typeof fetch)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${HOST}${LOCAL_HTTPS_HINT_PATH}`);
    expect(init).toMatchObject({ mode: "no-cors", credentials: "omit", cache: "no-store" });
  });

  it("is false when the fetch rejects (DNS, TLS, refused)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await probeLocalHttps(`https://${HOST}`, fetchImpl as unknown as typeof fetch)).toBe(false);
  });

  it("gives up after its timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    expect(await probeLocalHttps(`https://${HOST}`, fetchImpl as unknown as typeof fetch, 20)).toBe(false);
  });
});

describe("fetchHint", () => {
  it("answers the url, or null for anything else", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ url: `https://${HOST}` }), { status: 200 }));
    expect(await fetchHint(ok as unknown as typeof fetch)).toBe(`https://${HOST}`);
    const none = vi.fn(async () => new Response(JSON.stringify({ url: null }), { status: 200 }));
    expect(await fetchHint(none as unknown as typeof fetch)).toBeNull();
    const refused = vi.fn(async () => new Response("no", { status: 401 }));
    expect(await fetchHint(refused as unknown as typeof fetch)).toBeNull();
    const broken = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await fetchHint(broken as unknown as typeof fetch)).toBeNull();
  });
});
