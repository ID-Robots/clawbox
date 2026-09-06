import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";
import { get } from "@/lib/config-store";
import { readConfig } from "@/lib/openclaw-config";
// The persisted half of the refusal below. Its own module, and a deliberately
// thin one: `/setup-api/ai-models/status` writes the same fact from the portal
// poll, and importing THIS file there would drag the whole Hermes adapter graph
// into a badge route.
import {
  clearPersistedClawaiCredentialRefusal,
  persistClawaiCredentialRefusal,
} from "@/lib/clawai-credential-refusal";
// The other mark about a credential this box holds — the PLAN the portal
// reported for it. Retired by the same funnel below, for the same reason.
import { clearClawaiPlanTier } from "@/lib/clawai-plan-tier";

export {
  CLAWAI_CREDENTIAL_REFUSED_KEY,
  clearPersistedClawaiCredentialRefusal,
  persistClawaiCredentialRefusal,
} from "@/lib/clawai-credential-refusal";

/**
 * The one place that knows where each edition keeps the device's ClawBox AI
 * credential. SERVER ONLY — nothing here may be imported by a client component.
 *
 * It exists because the same credential has two homes and every route that
 * looked in only one of them was dark on the other edition. Voice input is the
 * worked example: `/setup-api/chat/transcribe` read `openclaw.json`
 * unconditionally, so on a Hermes box — which stores the SAME token somewhere
 * else — the route could only ever answer "not configured", and the microphone
 * was hidden to cover for it. Nothing about transcription is OpenClaw-specific;
 * the lookup was.
 */

export { CLAWBOX_AI_PROXY_URL } from "@/lib/hermes-clawai";

/** The config-store key the Hermes flow writes the device token under. */
const HERMES_TOKEN_KEY = "clawai_token";

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The device's ClawBox AI token, wherever this edition keeps it, or null.
 *
 * Read per request rather than cached, for the reason the transcribe route
 * already documented before this moved: the gateway rewrites `openclaw.json`
 * on restart and the portal can re-mint a token at any time, so a value
 * captured at module load goes stale exactly when someone re-links the device
 * and least expects to have to reboot it.
 *
 * OpenClaw's store is consulted first because it is the historical home and is
 * present on a dual box; the Hermes store is the fallback. On a box that has
 * both, the two hold the same credential — they are written by the same portal
 * hand-off — so the order only decides which read answers first, never which
 * token is used.
 *
 * Never logged, never echoed, never returned to a browser. Callers that only
 * need to know whether one EXISTS should send a boolean (see
 * `/setup-api/chat/capabilities`), not the value.
 */
export async function resolveClawaiToken(): Promise<string | null> {
  try {
    const config = await readConfig();
    const key = trimmedString(config.models?.providers?.[CLAWBOX_AI_PROVIDER]?.apiKey);
    if (key) return key;
  } catch {
    // A Hermes SKU has no OpenClaw config to read. That is not a failure here,
    // it is the whole reason this function has a second place to look.
  }
  try {
    return trimmedString(await get(HERMES_TOKEN_KEY));
  } catch {
    return null;
  }
}

/** Whether this box holds a ClawBox AI credential at all. */
export async function hasClawaiToken(): Promise<boolean> {
  return (await resolveClawaiToken()) !== null;
}

/* ---------------------------------------------------------------------------
 * A credential the proxy has already refused
 * ------------------------------------------------------------------------ */

/**
 * How long a refusal of this box's ClawBox AI credential is believed.
 *
 * A 401/403 from our own proxy, identified as such by the proxy (see
 * `noteClawaiCredentialRefused`), means the credential is not accepted, and
 * nothing the box can do makes the next identical request succeed. The honest
 * expiry is therefore "until the credential changes" — which is not a timer at
 * all, and is why every ClawBox writer of that credential clears this on the
 * way past (`forgetClawaiCredentialRefusal`), exactly as they already clear
 * `provider_verified_at`.
 *
 * The timer is the backstop for the one case the box cannot observe: a token
 * the PORTAL restores (a mis-revocation put back, a plan reinstated) with
 * nothing on the device changing. Fifteen minutes is short enough that such a
 * box heals on its own and long enough that being wrong costs four requests an
 * hour instead of two thousand.
 */
const CREDENTIAL_REFUSAL_TTL_MS = 15 * 60_000;

/**
 * When the proxy's refusal of this box's ClawBox AI credential expires, and
 * what it refused with.
 *
 * One slot, because a box holds ONE ClawBox AI credential: it is minted per
 * device by the portal and written to both stores by the same hand-off. What
 * makes "re-link the device" — the instruction the failure prints — take effect
 * at once is not a per-credential key but `forgetClawaiCredentialRefusal`,
 * called by every path that writes the credential.
 *
 * Nothing derived from the token is kept here. An earlier draft stored a
 * SHA-256 of it as a comparison key; CodeQL reads a credential reaching a bare
 * digest as a password hashed without a KDF, and it is right to — the fix is
 * not a stronger hash on the render path of a polled route, it is not deriving
 * anything from the secret in the first place.
 */
let refusal: { status: number; until: number } | null = null;

/**
 * How many times this box's ClawBox AI credential has been rewritten.
 *
 * A plain counter, and deliberately nothing derived from the secret. It exists
 * because a request made with the OLD credential can still be in flight when
 * the new one is written: without this, that request's 403 lands after the
 * rewrite and arms a refusal against a credential that was never refused,
 * muting the microphone and the picture button on a device the customer has
 * just successfully re-linked. Callers snapshot it before the request and hand
 * it back with the verdict; a verdict from a superseded generation is dropped.
 */
let credentialGeneration = 0;

/** The generation to snapshot before a request whose refusal may be recorded. */
export function clawaiCredentialGeneration(): number {
  return credentialGeneration;
}

/**
 * Has the ClawBox AI proxy refused this box's credential? Returns the status it
 * refused with, so the caller words the failure exactly as it would have worded
 * the real one.
 */
export function clawaiCredentialRefused(): number | null {
  if (!refusal) return null;
  if (Date.now() >= refusal.until) {
    refusal = null;
    return null;
  }
  return refusal.status;
}

/**
 * Note that the proxy refused this box's credential, so the next caller does
 * not spend a request — or an upload — finding out again.
 *
 * ONLY the caller may decide this: a bare 401/403 on the wire can come from an
 * edge rule, an interception proxy or a plan gate, and treating one of those as
 * "your device is unlinked" would hide a working feature and send a customer to
 * re-pair a healthy box. Callers arm this from the proxy's OWN identification
 * of the credential as the problem (`error.code` = `missing_token` /
 * `invalid_token`), never from the status alone.
 *
 * NOT 429: a spent daily allowance is refused for the same reason every time
 * too, but it belongs to a plan rather than to a credential and it resets on a
 * clock this module cannot see.
 */
export async function noteClawaiCredentialRefused(status: number, generation: number): Promise<void> {
  // The credential was rewritten while this request was in flight, so what came
  // back is a verdict on a token this box no longer holds.
  if (generation !== credentialGeneration) return;
  // Written down before the memo is armed, so "was this already remembered"
  // below still means "did an earlier request record it".
  const alreadyRemembered = clawaiCredentialRefused() !== null;
  refusal = { status, until: Date.now() + CREDENTIAL_REFUSAL_TTL_MS };
  // One store write per refusal WINDOW, not per refused request: the second
  // caller through here inside the window has nothing new to say, and this runs
  // on the picture and microphone paths.
  if (!alreadyRemembered) await persistClawaiCredentialRefusal();
}

/**
 * The credential changed — forget that it was refused, so the very next call
 * asks again.
 *
 * The same shape, and the same call sites, as `forgetProviderVerified`: a mark
 * about a credential is dropped by whoever rewrites that credential. Edition-
 * agnostic, so a writer can call it without caring whether this box is OpenClaw
 * or Hermes. It AWAITS now — the persisted half below has to land before the
 * caller restarts the gateway, or the boot that follows a re-link reads a
 * refusal about the credential that was just replaced.
 */
export async function forgetClawaiCredentialRefusal(): Promise<void> {
  credentialGeneration += 1;
  refusal = null;
  // The persisted half goes with it, in the SAME funnel rather than beside each
  // of the three callers: a writer that remembered one and forgot the other
  // would leave a freshly re-linked box standing its image path down at the
  // very restart the re-link triggers.
  await clearPersistedClawaiCredentialRefusal();
  // And so does the recorded PLAN, which is a fact about the ACCOUNT behind the
  // credential that has just been replaced. Left standing, the previous
  // account's Max plan would keep the cloud voice armed on a box re-linked to a
  // lower one — a refused round trip per spoken reply, with the panel calling
  // the voice configured while it happens. Clearing it puts both boot scripts
  // back on the device stamp until the next status poll answers for the
  // credential this box now holds.
  await clearClawaiPlanTier();
}

/** Test seam: forget every remembered refusal. */
export function resetClawaiCredentialRefusals(): void {
  refusal = null;
  credentialGeneration = 0;
}

/**
 * The most a refusal body may be read before it is parsed.
 *
 * Enough for the service's own error envelope and nothing like enough for an
 * interception page. `res.json()` and `res.text()` both buffer whatever the far
 * side sends before anything can object to its size, and a 401/403 is exactly
 * the response an edge appliance answers with a full HTML page — on a device
 * where memory is the scarce thing.
 */
const MAX_REFUSAL_BODY_BYTES = 8 * 1024;

/**
 * Did the ClawBox AI proxy identify THIS DEVICE'S CREDENTIAL as the reason it
 * refused?
 *
 * The proxy answers `401 {code:"missing_token"}` / `403 {code:"invalid_token"}`
 * for a credential and other codes for everything else, and those two are the
 * only answers that mean "asking again with this token is pointless". A bare
 * 401/403 on the wire can come from an edge rule, a rate-limit page, an
 * interception proxy or a plan gate.
 *
 * Reading `error.code` is not a breach of the never-relay-the-body rule the
 * callers follow: that rule is about what reaches the CUSTOMER, and nothing
 * read here is ever shown. Bounded, and it FAILS CLOSED — an unreadable,
 * oversized, bodiless or unrecognised refusal is treated as not-the-credential,
 * which costs a retry rather than a feature.
 *
 * One copy, shared by every ClawBox caller of the proxy, so the accepted
 * contract cannot drift between the picture path and the voice path.
 */
export async function proxyRefusedClawaiCredential(res: Response): Promise<boolean> {
  if (res.status !== 401 && res.status !== 403) return false;
  const body = res.body;
  if (!body) return false;
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        // Past the cap this is not the envelope we are looking for, and
        // draining the rest of it buys nothing.
        if (total > MAX_REFUSAL_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return false;
        }
        chunks.push(Buffer.from(value));
      }
      if (done) break;
    }
  } catch {
    return false;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return false;
  }
  const error = (payload as { error?: unknown } | null)?.error;
  const code = (error as { code?: unknown } | null)?.code;
  return code === "invalid_token" || code === "missing_token";
}
