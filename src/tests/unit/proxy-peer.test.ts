import { EventEmitter } from "events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// scripts/proxy-peer.js is CommonJS on purpose — production-server.js is CJS and
// has to be (it monkey-patches http.Server.prototype.listen before Next's
// standalone bundle loads), so the guard it requires cannot be an ES module.
import proxyPeer from "../../../scripts/proxy-peer.js";

const {
  PROXY_IDENTITY_HEADERS,
  attachProxyPeerGuard,
  isLoopback,
  stripUntrustedProxyHeaders,
} = proxyPeer as {
  PROXY_IDENTITY_HEADERS: string[];
  attachProxyPeerGuard: (server: EventEmitter) => boolean;
  isLoopback: (address: unknown) => boolean;
  stripUntrustedProxyHeaders: (req: unknown) => boolean;
};

const FORGED = {
  "cf-connecting-ip": "203.0.113.7",
  "cf-connecting-ipv6": "2001:db8::7",
  "true-client-ip": "203.0.113.8",
};

/** A minimal stand-in for an http.IncomingMessage. */
function fakeReq(remoteAddress: string | undefined, headers: Record<string, string> = { ...FORGED }) {
  return {
    method: "POST",
    url: "/login-api",
    headers: { host: "clawbox.local", "x-forwarded-proto": "https", ...headers } as Record<string, string>,
    socket: remoteAddress === undefined ? undefined : { remoteAddress },
  };
}

/**
 * The finding: /login-api keys a full-schedule lockout bucket on
 * CF-Connecting-IP, and on the LAN that header is whatever the client typed. A
 * direct client could mint a fresh bucket per request, or drive
 * `cf:<the owner's public IP>` to the 24 h tier and lock the owner out of the
 * tunnel. The only honest source of the header is cloudflared on loopback.
 */
describe("proxy-peer — a client that is not cloudflared cannot name itself", () => {
  it("deletes the three proxy-identity headers from a LAN request", () => {
    const req = fakeReq("192.168.1.9");

    expect(stripUntrustedProxyHeaders(req)).toBe(true);

    expect(req.headers).not.toHaveProperty("cf-connecting-ip");
    expect(req.headers).not.toHaveProperty("cf-connecting-ipv6");
    expect(req.headers).not.toHaveProperty("true-client-ip");
  });

  it("deletes them from a v4-mapped peer on a dual-stack listener", () => {
    const req = fakeReq("::ffff:10.0.0.5");

    expect(stripUntrustedProxyHeaders(req)).toBe(true);

    for (const name of PROXY_IDENTITY_HEADERS) expect(req.headers).not.toHaveProperty(name);
  });

  it("leaves the rest of the request alone", () => {
    // x-forwarded-* is deliberately out of scope: the route never consults
    // X-Forwarded-For, Next synthesises x-forwarded-proto itself, and the hop
    // to the gateway strips the family already.
    const req = fakeReq("192.168.1.9");

    stripUntrustedProxyHeaders(req);

    expect(req.headers.host).toBe("clawbox.local");
    expect(req.headers["x-forwarded-proto"]).toBe("https");
  });

  it("keeps the headers for a peer on 127.0.0.1 — that is the tunnel", () => {
    const req = fakeReq("127.0.0.1");

    expect(stripUntrustedProxyHeaders(req)).toBe(false);

    expect(req.headers["cf-connecting-ip"]).toBe("203.0.113.7");
    expect(req.headers["cf-connecting-ipv6"]).toBe("2001:db8::7");
    expect(req.headers["true-client-ip"]).toBe("203.0.113.8");
  });

  it("keeps them for ::1 too", () => {
    // A later `::` bind delivers the tunnel on ::1; a check that only knew
    // "127.0.0.1" would silently drop every tunnel user to `global` alone.
    const req = fakeReq("::1");

    expect(stripUntrustedProxyHeaders(req)).toBe(false);
    expect(req.headers["cf-connecting-ip"]).toBe("203.0.113.7");
  });

  it("recognises the whole of 127.0.0.0/8 and the v4-mapped loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.1.2.3")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("::FFFF:127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("192.168.1.9")).toBe(false);
    expect(isLoopback("::ffff:10.0.0.5")).toBe(false);
    expect(isLoopback("1270.0.0.1")).toBe(false);
    expect(isLoopback("2001:db8::1")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback("")).toBe(false);
  });

  it("never throws on a request with no socket, and treats it as untrusted", () => {
    // An unattributable client must not get to choose its bucket.
    const req = fakeReq(undefined);

    expect(() => stripUntrustedProxyHeaders(req)).not.toThrow();
    expect(req.headers).not.toHaveProperty("cf-connecting-ip");
  });

  it("never throws on a request with no headers at all", () => {
    expect(() => stripUntrustedProxyHeaders({ socket: { remoteAddress: "192.168.1.9" } })).not.toThrow();
    expect(() => stripUntrustedProxyHeaders(null)).not.toThrow();
    expect(stripUntrustedProxyHeaders(undefined)).toBe(false);
  });

  it("does nothing, and says so, when a LAN request carried none of them", () => {
    const req = fakeReq("192.168.1.9", {});

    expect(stripUntrustedProxyHeaders(req)).toBe(false);
    expect(req.headers.host).toBe("clawbox.local");
  });
});

describe("proxy-peer — attached to the server", () => {
  it("runs ahead of a listener registered earlier, so Next never sees the header", () => {
    // Next's handler is registered at createServer time; the access log and
    // the guard are attached at listen. Only a PREPENDED listener runs before
    // the handler, which is the whole point.
    const server = new EventEmitter();
    const seenByNext: Array<Record<string, string>> = [];
    server.on("request", (req: { headers: Record<string, string> }) => {
      seenByNext.push({ ...req.headers });
    });

    expect(attachProxyPeerGuard(server)).toBe(true);

    const lan = fakeReq("192.168.1.9");
    const tunnel = fakeReq("127.0.0.1");
    server.emit("request", lan, {});
    server.emit("request", tunnel, {});

    expect(seenByNext[0]).not.toHaveProperty("cf-connecting-ip");
    expect(seenByNext[1]["cf-connecting-ip"]).toBe("203.0.113.7");
  });

  it("does not take the request path down for a request it cannot read", () => {
    const server = new EventEmitter();
    let reached = false;
    server.on("request", () => {
      reached = true;
    });
    attachProxyPeerGuard(server);

    expect(() => server.emit("request", { headers: null, socket: null }, {})).not.toThrow();
    expect(reached).toBe(true);
  });
});

describe("proxy-peer — the wiring in production-server.js", () => {
  const SRC = readFileSync(path.join(process.cwd(), "production-server.js"), "utf-8");

  it("attaches the guard in the listen hook, ahead of the access log", () => {
    // The access line must record the honest client address, not a forged cf
    // value — so the guard has to be attached first. And it has to be in the
    // hook at all: that is the one place the server Next creates is in hand.
    const guard = SRC.indexOf("attachProxyPeerGuard(this)");
    const log = SRC.indexOf("attachAccessLog(this)");
    expect(guard).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(log);
  });

  it("keeps the same three names in the upgrade proxy's strip set", () => {
    // The WebSocket hop to the gateway strips FORWARDED_CLIENT_HEADERS. The
    // bucket-picking subset this module names must stay inside that set, or a
    // client could smuggle an identity through the upgrade path the guard
    // never sees.
    const from = SRC.indexOf("const FORWARDED_CLIENT_HEADERS = new Set([");
    expect(from).toBeGreaterThan(-1);
    const block = SRC.slice(from, SRC.indexOf("]);", from));
    for (const name of PROXY_IDENTITY_HEADERS) expect(block).toContain(`"${name}"`);
  });
});
