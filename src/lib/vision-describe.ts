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

const DESCRIBE_TIMEOUT_MS = 30_000;
// The completion budget must cover hidden REASONING as well as the answer:
// gpt-5.6-luna is a reasoning model, and on a busy screenshot (a game board)
// it spent an entire 500-token budget thinking and emitted zero content —
// finish_reason "length", reasoning_tokens 500, content "" (measured on
// run-0nxtbhb1, 2026-08-27). max_tokens is a ceiling, not a spend, so the
// budget is simply set high enough for thought AND answer on the busiest
// screens — a retry-with-more would re-upload and re-infer the whole image
// (the expensive part) exactly on the screens that need the room.
const MAX_DESCRIPTION_TOKENS = 6_000;

/** Re-ask the proxy which vision model this box may use at most this often. */
const RESOLVE_TTL_MS = 10 * 60_000;
let cachedModel: { id: string; at: number } | null = null;

const DEFAULT_PROMPT =
  "Describe this screenshot of a web page for a developer who cannot see it. "
  + "Cover the overall layout, all visible text (verbatim when short), the colors actually used, "
  + "any graphical or animated elements, and anything that looks wrong: blank areas, error messages, "
  + "missing images, overlapping or clipped elements. Be concrete and brief.";

export interface VisionDescription {
  text: string | null;
  error: string | null;
}

async function visionModelId(token: string): Promise<string> {
  if (cachedModel && Date.now() - cachedModel.at < RESOLVE_TTL_MS) return cachedModel.id;
  const resolved = await resolveVisionModelId({ token });
  cachedModel = { id: resolved.id, at: Date.now() };
  return resolved.id;
}

/** Describe a PNG through the box's vision model. */
export async function describeImage(pngBase64: string, prompt: string = DEFAULT_PROMPT): Promise<VisionDescription> {
  const token = await configGet("clawai_token");
  if (typeof token !== "string" || !token.trim()) {
    return { text: null, error: "ClawBox AI is not connected on this device" };
  }
  let model: string;
  try {
    model = await visionModelId(token.trim());
  } catch {
    return { text: null, error: "could not resolve a vision model" };
  }
  try {
    const res = await fetch(`${clawboxAiProxyUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token.trim()}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_DESCRIPTION_TOKENS,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { text: null, error: `the vision model answered ${res.status}` };
    }
    const data = await res.json() as { choices?: { message?: { content?: unknown } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      return { text: null, error: "the vision model answered without a description" };
    }
    return { text: text.trim(), error: null };
  } catch (err) {
    return { text: null, error: err instanceof Error && err.name === "TimeoutError" ? "the vision request timed out" : "the vision request failed" };
  }
}
