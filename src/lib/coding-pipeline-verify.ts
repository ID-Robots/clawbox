/**
 * Did the deployment actually do what was asked?
 *
 * WHY THIS EXISTS AT ALL. Vercel answering `READY` means Vercel finished a
 * build. It does not mean the page renders, it does not mean the page is the
 * new one, and it certainly does not mean the thing the owner asked for is on
 * it — a build that compiles a component nobody routed to is `READY`. The
 * owner's brief for the pipeline says the verification must NOT be "the API
 * said ready", so this module is the looking: fetch the address, require a
 * success status, check the page for what was asked for, and put a screenshot
 * and a written description of it on the record so a person can see what the
 * box saw.
 *
 * THE TWO KINDS OF ANSWER, AND WHY THE RECORD SAYS WHICH ONE IT IS.
 *
 *  - LITERAL. The caller named strings the page must contain. That is a fact
 *    this box establishes itself, and it is the strong answer.
 *  - JUDGED. The caller named nothing, so the screenshot's written description
 *    is put to the box's vision model together with the task, and its YES/NO
 *    decides. Weaker — it is a model's opinion about a picture — but it is
 *    independent of the run that did the work, which is the property that
 *    matters: the thing the pipeline must never do is believe the harness's own
 *    summary. `PipelineVerification.judgedBy` records which of the two decided,
 *    so no surface can draw them as the same claim.
 *
 * A CHECK THAT CANNOT BE MADE IS NEVER A PASS. No expectations AND no vision
 * model is not "probably fine"; it is `ok: false` with the reason, which the
 * pipeline's own preflight is meant to have caught before any of this ran.
 *
 * THE ADDRESS IS NOT A CALLER'S. It comes from Vercel's answer about a
 * deployment THIS box created. It is still held to the same rail the browser
 * route holds a caller's URL to (./private-address): https only, no
 * credentials in it, and a host that is not — and does not resolve to — one of
 * ours. Vercel is a third party, and a record that came back naming
 * `127.0.0.1` must not turn into this box fetching and screenshotting itself.
 */
import fs from "fs/promises";
import path from "path";

import { ensureArtifactsDir } from "@/lib/coding-agent-artifacts";
import { findPlaywrightChromium } from "@/lib/cdp-probe";
import { chromiumSandboxArgs } from "@/lib/chromium-sandbox";
import { hostIsPublic } from "@/lib/private-address";
import { describeImage } from "@/lib/vision-describe";
import type { PipelineVerification, VerificationExpectation } from "@/lib/coding-pipeline";

// The shapes live in the PURE half, which the run page can import; see its header.
export type { PipelineVerification, VerificationExpectation, VerificationJudge } from "@/lib/coding-pipeline";

/**
 * How many redirects the verification follows.
 *
 * It follows them at all because a deployment legitimately redirects — a
 * trailing slash, a locale prefix, an auth-free marketing page — and it follows
 * them BY HAND because `redirect: "follow"` validates nothing: a deployment
 * that answered `302 Location: http://169.254.169.254/` would have had this box
 * fetch a cloud metadata service, photograph it, and send the picture to a
 * vision model. Every hop is checked, and a chain longer than this is refused
 * rather than walked.
 */
export const VERIFY_MAX_REDIRECTS = 5;

/** The whole fetch's budget. A cold serverless function is seconds, not minutes. */
export const VERIFY_FETCH_TIMEOUT_MS = 30_000;
/** How much of the answer is read and searched. Enough for any page's markup. */
export const VERIFY_MAX_BODY_BYTES = 2 * 1024 * 1024;
/** The screenshot's own budget, above Playwright's navigation and below the stage's. */
export const VERIFY_SCREENSHOT_TIMEOUT_MS = 45_000;
/** How long the picture waits for a single-page app to draw itself. */
export const VERIFY_SETTLE_TIMEOUT_MS = 5_000;
/** How much of the page's own text the judgement is given beside the picture. */
export const VERIFY_MAX_TASK_CHARS = 600;

function refuse(url: string, reason: string, extra: Partial<PipelineVerification> = {}): PipelineVerification {
  return {
    ok: false,
    url,
    status: null,
    reason,
    judgedBy: "none",
    expectations: [],
    vision: null,
    screenshot: null,
    checkedAt: Date.now(),
    ...extra,
  };
}

/**
 * The address to check: the deployment's own, with the pipeline's path on it.
 *
 * Returns null with a reason rather than throwing, because every refusal here
 * is a stage failure the owner reads rather than a fault.
 */
export function verificationUrl(base: string, subPath: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return { ok: false, reason: "Vercel did not give this deployment an address that could be checked." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `That deployment's address is not a web address (${parsed.protocol}), so there was nothing to check.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "That deployment's address carries credentials, which this ClawBox will not follow." };
  }
  // The path REPLACES whatever the base carried: a deployment URL is a host,
  // and joining relatively would turn "/invoices" into a sibling of a path
  // Vercel happened to include.
  try {
    const joined = new URL(subPath || "/", parsed.origin);
    // …and it may not move the ADDRESS. `//other.example/` is a path that
    // starts with a slash and is a whole new origin once resolved, so a
    // verification would have gone looking at somebody else's site and passed
    // or failed the owner's deployment on what it found there.
    if (joined.origin !== parsed.origin) {
      return { ok: false, reason: "That path is an address of its own, not a path on the deployment." };
    }
    return { ok: true, url: joined.toString() };
  } catch {
    return { ok: false, reason: "That path could not be put onto the deployment's address." };
  }
}

/** Read at most `VERIFY_MAX_BODY_BYTES` of the answer as text. */
async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, VERIFY_MAX_BODY_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= VERIFY_MAX_BODY_BYTES) break;
    }
  } finally {
    // The connection goes even when the body was cut short at the cap: a
    // reader left open holds a socket for the length of the process.
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.min(chunk.byteLength, total - at)), at);
    at += chunk.byteLength;
    if (at >= total) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

/**
 * Take a picture of the page, into the run's evidence folder.
 *
 * Its OWN headless Chromium, opened and closed around the one capture, rather
 * than the browser route's long-lived shared handle. Two reasons, and the
 * second is the one that decided it: a verification runs minutes or hours
 * apart from anything else, so a kept-alive browser would be a hundred
 * megabytes of resident Chromium on a Jetson waiting for nothing; and the
 * shared one may be the DESKTOP browser the owner is looking at, whose tab
 * this has no business steering.
 *
 * Never throws: a box with no Chromium still gets a verification, it just gets
 * one with no picture, and the record says so.
 */
async function screenshotPage(runId: string, url: string): Promise<{ file: string | null; base64: string | null; error: string | null }> {
  const executablePath = findPlaywrightChromium();
  if (!executablePath) {
    return { file: null, base64: null, error: "Chromium is not installed on this box, so no screenshot was taken." };
  }
  let browser: import("playwright").Browser | null = null;
  try {
    const pw = await import("playwright");
    browser = await pw.chromium.launch({
      headless: true,
      executablePath,
      // The box's ONE answer about the sandbox (./chromium-sandbox), so this
      // Chromium is never hardened differently from the two the browser route
      // starts.
      args: chromiumSandboxArgs(),
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      // WITHOUT THIS THE GUARD BELOW HAS A HOLE IN IT. `page.route` does not
      // intercept a request a Service Worker makes, so a deployment that
      // registered one could fetch a private or link-local address from inside
      // it and never touch the handler. Nothing a verification needs is served
      // by a worker — this is a screenshot of a first load — so the cheapest
      // answer is that there are none.
      serviceWorkers: "block",
    });
    // Chromium follows redirects and re-resolves DNS itself, so the address the
    // fetch settled on proves nothing about where the RENDERER ends up. EVERY
    // request is put to the same rail before the browser connects — not only
    // navigations: the page being rendered is somebody else's, and an
    // `<img src="http://169.254.169.254/…">` or a `fetch()` in its own script
    // reaches an internal service exactly as a redirect would, and lands in the
    // screenshot this box then sends to a vision model.
    //
    // The answers are cached per ORIGIN for the length of the capture, which is
    // what keeps a page with sixty assets from costing sixty DNS lookups; a
    // navigation is never served from that cache, because a redirect hop is the
    // one request whose destination is the point.
    const origins = new Map<string, Promise<boolean>>();
    await page.route("**/*", async (route) => {
      const request = route.request();
      let parsed: URL | null = null;
      try {
        parsed = new URL(request.url());
      } catch {
        // Not an address this box will let a renderer reach.
      }
      const allowedScheme = parsed?.protocol === "http:" || parsed?.protocol === "https:";
      if (!parsed || !allowedScheme || parsed.username || parsed.password) {
        await route.abort("blockedbyclient");
        return;
      }
      const navigation = request.isNavigationRequest();
      const cached = navigation ? undefined : origins.get(parsed.origin);
      const check = cached ?? hostIsPublic(parsed.hostname);
      if (!cached && !navigation) {
        if (origins.size >= 128) origins.delete(origins.keys().next().value!);
        origins.set(parsed.origin, check);
      }
      if (await check) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await page.goto(url, { waitUntil: "load", timeout: VERIFY_SCREENSHOT_TIMEOUT_MS });
    // `load` and then a short wait for the network to go quiet, rather than
    // `domcontentloaded` as the browser route uses. The difference matters here
    // and not there: a single-page app renders nothing until its own script has
    // run and fetched, so a picture taken at DOMContentLoaded is a BLANK PAGE —
    // which the vision model would honestly judge as "not what was asked for",
    // sending working code back round and spending the owner's improvement
    // rounds on nothing. Best-effort: a page that keeps a socket open (a poll, a
    // websocket) never goes idle, and the picture is worth having anyway.
    await page.waitForLoadState("networkidle", { timeout: VERIFY_SETTLE_TIMEOUT_MS }).catch(() => {});
    const shot = await page.screenshot({ type: "png", timeout: VERIFY_SCREENSHOT_TIMEOUT_MS });
    const name = `verify-${Date.now().toString(36)}.png`;
    await fs.writeFile(path.join(ensureArtifactsDir(runId), name), shot, { mode: 0o600 });
    return { file: name, base64: shot.toString("base64"), error: null };
  } catch (err) {
    return { file: null, base64: null, error: err instanceof Error ? err.message : "the screenshot failed" };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * The question the vision model is asked when nothing literal was named.
 *
 * YES/NO first and the reason after, so the parse is on one token rather than
 * on a paragraph — and the bias is stated in the prompt: NO only when the page
 * plainly is not it. A model that hedges answers YES, because the literal
 * expectations are the strong check and this one must not fail a working
 * deployment over a cautious sentence.
 */
export function judgementPrompt(task: string): string {
  const asked = task.replace(/\s+/g, " ").trim().slice(0, VERIFY_MAX_TASK_CHARS);
  return [
    "You are checking a deployed web page against the task it was built for.",
    "",
    `TASK: ${asked}`,
    "",
    "Answer with YES or NO on the first line, then one sentence saying why.",
    "Answer NO only if the page plainly does not show the result of that task —",
    "an error page, a blank page, a build failure, a placeholder, or obviously the old version.",
    "If the page looks like a working result of the task, answer YES.",
    "Then, after the verdict line, describe what is actually on the page.",
  ].join("\n");
}

/**
 * The verdict off the FIRST non-blank line, or "unknown".
 *
 * The prompt asks for YES or NO on the first line and this reads exactly that,
 * because searching the whole answer is not a parse: "I cannot choose YES or
 * NO.\nNO" contains "YES" first, and a deployment showing the old version
 * would have passed on the strength of a refusal to answer. Anything this
 * cannot read is `unknown`, which fails the check rather than passing it.
 *
 * Leading punctuation is stripped because a model writes "**YES**" and "- NO".
 */
export function readVerdict(text: string | null): "yes" | "no" | "unknown" {
  if (!text) return "unknown";
  const first = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!first) return "unknown";
  const m = /^(yes|no)\b/i.exec(first.replace(/^[^A-Za-z]+/, ""));
  if (!m) return "unknown";
  return m[1].toLowerCase() === "yes" ? "yes" : "no";
}

/**
 * Fetch the page, checking EVERY hop.
 *
 * `redirect: "follow"` hands the whole chain to undici, which knows nothing
 * about which addresses are ours — so the redirects are walked here instead and
 * each target is put to `hostIsPublic` before a connection is made to it. The
 * same rail `src/app/setup-api/browser/route.ts` puts its own navigations on,
 * and for the same reason: the address came from somebody else.
 */
async function fetchThroughRedirects(start: string): Promise<
  | { ok: true; status: number; body: string; finalUrl: string }
  | { ok: false; reason: string; status?: number }
> {
  let current = start;
  const deadline = Date.now() + VERIFY_FETCH_TIMEOUT_MS;
  for (let hop = 0; hop <= VERIFY_MAX_REDIRECTS; hop += 1) {
    let target: URL;
    try {
      target = new URL(current);
    } catch {
      return { ok: false, reason: "That deployment redirected to something that is not a web address." };
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return { ok: false, reason: `That deployment redirected to ${target.protocol}, which this ClawBox will not follow.` };
    }
    if (target.username || target.password) {
      return { ok: false, reason: "That deployment redirected to an address carrying credentials, which this ClawBox will not follow." };
    }
    if (!(await hostIsPublic(target.hostname))) {
      return {
        ok: false,
        reason: hop === 0
          ? "That deployment's address is not a public one, so this ClawBox did not fetch it."
          : "That deployment redirected to an address inside this network, so this ClawBox stopped there.",
      };
    }

    let response: Response;
    try {
      response = await fetch(current, {
        // BY HAND: see the function's header.
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        headers: { "user-agent": "ClawBox-delivery-pipeline", accept: "text/html,*/*" },
      });
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error && err.name === "TimeoutError"
          ? `The page did not answer within ${Math.round(VERIFY_FETCH_TIMEOUT_MS / 1000)} seconds.`
          : `The page could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      // The body of a redirect is nothing anybody wants; releasing it keeps the
      // connection from being held for the life of the process.
      await response.body?.cancel().catch(() => {});
      if (!location) {
        return { ok: false, reason: `That deployment answered ${response.status} without saying where to go.`, status: response.status };
      }
      current = new URL(location, current).toString();
      continue;
    }
    return { ok: true, status: response.status, body: await readBody(response), finalUrl: current };
  }
  return { ok: false, reason: `That deployment redirected more than ${VERIFY_MAX_REDIRECTS} times, so this ClawBox stopped following it.` };
}

export interface VerifyInput {
  /** Whose evidence folder the screenshot goes in. */
  runId: string;
  /** The deployment's address, as Vercel gave it. */
  deploymentUrl: string;
  path: string;
  expect: readonly string[];
  /** The prompt the run was given, for the judged half. */
  task: string;
}

/**
 * Fetch the deployment, check it, and file the evidence.
 *
 * Never throws — every fault is an `ok: false` with the reason, because the
 * caller is a stage of the pipeline and a throw there would leave a stage
 * recorded as running that nothing is doing.
 */
export async function verifyDeployment(input: VerifyInput): Promise<PipelineVerification> {
  const built = verificationUrl(input.deploymentUrl, input.path);
  if (!built.ok) return refuse(input.deploymentUrl, built.reason);
  const url = built.url;

  const fetched = await fetchThroughRedirects(url);
  if (!fetched.ok) return refuse(url, fetched.reason, { status: fetched.status ?? null });
  const { status, body, finalUrl } = fetched;

  // BEFORE the status and the body are judged: a page this box was never shown
  // cannot be read as a page that is wrong. See `protectionWall`.
  const wall = protectionWall(url, finalUrl);
  if (wall) return { ...refuse(url, wall, { status }), blocked: true };

  if (status < 200 || status >= 300) {
    return refuse(url, `The page answered ${status}, so the deployment is not serving what was asked for.`, { status });
  }
  if (!body.trim()) {
    return refuse(url, "The page answered with an empty body.", { status });
  }

  // The picture is taken whatever the expectations say, because it is the
  // EVIDENCE half: a verification that passed and a verification that failed
  // are both worth being able to look at afterwards. Of the address the fetch
  // SETTLED on — already walked hop by hop — rather than the one it started
  // from, so Chromium repeats one fewer redirect.
  const shot = await screenshotPage(input.runId, finalUrl);

  const expectations: VerificationExpectation[] = input.expect.map((text) => ({
    text,
    found: body.toLowerCase().includes(text.toLowerCase()),
  }));

  if (expectations.length > 0) {
    const missing = expectations.filter((e) => !e.found);
    return {
      ok: missing.length === 0,
      url,
      status,
      reason: missing.length === 0
        ? null
        : `The page is up but does not contain ${missing.map((e) => `"${e.text}"`).join(", ")}.`,
      judgedBy: "expectations",
      expectations,
      vision: null,
      screenshot: shot.file,
      checkedAt: Date.now(),
    };
  }

  // Nothing literal to look for: the picture is judged instead.
  if (!shot.base64) {
    return refuse(
      url,
      `The page is up, but this ClawBox could not check that it shows what was asked for: ${shot.error ?? "no screenshot could be taken"}. Name what to look for, and it can.`,
      { status, screenshot: shot.file },
    );
  }
  const described = await describeImage(shot.base64, judgementPrompt(input.task));
  const verdict = readVerdict(described.text);
  if (verdict === "unknown") {
    return refuse(
      url,
      `The page is up, but this ClawBox could not check that it shows what was asked for: ${described.error ?? "the vision model gave no verdict"}. Name what to look for, and it can.`,
      {
        status,
        screenshot: shot.file,
        vision: { verdict, description: described.text, error: described.error },
      },
    );
  }
  return {
    ok: verdict === "yes",
    url,
    status,
    reason: verdict === "yes" ? null : `The page is up, but it does not show what the task asked for: ${(described.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}`,
    judgedBy: "vision",
    expectations: [],
    vision: { verdict, description: described.text, error: described.error },
    screenshot: shot.file,
    checkedAt: Date.now(),
  };
}

/**
 * Vercel's own login page, in front of a deployment nobody may look at.
 *
 * Vercel's Deployment Protection — on by default for team accounts — puts every
 * DEPLOYMENT URL behind `vercel.com/login` while leaving the production domain
 * open. The verification follows the redirect and gets HTTP 200 with a complete
 * HTML page, and the vision model then correctly and uselessly reports a login
 * screen: the check is honest, the ROUTING is wrong. Read as "the work is
 * wrong" it spends the owner's improvement rounds asking a coding harness to
 * fix a setting in somebody's Vercel account.
 *
 * The signal is deliberately narrow, and narrow in TWO ways rather than one:
 * the address LEFT the deployment's own origin, AND it landed on the sign-in
 * page Vercel's protection actually sends people to (`vercel.com/login` or
 * `vercel.com/sso-api`). A deployment that redirects to its own custom domain,
 * or to anything else on vercel.com that is not that gate, is still fetched and
 * judged on its merits — `blocked` ends a pipeline, so it is the one verdict
 * that must not be reached by resemblance.
 */
const PROTECTION_HOSTS = new Set(["vercel.com", "www.vercel.com"]);
const PROTECTION_PATHS = ["/login", "/sso-api"];

export function protectionWall(requested: string, landedOn: string): string | null {
  let asked: URL;
  let landed: URL;
  try {
    asked = new URL(requested);
    landed = new URL(landedOn);
  } catch {
    return null;
  }
  if (landed.origin === asked.origin) return null;
  if (!PROTECTION_HOSTS.has(landed.hostname.toLowerCase())) return null;
  // The path, by SEGMENT: `/login` and `/login/sso` are the gate, `/logins-are-
  // fun` is a page like any other.
  const path = landed.pathname.replace(/\/+$/, "").toLowerCase() || "/";
  if (!PROTECTION_PATHS.some((gate) => path === gate || path.startsWith(`${gate}/`))) return null;
  return `That deployment is behind Vercel's Deployment Protection: ${asked.origin} redirected to Vercel's own sign-in page (${landed.origin}${landed.pathname}), so this ClawBox was never shown the deployed page. That is a setting on the Vercel project rather than anything in this work — turn protection off for preview deployments, or give this ClawBox a bypass — so the pipeline stopped here instead of sending the work back.`;
}

/** One line for the run's progress feed and the stage's evidence. */
export function verificationSummary(v: PipelineVerification): string {
  if (v.ok) {
    return v.judgedBy === "expectations"
      ? `${v.url} answered ${v.status} and contains ${v.expectations.length} of ${v.expectations.length} expected thing(s).`
      : `${v.url} answered ${v.status} and the screenshot shows what was asked for.`;
  }
  return v.reason ?? `${v.url} could not be verified.`;
}
