/**
 * Can ClawBox AI's one model look at a picture right now — and if not, what can?
 *
 * ClawBox AI is one model, `deepseek-v4-flash`, and on 2026-11-07 it read
 * pictures (TASK-2261). Upstream can take that away without the box being told,
 * so nothing declares Flash a vision model on faith: this check SHOWS it a
 * picture and reads the answer. The outcome decides every picture slot the box
 * owns — OpenClaw's Flash row and `agents.defaults.imageModel` (the boot script
 * runs the same check in Python, scripts/gateway-pre-start.sh), Hermes'
 * `auxiliary.vision`, and the describe route (src/lib/vision-describe.ts):
 *
 *   flash     Flash read the picture: Flash looks at pictures.
 *   fallback  Flash did not, the fallback (`gpt-5.6-luna`) did: pictures go
 *             there, and Flash is declared text-only so OpenClaw never hands
 *             it one.
 *   none      Neither did: no picture slot is armed, and the chat refuses an
 *             attached picture with a plain sentence instead of accepting one
 *             nobody can read.
 *   unknown   The QUESTION failed (network, 5xx, a refused credential, an
 *             empty answer twice): the box keeps what it has, so a bad network
 *             moment never re-plumbs it.
 *
 * The probe is one tiny solid-red PNG and "what colour is this square?" — a
 * model that sees answers "red"; one that does not either errors (400 for an
 * image part it cannot take) or answers without it. It is asked at box start
 * and on a ClawBox AI link, never per turn.
 */
import { get as configGet, set as configSet } from "@/lib/config-store";
import {
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_PROVIDER,
  CLAWBOX_AI_VISION_FALLBACK_MODEL_ID,
  clawboxAiProxyUrl,
} from "@/lib/clawbox-ai-models";
import { isRetiredClawboxAiModel } from "@/lib/clawbox-ai-retired-models";

export type ClawboxAiVisionVerdict = "flash" | "fallback" | "none" | "unknown";

/** What one model did with the probe picture. */
export type ClawboxAiVisionLook = "sees" | "blind" | "unknown";

export interface ClawboxAiVisionProbe {
  verdict: ClawboxAiVisionVerdict;
  /** The model the verdict names, or null for `none` / `unknown`. */
  model: string | null;
  flash: ClawboxAiVisionLook;
  fallback: ClawboxAiVisionLook | null;
  /** What each answer was, for the log: statuses and a few words, never the token. */
  why?: string[];
}

/** A 32x32 solid red PNG (99 bytes): the picture the check shows. */
export const CLAWBOX_AI_VISION_PROBE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mO4ICBAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAGFgwC4HDqGmAAAAAElFTkSuQmCC";
export const CLAWBOX_AI_VISION_PROBE_QUESTION = "What colour is this square? Answer with one word.";
/** An answer naming the colour: the model saw the picture. */
const SAW_RED = /\b(red|crimson|scarlet|maroon)\b/i;
/** ...unless it says it could not look ("I cannot see images", "not red"): naming the colour is then no sighting. */
const SAYS_CANNOT = /\b(not|no|cannot|unable|can[’']t|don[’']t|doesn[’']t)\b/i;
/**
 * Statuses that ARE an answer about the picture: the request was understood
 * and refused (an image part the model cannot take, a model the proxy does not
 * serve). 401/403/429/5xx are about the credential or the moment, not the
 * picture, and stay `unknown`.
 */
const REFUSED_STATUSES = new Set([400, 404, 415, 422]);
const PROBE_TIMEOUT_MS = 15_000;
/**
 * The completion budget. Flash REASONS before it answers even this — measured
 * 2026-11-07, 25-64 reasoning tokens on the probe, and a 64-token budget came
 * back empty one time in four — so the budget is room for the thought and the
 * word, not for the word alone.
 */
const PROBE_MAX_TOKENS = 1024;

/** Config-store key holding the last verdict, for the describe route and the logs. */
export const CLAWBOX_AI_VISION_STORE_KEY = "clawai_vision";
/**
 * LAB OVERRIDE, never written by the product: an http(s) base URL the check
 * asks INSTEAD of the box's ClawBox AI endpoint — a stub that refuses pictures
 * is how a lab board proves the fallback and the refusal without waiting for
 * upstream to change. Read by the boot script too.
 */
export const CLAWBOX_AI_VISION_PROBE_URL_KEY = "clawai_vision_probe_url";

/** Where the check asks: the lab override when one is set, else the box's own endpoint. */
export async function clawboxAiVisionProbeUrl(baseUrl?: string | null): Promise<string> {
  let override: unknown;
  try {
    override = await configGet(CLAWBOX_AI_VISION_PROBE_URL_KEY);
  } catch {
    override = undefined;
  }
  const chosen = typeof override === "string" && /^https?:\/\//i.test(override.trim())
    ? override.trim()
    : (baseUrl?.trim() || clawboxAiProxyUrl());
  return chosen.replace(/\/+$/, "");
}

/** One showing of the probe picture: what the model did, and why, for the log. */
async function askOnce(
  model: string,
  { token, baseUrl, fetchImpl }: { token: string; baseUrl: string; fetchImpl: typeof fetch },
): Promise<{ look: ClawboxAiVisionLook | "empty"; why: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model,
        max_tokens: PROBE_MAX_TOKENS,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: CLAWBOX_AI_VISION_PROBE_QUESTION },
            { type: "image_url", image_url: { url: `data:image/png;base64,${CLAWBOX_AI_VISION_PROBE_PNG}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return { look: "unknown", why: err instanceof Error && err.name === "TimeoutError" ? "timed out" : "request failed" };
  }
  if (REFUSED_STATUSES.has(res.status)) return { look: "blind", why: `HTTP ${res.status}` };
  if (!res.ok) return { look: "unknown", why: `HTTP ${res.status}` };
  let data: { choices?: { message?: { content?: unknown } }[] };
  try {
    data = await res.json();
  } catch {
    return { look: "unknown", why: "unreadable answer" };
  }
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) return { look: "empty", why: "empty answer" };
  // A model's own words about a red square, clipped: nothing else is logged.
  const said = JSON.stringify(text.trim().slice(0, 24));
  return SAW_RED.test(text) && !SAYS_CANNOT.test(text)
    ? { look: "sees", why: `said ${said}` }
    : { look: "blind", why: `said ${said}` };
}

async function looks(
  model: string,
  options: { token: string; baseUrl: string; fetchImpl: typeof fetch },
  why: string[],
): Promise<ClawboxAiVisionLook> {
  // Asked again past an EMPTY answer (a reasoning model can spend its budget
  // thinking and say nothing, which is not blindness) and past a "blind" one:
  // a single refusal can be the proxy's moment, and moving every picture on
  // the box is not something one answer should decide. Two blinds in a row
  // are an answer; a blind and an empty one are not.
  let blind = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await askOnce(model, options);
    why.push(`${model}: ${answer.why}`);
    if (answer.look === "sees") return "sees";
    if (answer.look === "unknown") return "unknown";
    if (answer.look === "blind") {
      if (blind) return "blind";
      blind = true;
    }
  }
  return "unknown";
}

/**
 * Show Flash the probe picture, and the fallback too when Flash positively
 * does not see. Never throws.
 */
export async function probeClawboxAiVision(
  { token, baseUrl, fetchImpl = fetch }: { token: string; baseUrl?: string | null; fetchImpl?: typeof fetch },
): Promise<ClawboxAiVisionProbe> {
  const url = await clawboxAiVisionProbeUrl(baseUrl);
  const why: string[] = [];
  const flash = await looks(CLAWBOX_AI_FLASH_MODEL_ID, { token, baseUrl: url, fetchImpl }, why);
  if (flash === "sees") return { verdict: "flash", model: CLAWBOX_AI_FLASH_MODEL_ID, flash, fallback: null, why };
  // A Flash that could not be ASKED is not a Flash that cannot see: only a
  // definite "blind" moves pictures to the fallback.
  if (flash === "unknown") return { verdict: "unknown", model: null, flash, fallback: null, why };
  const fallback = await looks(CLAWBOX_AI_VISION_FALLBACK_MODEL_ID, { token, baseUrl: url, fetchImpl }, why);
  if (fallback === "sees") {
    return { verdict: "fallback", model: CLAWBOX_AI_VISION_FALLBACK_MODEL_ID, flash, fallback, why };
  }
  if (fallback === "blind") return { verdict: "none", model: null, flash, fallback, why };
  return { verdict: "unknown", model: null, flash, fallback, why };
}

/**
 * Is `value` a picture slot ClawBox AI wrote — Flash, the fallback, or an id
 * it used to write there — under ClawBox AI's own provider (`deepseek/…` while
 * that provider is the proxy, `clawai/…`), or bare when asked for one (Hermes,
 * whose slot names its provider beside the model)? Anything else is the
 * owner's: `openai/gpt-5.6-luna` included.
 */
export function isClawboxAiVisionSlotOurs(
  value: unknown,
  options: { bare?: boolean; deepseekIsClawboxAi?: boolean } = {},
): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  if (isRetiredClawboxAiModel(value, options)) return true;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  let id = trimmed;
  if (slash !== -1) {
    const provider = trimmed.slice(0, slash).toLowerCase();
    const ours = provider === "clawai" || (provider === CLAWBOX_AI_PROVIDER && options.deepseekIsClawboxAi !== false);
    if (!ours) return false;
    id = trimmed.slice(slash + 1);
  } else if (!options.bare) {
    return false;
  }
  return id === CLAWBOX_AI_FLASH_MODEL_ID || id === CLAWBOX_AI_VISION_FALLBACK_MODEL_ID;
}

/** The bare id of a picture slot's value (`deepseek/x` → `x`). */
function bareId(value: string): string {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * The model a picture slot ClawBox owns should name after a check, or null for
 * "arm no picture slot".
 *
 * `current` is what the slot holds now (one of ours, or nothing). A definite
 * verdict decides outright. An `unknown` one keeps the box as it is: a current
 * Flash or fallback stays — unless Flash itself just refused the picture, in
 * which case the fallback is the better guess. An empty slot an earlier check
 * left empty (`keptNone`: no model could see) stays empty — a boot before the
 * network is up must not hand pictures back to a model that refused them —
 * and any other empty slot gets Flash, the model measured to see.
 */
export function clawboxAiVisionModelFor(
  probe: ClawboxAiVisionProbe,
  current?: string | null,
  { keptNone = false }: { keptNone?: boolean } = {},
): string | null {
  if (probe.verdict !== "unknown") return probe.model;
  if (probe.flash === "blind") return CLAWBOX_AI_VISION_FALLBACK_MODEL_ID;
  const kept = current && current.trim() ? bareId(current) : "";
  if (kept === CLAWBOX_AI_FLASH_MODEL_ID || kept === CLAWBOX_AI_VISION_FALLBACK_MODEL_ID) return kept;
  return keptNone ? null : CLAWBOX_AI_FLASH_MODEL_ID;
}

/**
 * Did the last recorded check leave the box with no picture model? Its record
 * says so by naming none — a "none" verdict, or an unknown one that kept it.
 */
export async function clawboxAiVisionWasNone(): Promise<boolean> {
  const last = await readClawboxAiVision();
  return last !== null && last.model === null;
}

export interface ClawboxAiVisionRecord {
  verdict: ClawboxAiVisionVerdict;
  model: string | null;
  checkedAt: number;
  /** What the answers were (statuses and a few words), for whoever reads the store. */
  why?: string[];
}

/** Remember the last check, for the describe route and for anyone reading the store. Best-effort. */
export async function recordClawboxAiVision(probe: ClawboxAiVisionProbe, model: string | null): Promise<void> {
  const record: ClawboxAiVisionRecord = { verdict: probe.verdict, model, checkedAt: Date.now(), why: probe.why ?? [] };
  try {
    await configSet(CLAWBOX_AI_VISION_STORE_KEY, record);
  } catch (err) {
    console.warn("[clawai-vision] could not record the vision check:", err instanceof Error ? err.message : err);
  }
}

/** The last recorded check, or null when there is none (or it is not one this build wrote). */
export async function readClawboxAiVision(): Promise<ClawboxAiVisionRecord | null> {
  let raw: unknown;
  try {
    raw = await configGet(CLAWBOX_AI_VISION_STORE_KEY);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { verdict, model, checkedAt } = raw as Record<string, unknown>;
  if (verdict !== "flash" && verdict !== "fallback" && verdict !== "none" && verdict !== "unknown") return null;
  if (model !== null && typeof model !== "string") return null;
  return { verdict, model: model as string | null, checkedAt: typeof checkedAt === "number" ? checkedAt : 0 };
}
