// ── Mascot phrase generator (server-side) ──
//
// Replaces the hardcoded mascot phrase arrays with phrases the local LLM
// generates in the user's selected language. Refreshes incrementally
// across the week so phrases evolve based on what the user works on and
// shares with the assistant.
//
// Generation backend: Ollama (local-first, free, offline). If no Ollama
// model is available the cache stays empty and the Mascot falls back to
// the inspiration phrases in `mascot-phrases.ts`.

import fs from "fs/promises";
import { kvGet, kvSet } from "./kv-store";
import * as config from "./config-store";
import { getOllamaBaseUrl } from "./local-ai-runtime";
import {
  ensureFullPhraseSet,
  INSPIRATION_PHRASES,
  LANG_NAMES,
  PHRASE_CATEGORIES,
  type MascotPhraseSet,
} from "./mascot-phrases";

const KV_PHRASE_KEY = "clawbox-mascot-phrase-set";
const KV_CONVO_LINES_KEY = "clawbox-mascot-convo-lines";

const FULL_REGEN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const DAILY_TOPUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const GENERATION_TIMEOUT_MS = 60_000;
const MAX_PHRASES_PER_CATEGORY = 24; // cap so the bag doesn't grow forever
const TARGET_NEW_PER_CATEGORY = 8; // model is asked to produce ~8 fresh entries per category

const OPENCLAW_WORKSPACE_DIR = "/home/clawbox/.openclaw/workspace";

/**
 * Select a small Ollama model for fast generation. Prefers commonly-available
 * tiny instruct models; falls back to whatever's pulled.
 */
const PREFERRED_MODELS = [
  "llama3.2:3b",
  "llama3.2:1b",
  "qwen2.5:3b",
  "qwen2.5:1.5b",
  "gemma3:1b",
  "gemma2:2b",
  "phi3.5:3.8b",
];

interface PhraseCacheEnvelope {
  phrases: MascotPhraseSet;
  language: string;
  lastFullRegen: number;
  lastTopUp: number;
}

/**
 * In-flight generation guard so concurrent GETs don't kick off multiple
 * regenerations of the same payload.
 */
let inFlightGeneration: Promise<void> | null = null;

// ── Cache I/O ──────────────────────────────────────────────────────────

function readCache(): PhraseCacheEnvelope | null {
  const raw = kvGet(KV_PHRASE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PhraseCacheEnvelope;
    if (!parsed.phrases || typeof parsed.lastFullRegen !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(envelope: PhraseCacheEnvelope): void {
  kvSet(KV_PHRASE_KEY, JSON.stringify(envelope));
}

// ── Ollama call ────────────────────────────────────────────────────────

async function pickOllamaModel(): Promise<string | null> {
  try {
    const res = await fetch(`${getOllamaBaseUrl()}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { models?: { name: string }[] };
    const installed = (data.models ?? []).map(m => m.name);
    if (installed.length === 0) return null;
    for (const preferred of PREFERRED_MODELS) {
      if (installed.includes(preferred)) return preferred;
    }
    // No preferred match — return the first installed model.
    return installed[0];
  } catch {
    return null;
  }
}

interface GenerationContext {
  language: string;
  languageName: string;
  userName: string | null;
  workspaceMemory: string;
  recentSnippets: string[];
}

async function gatherContext(): Promise<GenerationContext> {
  const language = (await config.get("pref:ui_language") as string | null) ?? "en";
  const languageName = LANG_NAMES[language] ?? "English";
  const userNameRaw = (await config.get("pref:ui_user_name") as string | null) ?? null;
  const userName = userNameRaw && userNameRaw.trim().length > 0 ? userNameRaw.trim() : null;

  // OpenClaw workspace memory — concatenate USER.md + SOUL.md + MEMORY.md
  // if present, capped to keep prompts small.
  const memoryParts: string[] = [];
  for (const file of ["USER.md", "SOUL.md", "MEMORY.md"]) {
    try {
      const content = await fs.readFile(`${OPENCLAW_WORKSPACE_DIR}/${file}`, "utf-8");
      memoryParts.push(`### ${file}\n${content.trim()}`);
    } catch { /* file may not exist yet */ }
  }
  const workspaceMemory = memoryParts.join("\n\n").slice(0, 2000);

  // Recent chat snippets the user has shared (from ChatPopup auto-capture)
  const snippetsRaw = kvGet(KV_CONVO_LINES_KEY);
  let recentSnippets: string[] = [];
  if (snippetsRaw) {
    try {
      const parsed = JSON.parse(snippetsRaw) as { lines?: string[] };
      recentSnippets = (parsed.lines ?? []).slice(-12);
    } catch { /* ignore */ }
  }

  return { language, languageName, userName, workspaceMemory, recentSnippets };
}

function buildPrompt(ctx: GenerationContext, mode: "full" | "topup"): string {
  const inspirationLines = (Object.entries(INSPIRATION_PHRASES) as [keyof MascotPhraseSet, string[]][])
    .map(([cat, list]) => `${cat}: ${list.slice(0, 6).map(s => `"${s}"`).join(", ")}`)
    .join("\n");

  const memBlock = ctx.workspaceMemory
    ? `\nWHAT THE DEVICE KNOWS ABOUT THE USER (OpenClaw workspace memory):\n${ctx.workspaceMemory}\n`
    : "";

  const snippetsBlock = ctx.recentSnippets.length > 0
    ? `\nRECENT THINGS THE USER HAS DISCUSSED WITH THE ASSISTANT (use as flavor — do NOT quote verbatim):\n- ${ctx.recentSnippets.join("\n- ")}\n`
    : "";

  const intent = mode === "topup"
    ? `Generate a FRESH BATCH of new phrases. The cache already has older phrases — produce different ones, varying mood and topic. Tie a few of them subtly to what the user has been working on (without quoting verbatim).`
    : `Generate a complete starter set of phrases for every category.`;

  return `You are writing speech-bubble lines for a sarcastic crab mascot living on a private home AI device called ClawBox. The crab's vibe is "lazy, sarcastic, scandalous" — affectionate, terse, slightly chaotic.

${intent}

OUTPUT LANGUAGE: ${ctx.languageName} (${ctx.language}). Write phrases in ${ctx.languageName}. Emoji are fine and encouraged. Keep technical/programming terms in English (e.g. "deploy", "bug", "404").

CONSTRAINTS:
- Each phrase must be SHORT — under 60 characters, fits in a small speech bubble.
- No URLs, no markdown, no triple backticks.
- For "nameGreetings": every entry MUST contain the literal token {name} (curly braces included). The crab will substitute the user's name at render time.
- For "nameFallbacks": single-word friendly placeholder names ONLY (e.g. "boss", "captain"). These are used when the user hasn't set their name.
- Per category, produce ${mode === "topup" ? `${TARGET_NEW_PER_CATEGORY}-${TARGET_NEW_PER_CATEGORY + 4}` : `8-12`} unique entries.
- Do NOT copy the inspiration phrases verbatim — use them as TONAL REFERENCE only.

INSPIRATION (style/tone reference, English originals — translate the *vibe*, not the words):
${inspirationLines}
${memBlock}${snippetsBlock}
Output ONLY a single JSON object, no prose, in this exact shape:
{
  "sass": [...],
  "idle": [...],
  "sleep": [...],
  "jump": [...],
  "dance": [...],
  "facepalm": [...],
  "nameGreetings": [...],
  "nameFallbacks": [...]
}`;
}

async function callOllama(model: string, prompt: string): Promise<MascotPhraseSet | null> {
  try {
    const res = await fetch(`${getOllamaBaseUrl()}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.9,
          top_p: 0.95,
          num_predict: 1500,
        },
      }),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[mascot-phrases] Ollama generate failed: ${res.status}`);
      return null;
    }
    const data = await res.json() as { response?: string };
    if (!data.response) return null;
    let parsed: Partial<MascotPhraseSet>;
    try {
      parsed = JSON.parse(data.response) as Partial<MascotPhraseSet>;
    } catch (parseErr) {
      // Distinguish a malformed model output from a network/transport
      // failure — the former isn't a real error from our side, just the
      // small local LLM occasionally producing non-JSON despite
      // `format: "json"`. Logging both the raw response and the parse
      // error makes triage straightforward.
      console.error(
        "[mascot-phrases] Ollama response JSON parse failed:",
        parseErr instanceof Error ? parseErr.message : parseErr,
        "raw:", data.response.slice(0, 500),
      );
      return null;
    }
    return ensureFullPhraseSet(parsed);
  } catch (err) {
    console.error("[mascot-phrases] Ollama call failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────

function isStale(envelope: PhraseCacheEnvelope | null, language: string): { stale: boolean; mode: "full" | "topup" } {
  if (!envelope) return { stale: true, mode: "full" };
  if (envelope.language !== language) return { stale: true, mode: "full" };
  const now = Date.now();
  if (now - envelope.lastFullRegen >= FULL_REGEN_INTERVAL_MS) return { stale: true, mode: "full" };
  if (now - envelope.lastTopUp >= DAILY_TOPUP_INTERVAL_MS) return { stale: true, mode: "topup" };
  return { stale: false, mode: "topup" };
}

/**
 * Merge a freshly-generated batch into the existing cache. For "full" mode
 * the new batch replaces the cache. For "topup" mode the new batch is
 * appended (newest first), capped at MAX_PHRASES_PER_CATEGORY per category.
 */
function mergeBatch(existing: MascotPhraseSet, fresh: MascotPhraseSet, mode: "full" | "topup"): MascotPhraseSet {
  if (mode === "full") return fresh;
  const merged: MascotPhraseSet = { ...existing };
  for (const cat of PHRASE_CATEGORIES) {
    const seen = new Set<string>();
    const combined: string[] = [];
    // Newest first — fresh wins on duplicates
    for (const s of [...fresh[cat], ...existing[cat]]) {
      if (!seen.has(s)) { seen.add(s); combined.push(s); }
      if (combined.length >= MAX_PHRASES_PER_CATEGORY) break;
    }
    merged[cat] = combined;
  }
  return merged;
}

/**
 * Trigger a generation if the cache is stale. No-ops if a generation is
 * already in flight. Does not throw — failures are logged and the cache
 * is left untouched.
 */
export function maybeRegenerateInBackground(): Promise<void> {
  if (inFlightGeneration) return inFlightGeneration;
  inFlightGeneration = (async () => {
    try {
      const ctx = await gatherContext();
      const cached = readCache();
      const { stale, mode } = isStale(cached, ctx.language);
      if (!stale) return;

      const model = await pickOllamaModel();
      if (!model) return; // no local model available — keep falling back to inspiration

      const prompt = buildPrompt(ctx, mode);
      const fresh = await callOllama(model, prompt);
      if (!fresh) return;

      const now = Date.now();
      const existingPhrases = cached?.phrases ?? INSPIRATION_PHRASES;
      const merged = mergeBatch(existingPhrases, fresh, mode);

      writeCache({
        phrases: merged,
        language: ctx.language,
        lastFullRegen: mode === "full" ? now : (cached?.lastFullRegen ?? now),
        lastTopUp: now,
      });
    } catch (err) {
      // Background regen is best-effort; any failure here (gatherContext,
      // pickOllamaModel network blip, writeCache disk error, …) must NOT
      // reject the returned promise — callers fire-and-forget it and the
      // cache simply stays as-is until the next tick.
      console.error("[mascot-phrases-server] maybeRegenerateInBackground failed:", err);
    } finally {
      inFlightGeneration = null;
    }
  })();
  return inFlightGeneration;
}

/**
 * Force a full regen regardless of cache state. Returns the new phrase set,
 * or null if generation failed (caller should fall back to inspiration).
 *
 * Concurrent callers share a single in-flight generation — duplicate clicks
 * from the Settings UI must not spawn parallel Ollama runs (the model on a
 * Jetson is single-tenant and the second call would just queue + waste tokens).
 */
let inFlightForceRegen: Promise<MascotPhraseSet | null> | null = null;
export function forceRegenerate(): Promise<MascotPhraseSet | null> {
  if (inFlightForceRegen) return inFlightForceRegen;
  inFlightForceRegen = (async () => {
    try {
      const ctx = await gatherContext();
      const model = await pickOllamaModel();
      if (!model) return null;
      const prompt = buildPrompt(ctx, "full");
      const fresh = await callOllama(model, prompt);
      if (!fresh) return null;
      const now = Date.now();
      writeCache({
        phrases: fresh,
        language: ctx.language,
        lastFullRegen: now,
        lastTopUp: now,
      });
      return fresh;
    } finally {
      inFlightForceRegen = null;
    }
  })();
  return inFlightForceRegen;
}

/**
 * Read the current phrase set, kicking off a background regen if stale.
 * Always returns a fully-populated set — falls back to inspiration when
 * the cache is empty.
 */
export function getMascotPhrases(): { phrases: MascotPhraseSet; meta: { generated: boolean; language: string | null; lastFullRegen: number | null; lastTopUp: number | null } } {
  const cached = readCache();
  // Schedule a background regen if needed — fire-and-forget, don't await.
  void maybeRegenerateInBackground();
  if (!cached) {
    return {
      phrases: INSPIRATION_PHRASES,
      meta: { generated: false, language: null, lastFullRegen: null, lastTopUp: null },
    };
  }
  return {
    phrases: ensureFullPhraseSet(cached.phrases),
    meta: {
      generated: true,
      language: cached.language,
      lastFullRegen: cached.lastFullRegen,
      lastTopUp: cached.lastTopUp,
    },
  };
}
