// The ClawBox HTTP API, as the bench runner drives it — the same routes a
// hand-typed curl used, with the same two credentials:
//
//  - the OWNER's session cookie, for /setup-api/coding-agent/enable (the
//    consent switch is owner-only by design; the MCP bearer is refused there)
//  - the MCP bearer from data/.mcp-token, good for run/runs/status/stop
//
// On the box itself no password is needed: the cookie is minted locally from
// data/.session-secret + the current session_generation, exactly the way
// src/lib/auth.ts builds one. Off-box, set CLAWBOX_COOKIE (a captured
// clawbox_session value) or CLAWBOX_PASSWORD (one login attempt — never
// retried, because five failures lock the whole box out for five minutes).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CLAWBOX_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const DATA_DIR = path.join(CLAWBOX_ROOT, "data");

export function baseUrl() {
  return (process.env.CLAWBOX_URL || "http://127.0.0.1").replace(/\/+$/, "");
}

export function readBearer() {
  if (process.env.CLAWBOX_BEARER) return process.env.CLAWBOX_BEARER.trim();
  try {
    return fs.readFileSync(path.join(DATA_DIR, ".mcp-token"), "utf8").trim();
  } catch {
    return null;
  }
}

/** Mint an owner cookie the way src/lib/auth.ts does — on-box only. */
function mintCookie() {
  try {
    const secret = fs.readFileSync(path.join(DATA_DIR, ".session-secret"), "utf8").trim();
    const config = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8"));
    const payload = Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 6 * 3600,
      gen: config.session_generation ?? 0,
    })).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return `${payload}.${sig}`;
  } catch {
    return null;
  }
}

let cachedCookie = null;
export async function ownerCookie() {
  if (cachedCookie) return cachedCookie;
  if (process.env.CLAWBOX_COOKIE) return (cachedCookie = process.env.CLAWBOX_COOKIE.trim());
  const minted = mintCookie();
  if (minted) return (cachedCookie = minted);
  if (process.env.CLAWBOX_PASSWORD) {
    // ONE attempt. The rate limiter's shared bucket locks everyone out after
    // five failures; a wrong password here must fail the suite, not retry.
    const res = await fetch(`${baseUrl()}/login-api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: process.env.CLAWBOX_PASSWORD, duration: 21600 }),
    });
    if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/clawbox_session=([^;]+)/);
    if (!m) throw new Error("login succeeded but no clawbox_session cookie came back");
    return (cachedCookie = m[1]);
  }
  throw new Error(
    "No owner credential: run on the box (data/.session-secret readable), or set CLAWBOX_COOKIE or CLAWBOX_PASSWORD.",
  );
}

async function request(method, apiPath, { body, auth } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth === "owner") headers.cookie = `clawbox_session=${await ownerCookie()}`;
  else {
    const bearer = readBearer();
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    else headers.cookie = `clawbox_session=${await ownerCookie()}`;
  }
  const res = await fetch(`${baseUrl()}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON answer — kept raw */ }
  return { status: res.status, ok: res.ok, json, text };
}

export const get = (p) => request("GET", p);
export const post = (p, body, opts = {}) => request("POST", p, { body, ...opts });

/** Owner-only settings + switch. Answers the full status payload. */
export async function enable(settings) {
  return post("/setup-api/coding-agent/enable", settings, { auth: "owner" });
}

export const codingStatus = () => get("/setup-api/coding-agent/status");

export async function startRun({ task, directory, projectId, resumeRunId }) {
  return post("/setup-api/coding-agent/run", {
    task,
    ...(directory ? { directory } : {}),
    ...(projectId ? { projectId } : {}),
    ...(resumeRunId ? { resumeRunId } : {}),
  });
}

export const stopRun = (id) => post("/setup-api/coding-agent/stop", { id });

export const getRun = (id, waitSeconds = 0) =>
  get(`/setup-api/coding-agent/runs?id=${encodeURIComponent(id)}${waitSeconds > 0 ? `&wait=${waitSeconds}` : ""}`);

export const listRuns = (limit = 10) => get(`/setup-api/coding-agent/runs?limit=${limit}`);

/**
 * Long-poll a run to its end. The route's `wait` caps at 120 s per request and
 * a timeout is a normal 200 with status:"running", so this loops. Returns the
 * final record, or the still-running one once `deadlineMs` passes — the CALLER
 * decides what a runner timeout means (capture first; it is a finding).
 */
export async function waitForRun(id, deadlineMs, onPoll) {
  for (;;) {
    const remaining = deadlineMs - Date.now();
    const wait = Math.max(0, Math.min(120, Math.floor(remaining / 1000)));
    const res = await getRun(id, wait);
    if (!res.ok || !res.json?.run) throw new Error(`runs?id=${id} answered ${res.status}: ${res.text.slice(0, 200)}`);
    const run = res.json.run;
    if (onPoll) onPoll(run);
    if (run.status !== "running") return run;
    if (Date.now() >= deadlineMs) return run;
  }
}

/**
 * The record can settle before its commit lands (the git work is fire-and
 * -forget after the run is persisted). Give it a bounded grace and MEASURE the
 * lag — the lag itself is one of the things the bench exists to watch.
 */
export async function waitForCommit(id, graceMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const res = await getRun(id);
    const run = res.json?.run;
    if (!run) return { run: null, commitLagMs: null };
    const settled = run.commit !== null
      || (run.progress ?? []).some((line) => /^(Committed as |Not committed: )/.test(line))
      || (run.filesTouched ?? []).length === 0;
    if (settled) return { run, commitLagMs: run.commit !== null ? Date.now() - started : null };
    if (Date.now() - started >= graceMs) return { run, commitLagMs: null };
    await new Promise((r) => setTimeout(r, 500));
  }
}
