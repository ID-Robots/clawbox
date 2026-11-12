import { NextResponse } from "next/server";
import { POST as configureAiModelsPost } from "@/app/setup-api/ai-models/configure/route";
import { getActiveHarness } from "@/lib/harness";
import { humanizeApiError } from "@/lib/api-error-message";
import { ClawaiApplyError, applyClawaiToHermes } from "@/lib/hermes-clawai";
import { normalizeClawaiUiTier, uiTierToDeviceTier } from "@/lib/clawbox-ai-tiers";
import { fetchPortalTier } from "@/lib/clawbox-ai-portal-tier";
import {
  CLAWAI_CONFIGURING_TIMEOUT_MS,
  type ClawAiConnectSession,
  clearClawAiSession,
  isClawAiSessionExpired,
  readClawAiSession,
  writeClawAiSession,
} from "@/lib/clawai-connect";
import { getBackgroundTask } from "@/lib/background-tasks";
import {
  providerAuthBusyMessage,
  startProviderSignInTask,
  type ProviderSaveOutcome,
  type ProviderSignInEnd,
} from "@/lib/provider-auth-tasks";

export const dynamic = "force-dynamic";

const CLAWBOX_AI_DEVICE_POLL_URL =
  process.env.CLAWBOX_AI_DEVICE_POLL_URL?.trim()
  || "https://clawbox.com/api/clawbox-ai/device-poll";

// Max time a session may sit in `configuring` (clawai-connect.ts).
const CONFIGURING_TIMEOUT_MS = CLAWAI_CONFIGURING_TIMEOUT_MS;

interface UpstreamPollResponse {
  status?: string;
  access_token?: string;
  token?: string;
  error?: string;
  message?: string;
}

// Terminal portal errors that should stop the poll loop and surface an
// actionable message instead of being treated as "user hasn't entered
// the code yet". Adding a new gate is a one-row change here.
const TERMINAL_PORTAL_ERRORS: ReadonlyArray<{
  httpStatus: number;
  code: string;
  message: string;
}> = [
  {
    httpStatus: 403,
    code: "email_not_verified",
    message: "Please verify your email address in the ClawBox portal before authorising this device, then request a new device code.",
  },
  {
    httpStatus: 402,
    code: "paid_plan_required",
    message: "This tier needs a paid subscription. Subscribe to Pro or Max in the ClawBox portal, then request a new device code.",
  },
];

function formatUserFacingError(message: string) {
  const normalized = message.trim();
  if (/token limit reached/i.test(normalized)) {
    return "ClawBox AI could not authorise this device because your account has reached its token limit. Remove an old token in the portal or upgrade your plan, then try again.";
  }
  return normalized || "ClawBox AI authorisation failed.";
}

/**
 * BOTH halves of a failed response, because they have different readers.
 *
 * `sentence` is for the owner: the message out of the body, or `""` when there
 * is not one. The three callers all have a fallback of their own, and every one
 * of them is a better thing to show than a serialized body — this route put
 * `{"error":"Credential migration failed. …"}` on the setup wizard, braces and
 * all, by treating a body as a message.
 *
 * `raw` is for the operator, and it is the reason this returns a pair rather
 * than the sentence alone. The log line is the only window into why a sign-in
 * failed on a box nobody can reach, and a body whose shape `humanizeApiError`
 * does not recognise reduces to `""` — which would have left `Token save
 * failed 502` and nothing else in the journal. The wizard gets the sentence;
 * the journal keeps what actually arrived.
 */
async function readErrorBody(response: Response): Promise<{ raw: string; sentence: string }> {
  const raw = await response.text().catch(() => "");
  return { raw, sentence: humanizeApiError(raw, "") };
}

// Run the configure pipeline server-side AFTER acknowledging the poll
// request. Holding the poll's HTTP response open for the full ~50 s
// gateway restart left the embedded Chromium dropping the connection
// mid-flight, which stranded the UI on the device-code page even
// though provisioning had completed. The session-status state machine
// (pending → configuring → complete) lets a subsequent quick poll see
// that finalisation finished and trigger the success overlay.
//
// It runs as the box's provider sign-in TASK (TASK-2148,
// src/lib/provider-auth-tasks.ts), not as a promise nothing else can see: the
// desktop's corner card shows it, a Settings reopened half-way finds it, and
// the task waits out the gateway restart and reads the row back. The session
// file still says how it ended, for the device-login card that polls here.
async function saveClawaiSignIn(session: ClawAiConnectSession, accessToken: string): Promise<ProviderSaveOutcome> {
  // The OpenClaw configure route below writes ~/.openclaw/openclaw.json and
  // restarts the OpenClaw gateway, and it persists clawai_token only AFTER
  // that. On a Hermes device that runtime isn't installed, so the write threw
  // and the token was never stored — the device-login CTA could never
  // succeed. Route Hermes devices through Hermes' own config instead.
  // getActiveHarness() returns "openclaw" for every openclaw/dual-openclaw
  // device, so the OpenClaw path below is untouched.
  if ((await getActiveHarness()) === "hermes") {
    const uiTier = normalizeClawaiUiTier(session.tier) ?? "flash";
    // THE PLAN, asked here as well, because this is the primary link path on
    // this edition and nothing else on it holds a portal answer. The OpenClaw
    // branch below reaches `/setup-api/ai-models/configure`, which records
    // the plan itself; without this the two editions' own device-code flows
    // would disagree, and a Hermes box would finish the link with no plan on
    // record — so no withdrawal would be reachable at all until a BROWSER
    // happened to poll `/setup-api/ai-models/status` (TASK-744).
    //
    // ONE cold round trip, bounded at `PORTAL_FETCH_TIMEOUT_MS` (4 s) — the
    // cache is keyed by token and the box has never held this one — against a
    // finaliser the UI gives three minutes. It cannot fail the pairing:
    // `fetchPortalTier` reports every failure as `unreachable` rather than
    // throwing. The wizard's next status poll then lands on the entry this
    // call warmed.
    const lookup = await fetchPortalTier(accessToken).catch(() => null);
    try {
      await applyClawaiToHermes(accessToken, uiTierToDeviceTier(uiTier), {
        // Absent unless the portal ANSWERED — an unreachable lookup or a
        // probe that threw retires the plan rather than recording a guess.
        portalPlan: lookup?.source === "portal" ? { verdict: lookup.planVerdict } : undefined,
      });
    } catch (err) {
      // Only our own message is safe to store/show — a raw spawn failure can
      // carry the hermes binary path.
      throw new ClawaiApplyError(
        err instanceof ClawaiApplyError ? err.message : "Couldn't configure ClawBox AI on this device.",
      );
    }
    // Hermes applies the credential itself, with no configure route and no
    // session sweep behind it, so there is nothing here that can warn.
    return { ok: true, body: { success: true } };
  }

  const configureResponse = await configureAiModelsPost(new Request("http://localhost/setup-api/ai-models/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: session.scope,
      provider: "clawai",
      apiKey: accessToken,
      authMode: "subscription",
      clawaiTier: session.tier ?? "flash",
    }),
  }));

  if (!configureResponse.ok) {
    // `readErrorBody`, NOT `.text()`. This one line is how the configure
    // route's JSON body reached the wizard verbatim: the sign-in's own
    // rollback message is a perfectly good sentence, and it was shown
    // wrapped in the object it travelled in.
    const configureBody = await readErrorBody(configureResponse);
    const userFacing = formatUserFacingError(configureBody.sentence || "Failed to save ClawBox AI token.");
    // The RAW body in the journal, deliberately: the owner is spared the
    // braces, the operator diagnosing this box is not spared the evidence.
    console.error("[clawai/poll] Token save failed", configureResponse.status, configureBody.raw.slice(0, 200));
    return { ok: false, body: { error: userFacing }, httpStatus: configureResponse.status };
  }

  // The BODY of a successful configure, not just `response.ok`: a save can
  // land and still not have done all of it — the session sweep this sign-in
  // defers past the gateway restart is exactly that — and reading only the
  // status dropped the one sentence that says so on the primary sign-in path
  // of these boxes. Best effort: an unreadable body is a save that landed,
  // never an error, so it costs the warning and nothing else. The gateway
  // restart it answers early about (TASK-1535) is the task's to wait out, so
  // "complete" keeps meaning a box the owner can chat with.
  try {
    const configured = await configureResponse.json() as Record<string, unknown>;
    return { ok: true, body: { ...configured, success: true } };
  } catch (err) {
    console.warn("[clawai/poll] Could not read the configure answer's warning:", err instanceof Error ? err.message : err);
    return { ok: true, body: { success: true } };
  }
}

/** The session record of how the task ended, for the device-login card that polls this route. */
async function recordClawaiEnd(session: ClawAiConnectSession, end: ProviderSignInEnd): Promise<void> {
  if (end.ok) {
    const warning = typeof end.result.warning === "string" && end.result.warning.trim() ? end.result.warning : null;
    await writeClawAiSession({ ...session, status: "complete", error: null, warning, completedAt: Date.now() });
    return;
  }
  console.error("[clawai/poll] Background configure failed:", end.error);
  await writeClawAiSession({ ...session, status: "error", error: formatUserFacingError(end.error) });
}

/**
 * The token of a link for the PLAN alone (TASK-2501): record it as the box's
 * subscription link and nothing else.
 *
 * None of the ClawBox AI finaliser above runs. No configure route, no Hermes
 * apply, no gateway restart, no provider sign-in task: the chat model the box
 * runs on is exactly what it was, and `clawai_token` — the credential every
 * cloud feature looks for — is not written. That is the whole difference
 * between linking a subscription and signing in to ClawBox AI.
 *
 * Inline rather than detached, because there is nothing slow left to wait out:
 * one portal round trip, bounded at four seconds, and one store write. The
 * session goes through `configuring` first all the same, so a second poll that
 * lands meanwhile answers "configuring" instead of linking a second time.
 */
async function finishSubscriptionLink(session: ClawAiConnectSession, accessToken: string): Promise<NextResponse> {
  const linking: ClawAiConnectSession = { ...session, status: "configuring", error: null, configuringStartedAt: Date.now() };
  await writeClawAiSession(linking);
  const { linkSubscription } = await import("@/lib/subscription-link");
  const outcome = await linkSubscription(accessToken);
  if (!outcome.ok) {
    console.error("[clawai/poll] Subscription link failed:", outcome.code);
    await writeClawAiSession({ ...linking, status: "error", error: outcome.message });
    return NextResponse.json(
      { status: "error", error: outcome.message },
      { status: outcome.code === "store_failed" ? 500 : 409 },
    );
  }
  await writeClawAiSession({ ...linking, status: "complete", error: null, warning: null, completedAt: Date.now() });
  return NextResponse.json({ status: "complete" });
}

export async function POST() {
  const session = await readClawAiSession();
  if (!session) {
    return NextResponse.json({ status: "error", error: "No pending ClawBox AI session." }, { status: 400 });
  }

  // Terminal states first — return without re-querying upstream so the
  // UI sees the resolved state on its very next poll tick after a long
  // outage / browser sleep / disconnected fetch.
  if (session.status === "complete") {
    // The warning rides beside the status, the way `error` does, so the panel
    // that renders it (`showSuccessAndContinue` → `saveWarning`) gets the same
    // sentence the pasted-key and provider-OAuth paths already show.
    return NextResponse.json({ status: "complete", ...(session.warning ? { warning: session.warning } : {}) });
  }
  if (session.status === "error" && session.error) {
    return NextResponse.json({ status: "error", error: session.error });
  }
  if (session.status === "configuring") {
    // The sign-in's task is the truth while it is known: running, it may run
    // past the window below (a slow restart is waited out, not cut off); ended
    // without writing the session — a web server that restarted under it — it
    // says how, at once, instead of three minutes later.
    const task = session.taskId ? getBackgroundTask(session.taskId) : null;
    if (task?.state === "running") return NextResponse.json({ status: "configuring", taskId: task.id });
    if (task) {
      const end: ProviderSignInEnd = task.state === "succeeded"
        ? { ok: true, result: task.result ?? {} }
        : { ok: false, error: task.error || "ClawBox AI setup did not finish. Please request a new code and try again." };
      await recordClawaiEnd(session, end);
      const ended = await readClawAiSession();
      return ended?.status === "complete"
        ? NextResponse.json({ status: "complete", ...(ended.warning ? { warning: ended.warning } : {}) })
        : NextResponse.json({ status: "error", error: ended?.error ?? formatUserFacingError(end.ok ? "" : end.error) });
    }
    // The background configure normally flips the session to complete/error
    // within a gateway-restart cycle. If it never reports back (process died
    // mid-restart, etc.) the session would sit in `configuring` forever and
    // the UI would poll indefinitely. Time it out into a retryable error so
    // the user can request a fresh code.
    const configuringStartedAt = session.configuringStartedAt ?? session.createdAt;
    if (Date.now() - configuringStartedAt > CONFIGURING_TIMEOUT_MS) {
      await clearClawAiSession();
      return NextResponse.json(
        { status: "error", error: "ClawBox AI setup timed out while finishing up. Please request a new code and try again." },
        { status: 408 },
      );
    }
    return NextResponse.json({ status: "configuring" });
  }

  if (isClawAiSessionExpired(session)) {
    await clearClawAiSession();
    return NextResponse.json({ status: "error", error: "ClawBox AI code expired. Please request a new code." }, { status: 410 });
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(CLAWBOX_AI_DEVICE_POLL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: session.device_id,
        user_code: session.user_code,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Include the upstream URL and device_id so a single log line is enough
    // to correlate a transient failure to the affected device pairing flow.
    // user_code is *not* logged — it's the secret the user types on the
    // portal to claim this session.
    console.warn(
      `[clawai/poll] Upstream unreachable url=${CLAWBOX_AI_DEVICE_POLL_URL} device_id=${session.device_id}:`,
      err instanceof Error ? err.message : err,
    );
    // Treat transient failures as pending so the UI keeps polling — the
    // user may simply be on a flaky uplink; turning every blip into a
    // hard error would drop them back to the start of the flow.
    return NextResponse.json({ status: "pending" });
  }

  // 202/403/404 are common "user hasn't entered the code yet" responses.
  // Exception: a status carrying a known terminal error code (e.g. 403
  // email_not_verified, 402 paid_plan_required) means the portal will
  // never advance — write the error to the session and surface it so
  // the UI stops polling and renders the actionable instruction
  // instead of stalling on the device-code page.
  const terminal = TERMINAL_PORTAL_ERRORS.find((e) => e.httpStatus === upstreamRes.status);
  if (terminal) {
    const errCode = (await readErrorBody(upstreamRes)).sentence.trim().toLowerCase();
    if (errCode === terminal.code) {
      await writeClawAiSession({ ...session, status: "error", error: terminal.message });
      return NextResponse.json({ status: "error", error: terminal.message }, { status: terminal.httpStatus });
    }
    return NextResponse.json({ status: "pending" });
  }
  if (upstreamRes.status === 202 || upstreamRes.status === 404) {
    return NextResponse.json({ status: "pending" });
  }

  if (!upstreamRes.ok) {
    const errText = await readErrorBody(upstreamRes);
    if (upstreamRes.status === 410 || upstreamRes.status === 400) {
      const userFacing = formatUserFacingError(errText.sentence || "ClawBox AI session is no longer valid.");
      await writeClawAiSession({ ...session, status: "error", error: userFacing });
      return NextResponse.json({ status: "error", error: userFacing }, { status: 410 });
    }
    console.warn("[clawai/poll] Upstream poll failed", upstreamRes.status, errText.raw.slice(0, 200));
    // 5xx — don't burn the session; let the UI retry.
    return NextResponse.json({ status: "pending" });
  }

  const data = await upstreamRes.json() as UpstreamPollResponse;
  const upstreamStatus = (data.status || "").toLowerCase();

  if (upstreamStatus === "pending" || upstreamStatus === "authorization_pending") {
    return NextResponse.json({ status: "pending" });
  }

  const accessToken = (data.access_token || data.token || "").trim();
  if (!accessToken) {
    if (upstreamStatus === "error") {
      const userFacing = formatUserFacingError(data.error || data.message || "ClawBox AI authorisation failed.");
      await writeClawAiSession({ ...session, status: "error", error: userFacing });
      return NextResponse.json({ status: "error", error: userFacing });
    }
    // Unknown payload — keep polling rather than aborting.
    return NextResponse.json({ status: "pending" });
  }

  // The session this poll read may have ended while the portal answered: a
  // sign-out clears it (src/lib/provider-sign-out.ts), and the token in hand
  // must not sign the box back in to the account it just left.
  const current = await readClawAiSession();
  if (!current || current.device_id !== session.device_id) {
    return NextResponse.json(
      { status: "error", error: "This ClawBox AI sign-in was cancelled. Request a new code to sign in." },
      { status: 410 },
    );
  }

  if (session.scope === "entitlement") {
    return finishSubscriptionLink(session, accessToken);
  }

  // Upstream issued a token. Mark the session as `configuring` first so
  // a concurrent poll (which can happen if the client is on a fast
  // interval) doesn't fire a second background configure. Then kick
  // off the configure off the request lifecycle and acknowledge the
  // poll quickly. The next poll tick — typically within `interval`
  // seconds — sees `configuring` or `complete` and the UI advances.
  const configuringSession: ClawAiConnectSession = {
    ...session,
    status: "configuring",
    error: null,
    configuringStartedAt: Date.now(),
  };
  await writeClawAiSession(configuringSession);
  // Nothing awaited between the write above and the start below can start a
  // second one: a poll that lands meanwhile reads `configuring`.
  const start = startProviderSignInTask({
    provider: "clawai",
    label: "ClawBox AI",
    ask: { deviceLogin: session.device_id },
    save: async (ctx) => {
      // Inside the task, so this write cannot land after the ending's.
      await writeClawAiSession({ ...configuringSession, taskId: ctx.id });
      return saveClawaiSignIn(configuringSession, accessToken);
    },
    onEnd: (end) => recordClawaiEnd(configuringSession, end),
  });
  if (!start.ok || !start.started) {
    // Another provider change holds the box — or a ClawBox AI sign-in that is
    // not this one (a pasted token) is already finishing. The token in hand is
    // not saved over it; the owner asks for a new code once it is done.
    const error = start.ok
      ? "A ClawBox AI sign-in is already finishing on this box. Wait for it, then request a new code if it is still needed."
      : providerAuthBusyMessage(start.running, "Request a new code once it has finished.");
    await writeClawAiSession({ ...configuringSession, status: "error", error });
    return NextResponse.json({ status: "error", error }, { status: 409 });
  }

  return NextResponse.json({ status: "configuring", taskId: start.task.id });
}
