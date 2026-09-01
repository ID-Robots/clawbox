import { EventEmitter } from "events";
import { describe, expect, it } from "vitest";

import { testEnv } from "@/tests/helpers/env";

// scripts/access-log.js is CommonJS on purpose — production-server.js is CJS and
// has to be (it monkey-patches http.Server.prototype.listen before Next's
// standalone bundle loads), so the logger it requires cannot be an ES module.
import accessLog from "../../../scripts/access-log.js";

const {
  accessLogEnabled,
  attachAccessLog,
  clientIp,
  formatAccessLine,
  logsStaticAssets,
  requestHost,
  sanitizePath,
  shouldSkip,
} = accessLog as {
  accessLogEnabled: (env?: NodeJS.ProcessEnv) => boolean;
  attachAccessLog: (
    server: EventEmitter,
    options?: { env?: NodeJS.ProcessEnv; write?: (line: string) => void; now?: () => number },
  ) => boolean;
  clientIp: (req: unknown) => string;
  formatAccessLine: (entry: Record<string, unknown>) => string;
  logsStaticAssets: (env?: NodeJS.ProcessEnv) => boolean;
  requestHost: (req: unknown) => string;
  sanitizePath: (rawUrl: unknown) => string;
  shouldSkip: (rawUrl: unknown, env?: NodeJS.ProcessEnv) => boolean;
};

/** A minimal stand-in for an http.IncomingMessage. */
function fakeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: "GET",
    url: "/setup-api/system/stats",
    headers: { host: "clawbox.local" },
    socket: { remoteAddress: "192.168.50.10" },
    ...overrides,
  };
}

/** A minimal stand-in for an http.ServerResponse. */
class FakeRes extends EventEmitter {
  statusCode = 200;
  writableEnded = true;
}

describe("access log — line format", () => {
  // The bug: the device kept NO record of any HTTP request. Two probes to a
  // unique path (one over the LAN, one over the public tunnel) produced zero
  // journal lines anywhere on the box and there was no access-log file on disk.
  it("emits method, path, status, duration, client ip and host", () => {
    expect(
      formatAccessLine({
        status: 200,
        method: "GET",
        path: "/setup-api/system/stats",
        durationMs: 9.4,
        ip: "192.168.50.10",
        host: "clawbox.local",
      }),
    ).toBe("[access] 200 GET /setup-api/system/stats 9ms ip=192.168.50.10 host=clawbox.local");
  });

  it("marks an aborted response instead of silently reporting 200", () => {
    expect(
      formatAccessLine({
        status: 404,
        method: "GET",
        path: "/probe",
        durationMs: 1,
        ip: "203.0.113.7",
        host: "abc.trycloudflare.com",
        aborted: true,
      }),
    ).toBe("[access] 404 GET /probe 1ms ip=203.0.113.7 host=abc.trycloudflare.com aborted");
  });

  it("never emits a negative or fractional duration", () => {
    const line = formatAccessLine({ status: 200, method: "GET", path: "/", durationMs: -5, ip: "-", host: "-" });
    expect(line).toContain(" 0ms ");
  });

  it("fills every missing field rather than printing undefined", () => {
    expect(formatAccessLine({})).toBe("[access] - - - 0ms ip=- host=-");
  });
});

describe("access log — path sanitising", () => {
  it("keeps an ordinary path untouched", () => {
    expect(sanitizePath("/setup-api/portal/status")).toBe("/setup-api/portal/status");
  });

  it("redacts sensitive query VALUES but keeps the parameter names", () => {
    // Knowing a request carried a token is the useful half; the value is the
    // half that must not end up in a durable, agent-readable journal.
    expect(sanitizePath("/x?token=abcdef&page=2")).toBe("/x?token=REDACTED&page=2");
    expect(sanitizePath("/x?apiKey=sk-live-1&password=hunter2")).toBe(
      "/x?apiKey=REDACTED&password=REDACTED",
    );
    expect(sanitizePath("/setup-api/oauth?code=4/0AX&state=s")).toBe(
      "/setup-api/oauth?code=REDACTED&state=s",
    );
  });

  it("redacts a percent-encoded parameter name too", () => {
    expect(sanitizePath("/x?%74oken=secretvalue")).toBe("/x?%74oken=REDACTED");
  });

  it("leaves non-sensitive query parameters readable", () => {
    expect(sanitizePath("/setup-api/webapps?app=notes")).toBe("/setup-api/webapps?app=notes");
  });

  it("strips control characters so a request cannot forge a second log line", () => {
    expect(sanitizePath("/a\nb\r[access] 200 GET /fake 0ms")).not.toContain("\n");
    expect(sanitizePath("/a\nb")).toBe("/a?b");
  });

  it("bounds the logged target so a long URL cannot bloat the journal", () => {
    const line = sanitizePath(`/${"a".repeat(2000)}`);
    expect(line.length).toBeLessThanOrEqual(515);
    expect(line.endsWith("...")).toBe(true);
  });

  it("handles a missing or non-string url", () => {
    expect(sanitizePath(undefined)).toBe("-");
    expect(sanitizePath("")).toBe("-");
  });
});

describe("access log — client ip", () => {
  // Remote access runs through a Cloudflare Quick Tunnel, so for every request
  // that arrives from the internet the socket address is 127.0.0.1 and the only
  // real client address is in cf-connecting-ip.
  it("prefers cf-connecting-ip over the loopback socket address", () => {
    expect(
      clientIp(
        fakeReq({
          headers: { host: "abc.trycloudflare.com", "cf-connecting-ip": "203.0.113.7" },
          socket: { remoteAddress: "127.0.0.1" },
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("falls back to x-forwarded-for, then x-real-ip, then the socket", () => {
    expect(clientIp(fakeReq({ headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.1" } }))).toBe(
      "198.51.100.4",
    );
    expect(clientIp(fakeReq({ headers: { "x-real-ip": "198.51.100.9" } }))).toBe("198.51.100.9");
    expect(clientIp(fakeReq({ headers: {} }))).toBe("192.168.50.10");
  });

  it("unwraps an IPv4-mapped IPv6 socket address", () => {
    expect(clientIp(fakeReq({ headers: {}, socket: { remoteAddress: "::ffff:192.168.50.10" } }))).toBe(
      "192.168.50.10",
    );
  });

  it("drops a forwarding header that is not IP-shaped instead of echoing it", () => {
    // These headers are client-settable on a direct LAN request.
    expect(clientIp(fakeReq({ headers: { "cf-connecting-ip": "not an ip <script>" } }))).toBe(
      "192.168.50.10",
    );
    expect(clientIp(fakeReq({ headers: { "x-forwarded-for": "a".repeat(100) } }))).toBe(
      "192.168.50.10",
    );
  });

  it("returns - when there is nothing at all", () => {
    expect(clientIp({ headers: {}, socket: {} })).toBe("-");
    expect(clientIp({})).toBe("-");
  });
});

describe("access log — host", () => {
  // The Host header is what makes a stray tunnel hostname traceable: the same
  // box answers on clawbox.local, an IP, and every *.trycloudflare.com URL it
  // has published.
  it("records the hostname the request arrived on", () => {
    expect(requestHost(fakeReq({ headers: { host: "abc-123.trycloudflare.com" } }))).toBe(
      "abc-123.trycloudflare.com",
    );
    expect(requestHost(fakeReq({ headers: { host: "10.42.0.1:80" } }))).toBe("10.42.0.1:80");
  });

  it("rejects a malformed host rather than logging it", () => {
    expect(requestHost(fakeReq({ headers: { host: "evil host\nX" } }))).toBe("-");
    expect(requestHost(fakeReq({ headers: {} }))).toBe("-");
  });
});

describe("access log — volume controls", () => {
  it("is on by default and off only when explicitly disabled", () => {
    expect(accessLogEnabled(testEnv())).toBe(true);
    expect(accessLogEnabled(testEnv({ CLAWBOX_ACCESS_LOG: "1" }))).toBe(true);
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      expect(accessLogEnabled(testEnv({ CLAWBOX_ACCESS_LOG: off }))).toBe(false);
    }
  });

  it("skips build assets by default and includes them on request", () => {
    const env = testEnv();
    expect(shouldSkip("/_next/static/chunks/main.js", env)).toBe(true);
    expect(shouldSkip("/_next/image?url=x", env)).toBe(true);
    expect(shouldSkip("/setup-api/system/stats", env)).toBe(false);

    const verbose = testEnv({ CLAWBOX_ACCESS_LOG_STATIC: "1" });
    expect(logsStaticAssets(verbose)).toBe(true);
    expect(shouldSkip("/_next/static/chunks/main.js", verbose)).toBe(false);
  });
});

describe("access log — attachAccessLog", () => {
  function run(options: { env?: NodeJS.ProcessEnv; reqOverrides?: Record<string, unknown> } = {}) {
    const server = new EventEmitter();
    const lines: string[] = [];
    let clock = 0;
    const attached = attachAccessLog(server, {
      env: options.env ?? testEnv(),
      write: (line) => lines.push(line),
      now: () => clock,
    });
    const req = fakeReq(options.reqOverrides);
    const res = new FakeRes();
    server.emit("request", req, res);
    clock = 12;
    return { lines, res, attached, finish: () => res.emit("close") };
  }

  it("logs one line per completed request", () => {
    const { lines, res, finish, attached } = run();
    expect(attached).toBe(true);
    expect(lines).toEqual([]); // nothing logged until the response closes
    res.statusCode = 200;
    finish();
    expect(lines).toEqual([
      "[access] 200 GET /setup-api/system/stats 12ms ip=192.168.50.10 host=clawbox.local",
    ]);
  });

  it("logs an aborted request — the one most worth having", () => {
    // 'finish' never fires on an aborted response, which is why the timer stops
    // on 'close'.
    const { lines, res, finish } = run();
    res.writableEnded = false;
    res.statusCode = 499;
    finish();
    expect(lines[0]).toContain("499");
    expect(lines[0]).toContain("aborted");
  });

  it("attaches without displacing an existing request handler", () => {
    const server = new EventEmitter();
    const seen: string[] = [];
    server.on("request", () => seen.push("next-handler"));
    attachAccessLog(server, { env: testEnv(), write: () => {} });
    server.emit("request", fakeReq(), new FakeRes());
    expect(seen).toEqual(["next-handler"]);
  });

  it("does nothing when disabled", () => {
    const server = new EventEmitter();
    const attached = attachAccessLog(server, {
      env: testEnv({ CLAWBOX_ACCESS_LOG: "0" }),
      write: () => {},
    });
    expect(attached).toBe(false);
    expect(server.listenerCount("request")).toBe(0);
  });

  it("records the tunnel hostname and the real client ip for a remote request", () => {
    const { lines, finish } = run({
      reqOverrides: {
        url: "/login?token=supersecret",
        headers: { host: "abc-123.trycloudflare.com", "cf-connecting-ip": "203.0.113.7" },
        socket: { remoteAddress: "127.0.0.1" },
      },
    });
    finish();
    expect(lines[0]).toBe(
      "[access] 200 GET /login?token=REDACTED 12ms ip=203.0.113.7 host=abc-123.trycloudflare.com",
    );
  });

  it("skips static assets so the log stays signal", () => {
    const { lines, finish } = run({ reqOverrides: { url: "/_next/static/chunks/main.js" } });
    finish();
    expect(lines).toEqual([]);
  });

  it("never lets a failing writer take the request path down", () => {
    const server = new EventEmitter();
    attachAccessLog(server, {
      env: testEnv(),
      write: () => {
        throw new Error("journal is full");
      },
    });
    const res = new FakeRes();
    server.emit("request", fakeReq(), res);
    expect(() => res.emit("close")).not.toThrow();
  });
});
