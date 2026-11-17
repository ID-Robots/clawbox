// The chat half of scripts/nano-tests/tests/57-multi-user-limits.sh, run ON
// the board (TASK-2446): with the owner's chat limit for other users set to
// one message a minute, user A's first turn is taken and their second is
// refused by the box itself — the OpenClaw relay's RATE_LIMITED frame, the
// Hermes route's 429 — without reaching the model; the owner's two turns in
// the same minute are both taken (the owner is never limited); and once the
// minute is over A may send again.
//
// Env: A_COOKIE, OWNER_COOKIE (minted on the board, never printed), MARK,
// RUNTIME (openclaw | hermes), REPO. Prints `RESULT ok - …` / `RESULT not ok
// - …` and `NOTE …` lines for the shell test to read.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const REPO = process.env.REPO || "/home/clawbox/clawbox";
const require = createRequire(path.join(REPO, "package.json"));
const WebSocket = require("ws");
const relay = require(path.join(REPO, "scripts/gateway-user-relay.js"));

const DASHBOARD = "http://127.0.0.1";
const HOME = process.env.HOME || "/home/clawbox";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
const { A_COOKIE, OWNER_COOKIE, MARK, RUNTIME } = process.env;
const TURN_MS = 240_000;
const PROMPT = "Reply with the single word OK and nothing else.";
const LIMIT_RE = /^You have reached your chat limit on this ClawBox: 1 message a minute\. Try again in \d+ seconds?\.$/;

const say = (line) => console.log(`RESULT ${line}`);
const note = (line) => console.log(`NOTE [${RUNTIME}] ${String(line).replace(/\s+/g, " ").slice(0, 600)}`);
const check = (cond, line, why = "") => say(cond ? `ok - [${RUNTIME}] ${line}` : `not ok - [${RUNTIME}] ${line}${why ? ` — ${why}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A chat socket that answers requests by id (the shape of org-mode-staff.mjs's). */
function chatSocket(url, headers, { owner = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const waiting = new Map();
    let n = 0;
    let hello = null;
    const state = relay.createRelayState("");
    const token = owner ? relay.readGatewayToken(path.join(OPENCLAW_HOME, "openclaw.json")) : "";
    const identity = owner ? relay.loadOrCreateRelayIdentity(path.join(REPO, "data", ".gateway-user-relay-device.json")) : null;
    const timer = setTimeout(() => reject(new Error("no hello within 30 s")), 30_000);
    const api = {
      hello: () => hello,
      request(method, params, timeoutMs = 60_000) {
        const id = `r${++n}`;
        return new Promise((res) => {
          const t = setTimeout(() => { waiting.delete(id); res({ ok: false, error: { message: "timeout" } }); }, timeoutMs);
          waiting.set(id, (frame) => { clearTimeout(t); res(frame); });
          ws.send(JSON.stringify({ type: "req", id, method, params }));
        });
      },
      close() { try { ws.close(); } catch { /* gone */ } },
    };
    ws.on("error", (err) => reject(err));
    ws.on("message", (raw) => {
      let f;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (f.type === "event" && f.event === "connect.challenge") {
        state.challenge = f.payload;
        const frame = owner
          ? relay.buildRelayConnect(state, { id: "c", params: {} }, { token, identity, scopes: relay.RESET_SCOPES })
          : { type: "req", id: "c", method: "connect", params: { auth: { token: "" } } };
        ws.send(JSON.stringify(frame));
        return;
      }
      if (f.type === "res" && f.id === "c") {
        clearTimeout(timer);
        if (!f.ok) { reject(new Error(`connect refused: ${JSON.stringify(f.error)}`)); return; }
        hello = f.payload;
        resolve(api);
        return;
      }
      if (f.type === "res" && waiting.has(f.id)) { waiting.get(f.id)(f); waiting.delete(f.id); }
    });
  });
}

const send = (sock, key, tag) => sock.request("chat.send", { sessionKey: key, message: PROMPT, deliver: false, idempotencyKey: `${MARK}-${tag}-${randomUUID()}` });

async function openclawRun() {
  const a = await chatSocket(`ws://127.0.0.1/user-chat-ws`, { cookie: `clawbox_session=${A_COOKIE}`, origin: DASHBOARD });
  const aMain = a.hello()?.snapshot?.sessionDefaults?.mainSessionKey;
  check(typeof aMain === "string" && aMain.length > 0, "A's chat opens on the user-chat relay", JSON.stringify(aMain));
  const first = await send(a, aMain, "a1");
  check(first.ok === true, "A's first turn within the limit is taken by the gateway", JSON.stringify(first.error));
  const second = await send(a, aMain, "a2");
  check(second.ok === false && second.error?.code === "RATE_LIMITED" && LIMIT_RE.test(second.error?.message || ""),
    "A's second turn in the same minute is refused by the relay (RATE_LIMITED, with the wait), before the gateway", JSON.stringify(second.error));
  note(`A's refusal: ${second.error?.code} "${second.error?.message}" retryAfterMs=${second.error?.retryAfterMs}`);
  await a.request("chat.abort", { sessionKey: aMain });

  // The owner's own socket: production-server.js pipes it to the gateway as it
  // is, never through the relay — two turns in the same minute both taken.
  const config = JSON.parse(fs.readFileSync(path.join(OPENCLAW_HOME, "openclaw.json"), "utf-8"));
  const ownerAgent = config.agents?.defaults?.systemAgent?.agentId || "main";
  const ownerKey = `agent:${ownerAgent}:nano-ci-owner-${MARK}`;
  const owner = await chatSocket(`ws://127.0.0.1/`, { cookie: `clawbox_session=${OWNER_COOKIE}`, origin: DASHBOARD }, { owner: true });
  const o1 = await send(owner, ownerKey, "o1");
  await owner.request("chat.abort", { sessionKey: ownerKey });
  const o2 = await send(owner, ownerKey, "o2");
  check(o1.ok === true && o2.ok === true, "the owner's two turns in the same minute are both taken (the owner is never limited)",
    JSON.stringify([o1.error, o2.error]));
  await owner.request("chat.abort", { sessionKey: ownerKey });
  await sleep(2000);
  await owner.request("sessions.delete", { key: ownerKey, deleteTranscript: true });
  owner.close();

  // Once the minute is over, A may send again.
  const wait = Math.min(65_000, (second.error?.retryAfterMs ?? 60_000) + 2_000);
  note(`waiting ${Math.round(wait / 1000)} s for A's minute to pass`);
  await sleep(wait);
  const third = await send(a, aMain, "a3");
  check(third.ok === true, "A may send again once the minute has passed", JSON.stringify(third.error));
  await a.request("chat.abort", { sessionKey: aMain });
  a.close();
}

async function hermesPost(cookie, body) {
  const res = await fetch(`${DASHBOARD}/setup-api/hermes/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", cookie: `clawbox_session=${cookie}`, origin: DASHBOARD },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TURN_MS),
  });
  let json = {};
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
}

async function hermesRun() {
  // Two turns at once: whichever the route takes first runs, the other is
  // refused. The order is the route's (several awaits come before it counts a
  // turn), so neither request is assumed to be the first.
  const [one, two] = await Promise.all([hermesPost(A_COOKIE, { message: PROMPT }), hermesPost(A_COOKIE, { message: PROMPT })]);
  const ran = [one, two].filter((r) => r.status === 200);
  const refused = [one, two].filter((r) => r.status === 429);
  const second = refused[0] ?? { status: 0, json: {}, retryAfter: null };
  check(ran.length === 1, "one of A's two turns in the same minute runs", `${one.status} ${two.status}`);
  if (ran[0]) note(`A's answer: ${JSON.stringify(ran[0].json?.text ?? ran[0].json).slice(0, 200)}`);
  check(refused.length === 1 && second.json?.code === "rate_limited" && LIMIT_RE.test(second.json?.error || "") && Number(second.retryAfter) > 0,
    "the other is refused 429 rate_limited with Retry-After, and no turn runs for it", `${one.status} ${two.status} ${JSON.stringify(second.json)}`);
  note(`A's refusal: ${second.status} Retry-After=${second.retryAfter} "${second.json?.error}"`);

  const ownerKey = `desktop-${MARK}`;
  const o1 = await hermesPost(OWNER_COOKIE, { message: PROMPT, sessionKey: ownerKey });
  const o2 = await hermesPost(OWNER_COOKIE, { message: PROMPT, sessionKey: ownerKey });
  check(o1.status === 200 && o2.status === 200, "the owner's two turns in the same minute both run (the owner is never limited)", `${o1.status} ${o2.status}`);

  const wait = Math.min(65_000, (Number(second.retryAfter) || 60) * 1000 + 2_000);
  note(`waiting ${Math.round(wait / 1000)} s for A's minute to pass`);
  await sleep(wait);
  const third = await hermesPost(A_COOKIE, { message: PROMPT });
  check(third.status === 200, "A may send again once the minute has passed", `${third.status} ${JSON.stringify(third.json).slice(0, 300)}`);
}

try {
  if (RUNTIME === "openclaw") await openclawRun();
  else await hermesRun();
} catch (err) {
  say(`not ok - [${RUNTIME}] the chat driver failed: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
