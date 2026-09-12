/**
 * The Vercel REST client: the calls this box makes on the owner's behalf, and
 * nothing else.
 *
 * WHAT IT IS FOR. A coding run's work reaches GitHub as a branch and a pull
 * request (src/lib/coding-pr.ts), and a project wired to Vercel builds that
 * branch into a preview the owner can open. Until now the box knew nothing
 * about that half: the run card said "pull request opened" and the owner went
 * to another website to find out whether the thing actually built. This module
 * is how the box asks.
 *
 * THE TOKEN IS NEVER AN ARGUMENT THE CALLER TYPES. Every function here takes a
 * resolved `VercelAuth`, which ./vercel-link produces by reading ONE named
 * entry out of the owner's secret store. The value is held for the duration of
 * the call and never returned, logged, or put on a run record — see
 * `redactToken` below, which is what keeps it out of an error sentence that
 * quotes Vercel's own answer.
 *
 * WHY EVERY ANSWER IS A RESULT AND NOT A THROW. This is polled on a timer in
 * the web server, which CLAUDE.md calls the one long-lived ClawBox process. A
 * network fault on a home connection is the ordinary case, not the exception,
 * and it has to be told apart from "Vercel says your token is wrong": the first
 * is waited through, the second ends the watch and needs the owner. So the
 * result carries a `kind`, and the watcher decides.
 *
 * WHY THE RESPONSE IS BOUNDED. `/v3/deployments/:id/events` is a build log, and
 * a failing install step on a big project prints megabytes. `readBounded` caps
 * what is ever held in memory rather than slicing after `res.json()` has
 * already buffered the lot — the same reasoning `MAX_LOG_CHARS` in
 * coding-review.ts is written from, and for the same box.
 */

import { parseDeployment, type VercelDeployment } from "./vercel-state";

// One import for server callers, the way ./coding-pr re-exports its own pure
// half; the browser imports ./vercel-state directly.
export * from "./vercel-state";

/** Vercel's API. A constant so a test can point it somewhere else. */
export const VERCEL_API = "https://api.vercel.com";

/** How long one call gets. */
const CALL_TIMEOUT_MS = 20_000;

/** How long the build-log call gets — it is bigger than the rest. */
const LOG_TIMEOUT_MS = 45_000;

/**
 * The most of any answer that is ever held in memory.
 *
 * Generous for the JSON endpoints (a deployment list is kilobytes) and the real
 * bound for the log one. A truncated JSON body fails to parse and is reported
 * as such, which is the honest outcome: an answer this box could not read
 * whole is not one it should act on.
 */
const MAX_RESPONSE_CHARS = 1_000_000;

/** The most of a build log that is ever kept for the agent. */
export const MAX_BUILD_LOG_CHARS = 12_000;

/** How many of a project's deployments are asked for at a time. */
const DEPLOYMENT_PAGE = 20;

/** The credential and the account one call is made under. */
export interface VercelAuth {
  token: string;
  teamId: string | null;
}

/**
 * What went wrong, told apart the way the watcher needs it.
 *
 *  - `network`   the box could not reach Vercel (offline, DNS, a timeout)
 *  - `auth`      401/403 — the token is wrong, expired, or lacks the scope
 *  - `not_found` 404 — the project or the deployment is not there
 *  - `rate`      429 — asked too often; the watcher backs off rather than ends
 *  - `upstream`  a 5xx, or an answer this box could not read
 *  - `refused`   any other 4xx: a request Vercel rejected on its merits
 */
export type VercelErrorKind = "network" | "auth" | "not_found" | "rate" | "upstream" | "refused";

export interface VercelFailure {
  ok: false;
  kind: VercelErrorKind;
  /** In words meant for the owner. Never carries the token — see redactToken. */
  detail: string;
  status: number | null;
}

export type VercelResult<T> = ({ ok: true } & T) | VercelFailure;

/** Is this failure worth another poll, or is it the end of the watch? */
export function isTransient(kind: VercelErrorKind): boolean {
  return kind === "network" || kind === "rate" || kind === "upstream";
}

/**
 * Take the token out of anything about to be shown or stored.
 *
 * Vercel does not normally echo a credential, but this text comes from an
 * upstream sentence and lands on a run record that a route the MCP bearer
 * reaches answers. The store's whole premise is that a value does not leak into
 * the box's own output (src/lib/secret-redact.ts does the same for a run's
 * transcript), so the one sentence that could carry it is scrubbed at the
 * source rather than trusted.
 */
function redactToken(text: string, token: string): string {
  if (!token || token.length < 8) return text;
  return text.split(token).join("<token>");
}

function failure(kind: VercelErrorKind, detail: string, status: number | null = null): VercelFailure {
  return { ok: false, kind, detail, status };
}

/** The body, up to the cap, without ever buffering more than that. */
async function readBounded(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body) return (await res.text()).slice(0, max);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= max) {
        // Stop pulling: the rest of this answer is not going to be read, and on
        // a box with one web server it must not be paid for either.
        await reader.cancel().catch(() => {});
        return out.slice(0, max);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return out.slice(0, max);
}

/** The URL for one call, with the team scope when there is one. */
function url(pathname: string, auth: VercelAuth, query: Record<string, string> = {}): string {
  const built = new URL(pathname, VERCEL_API);
  for (const [key, value] of Object.entries(query)) built.searchParams.set(key, value);
  // Vercel scopes a personal-account call by leaving this off entirely; sending
  // an empty `teamId` is not the same thing and answers 403.
  if (auth.teamId) built.searchParams.set("teamId", auth.teamId);
  return built.toString();
}

/** How Vercel's error body spells its message, when it sends one. */
function upstreamMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 400);
    const code = parsed?.error?.code;
    if (typeof code === "string" && code.trim()) return code.trim().slice(0, 200);
  } catch {
    /* not JSON: the status alone is the answer */
  }
  return null;
}

/** One call, with everything that can go wrong turned into a `kind`. */
async function call(
  auth: VercelAuth,
  pathname: string,
  init: { method?: "GET" | "POST"; query?: Record<string, string>; timeoutMs?: number; maxChars?: number } = {},
): Promise<VercelResult<{ body: string; status: number }>> {
  let res: Response;
  try {
    res = await fetch(url(pathname, auth, init.query ?? {}), {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure("network", `This ClawBox could not reach Vercel: ${redactToken(message, auth.token)}`);
  }

  const body = await readBounded(res, init.maxChars ?? MAX_RESPONSE_CHARS).catch(() => "");
  if (res.ok) return { ok: true, body, status: res.status };

  const said = upstreamMessage(body);
  const detail = redactToken(said ?? `Vercel answered ${res.status}.`, auth.token);
  if (res.status === 401 || res.status === 403) {
    return failure("auth", `Vercel refused this ClawBox's token: ${detail}`, res.status);
  }
  if (res.status === 404) return failure("not_found", detail, res.status);
  if (res.status === 429) return failure("rate", `Vercel is rate-limiting this ClawBox: ${detail}`, res.status);
  if (res.status >= 500) return failure("upstream", `Vercel is having trouble: ${detail}`, res.status);
  return failure("refused", detail, res.status);
}

/** The parsed JSON of a call, or the failure that stopped it. */
async function json<T>(
  auth: VercelAuth,
  pathname: string,
  init?: Parameters<typeof call>[2],
): Promise<VercelResult<{ data: T }>> {
  const answered = await call(auth, pathname, init);
  if (!answered.ok) return answered;
  try {
    return { ok: true, data: JSON.parse(answered.body) as T };
  } catch {
    return failure("upstream", "This ClawBox could not read Vercel's answer.", answered.status);
  }
}

// ── readiness ───────────────────────────────────────────────────────────────

/**
 * Does this token work, and whose is it?
 *
 * `/v2/user` is asked rather than the projects list because it is the narrowest
 * question that proves the credential: a token scoped to one project answers it
 * too, and a listing that came back empty would be indistinguishable from an
 * account with no projects.
 */
export async function verifyToken(auth: VercelAuth): Promise<VercelResult<{ username: string | null }>> {
  const answered = await json<{ user?: { username?: unknown; name?: unknown; email?: unknown } }>(auth, "/v2/user");
  if (!answered.ok) return answered;
  const user = answered.data?.user ?? {};
  const username = [user.username, user.name].find((x): x is string => typeof x === "string" && x.trim() !== "") ?? null;
  return { ok: true, username };
}

/** Does this project id resolve, and what is it called? */
export async function readProject(auth: VercelAuth, projectId: string): Promise<VercelResult<{ id: string; name: string | null }>> {
  const answered = await json<{ id?: unknown; name?: unknown }>(auth, `/v9/projects/${encodeURIComponent(projectId)}`);
  if (!answered.ok) return answered;
  const id = typeof answered.data?.id === "string" ? answered.data.id : projectId;
  const name = typeof answered.data?.name === "string" ? answered.data.name : null;
  return { ok: true, id, name };
}

// ── deployments ─────────────────────────────────────────────────────────────

/**
 * A project's recent deployments, newest first.
 *
 * The BRANCH is not a filter Vercel offers on this endpoint in a form that is
 * stable across API versions, so the page is fetched and matched here
 * (`matchDeployment`) — which is also what lets the match prefer the COMMIT,
 * the only field that names exactly one build.
 */
export async function listDeployments(
  auth: VercelAuth,
  projectId: string,
): Promise<VercelResult<{ deployments: VercelDeployment[] }>> {
  const answered = await json<{ deployments?: unknown }>(auth, "/v6/deployments", {
    query: { projectId, limit: String(DEPLOYMENT_PAGE) },
  });
  if (!answered.ok) return answered;
  const raw = Array.isArray(answered.data?.deployments) ? answered.data.deployments : [];
  const deployments: VercelDeployment[] = [];
  for (const entry of raw) {
    const parsed = parseDeployment(entry);
    if (parsed) deployments.push(parsed);
  }
  return { ok: true, deployments };
}

/** One deployment, in full. */
export async function readDeployment(auth: VercelAuth, deploymentId: string): Promise<VercelResult<{ deployment: VercelDeployment }>> {
  const answered = await json<unknown>(auth, `/v13/deployments/${encodeURIComponent(deploymentId)}`);
  if (!answered.ok) return answered;
  const deployment = parseDeployment(answered.data);
  if (!deployment) return failure("upstream", "Vercel did not say which deployment that is.");
  return { ok: true, deployment };
}

/**
 * The tail of a failed build's log — what the agent is handed.
 *
 * The TAIL, because the error is at the end: an install that fails prints a
 * screen of warnings first, and the last lines are the ones that say what
 * broke. Bounded twice — once on the wire (`maxChars`) so the box never holds
 * the whole thing, and once here so what reaches a run's task is a few
 * thousand characters rather than a build log.
 *
 * The events endpoint answers either a JSON array or newline-delimited JSON
 * depending on the version and the query, so both are read: a log this box
 * could not parse comes back as the raw tail rather than as nothing, since raw
 * text is still exactly what the agent needs to read.
 */
export async function readBuildLog(auth: VercelAuth, deploymentId: string): Promise<VercelResult<{ log: string }>> {
  const answered = await call(auth, `/v3/deployments/${encodeURIComponent(deploymentId)}/events`, {
    query: { builds: "1", direction: "backward", limit: "500" },
    timeoutMs: LOG_TIMEOUT_MS,
    maxChars: MAX_RESPONSE_CHARS,
  });
  if (!answered.ok) return answered;
  return { ok: true, log: tailOf(extractLogText(answered.body)) };
}

/** The text of a log event, whatever shape it arrived in. */
function eventText(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return null;
  const v = entry as Record<string, unknown>;
  if (typeof v.text === "string") return v.text;
  const payload = typeof v.payload === "object" && v.payload !== null ? (v.payload as Record<string, unknown>) : null;
  if (payload && typeof payload.text === "string") return payload.text;
  return null;
}

/** Turn the events answer into plain log text. Exported for its test. */
export function extractLogText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const lines = parsed.map(eventText).filter((x): x is string => x !== null);
      if (lines.length) return lines.join("\n");
    }
  } catch {
    /* newline-delimited, or something else: fall through */
  }
  const lines: string[] = [];
  let anyParsed = false;
  for (const line of trimmed.split("\n")) {
    const bare = line.trim();
    if (!bare) continue;
    try {
      const text = eventText(JSON.parse(bare) as unknown);
      if (text !== null) { lines.push(text); anyParsed = true; continue; }
    } catch {
      /* not JSON */
    }
    lines.push(line);
  }
  // A body this box could not read as events is still the log the agent needs,
  // so the raw text is the answer rather than nothing.
  return anyParsed ? lines.join("\n") : trimmed;
}

/** The last MAX_BUILD_LOG_CHARS of a log, cut on a line boundary. */
export function tailOf(log: string, max = MAX_BUILD_LOG_CHARS): string {
  const text = log.replace(/\r\n?/g, "\n").trimEnd();
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const newline = cut.indexOf("\n");
  return newline >= 0 ? cut.slice(newline + 1) : cut;
}

// ── promotion ───────────────────────────────────────────────────────────────

/**
 * Point the project's production traffic at this deployment.
 *
 * NEVER called from a watcher, a settle or any other automatic path: the only
 * caller is the owner-fenced route, which additionally requires an explicit
 * confirmation in the body. A box that promoted a green preview by itself would
 * be deciding, on the owner's behalf, that a build the agent wrote goes in
 * front of that project's users.
 */
export async function promoteDeployment(
  auth: VercelAuth,
  projectId: string,
  deploymentId: string,
): Promise<VercelResult<{ promoted: true }>> {
  const answered = await call(
    auth,
    `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`,
    { method: "POST" },
  );
  if (!answered.ok) return answered;
  return { ok: true, promoted: true };
}
