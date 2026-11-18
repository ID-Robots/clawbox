import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createHermesDriver } from "../../../scripts/nano-stress/hermes-chat.mjs";

// The stress run end to end, on a stand-in board (TASK-2500): run.sh packs the
// board side, "ships" it through a stand-in for `nano-ci ssh` that runs the
// board scripts on this machine, starts it, polls it, stops it, and brings its
// record back. The board side talks to stub routes instead of a box: the
// desktop chat's Hermes route, and the OpenClaw gateway's socket.
//
// What it holds: the packed board side starts (a run once died at start on a
// board with ERR_MODULE_NOT_FOUND); a stop ends the turn in flight on the
// runtime (once), starts no further turn, records the step it cut short, and
// brings the partial record back; the board folder goes only once the record
// is safely back.

// Real bash, curl, jq and node processes per case, and run.sh's own settle
// polls (5 s on Hermes): a loaded CI runner needs more than vitest's 5 s
// (test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const RUN_SH = path.join(REPO, "scripts/nano-stress/run.sh");
const HERMES_SESSION = "20261117_120000_abcdef";
const tagOf = (message: string) => /STRESS-[0-9A-F]+/.exec(message)?.[0] ?? "none";

type Mode = "answer" | "hang" | "hang-stop" | "eof" | "destroy" | "refuse" | "cli-502" | "error";

/** The box's web server, as far as the stress run uses it. */
class Dashboard {
  server = http.createServer((req, res) => this.handle(req, res));
  url = "";
  runtime: "hermes" | "openclaw" = "hermes";
  mode: Mode = "answer";
  posts: Array<{ sessionKey: string; turnId: string; message: string }> = [];
  stops: Array<{ sessionKey: string | null; turnId: string | null }> = [];
  hanging = new Set<http.ServerResponse>();
  heldStops = new Set<http.ServerResponse>();
  // GET re-attach: "none" 204 (no turn on record); "held" a running turn (the
  // stream stays open); "eof" a stream that closes with no end of the turn in
  // it; "replay" an ended turn (its frames, then its "stopped" frame);
  // "answered" a turn that sent its `done` but has not ended yet (open);
  // "answered-cut" the same, closed 600 ms later while the turn runs on (the
  // route's owner-session recheck closing the listener); "recheck" the same
  // turn, whose re-attach the route closes at once when it was made on a
  // person's session (a recheck close delivered late) and never when it was
  // made with the bearer, which the route does not watch.
  attach: "none" | "held" | "eof" | "replay" | "answered" | "answered-cut" | "recheck" = "none";
  attachAuth: string[] = [];
  attaches = 0;
  // The Stop request itself fails (HTTP 500).
  failStop = false;
  // How long an answered turn takes (0: at once).
  answerDelayMs = 0;
  // How many running turns a Stop reports it stopped (0: the POST had not
  // registered its turn yet).
  stoppedCount = 1;
  // The status a plain JSON error answer comes back with.
  errorStatus = 502;
  onPost: (() => void) | null = null;

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  reset(mode: Mode = "answer") {
    this.mode = mode;
    this.posts = [];
    this.stops = [];
    this.onPost = null;
    this.attach = "none";
    this.attaches = 0;
    this.attachAuth = [];
    this.failStop = false;
    this.answerDelayMs = 0;
    this.stoppedCount = 1;
    this.errorStatus = 502;
    for (const res of this.hanging) res.end();
    this.hanging.clear();
    for (const res of this.heldStops) res.destroy();
    this.heldStops.clear();
  }
  close() {
    for (const res of this.hanging) res.destroy();
    for (const res of this.heldStops) res.destroy();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", "http://x");
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.method === "GET" && url.pathname === "/setup-api/harness/active") return this.json(res, 200, { active: this.runtime });
      if (req.method === "GET" && url.pathname === "/setup-api/harness/status") return this.json(res, 200, { harnesses: [{ id: "hermes", healthy: true }] });
      if (req.method === "GET" && url.pathname === "/setup-api/gateway/ws-config") return this.json(res, 200, { token: "stub-gateway-token" });
      if (url.pathname !== "/setup-api/hermes/chat") return this.json(res, 404, { error: "not here" });
      if (req.method === "GET") {
        this.attaches++;
        this.attachAuth.push(String(req.headers.authorization || req.headers.cookie || ""));
        if (this.attach === "none") { res.writeHead(204); res.end(); return; }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: delta\ndata: ${JSON.stringify({ text: "…" })}\n\n`);
        if (this.attach === "eof") { res.end(); return; }
        if (this.attach === "replay") { res.end("event: stopped\ndata: {}\n\n"); return; }
        if (this.attach === "answered" || this.attach === "answered-cut" || this.attach === "recheck") res.write(`event: done\ndata: ${JSON.stringify({ text: "x" })}\n\n`);
        if (this.attach === "recheck" && !String(req.headers.authorization || "").startsWith("Bearer ")) { res.end(); return; }
        if (this.attach === "answered-cut") { setTimeout(() => res.end(), 600); return; }
        this.heldStops.add(res);
        return;
      }
      if (req.method === "DELETE") {
        this.stops.push({ sessionKey: url.searchParams.get("sessionKey"), turnId: url.searchParams.get("turnId") });
        if (this.failStop) return this.json(res, 500, { error: "stop failed" });
        // A Stop that never answers: the turn sending it cannot end.
        if (this.mode === "hang-stop" && url.searchParams.get("turnId")) { this.heldStops.add(res); return; }
        for (const h of this.hanging) h.end();
        this.hanging.clear();
        return this.json(res, 200, { stopped: this.stoppedCount });
      }
      const turn = JSON.parse(body || "{}");
      this.posts.push({ sessionKey: turn.sessionKey, turnId: turn.turnId, message: turn.message });
      this.onPost?.();
      if (this.mode === "refuse") return this.json(res, 409, { error: "a turn is already running" });
      // The CLI fallback failing after it may have opened a session.
      if (this.mode === "cli-502") return this.json(res, this.errorStatus, { error: "hermes exited with code 1" });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: delta\ndata: ${JSON.stringify({ text: "…" })}\n\n`);
      if (this.mode === "answer") {
        const done = `event: done\ndata: ${JSON.stringify({ text: tagOf(turn.message), sessionId: HERMES_SESSION, model: "stub-model" })}\n\n`;
        if (this.answerDelayMs) setTimeout(() => res.end(done), this.answerDelayMs);
        else res.end(done);
      } else if (this.mode === "error") {
        res.end(`event: error\ndata: ${JSON.stringify({ error: "provider said no" })}\n\n`);
      } else if (this.mode === "eof") {
        res.end();
      } else if (this.mode === "destroy") {
        setTimeout(() => res.destroy(), 20);
      } else {
        this.hanging.add(res);
        res.on("close", () => this.hanging.delete(res));
      }
    });
  }
}

/** The OpenClaw gateway: its health probes and the operator socket. */
class Gateway {
  server = http.createServer((req, res) => {
    if (req.url === "/startupz" || req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
    if (req.url === "/readyz") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
    res.writeHead(404); res.end();
  });
  wss = new WebSocketServer({ server: this.server });
  port = 0;
  mode: "answer" | "stale" | "silent" | "drop" = "answer";
  // "drop": the first send is acknowledged, then its socket closes mid-turn.
  // That turn's abort opens a socket of its own (handshake 1 after the drop);
  // the next turn must reopen the session's socket (handshake 2), which
  // answers late.
  dropped = false;
  held = false;
  private connectsAfterDrop = 0;
  onConnectHeld: (() => void) | null = null;
  calls: Array<{ conn: number; method: string; params: Record<string, unknown> }> = [];
  onSend: (() => void) | null = null;
  private conns = 0;

  constructor() {
    this.wss.on("connection", (ws: WebSocket) => {
      const conn = ++this.conns;
      ws.on("message", (data) => {
        const f = JSON.parse(String(data));
        if (f.type !== "req") return;
        const ok = (payload: unknown) => ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload }));
        if (f.method === "connect") {
          if (this.mode === "drop" && this.dropped && ++this.connectsAfterDrop === 2) {
            this.held = true;
            this.onConnectHeld?.();
            setTimeout(() => ok({}), 4000);
            return;
          }
          return ok({});
        }
        this.calls.push({ conn, method: f.method, params: f.params || {} });
        if (f.method === "chat.send") {
          this.onSend?.();
          if (this.mode === "silent") return; // sent, never acknowledged
          if (this.mode === "drop" && !this.dropped) {
            this.dropped = true;
            ok({ runId: crypto.randomUUID() });
            setTimeout(() => ws.close(), 50);
            return;
          }
          const event = (payload: unknown) => ws.send(JSON.stringify({ type: "event", event: "chat", payload }));
          const sessionKey = f.params.sessionKey;
          // The late end of an earlier run in the session, before this send's ack.
          if (this.mode === "stale") event({ sessionKey, runId: "an-earlier-run", state: "final", message: { content: [{ type: "text", text: "STALE" }] } });
          const runId = crypto.randomUUID();
          ok({ runId });
          event({ sessionKey, runId, state: "delta" });
          event({ sessionKey, runId, state: "final", message: { content: [{ type: "text", text: tagOf(f.params.message) }], model: "stub-model" } });
          return;
        }
        // As the gateway answers an abort it will not carry out (server busy).
        if (f.method === "chat.abort" && this.refuseAbort) {
          ws.send(JSON.stringify({ type: "res", id: f.id, ok: false, error: { message: "The server is busy. Check this turn's status before trying Stop again." } }));
          return;
        }
        // An idle session's abort: ok, nothing aborted.
        if (f.method === "chat.abort") return ok({ ok: true, aborted: false, runIds: [] });
        ok({});
      });
    });
  }
  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }
  refuseAbort = false;
  reset(mode: "answer" | "stale" | "silent" | "drop" = "answer") {
    this.mode = mode;
    this.calls = [];
    this.refuseAbort = false;
    this.onSend = null;
    this.dropped = false;
    this.held = false;
    this.connectsAfterDrop = 0;
    this.onConnectHeld = null;
  }
  close() {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const dash = new Dashboard();
const gateway = new Gateway();
beforeAll(async () => {
  await dash.start();
  await gateway.start();
});
afterAll(async () => {
  await dash.close();
  await gateway.close();
});

// ---- the Hermes driver alone ------------------------------------------------------
describe("the Hermes turn", () => {
  // The box's bearer, as board-stress.mjs hands it over for settle checks.
  const bearer = (extra = {}) => ({ Authorization: "Bearer stub-mcp-token", ...extra });
  const live = () => createHermesDriver({ dash: dash.url, headers: (extra = {}) => extra, settleHeaders: bearer });
  // The session object the driver works on; `blocked`, `untracked` and
  // `turnsSent` appear only once the driver sets them (the tests check that).
  type Sess = { key: string; sessionId: string | null; hermesIds: Set<string>; blocked?: boolean; untracked?: number; turnsSent?: number };
  const sess = (): Sess => ({ key: `stress-test-${crypto.randomBytes(3).toString("hex")}`, sessionId: null, hermesIds: new Set<string>() });
  const ask = "Reply with exactly this text and nothing else: STRESS-0A1B2C";

  it("is not Stopped when the route ended it", async () => {
    for (const mode of ["answer", "error", "refuse"] as const) {
      dash.reset(mode);
      const s = sess();
      const r = await live().turn(s, ask, 5000);
      expect(dash.stops).toEqual([]);
      if (mode === "answer") {
        expect(r.error).toBeNull();
        expect(r.text).toBe("STRESS-0A1B2C");
        expect(r.latencyMs).toEqual(expect.any(Number));
        expect(s.sessionId).toBe(HERMES_SESSION);
      } else {
        expect(r.error?.kind).toBe(mode === "error" ? "agent-error" : "http");
      }
    }
  });

  it("Stops, once, a turn whose stream broke off or ended early", async () => {
    for (const mode of ["eof", "destroy"] as const) {
      dash.reset(mode);
      const s = sess();
      const r = await live().turn(s, ask, 5000);
      expect(r.error?.kind).toBe("connection");
      expect(r.latencyMs).toBeNull();
      expect(dash.stops).toEqual([{ sessionKey: s.key, turnId: dash.posts[0].turnId }]);
    }
  });

  it("Stops, once, a turn that timed out", async () => {
    dash.reset("hang");
    const s = sess();
    const r = await live().turn(s, ask, 300);
    expect(r.error?.kind).toBe("timeout");
    expect(r.latencyMs).toBeNull();
    expect(dash.stops).toEqual([{ sessionKey: s.key, turnId: dash.posts[0].turnId }]);
  });

  it("asks the route whether a Stopped turn settled, and blocks the session when it did not", async () => {
    dash.reset("hang");
    const s = sess();
    const r = await live().turn(s, ask, 300);
    expect(r.error?.kind).toBe("timeout");
    expect(dash.attaches).toBe(1);
    expect(s).not.toHaveProperty("blocked");

    dash.reset("hang");
    dash.attach = "held"; // the route still holds a running turn under the key
    const held = sess();
    const driver = createHermesDriver({ dash: dash.url, headers: (extra = {}) => extra, settleHeaders: bearer, settleMs: 400 });
    const r2 = await driver.turn(held, ask, 300);
    expect(r2.error?.kind).toBe("timeout");
    expect(r2.error?.message).toContain("its Stop was not confirmed within 0 s, so no more turns go to this session");
    expect(held).toMatchObject({ blocked: true, untracked: 1 });
    const next = await driver.turn(held, ask, 300);
    expect(next.error?.kind).toBe("blocked");
    expect(dash.posts).toHaveLength(1);
  });

  it("takes only a 204 or a replayed end of the turn as settled, never a bare end of stream", async () => {
    const driver = createHermesDriver({ dash: dash.url, headers: (extra = {}) => extra, settleHeaders: bearer, settleMs: 1500 });
    dash.reset("hang");
    dash.attach = "replay";
    const replayed = sess();
    await driver.turn(replayed, ask, 300);
    expect(replayed).not.toHaveProperty("blocked");

    dash.reset("hang");
    dash.attach = "eof"; // e.g. the connection dropped: proves nothing
    const cut = sess();
    const r = await driver.turn(cut, ask, 300);
    expect(r.error?.message).toContain("its Stop was not confirmed within 2 s");
    expect(cut.blocked).toBe(true);
    expect(dash.attaches).toBeGreaterThan(1); // asked again until the deadline
  });

  it("sends a session's next turn only once the route has ENDED the previous one, not just answered it", async () => {
    const driver = createHermesDriver({ dash: dash.url, headers: (extra = {}) => extra, settleHeaders: bearer, settleMs: 1200 });
    dash.reset("answer");
    const s = sess();
    expect((await driver.turn(s, ask, 5000)).error).toBeNull();
    // The first turn's `done` went out, but the route has not ended it.
    dash.attach = "answered";
    const r = await driver.turn(s, ask, 5000);
    expect(r.error).toEqual({ kind: "blocked", message: "the previous turn on this session was not confirmed ended" });
    expect(s.blocked).toBe(true);
    expect(dash.posts).toHaveLength(1);

    dash.reset("answer");
    const t = sess();
    await driver.turn(t, ask, 5000);
    dash.attach = "replay"; // ended: its end replayed, then the stream closes
    expect((await driver.turn(t, ask, 5000)).error).toBeNull();
    expect(dash.posts).toHaveLength(2);
  });

  it("does not take a re-attach closed after `done` while the turn runs on as the turn's end", async () => {
    const driver = createHermesDriver({ dash: dash.url, headers: (extra = {}) => extra, settleHeaders: bearer, settleMs: 2500, replayCloseMs: 300 });
    dash.reset("answer");
    const s = sess();
    await driver.turn(s, ask, 5000);
    dash.attach = "answered-cut";
    const r = await driver.turn(s, ask, 5000);
    expect(r.error).toEqual({ kind: "blocked", message: "the previous turn on this session was not confirmed ended" });
    expect(dash.attaches).toBeGreaterThan(1); // dropped and asked again
    expect(dash.posts).toHaveLength(1);
  });

  it("signs its settle checks with the bearer, whose re-attach no session recheck can close", async () => {
    const owner = (extra = {}) => ({ Cookie: "clawbox_session=stub", ...extra });
    // With the bearer, a turn that answered but has not ended is never taken as ended.
    const driver = createHermesDriver({ dash: dash.url, headers: owner, settleHeaders: bearer, settleMs: 1200 });
    dash.reset("answer");
    const s = sess();
    await driver.turn(s, ask, 5000);
    dash.attach = "recheck";
    expect((await driver.turn(s, ask, 5000)).error?.kind).toBe("blocked");
    expect(dash.attachAuth.every((a) => a === "Bearer stub-mcp-token")).toBe(true);
    expect(dash.posts.filter((p) => p.sessionKey === s.key)).toHaveLength(1);
    // With no bearer it fails closed: the owner's session is never asked (a
    // recheck close delivered at once would pass for the turn's end), no
    // turn's end is confirmed, and the session takes no second turn.
    const logs: string[] = [];
    const bare = createHermesDriver({ dash: dash.url, headers: owner, settleMs: 1200, log: (l: string) => logs.push(l) });
    dash.reset("answer");
    dash.attach = "recheck";
    const t = sess();
    expect((await bare.turn(t, ask, 5000)).error).toBeNull();
    expect((await bare.turn(t, ask, 5000)).error?.kind).toBe("blocked");
    expect(t.blocked).toBe(true);
    expect(dash.attaches).toBe(0);
    expect(dash.posts).toHaveLength(1);
    expect(logs).toContain("no bearer for the Hermes settle checks: no turn's end can be confirmed");
  });

  it("blocks the session when the Stop itself failed, even if the route shows no turn", async () => {
    dash.reset("hang");
    dash.failStop = true;
    const s = sess();
    const r = await live().turn(s, ask, 300);
    expect(r.error?.message).toContain("its Stop failed, so no more turns go to this session");
    expect(s.blocked).toBe(true);
    expect(dash.attaches).toBe(0);
  });

  it("counts every plain error answer with no session id as a turn that may have opened a session", async () => {
    // 502 from the CLI fallback, 401 when the owner's session ran out after
    // the turn, 499 after a Stop: none proves that no turn ran.
    for (const status of [502, 401, 499]) {
      dash.reset("cli-502");
      dash.errorStatus = status;
      const failed = sess();
      expect((await live().turn(failed, ask, 5000)).error?.message).toContain(`HTTP ${status}`);
      expect(failed.untracked).toBe(1);
    }
    dash.reset("refuse");
    const refused = sess();
    expect((await live().turn(refused, ask, 5000)).error?.kind).toBe("http");
    expect(refused.untracked).toBe(1);
    expect(dash.stops).toEqual([]);
  });

  it("blocks the session after a Stop that found no registered turn, whatever the route replays", async () => {
    // The POST may still be in its setup; a 204, or a replayed end (maybe of
    // an EARLIER turn: the replay names no turn), cannot confirm this one.
    for (const attach of ["none", "replay"] as const) {
      dash.reset("hang");
      dash.stoppedCount = 0;
      dash.attach = attach;
      const s = sess();
      const r = await live().turn(s, ask, 300);
      expect(r.error?.message).toContain("its Stop found no turn running, so its end cannot be confirmed");
      expect(s.blocked).toBe(true);
      expect(dash.attaches).toBe(0);
    }
  });

  it("ends at once, Stopped, when the run stops; starts nothing once it has", async () => {
    dash.reset("hang");
    const s = sess();
    const stop = new AbortController();
    dash.onPost = () => setTimeout(() => stop.abort(), 50);
    const r = await live().turn(s, ask, 60_000, stop.signal);
    expect(r.error?.kind).toBe("stopped");
    expect(dash.stops).toEqual([{ sessionKey: s.key, turnId: dash.posts[0].turnId }]);
    const again = await live().turn(s, ask, 60_000, stop.signal);
    expect(again.error?.kind).toBe("stopped");
    expect(dash.posts).toHaveLength(1);
  });
});

// ---- run.sh on a stand-in board ------------------------------------------------------
const hasTools = ["bash", "curl", "jq", "setsid", "gzip", "base64", "tar"].every((t) =>
  (process.env.PATH || "").split(":").some((d) => d && fs.existsSync(path.join(d, t))),
);

// `nano-ci ssh <serial> <command>`, where the board is this machine: the board
// script is decoded and the board's own paths and ports are pointed at the
// fixture and the stubs before it runs.
const FAKE_NANO_CI = `#!/usr/bin/env bash
set -u
[ "\${1:-}" = ssh ] || { echo "stand-in nano-ci: ssh only" >&2; exit 2; }
cmd=\${3:-}
b64=\${cmd#*echo }
b64=\${b64%% | base64 -d*}
script=$(printf '%s' "$b64" | base64 -d) || exit 255
script=\${script//REPO=\\/home\\/clawbox\\/clawbox/REPO=$FAKE_REPO}
script=\${script//DASHBOARD=http:\\/\\/127.0.0.1/DASHBOARD=$FAKE_DASH}
script=\${script//export HOME=\\/home\\/clawbox/export HOME=$FAKE_HOME}
script=\${script//http:\\/\\/127.0.0.1:18789/$FAKE_GATEWAY}
# Every board script carries lib.sh's prelude: a substitution that missed
# would send this run to this machine's own box (port 80, /home/clawbox).
[[ $script == *"REPO=$FAKE_REPO"* && $script == *"DASHBOARD=$FAKE_DASH"* && $script == *"export HOME=$FAKE_HOME"* ]] \
  || { echo "stand-in nano-ci: the lib.sh prelude changed; update the substitutions" >&2; exit 97; }
case "$script" in *"127.0.0.1:18789"*|*"/home/clawbox"*) echo "stand-in nano-ci: a board path or port was not redirected" >&2; exit 97 ;; esac
if [ -n "\${FAKE_FETCH_FAIL_ONCE:-}" ] && [ ! -e "$FAKE_FETCH_FAIL_ONCE" ] && [[ $script == *'gzip -c "$f"'* ]]; then
  : > "$FAKE_FETCH_FAIL_ONCE"
  printf '@@nano-ci-output@@\\n%s\\n' 'not-a-record'
  exit 0
fi
# The launch ran (or was refused) on the board, but its reply never came back.
if [ -n "\${FAKE_LOSE_START:-}" ] && [[ $script == *'echo "@@exists"'* ]]; then
  bash -c "$script" >/dev/null 2>&1
  exit 255
fi
if [ -n "\${FAKE_FETCH_FAIL:-}" ] && [[ $script == *'gzip -c "$f"'* ]]; then
  printf '@@nano-ci-output@@\\n%s\\n' 'not-a-record'
  exit 0
fi
exec bash -c "$script"
`;

describe.skipIf(!hasTools)("run.sh on a stand-in board", () => {
  let root = "";
  let boardDir = "";

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (boardDir) fs.rmSync(boardDir, { recursive: true, force: true });
    root = "";
    boardDir = "";
  });

  function fixture() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nano-stress-run-"));
    boardDir = `/tmp/clawbox-stress-vitest-${crypto.randomBytes(4).toString("hex")}`;
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "data/chat-transcripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "data/.session-secret"), "stub-session-secret\n");
    fs.writeFileSync(path.join(repo, "data/.mcp-token"), "stub-mcp-token\n");
    fs.mkdirSync(path.join(root, "home"));
    const nanoCi = path.join(root, "nano-ci");
    fs.writeFileSync(nanoCi, FAKE_NANO_CI, { mode: 0o755 });
    const hermes = path.join(root, "hermes");
    // The Hermes CLI: records its calls; with FAKE_HERMES_FAIL_ONCE it fails
    // the first one, as `hermes sessions delete` did on a board right after a Stop.
    fs.writeFileSync(hermes, [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(path.join(root, "hermes-calls"))}`,
      'if [ -n "${FAKE_HERMES_FAIL_ONCE:-}" ] && [ ! -e "$FAKE_HERMES_FAIL_ONCE" ]; then : > "$FAKE_HERMES_FAIL_ONCE"; echo "session is busy" >&2; exit 1; fi',
      "",
    ].join("\n"), { mode: 0o755 });
    return {
      results: path.join(root, "results"),
      env: {
        ...process.env,
        NANO_CI: nanoCi,
        NANO_STRESS_BOARD_DIR: boardDir,
        NANO_STRESS_POLL_S: "1",
        FAKE_REPO: repo,
        FAKE_HOME: path.join(root, "home"),
        FAKE_DASH: dash.url,
        FAKE_GATEWAY: `http://127.0.0.1:${gateway.port}`,
        // read by board-stress.mjs on the "board"
        CLAWBOX_REPO: repo,
        CLAWBOX_DASHBOARD: dash.url,
        GATEWAY_PORT: String(gateway.port),
        HERMES_BIN: hermes,
      } as NodeJS.ProcessEnv,
    };
  }

  /** run.sh, asynchronously (the stubs answer from this process). */
  function runSh(env: NodeJS.ProcessEnv, args: string[], onStart?: (stop: () => void) => void) {
    return new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn("bash", [RUN_SH, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { out += c; });
      onStart?.(() => child.kill("SIGTERM"));
      child.on("close", (code) => resolve({ code, out }));
    });
  }
  const STRESS = ["--", "--steps", "ramp", "--ramp", "1", "--ramp-turns", "2", "--settle", "0", "--idle", "0", "--turn-timeout", "30", "--sample-ms", "250"];
  const readRaw = (results: string, runtime: string) => JSON.parse(fs.readFileSync(path.join(results, `raw-${runtime}.json`), "utf8"));

  it("ships the board side, runs it on Hermes, brings the record back and removes the board folder", async () => {
    dash.runtime = "hermes";
    dash.reset("answer");
    const { results, env } = fixture();
    // The first `hermes sessions delete` fails: the cleanup tries again.
    const { code, out } = await runSh({ ...env, FAKE_HERMES_FAIL_ONCE: path.join(root, "hermes-failed") }, ["--results", results, "stand-in", ...STRESS]);
    expect(out).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    expect(code, out).toBe(0);
    const raw = readRaw(results, "hermes");
    expect(raw).toMatchObject({ final: true, runtime: "hermes", cleanup: { sessions: 1, deleted: 1, left: [] } });
    expect(raw.steps.map((s: { id: string }) => s.id)).toEqual(["ramp-1"]);
    expect(raw.turns.map((t: { ok: boolean }) => t.ok)).toEqual([true, true]);
    expect(dash.posts).toHaveLength(2);
    // The second turn waited for the first to end, and the cleanup for the
    // last one, each asked with the box's bearer.
    expect(dash.attachAuth).toEqual(["Bearer stub-mcp-token", "Bearer stub-mcp-token"]);
    expect(fs.readFileSync(path.join(results, "stress-hermes.md"), "utf8")).toContain("| ramp-1 | 1 | 2/2 |");
    expect(fs.readFileSync(path.join(root, "hermes-calls"), "utf8")).toBe(`sessions delete --yes ${HERMES_SESSION}\n`.repeat(2));
    const log = fs.readFileSync(path.join(results, "board-hermes.log"), "utf8");
    expect(log).toContain(`hermes sessions delete ${HERMES_SESSION} (try 1/5): session is busy`);
    expect(log).toContain(`hermes sessions delete ${HERMES_SESSION}: deleted on try 2`);
    expect(fs.existsSync(boardDir)).toBe(false);
  });

  it("keeps the board folder, record and all, when the record does not come back", async () => {
    dash.runtime = "hermes";
    dash.reset("answer");
    const { results, env } = fixture();
    const { code, out } = await runSh({ ...env, FAKE_FETCH_FAIL: "1" }, ["--results", results, "stand-in", ...STRESS]);
    expect(code, out).toBe(1);
    expect(out).toContain("no readable record came back");
    expect(out).toContain(`${boardDir} is kept on the board`);
    expect(JSON.parse(fs.readFileSync(path.join(boardDir, "raw.json"), "utf8")).final).toBe(true);
    expect(fs.existsSync(path.join(results, "board-hermes.log"))).toBe(true);
    expect(fs.existsSync(path.join(results, "stress-hermes.md"))).toBe(false);
  });

  it("tries a failed transfer once more, and then summarises the record as usual", async () => {
    dash.runtime = "hermes";
    dash.reset("answer");
    const { results, env } = fixture();
    const { code, out } = await runSh({ ...env, FAKE_FETCH_FAIL_ONCE: path.join(root, "fetch-failed") }, ["--results", results, "stand-in", ...STRESS]);
    expect(code, out).toBe(0);
    expect(out).toContain("trying once more");
    expect(readRaw(results, "hermes").final).toBe(true);
    expect(fs.readFileSync(path.join(results, "stress-hermes.md"), "utf8")).toContain("| ramp-1 | 1 | 2/2 |");
    expect(fs.existsSync(boardDir)).toBe(false);
  });

  it("will not start over a board folder that already exists, and leaves it alone", async () => {
    dash.runtime = "hermes";
    dash.reset("answer");
    const { results, env } = fixture();
    fs.mkdirSync(boardDir);
    fs.writeFileSync(path.join(boardDir, "raw.json"), '{"tool":"clawbox-nano-stress","from":"an earlier run"}');
    const { code, out } = await runSh(env, ["--results", results, "stand-in", ...STRESS]);
    expect(code, out).toBe(1);
    expect(out).toContain(`${boardDir} already exists on the board`);
    expect(dash.posts).toHaveLength(0);
    expect(fs.readdirSync(boardDir)).toEqual(["raw.json"]);
    expect(fs.existsSync(path.join(results, "raw-hermes.json"))).toBe(false);
  });

  it("stopped mid-turn on Hermes: Stops that turn once, starts no other, records the step and brings the partial record back", async () => {
    dash.runtime = "hermes";
    dash.reset("hang");
    const { results, env } = fixture();
    const { code, out } = await runSh(env, ["--results", results, "stand-in", ...STRESS], (stop) => {
      dash.onPost = () => setTimeout(stop, 200);
    });
    expect(code, out).toBe(130);
    expect(out).toContain("stopping the board side");
    expect(dash.posts).toHaveLength(1);
    const turnId = dash.posts[0].turnId;
    expect(dash.stops.filter((s) => s.turnId === turnId)).toHaveLength(1);
    const raw = readRaw(results, "hermes");
    expect(raw.final).toBe(false);
    expect(raw.steps).toHaveLength(1);
    expect(raw.steps[0]).toMatchObject({ id: "ramp-1", failure: "the run was stopped (SIGTERM) during the step", endedAt: expect.any(Number) });
    expect(raw.turns).toHaveLength(1);
    expect(raw.turns[0].error.kind).toBe("stopped");
    // The cut turn was the session's first: Hermes never named its session,
    // so the cleanup cannot claim to have deleted it.
    expect(raw.cleanup).toEqual({ sessions: 1, deleted: 0, left: [dash.posts[0].sessionKey] });
    expect(fs.readFileSync(path.join(results, "board-hermes.log"), "utf8")).toContain("1 turn(s) ended before Hermes named their session");
    expect(fs.readFileSync(path.join(results, "stress-hermes.md"), "utf8")).toContain("## Hermes (incomplete)");
    expect(fs.existsSync(boardDir)).toBe(false);
  });

  it("runs on OpenClaw through the gateway socket, takes no late end of an earlier run for a turn's own, and deletes its sessions", async () => {
    dash.runtime = "openclaw";
    // Every send is preceded by a "final" of another run in the session,
    // before its ack: the turns must still wait for their own.
    gateway.reset("stale");
    const { results, env } = fixture();
    const { code, out } = await runSh(env, ["--results", results, "stand-in", ...STRESS]);
    expect(code, out).toBe(0);
    const raw = readRaw(results, "openclaw");
    expect(raw).toMatchObject({ final: true, runtime: "openclaw", cleanup: { sessions: 1, deleted: 1, left: [] } });
    expect(raw.turns.map((t: { ok: boolean }) => t.ok)).toEqual([true, true]);
    const sends = gateway.calls.filter((c) => c.method === "chat.send");
    expect(sends).toHaveLength(2);
    expect(gateway.calls.filter((c) => c.method === "sessions.delete").map((c) => c.params.key)).toEqual([sends[0].params.sessionKey]);
    expect(fs.readFileSync(path.join(results, "stress-openclaw.md"), "utf8")).toContain("## OpenClaw");
    expect(fs.existsSync(boardDir)).toBe(false);
  });

  it("stopped with a chat.send not yet acknowledged on OpenClaw: aborts that turn over its own socket before the session goes", async () => {
    dash.runtime = "openclaw";
    gateway.reset("silent");
    const { results, env } = fixture();
    const { code, out } = await runSh(env, ["--results", results, "stand-in", ...STRESS], (stop) => {
      gateway.onSend = () => setTimeout(stop, 200);
    });
    expect(code, out).toBe(130);
    const sends = gateway.calls.filter((c) => c.method === "chat.send");
    expect(sends).toHaveLength(1);
    const key = sends[0].params.sessionKey;
    const own = gateway.calls.filter((c) => c.conn === sends[0].conn && c.method === "chat.abort");
    expect(own.map((c) => c.params)).toEqual([{ sessionKey: key }]);
    // The turn's own abort, not the cleanup's: on the send's connection, and
    // before the session is deleted.
    const ownAbort = gateway.calls.findIndex((c) => c.conn === sends[0].conn && c.method === "chat.abort");
    expect(ownAbort).toBeGreaterThanOrEqual(0);
    expect(ownAbort).toBeLessThan(gateway.calls.findIndex((c) => c.method === "sessions.delete"));
    const raw = readRaw(results, "openclaw");
    expect(raw.final).toBe(false);
    expect(raw.turns.map((t: { error?: { kind: string } }) => t.error?.kind)).toEqual(["stopped"]);
    expect(raw.cleanup).toMatchObject({ sessions: 1, deleted: 1 });
  });

  it("stopped while a turn reopens its gateway socket on OpenClaw: sends nothing after the stop", async () => {
    dash.runtime = "openclaw";
    gateway.reset("drop");
    const { results, env } = fixture();
    const { code, out } = await runSh(env, ["--results", results, "stand-in", ...STRESS], (stop) => {
      gateway.onConnectHeld = () => stop();
    });
    expect(code, out).toBe(130);
    expect(gateway.held).toBe(true);
    // Only the first turn's send: the turn that reopened the socket saw the
    // stop once the handshake answered, and sent nothing.
    expect(gateway.calls.filter((c) => c.method === "chat.send").length, out).toBe(1);
    const raw = readRaw(results, "openclaw");
    expect(raw.turns.map((t: { error?: { kind: string } }) => t.error?.kind ?? "ok")).toEqual(["connection", "stopped"]);
    expect(raw.steps[0].reconnects).toBe(1);
    expect(raw.cleanup).toMatchObject({ sessions: 1, deleted: 1 });
  });

  it("a step that will not wind down keeps its sessions: none is deleted under a running turn", async () => {
    dash.runtime = "hermes";
    dash.reset("hang-stop");
    const { results, env } = fixture();
    const { code, out } = await runSh({ ...env, NANO_STRESS_WIND_DOWN_MS: "2000" }, ["--results", results, "stand-in", ...STRESS], (stop) => {
      dash.onPost = () => setTimeout(stop, 200);
    });
    expect(code, out).toBe(130);
    const key = dash.posts[0].sessionKey;
    // The turn's own Stop (which never answers), and no cleanup Stop or delete after it.
    expect(dash.stops).toEqual([{ sessionKey: key, turnId: dash.posts[0].turnId }]);
    expect(fs.existsSync(path.join(root, "hermes-calls"))).toBe(false);
    const raw = readRaw(results, "hermes");
    expect(raw.cleanup).toEqual({ sessions: 1, deleted: 0, left: [key] });
    expect(fs.readFileSync(path.join(results, "board-hermes.log"), "utf8")).toContain("the step in flight (ramp-1) did not end within 2 s: its sessions are left alone");
    expect(fs.readFileSync(path.join(results, "stress-hermes.md"), "utf8")).toContain("cleanup: 1 of 1 sessions could not be deleted");
  });

  it("a launch whose reply is lost never touches a board folder this run did not make", async () => {
    dash.runtime = "hermes";
    dash.reset("answer");
    const { results, env } = fixture();
    // Someone else's run in the folder: its record, and a live process by its pid.
    const other = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      fs.mkdirSync(boardDir);
      fs.writeFileSync(path.join(boardDir, "raw.json"), '{"tool":"clawbox-nano-stress","from":"another run"}');
      fs.writeFileSync(path.join(boardDir, "raw.json.pid"), String(other.pid));
      const { code, out } = await runSh({ ...env, FAKE_LOSE_START: "1" }, ["--results", results, "stand-in", ...STRESS]);
      expect(code, out).toBe(1);
      expect(out).toContain(`${boardDir} on the board is not this run's (no token of its own there): left alone`);
      expect(() => process.kill(other.pid!, 0)).not.toThrow();
      expect(fs.readdirSync(boardDir).sort()).toEqual(["raw.json", "raw.json.pid"]);
      expect(dash.posts).toHaveLength(0);
    } finally {
      other.kill();
    }
  });

  it("a launch whose reply is lost still stops, collects and removes the folder it made", async () => {
    dash.runtime = "hermes";
    dash.reset("answer");
    const { results, env } = fixture();
    const { code, out } = await runSh({ ...env, FAKE_LOSE_START: "1" }, ["--results", results, "stand-in", ...STRESS]);
    expect(code, out).toBe(1);
    expect(out).toContain("the stress run did not start on the board");
    expect(readRaw(results, "hermes").tool).toBe("clawbox-nano-stress");
    expect(fs.existsSync(boardDir)).toBe(false);
  });

  it("refuses a Hermes run on a box with no MCP bearer, before any session exists", async () => {
    dash.runtime = "hermes";
    dash.reset("answer");
    const { results, env } = fixture();
    // The board script's own view of the box has no token (lib.sh on the
    // host side still reads the fixture's, to learn the runtime).
    const bare = path.join(root, "repo-without-token");
    fs.cpSync(env.FAKE_REPO!, bare, { recursive: true });
    fs.rmSync(path.join(bare, "data/.mcp-token"));
    const { code, out } = await runSh({ ...env, CLAWBOX_REPO: bare }, ["--results", results, "stand-in", ...STRESS]);
    expect(code, out).toBe(1);
    expect(dash.posts).toHaveLength(0);
    expect(fs.readFileSync(path.join(results, "board-hermes.log"), "utf8")).toContain("a Hermes run cannot confirm its turns ended without it");
    expect(readRaw(results, "hermes")).toMatchObject({ final: false, steps: [], turns: [] });
    expect(fs.existsSync(boardDir)).toBe(false);
  });

  it("refuses a results folder that already holds this runtime's files, before anything starts on the board", async () => {
    dash.runtime = "hermes";
    dash.reset("answer");
    const { results, env } = fixture();
    fs.mkdirSync(results, { recursive: true });
    fs.writeFileSync(path.join(results, "raw-hermes.json"), "an earlier run");
    const { code, out } = await runSh(env, ["--results", results, "stand-in", ...STRESS]);
    expect(code, out).toBe(2);
    expect(out).toContain(`${results} already holds raw-hermes.json from an earlier hermes run: not overwriting it`);
    expect(fs.readFileSync(path.join(results, "raw-hermes.json"), "utf8")).toBe("an earlier run");
    expect(dash.posts).toHaveLength(0);
    expect(fs.existsSync(boardDir)).toBe(false);
  });

  it("reads a budget with a leading zero as decimal", async () => {
    dash.runtime = "hermes";
    dash.reset("answer");
    // Turns slow enough that the run is still going at the first progress
    // poll, which is where the budget's deadline is first read.
    dash.answerDelayMs = 1500;
    const { results, env } = fixture();
    const { code, out } = await runSh(env, ["--results", results, "--budget-min", "08", "stand-in", ...STRESS]);
    expect(code, out).toBe(0);
    expect(out).not.toMatch(/value too great for base|unbound variable/);
    expect(readRaw(results, "hermes").final).toBe(true);
  });

  it("keeps an OpenClaw session whose cleanup abort the gateway refused, and deletes nothing under it", async () => {
    dash.runtime = "openclaw";
    gateway.reset("answer");
    gateway.refuseAbort = true;
    const { results, env } = fixture();
    const { code, out } = await runSh(env, ["--results", results, "stand-in", ...STRESS]);
    expect(code, out).toBe(0);
    const key = gateway.calls.find((c) => c.method === "chat.send")!.params.sessionKey;
    expect(readRaw(results, "openclaw").cleanup).toEqual({ sessions: 1, deleted: 0, left: [key] });
    expect(gateway.calls.filter((c) => c.method === "sessions.delete")).toHaveLength(0);
    expect(fs.readFileSync(path.join(results, "board-openclaw.log"), "utf8")).toContain(`cleanup: chat.abort ${key}:`);
  });

  it("keeps a Hermes session whose cleanup Stop failed, or whose last turn the route did not confirm ended", async () => {
    dash.runtime = "hermes";
    for (const why of ["stop-failed", "not-ended"] as const) {
      dash.reset("answer");
      const { results, env } = fixture();
      // Both turns answer normally; only then does the route turn against the cleanup.
      dash.onPost = () => {
        if (dash.posts.length < 2) return;
        if (why === "stop-failed") dash.failStop = true;
        else dash.attach = "held";
      };
      const { code, out } = await runSh(env, ["--results", results, "stand-in", ...STRESS]);
      expect(code, out).toBe(0);
      const raw = readRaw(results, "hermes");
      expect(raw.turns.map((t: { ok: boolean }) => t.ok)).toEqual([true, true]);
      expect(raw.cleanup).toEqual({ sessions: 1, deleted: 0, left: [dash.posts[0].sessionKey] });
      expect(fs.existsSync(path.join(root, "hermes-calls"))).toBe(false);
      expect(fs.readFileSync(path.join(results, "board-hermes.log"), "utf8")).toContain(why === "stop-failed" ? "its Stop failed: left alone" : "its last turn was not confirmed ended: left alone");
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(boardDir, { recursive: true, force: true });
    }
  });
});
