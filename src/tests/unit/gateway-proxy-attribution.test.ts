import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { gatewayProxyHeaders } from "@/lib/gateway-proxy";

// OpenClaw 2 refuses a request that presents forwarded client attribution from
// an address it was not told to trust (403 proxy_attribution_required). Every
// Control UI asset went through a next.config.ts rewrite, which adds
// x-forwarded-* of its own, so the OpenClaw app rendered as an empty dark
// panel: the /chat shell loaded, none of its JS or CSS did.
describe("gatewayProxyHeaders", () => {
  it("drops the whole x-forwarded-* family", () => {
    const out = gatewayProxyHeaders(
      new Headers({
        "x-forwarded-for": "1.2.3.4",
        "x-forwarded-host": "example.trycloudflare.com",
        "x-forwarded-proto": "https",
        "x-forwarded-port": "443",
        "x-forwarded-user": "someone",
      })
    );
    for (const [name] of out) expect(name.startsWith("x-forwarded-")).toBe(false);
  });

  it("drops the attribution headers that do not share that prefix", () => {
    const out = gatewayProxyHeaders(
      new Headers({
        "x-real-ip": "1.2.3.4",
        forwarded: "for=1.2.3.4",
        "true-client-ip": "1.2.3.4",
        "cdn-loop": "cloudflare",
        "cf-connecting-ip": "1.2.3.4",
        "cf-ray": "abc123",
        "cf-visitor": '{"scheme":"https"}',
      })
    );
    expect([...out.keys()].filter((k) => k !== "origin" && k !== "accept-encoding")).toEqual([]);
  });

  it("keeps the headers the gateway actually needs", () => {
    const out = gatewayProxyHeaders(
      new Headers({
        authorization: "Bearer token-value",
        cookie: "clawbox_session=abc",
        accept: "application/json",
        "content-type": "application/json",
      })
    );
    expect(out.get("authorization")).toBe("Bearer token-value");
    expect(out.get("cookie")).toBe("clawbox_session=abc");
    expect(out.get("accept")).toBe("application/json");
    expect(out.get("content-type")).toBe("application/json");
  });

  it("rewrites Origin to the port-less loopback the allowlist carries", () => {
    const out = gatewayProxyHeaders(new Headers({ origin: "https://example.trycloudflare.com" }));
    expect(out.get("origin")).toBe("http://127.0.0.1");
  });

  it("asks for identity encoding and drops hop-by-hop headers", () => {
    const out = gatewayProxyHeaders(
      new Headers({
        "accept-encoding": "gzip, br",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        te: "trailers",
        host: "clawbox.local",
        "content-length": "12",
      })
    );
    expect(out.get("accept-encoding")).toBe("identity");
    expect(out.get("connection")).toBeNull();
    expect(out.get("transfer-encoding")).toBeNull();
    expect(out.get("te")).toBeNull();
    expect(out.get("host")).toBeNull();
    expect(out.get("content-length")).toBeNull();
  });
});

// production-server.js strips the same family on WebSocket upgrades. The two
// lists are the same policy applied at two layers; a header added to one and
// forgotten in the other is a 403 on exactly one transport.
describe("the HTTP and upgrade strips agree", () => {
  const setFrom = (file: string, marker: string) => {
    const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const at = src.indexOf(marker);
    expect(at, `${marker} not found in ${file}`).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("]);", at));
    return new Set(block.match(/"([a-z0-9-]+)"/g)?.map((s) => s.slice(1, -1)) ?? []);
  };

  it("lists the same non-prefixed attribution headers", () => {
    expect(setFrom("src/lib/gateway-proxy.ts", "const FORWARDED_CLIENT_HEADERS")).toEqual(
      setFrom("production-server.js", "const FORWARDED_CLIENT_HEADERS")
    );
  });
});

// The rewrites are what added the offending headers; a reinstated entry would
// silently reintroduce the blank Control UI.
describe("next.config.ts", () => {
  it("does not rewrite gateway paths through Next's proxy", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
    expect(src).toMatch(/beforeFiles:\s*\[\s*\]/);
  });
});
