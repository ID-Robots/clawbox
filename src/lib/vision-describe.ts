/**
 * Text eyes for agents that cannot see.
 *
 * The coding-agent runs execute on DeepSeek models whose vision the ClawBox AI
 * proxy does not serve yet — an image block in a tool result reaches them as
 * "[Unsupported Image]" (measured on this box, 2026-08-27). The box DOES have
 * a working vision model: whatever resolveVisionModelId() answers (today the
 * legacy gpt-5.6-luna, DeepSeek's own the day the proxy allows it). So instead
 * of handing an agent pixels it cannot read, the browser route hands it this
 * module's written description of the pixels.
 *
 * Failure is an answer, never an exception: an offline box or an unlinked
 * account returns { text: null, error } and the caller degrades to titles.
 */
import { get as configGet } from "@/lib/config-store";
import { clawboxAiProxyUrl, resolveVisionModelId } from "@/lib/clawbox-ai-vision";

/**
 * The whole call's wall-clock budget, retry included. 60 s, not 30: the
 * flash-vision round trip was measured at 3.1-30.5 s on this box
 * (run-d8816d78, 2026-08-29) - the old 30 s ceiling sat BELOW the observed
 * maximum, so the slowest answers were thrown away after being paid for.
 *
 * Exported because the callers that wait on this — the MCP describe_image
 * tool, the browser tools' described captures — must size their own timeouts
 * ABOVE it: a client that gives up first pays for an answer it discards and
 * then asks the same question again.
 */
export const DESCRIBE_TIMEOUT_MS = 60_000;
// The completion budget must cover hidden REASONING as well as the answer:
// gpt-5.6-luna is a reasoning model, and on a busy screenshot (a game board)
// it spent an entire 500-token budget thinking and emitted zero content —
// finish_reason "length", reasoning_tokens 500, content "" (measured on
// run-0nxtbhb1, 2026-08-27). max_tokens is a ceiling, not a spend, so the
// budget is simply set high enough for thought AND answer on the busiest
// screens — a retry-with-more would re-upload and re-infer the whole image
// (the expensive part) exactly on the screens that need the room.
const MAX_DESCRIPTION_TOKENS = 6_000;

/**
 * One retry, and only on a TRANSIENT failure. The vision proxy's round trip
 * flaps (seen live: two failures inside a minute while the same call answered
 * in 4.6 s just after), and one short retry converts most flaps into an
 * answer. It lives here rather than in the MCP tool so the browser route's
 * described captures get it too, and so that what is NOT retried is decided
 * once: a timeout (the budget is spent), and every deterministic answer — an
 * unlinked account, a 400 for a model the proxy does not serve, an empty
 * description — which a second identical question would only repeat.
 */
export const RETRY_DELAY_MS = 2_500;
/** No retry with less than this of the budget left: a question that cannot finish is only a second bill. */
export const MIN_RETRY_MS = 10_000;
// The proxy's known flap bodies, on any status: the same shapes
// coding-agent.ts's isTransientFailure() restarts a run for — an auth or
// entitlement hiccup upstream that the next identical request sails through
// (run-ssodhkys died to unrecognized_model minutes after run-5vt51ppv built
// on the same model string).
const PROXY_FLAP_RE = /failed to authenticate|attention required|cloudflare|unrecognized_model/i;

/** Re-ask the proxy which vision model this box may use at most this often. */
const RESOLVE_TTL_MS = 10 * 60_000;
let cachedModel: { id: string; at: number } | null = null;

const DEFAULT_PROMPT =
  "Describe this screenshot of a web page for a developer who cannot see it. "
  + "Cover the overall layout, all visible text (verbatim when short), the colors actually used, "
  + "any graphical or animated elements, and anything that looks wrong: blank areas, error messages, "
  + "missing images, overlapping or clipped elements. Be concrete and brief.";

/**
 * The image types the vision proxy accepts. The describe route derives its
 * extension map from this and the artifacts store's inline-image table, so
 * "can be described" and "is served as an image" cannot drift apart.
 */
export const VISION_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type VisionImageMime = (typeof VISION_IMAGE_MIMES)[number];

export function isVisionImageMime(mime: string): mime is VisionImageMime {
  return (VISION_IMAGE_MIMES as readonly string[]).includes(mime);
}

export interface VisionDescription {
  text: string | null;
  error: string | null;
}

/** One attempt's answer, plus whether asking again could change it. */
interface Attempt extends VisionDescription {
  transient: boolean;
}

async function visionModelId(token: string): Promise<string> {
  if (cachedModel && Date.now() - cachedModel.at < RESOLVE_TTL_MS) return cachedModel.id;
  const resolved = await resolveVisionModelId({ token });
  cachedModel = { id: resolved.id, at: Date.now() };
  return resolved.id;
}

async function ask(
  token: string,
  model: string,
  prompt: string,
  imageBase64: string,
  mime: VisionImageMime,
  timeoutMs: number,
): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetch(`${clawboxAiProxyUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_DESCRIPTION_TOKENS,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mime};base64,${imageBase64}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { text: null, error: "the vision request timed out", transient: false };
    }
    return { text: null, error: "the vision request failed", transient: true };
  }
  if (!res.ok) {
    // 5xx and 429 are the proxy's moment, not this image's; any other status
    // is final unless the body is one of the known flaps.
    const body = await res.text().catch(() => "");
    const transient = res.status >= 500 || res.status === 429 || PROXY_FLAP_RE.test(body);
    return { text: null, error: `the vision model answered ${res.status}`, transient };
  }
  let data: { choices?: { message?: { content?: unknown } }[] };
  try {
    data = await res.json();
  } catch {
    // A 200 whose body did not arrive whole is a transport failure, not an answer.
    return { text: null, error: "the vision request failed", transient: true };
  }
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    return { text: null, error: "the vision model answered without a description", transient: false };
  }
  return { text: text.trim(), error: null, transient: false };
}

/** Describe a PNG through the box's vision model. */
export async function describeImage(imageBase64: string, prompt: string = DEFAULT_PROMPT, mime: VisionImageMime = "image/png"): Promise<VisionDescription> {
  const token = await configGet("clawai_token");
  if (typeof token !== "string" || !token.trim()) {
    return { text: null, error: "ClawBox AI is not connected on this device" };
  }
  const deadline = Date.now() + DESCRIBE_TIMEOUT_MS;
  let model: string;
  try {
    model = await visionModelId(token.trim());
  } catch {
    return { text: null, error: "could not resolve a vision model" };
  }
  const first = await ask(token.trim(), model, prompt, imageBase64, mime, DESCRIBE_TIMEOUT_MS);
  if (!first.transient || deadline - Date.now() - RETRY_DELAY_MS < MIN_RETRY_MS) {
    return { text: first.text, error: first.error };
  }
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  // The retry lives inside the SAME budget, so a caller sized against
  // DESCRIBE_TIMEOUT_MS never sees the two attempts as one long hang.
  const second = await ask(token.trim(), model, prompt, imageBase64, mime, deadline - Date.now());
  return { text: second.text, error: second.error };
}
