/**
 * Settings actions that are not instant, as JOBS of the box — the one shared
 * helper every such action is built on (TASK-2148), on top of the background
 * tasks of TASK-2056 (src/lib/background-tasks.ts).
 *
 * WHY. Anything a Settings control starts that takes more than a moment — a
 * provider sign-in, a channel's setup, a disconnect — used to live in the
 * window that started it: the request carried the work's only verdict, the
 * window its only progress. Close Settings half-way and reopen it, and it
 * drew the state from before; only a page refresh told the truth. A job is the
 * same work owned by the web server: it runs whether or not the window is
 * open, the desktop's corner card shows it (with a turning ring — these
 * measure nothing they could fill a bar with), and a reopened Settings — or
 * another tab, another device — reads it and draws it in progress.
 *
 * WHAT A JOB IS. A background task of a SETTINGS kind (`SETTINGS_JOB_KINDS`)
 * whose `meta` says what it is about: `subject` (the provider's row id, the
 * channel), `action` (`sign-in`, `configure`, `disconnect`, …), `label` (the
 * subject's name, for sentences), and `ask` — a keyed fingerprint of what it
 * was asked with.
 *
 * ONE AT A TIME PER GROUP. Asked again for the same subject, action and ask
 * while it runs — a double click, a second tab, a reopened Settings — the
 * running job is answered (`started: false`), never a second one started.
 * Anything else in the group is refused with the running job named, a second
 * ask of the same subject with other values included: following the first
 * would report a save that never happened.
 *
 * FROM A ROUTE. `routeAsSettingsJob` turns a route's own handler into a job
 * when the request asks `background: true` (or `?background=1` for a body-less
 * DELETE): the job calls the handler with the same body, in-process, and ends
 * with its answer — status kept — so the browser's half
 * (src/lib/settings-job-client.ts, `settingsJobFetch`) hands the caller the
 * very Response the route would have answered, once the box has finished.
 *
 * SERVER ONLY.
 */

import { createHmac, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { humanizeApiError } from "@/lib/api-error-message";
import {
  BackgroundTaskFailure,
  runningBackgroundTask,
  startBackgroundTask,
  type BackgroundTaskContext,
  type BackgroundTaskView,
} from "@/lib/background-tasks";
import { SETTINGS_JOB_KINDS } from "@/lib/background-task-kinds";
import { processStore } from "@/lib/process-store";

/** What a settings job records as its `meta`. */
export interface SettingsJobMeta {
  /** What it is about: a provider's row id, a channel. */
  subject: string;
  /** Which way: `sign-in`, `sign-out`, `configure`, `disconnect`, … */
  action: string;
  /** The subject's name, for the sentences about it. */
  label: string;
  /**
   * What it was asked with, fingerprinted (a keyed hash of the body, never
   * the body): a second ask follows the running job only when it is the same.
   */
  ask?: string;
}

export type SettingsJobStart =
  | { ok: true; started: boolean; task: BackgroundTaskView }
  | { ok: false; running: BackgroundTaskView };

export type SettingsJobStep = { id: string; label: string; weight?: number };

/**
 * The fingerprint `SettingsJobMeta.ask` holds: keyed by a secret of this
 * process, so the record carries nothing a pasted key or token could be read
 * back or guessed from. A job outlives no process (a restart closes it), so
 * neither need the key.
 */
export function askFingerprint(ask: Record<string, unknown>): string {
  const salt = processStore("settings-job-ask-salt", () => ({ key: randomBytes(32) })).key;
  const sorted = Object.keys(ask).sort().map((key) => [key, ask[key]]);
  return createHmac("sha256", salt).update(JSON.stringify(sorted)).digest("hex").slice(0, 32);
}

/** The meta of a settings job, or null for any other task. */
export function settingsJobMetaOf(task: Pick<BackgroundTaskView, "kind" | "meta">): SettingsJobMeta | null {
  if (!SETTINGS_JOB_KINDS.includes(task.kind)) return null;
  const meta = task.meta ?? {};
  const subject = typeof meta.subject === "string" && meta.subject ? meta.subject : null;
  const action = typeof meta.action === "string" && meta.action ? meta.action : null;
  if (!subject || !action) return null;
  return {
    subject,
    action,
    label: typeof meta.label === "string" && meta.label ? meta.label : subject,
    ...(typeof meta.ask === "string" ? { ask: meta.ask } : {}),
  };
}

/** The job of this group the box is running now, if any. */
export function runningSettingsJob(group: string): BackgroundTaskView | null {
  return runningBackgroundTask(group);
}

function sameJob(task: BackgroundTaskView, meta: SettingsJobMeta): boolean {
  const running = settingsJobMetaOf(task);
  return running !== null
    && running.subject === meta.subject
    && running.action === meta.action
    && (running.ask ?? null) === (meta.ask ?? null);
}

export interface SettingsJobSpec {
  kind: string;
  group: string;
  subject: string;
  action: string;
  label: string;
  /** What it was asked with (see `SettingsJobMeta.ask`); absent, any ask of the subject and action is the same. */
  ask?: Record<string, unknown>;
  title: string;
  /** The first headline. */
  status: string;
  steps: SettingsJobStep[];
  run: (ctx: BackgroundTaskContext) => Promise<Record<string, unknown>>;
}

/**
 * Start a settings job, or answer the one already running for the same ask.
 * Synchronous from the group check to the insert (`startBackgroundTask`), so
 * two requests that arrive together cannot both start one. Not cancellable:
 * a credential half-written or a channel half-configured is worse than either
 * finished, and none of these has a safe stop.
 */
export function startSettingsJob(spec: SettingsJobSpec): SettingsJobStart {
  const meta: SettingsJobMeta = {
    subject: spec.subject,
    action: spec.action,
    label: spec.label,
    ...(spec.ask ? { ask: askFingerprint(spec.ask) } : {}),
  };
  const running = runningSettingsJob(spec.group);
  if (running) return sameJob(running, meta) ? { ok: true, started: false, task: running } : { ok: false, running };
  const start = startBackgroundTask({
    kind: spec.kind,
    group: spec.group,
    title: spec.title,
    meta: { ...meta },
    status: spec.status,
    steps: spec.steps,
    run: spec.run,
  });
  if (start.started) return { ok: true, started: true, task: start.task };
  return sameJob(start.running, meta) ? { ok: true, started: false, task: start.running } : { ok: false, running: start.running };
}

/** The sentence a refusal names the running job in; `next` is what the owner does about it. */
export function settingsJobBusyMessage(running: BackgroundTaskView, next = "Try again when it has finished."): string {
  return `${running.title} is still running on this box. ${next}`;
}

/**
 * The HTTP answer to a start: 202 with the job to follow (`started: false`
 * when it is the one already running for the same ask), or 409 with `code`
 * naming the other job that runs.
 */
export function settingsJobStartResponse(
  start: SettingsJobStart,
  busy: { code?: string; message?: (running: BackgroundTaskView) => string } = {},
): NextResponse {
  if (!start.ok) {
    const code = busy.code ?? "settings_job_running";
    return NextResponse.json(
      {
        error: (busy.message ?? settingsJobBusyMessage)(start.running),
        code,
        kind: code,
        taskId: start.running.id,
      },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { taskId: start.task.id, started: start.started, task: start.task },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The JSON body without its `background` flag when it asks `background:
 * true` — Settings' ask that an action run as a job — else null. A body-less
 * request (a DELETE) asks with `?background=1` and answers `{}`. Reads a copy:
 * the action itself reads the request, and a body that is not JSON is its own
 * 400 to answer.
 */
export async function backgroundAskOf(request: Request): Promise<Record<string, unknown> | null> {
  if (new URL(request.url, "http://localhost").searchParams.get("background") === "1") {
    const body: unknown = await request.clone().json().catch(() => ({}));
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  }
  const body: unknown = await request.clone().json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { background, ...rest } = body as Record<string, unknown>;
  return background === true ? rest : null;
}

/** A route's own action, as a request of its own, for a job that holds only the body. */
export function jobRequest(path: string, body: Record<string, unknown>, method = "POST"): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body) }),
  });
}

/** What an action answered: its route's JSON, and whether that was a success. */
export interface JobOutcome {
  /** False for a refusal or a failure; `body.error` says why. */
  ok: boolean;
  body: Record<string, unknown>;
  /** The HTTP status the action answered with. */
  httpStatus?: number;
  /** The sentence a failure is said in, where `body.error` is a code rather than one. */
  message?: string;
}

/**
 * A route's JSON answer as an outcome. A non-2xx answer that says
 * `success: true` is a success with something to say (Telegram's 502 "saved,
 * but the gateway is not serving it yet"); a 2xx that says `success: false`
 * is not.
 */
export async function outcomeOf(response: Response): Promise<JobOutcome> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const ok = (response.ok && body.success !== false) || body.success === true;
  return { ok, body, httpStatus: response.status };
}

export interface RouteJobSpec {
  /** The route's path, for the in-process request. */
  path: string;
  method?: "POST" | "DELETE";
  kind: string;
  group: string;
  /** What the job is about, from the body it was asked with. */
  describe: (body: Record<string, unknown>) => {
    subject: string;
    action: string;
    label: string;
    title: string;
    status: string;
    /** The headline of a success with nothing else to say. */
    done: string;
    steps?: SettingsJobStep[];
  };
  /** The route's own handler, answered as one JSON body once the action is done. */
  handler: (request: Request) => Promise<Response>;
  /** The code a refusal while another job of the group runs answers with. */
  busyCode?: string;
  /**
   * The sentence the card says a failure in, by the code a route answers as
   * its `error` (Settings translates those codes itself; the card cannot). A
   * code with no sentence here is said as "<title> did not finish (<code>)."
   */
  messages?: Record<string, string>;
}

/** An `error` that is a code (`allowlist_unsupported`), not a sentence. */
const ERROR_CODE = /^[a-z][a-z0-9_]*$/;

/**
 * The route-side helper: when `request` asks for a job, start one that calls
 * the route's own handler with the same body and ends with its answer —
 * `httpStatus` kept, `status` the headline the card ends on (the answer's own
 * `warning` when it has one) — and answer 202 (or 409). Null when the request
 * does not ask: the route answers it in-request, as before.
 */
export async function routeAsSettingsJob(request: Request, spec: RouteJobSpec): Promise<Response | null> {
  const body = await backgroundAskOf(request);
  if (!body) return null;
  const about = spec.describe(body);
  const method = spec.method ?? "POST";
  const steps = about.steps ?? [{ id: "apply", label: about.title }];
  return settingsJobStartResponse(startSettingsJob({
    kind: spec.kind,
    group: spec.group,
    subject: about.subject,
    action: about.action,
    label: about.label,
    ask: body,
    title: about.title,
    status: about.status,
    steps,
    run: async (ctx) => {
      ctx.step(steps[0].id, about.status);
      const outcome = await outcomeOf(await spec.handler(jobRequest(spec.path, body, method)));
      if (!outcome.ok) {
        const said = outcome.message ?? humanizeApiError(outcome.body, `${about.title} did not finish.`);
        throw new BackgroundTaskFailure(
          ERROR_CODE.test(said) ? spec.messages?.[said] ?? `${about.title} did not finish (${said}).` : said,
          { ...outcome.body, httpStatus: outcome.httpStatus },
        );
      }
      const warning = typeof outcome.body.warning === "string" && outcome.body.warning.trim() ? outcome.body.warning.trim() : null;
      // `status` is the card's closing line, unless the answer already has a
      // field of that name the caller reads.
      return {
        ...outcome.body,
        httpStatus: outcome.httpStatus,
        ...(outcome.body.status === undefined ? { status: warning ?? about.done } : {}),
      };
    },
  }), { code: spec.busyCode });
}
