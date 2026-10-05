import { execFileSync } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testEnv } from "@/tests/helpers/env";

// scripts/access-log.js is CommonJS on purpose — production-server.js is CJS and
// has to be (it monkey-patches http.Server.prototype.listen before Next's
// standalone bundle loads), so the logger it requires cannot be an ES module.
import accessLog from "../../../scripts/access-log.js";

// One case starts a real `node` to prove the exit flush and the unref'd sweep:
// vitest's 5 s test and 10 s hook defaults are not enough on a loaded CI
// runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

const {
  MAX_QUIET_KEYS,
  QUIET_MAX_DURATION_MS,
  QUIET_REPEAT_LOG_MS,
  accessLogEnabled,
  attachAccessLog,
  clientIp,
  formatAccessLine,
  formatQuietCountLine,
  logsEveryPoll,
  logsStaticAssets,
  quietPollKey,
  requestHost,
  sanitizePath,
  shouldSkip,
} = accessLog as {
  MAX_QUIET_KEYS: number;
  QUIET_MAX_DURATION_MS: number;
  QUIET_REPEAT_LOG_MS: number;
  accessLogEnabled: (env?: NodeJS.ProcessEnv) => boolean;
  logsEveryPoll: (env?: NodeJS.ProcessEnv) => boolean;
  quietPollKey: (method: string, path: string, ip: string, host: string) => string | null;
  attachAccessLog: (
    server: EventEmitter,
    options?: {
      env?: NodeJS.ProcessEnv;
      write?: (line: string) => void;
      now?: () => number;
      atExit?: (flush: () => void) => void;
    },
  ) => boolean;
  clientIp: (req: unknown) => string;
  formatAccessLine: (entry: Record<string, unknown>) => string;
  formatQuietCountLine: (entry: Record<string, unknown>) => string;
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
    socket: { remoteAddress: "192.0.2.10" },
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
        ip: "192.0.2.10",
        host: "clawbox.local",
      }),
    ).toBe("[access] 200 GET /setup-api/system/stats 9ms ip=192.0.2.10 host=clawbox.local");
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
    expect(clientIp(fakeReq({ headers: { "x-forwarded-for": "198.51.100.4, 192.0.2.1" } }))).toBe(
      "198.51.100.4",
    );
    expect(clientIp(fakeReq({ headers: { "x-real-ip": "198.51.100.9" } }))).toBe("198.51.100.9");
    expect(clientIp(fakeReq({ headers: {} }))).toBe("192.0.2.10");
  });

  it("unwraps an IPv4-mapped IPv6 socket address", () => {
    expect(clientIp(fakeReq({ headers: {}, socket: { remoteAddress: "::ffff:192.0.2.10" } }))).toBe(
      "192.0.2.10",
    );
  });

  it("drops a forwarding header that is not IP-shaped instead of echoing it", () => {
    // These headers are client-settable on a direct LAN request.
    expect(clientIp(fakeReq({ headers: { "cf-connecting-ip": "not an ip <script>" } }))).toBe(
      "192.0.2.10",
    );
    expect(clientIp(fakeReq({ headers: { "x-forwarded-for": "a".repeat(100) } }))).toBe(
      "192.0.2.10",
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
      "[access] 200 GET /setup-api/system/stats 12ms ip=192.0.2.10 host=clawbox.local",
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

/**
 * An open desktop polls a dozen routes every 2-30 s, and one line each was 97%
 * of the web server's journal — ~110 identical 200s a minute from one idle
 * desktop, pushing real diagnostics out of the capped journal within days.
 * A quiet repeat is folded into the next line's `quiet=N`; what the log is
 * FOR — who asked, from where, over which hostname, and anything that went
 * wrong or slow — is still written every time.
 */
describe("access log — repeated polls", () => {
  function server(env: NodeJS.ProcessEnv = testEnv()) {
    const emitter = new EventEmitter();
    const lines: string[] = [];
    let clock = 1_000;
    attachAccessLog(emitter, { env, write: (line) => lines.push(line), now: () => clock });
    /** One request that takes `ms` and answers `status` (aborted when `aborted`). */
    const request = (
      overrides: Record<string, unknown> = {},
      { status = 200, ms = 5, aborted = false }: { status?: number; ms?: number; aborted?: boolean } = {},
    ) => {
      const res = new FakeRes();
      emitter.emit("request", fakeReq({ url: "/setup-api/clawkeep", ...overrides }), res);
      clock += ms;
      res.statusCode = status;
      res.writableEnded = !aborted;
      res.emit("close");
    };
    const wait = (ms: number) => { clock += ms; };
    return { lines, request, wait };
  }

  it("writes the first poll, folds its repeats, and writes one again a window later with the count", () => {
    const s = server();
    s.request();
    for (let i = 0; i < 119; i += 1) {
      s.wait(5_000);
      s.request();
    }
    expect(s.lines).toEqual(["[access] 200 GET /setup-api/clawkeep 5ms ip=192.0.2.10 host=clawbox.local"]);
    s.wait(QUIET_REPEAT_LOG_MS);
    s.request();
    expect(s.lines).toHaveLength(2);
    expect(s.lines[1]).toBe("[access] 200 GET /setup-api/clawkeep 5ms ip=192.0.2.10 host=clawbox.local quiet=119");
    // The count starts over with the line that carried it.
    s.wait(5_000);
    s.request();
    s.wait(QUIET_REPEAT_LOG_MS);
    s.request();
    expect(s.lines[2]).toMatch(/ quiet=1$/);
  });

  it("writes every error, abort and slow answer — and the recovery after one", () => {
    const s = server();
    s.request();
    s.request({}, { status: 503 });
    s.request({}, { status: 503 });
    s.request();
    s.request({}, { aborted: true, status: 200 });
    s.request({}, { ms: QUIET_MAX_DURATION_MS });
    s.request();
    s.request();
    expect(s.lines.map((l) => l.split(" ").slice(1, 2)[0])).toEqual(["200", "503", "503", "200", "200", "200", "200"]);
    expect(s.lines[4]).toMatch(/ aborted$/);
    expect(s.lines[5]).toContain(` ${QUIET_MAX_DURATION_MS}ms `);
  });

  it("a second client, the same desktop over another hostname, or another route is a first sighting of its own", () => {
    const s = server();
    s.request();
    s.request({ socket: { remoteAddress: "192.0.2.77" } });
    s.request({ headers: { host: "abc-123.trycloudflare.com", "cf-connecting-ip": "192.0.2.10" } });
    s.request({ url: "/setup-api/monitors" });
    s.request();
    expect(s.lines).toHaveLength(4);
    expect(s.lines[1]).toContain("ip=192.0.2.77");
    expect(s.lines[2]).toContain("host=abc-123.trycloudflare.com");
    expect(s.lines[3]).toContain("/setup-api/monitors");
  });

  it("folds only reads of the box's API", () => {
    expect(quietPollKey("GET", "/setup-api/kv?key=REDACTED", "ip", "h")).not.toBeNull();
    expect(quietPollKey("HEAD", "/setup-api/clawkeep", "ip", "h")).not.toBeNull();
    // Pages, the gateway's own paths and every write are logged every time.
    expect(quietPollKey("POST", "/setup-api/kv", "ip", "h")).toBeNull();
    expect(quietPollKey("GET", "/", "ip", "h")).toBeNull();
    expect(quietPollKey("GET", "/api/sessions", "ip", "h")).toBeNull();
    expect(quietPollKey("POST", "/setup-api/system/power", "ip", "h")).toBeNull();
    expect(quietPollKey("POST", "/login-api", "ip", "h")).toBeNull();

    const s = server();
    s.request({ url: "/setup-api/system/power", method: "POST" });
    s.request({ url: "/setup-api/system/power", method: "POST" });
    s.request({ url: "/", method: "GET" });
    s.request({ url: "/", method: "GET" });
    expect(s.lines).toHaveLength(4);
  });

  it("CLAWBOX_ACCESS_LOG_POLLS=1 writes every poll again", () => {
    expect(logsEveryPoll(testEnv())).toBe(false);
    expect(logsEveryPoll(testEnv({ CLAWBOX_ACCESS_LOG_POLLS: "1" }))).toBe(true);
    const s = server(testEnv({ CLAWBOX_ACCESS_LOG_POLLS: "1" }));
    s.request();
    s.request();
    s.request();
    expect(s.lines).toHaveLength(3);
    expect(s.lines.every((l) => !l.includes("quiet="))).toBe(true);
  });

  it("forgets the request whose last line is oldest past its cap, rather than growing", () => {
    const s = server();
    for (let i = 0; i < 300; i += 1) s.request({ url: `/setup-api/files/f${i}` });
    // The first ones were forgotten: asked again, they are first sightings.
    s.request({ url: "/setup-api/files/f0" });
    // The newest are still remembered: their repeat is folded.
    s.request({ url: "/setup-api/files/f299" });
    expect(s.lines).toHaveLength(301);
    expect(s.lines[300]).toContain("/setup-api/files/f0 ");
  });

  it("never puts quiet=0 on a line", () => {
    expect(formatAccessLine({ status: 200, method: "GET", path: "/x", durationMs: 1, ip: "-", host: "-", quiet: 0 }))
      .toBe("[access] 200 GET /x 1ms ip=- host=-");
  });
});

const SCRIPT = path.resolve(__dirname, "../../../scripts/access-log.js");

/**
 * A logger on a fake server. `fake` runs its clock on vitest's fake timers, so
 * the sweep's timer fires at the moments the requests say it should; without
 * it the clock is a plain counter and no timer ever fires. `exit()` is the
 * process-exit flush, captured instead of hooked onto the test worker.
 */
function logger({ env = testEnv(), fake = false }: { env?: NodeJS.ProcessEnv; fake?: boolean } = {}) {
  const emitter = new EventEmitter();
  const lines: string[] = [];
  let clock = 1_000;
  let exitFlush: () => void = () => {};
  attachAccessLog(emitter, {
    env,
    write: (line) => lines.push(line),
    now: fake ? () => Date.now() : () => clock,
    atExit: (flush) => { exitFlush = flush; },
  });
  const wait = (ms: number) => {
    if (fake) vi.advanceTimersByTime(ms);
    else clock += ms;
  };
  const request = (
    overrides: Record<string, unknown> = {},
    { status = 200, ms = 5 }: { status?: number; ms?: number } = {},
  ) => {
    const res = new FakeRes();
    emitter.emit("request", fakeReq({ url: "/setup-api/clawkeep", ...overrides }), res);
    wait(ms);
    res.statusCode = status;
    res.emit("close");
  };
  return { emitter, lines, request, wait, exit: () => exitFlush() };
}

const countLines = (lines: string[]) => lines.filter((l) => l.startsWith("[access] - "));

/**
 * A folded count used to reach the journal only with the same request's NEXT
 * line. A desktop polled for nine minutes and was then closed, the server
 * restarted, or the request was dropped from the table to make room — and the
 * journal showed one request where there had been hundreds.
 */
describe("access log — counts no later line would carry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a line that is no request: no status, no duration, the request as it was counted", () => {
    expect(
      formatQuietCountLine({ method: "GET", target: "/setup-api/kv?key", ip: "192.0.2.10", host: "clawbox.local", quiet: 299 }),
    ).toBe("[access] - GET /setup-api/kv?key - ip=192.0.2.10 host=clawbox.local quiet=299");
  });

  it("writes the count of a request forgotten to make room, before the line that took its place", () => {
    const s = logger();
    s.request();
    s.request();
    s.request();
    // clawkeep is the oldest of MAX_QUIET_KEYS; the last of these needs its place.
    for (let i = 0; i < MAX_QUIET_KEYS; i += 1) s.request({ url: `/setup-api/files/f${i}` });
    const count = "[access] - GET /setup-api/clawkeep - ip=192.0.2.10 host=clawbox.local quiet=2";
    expect(s.lines.at(-2)).toBe(count);
    expect(s.lines.at(-1)).toContain(`/setup-api/files/f${MAX_QUIET_KEYS - 1} `);
    // A request forgotten with nothing counted goes without a line.
    s.request({ url: "/setup-api/other" });
    expect(countLines(s.lines)).toEqual([count]);
  });

  it("sweeps a poll nobody has asked for in a whole window, then stands down", () => {
    vi.useFakeTimers();
    const s = logger({ fake: true });
    s.request();
    for (let i = 0; i < 40; i += 1) {
      s.wait(5_000);
      s.request();
    }
    // The desktop is closed. The first sweep comes 400 s after its last poll:
    // too soon to tell a poll that stopped from one between two repeats.
    s.wait(QUIET_REPEAT_LOG_MS);
    expect(countLines(s.lines)).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    // One more route is read once, just now.
    s.request({ url: "/setup-api/monitors" });

    s.wait(QUIET_REPEAT_LOG_MS);
    expect(s.lines.at(-1)).toBe("[access] - GET /setup-api/clawkeep - ip=192.0.2.10 host=clawbox.local quiet=40");
    // monitors was asked 400 s ago: it waits for the next sweep.
    expect(vi.getTimerCount()).toBe(1);

    const before = s.lines.length;
    s.wait(QUIET_REPEAT_LOG_MS);
    // Forgotten with nothing to count, and with the table empty the timer is
    // gone: no wake-ups on a box nobody is polling.
    expect(s.lines).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);

    // Asked again, clawkeep is a first sighting; nothing is counted twice.
    s.request();
    expect(s.lines.at(-1)).toBe("[access] 200 GET /setup-api/clawkeep 5ms ip=192.0.2.10 host=clawbox.local");
    s.exit();
    expect(countLines(s.lines)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a poll that is still going to its own next line", () => {
    vi.useFakeTimers();
    const s = logger({ fake: true });
    for (let i = 0; i < 25 * 12; i += 1) {
      s.request();
      s.wait(5_000);
    }
    expect(countLines(s.lines)).toEqual([]);
    expect(s.lines.slice(1).every((l) => / quiet=\d+$/.test(l))).toBe(true);
  });

  it("writes every count still held when the server closes, and not again at exit", () => {
    const s = logger();
    s.request();
    s.request();
    s.request();
    s.request({ url: "/setup-api/kv?key=ui:pending-actions" });
    s.request({ url: "/setup-api/kv?key=ui:pending-actions" });
    s.request({ url: "/setup-api/monitors" });
    s.emitter.emit("close");
    expect(countLines(s.lines)).toEqual([
      "[access] - GET /setup-api/clawkeep - ip=192.0.2.10 host=clawbox.local quiet=2",
      "[access] - GET /setup-api/kv?key - ip=192.0.2.10 host=clawbox.local quiet=1",
    ]);
    s.exit();
    expect(countLines(s.lines)).toHaveLength(2);
  });

  it("writes them at exit when the server never finished closing", () => {
    const s = logger();
    s.request();
    s.request();
    s.exit();
    expect(s.lines.at(-1)).toBe("[access] - GET /setup-api/clawkeep - ip=192.0.2.10 host=clawbox.local quiet=1");
  });

  it("flushes at a real process exit, and its sweep never holds the process open", () => {
    // The default wiring, not the test seam: one process 'exit' listener, and
    // an unref'd timer. A ref'd 10-minute interval would keep this child alive
    // well past the timeout.
    const child = `
      const { EventEmitter } = require("events");
      const { attachAccessLog } = require(${JSON.stringify(SCRIPT)});
      const server = new EventEmitter();
      attachAccessLog(server, { env: {} });
      for (let i = 0; i < 3; i += 1) {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.writableEnded = true;
        server.emit("request", {
          method: "GET",
          url: "/setup-api/clawkeep",
          headers: { host: "clawbox.local" },
          socket: { remoteAddress: "192.0.2.10" },
        }, res);
        res.emit("close");
      }
    `;
    // The child's deadline is generous for a loaded machine and still nothing
    // like the ten minutes a ref'd timer would hold it; the test's own
    // timeout sits above it so the failure is the child's, not vitest's.
    const out = execFileSync("node", ["-e", child], { encoding: "utf-8", timeout: 8_000 });
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[access\] 200 GET \/setup-api\/clawkeep \d+ms ip=192\.0\.2\.10 host=clawbox\.local$/);
    expect(lines[1]).toBe("[access] - GET /setup-api/clawkeep - ip=192.0.2.10 host=clawbox.local quiet=2");
  }, 15_000);

  it("every request is a line of its own or counted on one", () => {
    vi.useFakeTimers();
    const s = logger({ fake: true });
    let sent = 0;
    for (let t = 0; t < 25 * 60; t += 1) {
      if (t % 2 === 0) {
        s.request({ url: "/setup-api/kv?key=ui:pending-actions" }, { ms: 0 });
        sent += 1;
      }
      if (t % 5 === 0) {
        s.request({}, { status: t % 300 === 0 ? 503 : 200, ms: 0 });
        sent += 1;
      }
      if (t % 30 === 0) {
        s.request({ url: `/setup-api/files?path=docs/f${t}` }, { ms: 0 });
        sent += 1;
      }
      s.wait(1_000);
    }
    // The desktop is closed; two sweeps later every count is out.
    s.wait(2 * QUIET_REPEAT_LOG_MS);
    const counted = s.lines.reduce((n, line) => {
      const quiet = Number(/ quiet=(\d+)$/.exec(line)?.[1] ?? 0);
      return n + (line.startsWith("[access] - ") ? 0 : 1) + quiet;
    }, 0);
    expect(counted).toBe(sent);
  });
});

/**
 * Keyed on the whole target, every distinct query value was a request of its
 * own: browsing folders (`files?path=…`) filled the 256-entry table with
 * one-off reads and pushed the desktop's steady polls out of it.
 */
describe("access log — one route, other query values", () => {
  it("counts reads of a route together whatever their values, and still writes each line's full target", () => {
    const s = logger();
    s.request({ url: "/setup-api/files?path=docs/a" });
    s.request({ url: "/setup-api/files?path=docs/b" });
    s.request({ url: "/setup-api/files?path=docs/c" });
    s.wait(QUIET_REPEAT_LOG_MS);
    s.request({ url: "/setup-api/files?path=docs/d" });
    expect(s.lines).toEqual([
      "[access] 200 GET /setup-api/files?path=docs/a 5ms ip=192.0.2.10 host=clawbox.local",
      "[access] 200 GET /setup-api/files?path=docs/d 5ms ip=192.0.2.10 host=clawbox.local quiet=2",
    ]);
  });

  it("keeps calls with other parameter NAMES apart, in whatever order they come", () => {
    const key = (target: string) => quietPollKey("GET", target, "ip", "h");
    expect(key("/setup-api/kv?key=a")).toBe(key("/setup-api/kv?key=b"));
    expect(key("/setup-api/kv?key=a")).not.toBe(key("/setup-api/kv?prefix=a"));
    expect(key("/setup-api/kv")).not.toBe(key("/setup-api/kv?key=a"));
    expect(key("/setup-api/x?a=1&b=2")).toBe(key("/setup-api/x?b=3&a=4&a=5"));
    // The route still decides what is a poll.
    expect(key("/other?x=/setup-api/kv")).toBeNull();
  });

  it("browsing does not push the desktop's steady polls out of the table", () => {
    const s = logger();
    s.request({ url: "/setup-api/kv?key=ui:pending-actions" });
    for (let i = 0; i < 300; i += 1) s.request({ url: `/setup-api/files?path=docs/f${i}` });
    s.request({ url: "/setup-api/kv?key=ui:pending-actions" });
    expect(s.lines).toEqual([
      // `key` is a name whose value is never written down.
      "[access] 200 GET /setup-api/kv?key=REDACTED 5ms ip=192.0.2.10 host=clawbox.local",
      "[access] 200 GET /setup-api/files?path=docs/f0 5ms ip=192.0.2.10 host=clawbox.local",
    ]);
  });
});

/**
 * POST /setup-api/kv was folded as the mascot's clocked position save, but it
 * is also how the agent's `ui_notify` / `clawbox notify` reach the desktop
 * (from loopback) and how a web app saves through the KV bridge — and only the
 * body, which the logger never reads, tells them apart.
 */
describe("access log — KV saves", () => {
  it("writes every one, the agent's from loopback and the desktop's alike", () => {
    const s = logger();
    const agent = { method: "POST", url: "/setup-api/kv", headers: { host: "localhost" }, socket: { remoteAddress: "127.0.0.1" } };
    s.request(agent);
    s.request(agent);
    s.request(agent);
    s.request({ method: "POST", url: "/setup-api/kv" });
    s.request({ method: "POST", url: "/setup-api/kv" });
    expect(s.lines).toHaveLength(5);
    expect(s.lines.slice(0, 3).every((l) => l === "[access] 200 POST /setup-api/kv 5ms ip=127.0.0.1 host=localhost")).toBe(true);
    expect(s.lines.every((l) => !l.includes("quiet="))).toBe(true);
    s.exit();
    expect(s.lines).toHaveLength(5);
  });
});
