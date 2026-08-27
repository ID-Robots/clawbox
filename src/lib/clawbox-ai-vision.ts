/**
 * Which vision model may this box actually name?
 *
 * The preferred id is DeepSeek's multimodal model
 * (`CLAWBOX_AI_VISION_MODEL_ID`, default deepseek-v4-flash-vision-exp), but
 * the ClawBox AI proxy allowlists BARE model ids and answers
 * 400 `model_not_allowed` for anything it does not serve yet — and a config
 * that names a model the proxy refuses turns every attached picture into an
 * HTTP 400. So nothing writes the preferred id on faith: this probe asks the
 * proxy first and falls back to the vision model boxes already run
 * (`CLAWBOX_AI_LEGACY_VISION_MODEL_ID`) until the new one is served. Boots
 * and re-links re-resolve, so a box upgrades itself the first time the proxy
 * says yes — and heals back the same way if the id ever stops being served.
 *
 * The probe is one text-only completion capped at a single token — the
 * cheapest question the OpenAI surface can be asked. `model_not_allowed` is
 * the only answer that means "not served": auth failures, timeouts and 5xx
 * mean the QUESTION failed, and on an unanswered question the resolver stays
 * conservative (legacy, unverified) rather than flip-flopping the config on
 * a bad network moment.
 *
 * An env override (`CLAWBOX_AI_VISION_MODEL_ID`) skips the probe entirely:
 * the operator's word is final, exactly as it is for the chat and image slugs.
 */
import {
  CLAWBOX_AI_LEGACY_VISION_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL_ID,
} from "@/lib/clawbox-ai-models";

const DEFAULT_PROXY_URL = "https://clawbox.com/api/ai";
const PROBE_TIMEOUT_MS = 6_000;

export interface ResolvedVisionModel {
  id: string;
  /** True when the proxy itself answered the question this run. */
  verified: boolean;
  reason: "env-override" | "proxy-allows" | "proxy-refuses" | "probe-failed";
}

function proxyUrl(): string {
  return (process.env.CLAWBOX_AI_PROXY_URL?.trim() || DEFAULT_PROXY_URL).replace(/\/+$/, "");
}

/** Resolve the vision model id this box may write into harness config. */
export async function resolveVisionModelId(
  { token, fetchImpl = fetch }: { token: string; fetchImpl?: typeof fetch },
): Promise<ResolvedVisionModel> {
  const preferred = CLAWBOX_AI_VISION_MODEL_ID;
  if (process.env.CLAWBOX_AI_VISION_MODEL_ID?.trim()) {
    return { id: preferred, verified: false, reason: "env-override" };
  }
  try {
    const res = await fetchImpl(`${proxyUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: preferred,
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { id: preferred, verified: true, reason: "proxy-allows" };
    const body = await res.text();
    if (res.status === 400 && /model[_ ]not[_ ]allowed|model not allowed/i.test(body)) {
      return { id: CLAWBOX_AI_LEGACY_VISION_MODEL_ID, verified: true, reason: "proxy-refuses" };
    }
    return { id: CLAWBOX_AI_LEGACY_VISION_MODEL_ID, verified: false, reason: "probe-failed" };
  } catch {
    return { id: CLAWBOX_AI_LEGACY_VISION_MODEL_ID, verified: false, reason: "probe-failed" };
  }
}

/** Is `ref`/`id` one of OUR vision ids — ours to move — rather than an owner's choice? */
export function isClawboxAiVisionId(value: string): boolean {
  const bare = value.replace(/^[a-z0-9-]+\//i, "").trim();
  return bare === CLAWBOX_AI_VISION_MODEL_ID || bare === CLAWBOX_AI_LEGACY_VISION_MODEL_ID;
}
