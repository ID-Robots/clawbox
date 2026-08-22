// ── Mascot phrase cache + generation schedule (server-side) ──
//
// The mascot's phrases come from three places, in order:
//
//   1. the per-locale cache written by the local generator (this file),
//   2. the hand-written pack for that locale (`mascot-packs/<locale>.ts`),
//   3. the language-free neutral pack.
//
// There is NO cross-locale fallback: a Bulgarian box never renders English.
//
// Generation is LOCAL ONLY — the on-device llama.cpp server, nothing leaves
// the box, and there is deliberately no cloud path. This file owns the cache,
// the schedule, the resource gates, the failure backoff and the validation
// gate; `mascot-generation-local.ts` owns the call to the model.

import fs from "fs/promises";
import { kvDelete, kvGet, kvSet } from "./kv-store";
import * as config from "./config-store";
import { getLocalAiRuntimeSnapshot } from "./local-ai-runtime";
import { isLlamaCppPidRunning, readLlamaCppPid } from "./llamacpp-server";
import { isPreferenceLanguage } from "./preference-schema";
import { VALIDATOR_VERSION } from "./mascot-language";
import { mergeWithPack, packFor } from "./mascot-packs";
import { generatePhrasesLocally, type FailureKind } from "./mascot-generation-local";
import {
  GENERATION_DISABLED_REASON,
  GENERATION_LOCALES,
  LANG_NAMES,
  PHRASE_CATEGORIES,
  isGenerationLocale,
  stripEchoes,
  validateBatch,
  type MascotPhraseSet,
} from "./mascot-phrases";

export type { FailureKind };

// The allowlist itself lives in `mascot-phrases.ts` so the Settings UI can
// import it; re-exported here because this module is where callers look for
// anything about the generation schedule.
export { GENERATION_DISABLED_REASON, GENERATION_LOCALES, isGenerationLocale };

/** Per-locale cache key. INV-4: one envelope per locale, never a shared one. */
const KV_PHRASE_PREFIX = "clawbox-mascot-phrase-set:";
const KV_FAILURE_PREFIX = "clawbox-mascot-phrase-failure:";

// Written by versions that had a single locale-blind cache and a
// "the crab quotes your chat back at you" snippet collector. Both are gone;
// delete them the first time this module reads anything so the KV file does
// not keep stale (and possibly wrong-language) payloads around.
const LEGACY_KEYS = ["clawbox-mascot-phrase-set", "clawbox-mascot-convo-lines", "clawbox-mascot-phrase-last-failure"];

const FULL_REGEN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const DAILY_TOPUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Why a run produced nothing cacheable. The generator's own failures, plus the
 * one only the validator can see: a batch that parsed and read fine but was
 * entirely lines the crab already knew.
 */
type PhraseFailureKind = FailureKind | "no-new-phrases";

/**
 * After a failed generation do NOT retry in the background for this long.
 * Without it a stale cache + a failing model retried on every mascot fetch,
 * reloading a multi-GB model into RAM every ~90s and swap-spiralling 8GB
 * Jetsons. A malformed answer backs off twice as long as a transport error:
 * the model producing junk will keep producing junk, while a timeout may
 * clear on its own.
 */
const FAILURE_BACKOFF_MS: Record<PhraseFailureKind, number> = {
  transport: 12 * 60 * 60 * 1000,
  timeout: 12 * 60 * 60 * 1000,
  unavailable: 12 * 60 * 60 * 1000,
  malformed: 24 * 60 * 60 * 1000,
  // Same as malformed: the model ran, it just had nothing new to say, and
  // asking it again an hour later will not change that. An explicit press of
  // the Settings button still bypasses this — see `forceRegenerate`.
  "no-new-phrases": 24 * 60 * 60 * 1000,
};

/**
 * Gemma 4 E2B peaks around 3.8 GB resident, so do not start a COLD load below
 * that. This gate is deliberately not applied when the server is already up —
 * see `hasMemoryHeadroom`.
 */
const MIN_AVAILABLE_MEM_KB = Math.round(3.8 * 1024 * 1024);
const MAX_PHRASES_PER_CATEGORY = 24; // cap so the bag doesn't grow forever
const TARGET_NEW_PER_CATEGORY = 8;

const OPENCLAW_WORKSPACE_DIR = "/home/clawbox/.openclaw/workspace";

export type GenerationMode = "full" | "topup";

interface PhraseCacheEnvelope {
  /** Only the categories generation actually produced; the pack fills the rest. */
  phrases: Partial<MascotPhraseSet>;
  locale: string;
  /** Rules the entries were filtered with — a bump forces a re-filter on read. */
  validatorVersion: number;
  lastFullRegen: number;
  lastTopUp: number;
}

export type PhraseSource = "pack" | "local";

export interface PhraseMeta {
  source: PhraseSource;
  reason: string;
  locale: string;
  validatorVersion: number;
  lastFullRegen: number | null;
  lastTopUp: number | null;
}

// ── Legacy cleanup ─────────────────────────────────────────────────────

let legacyPurged = false;

function purgeLegacyKeys(): void {
  if (legacyPurged) return;
  legacyPurged = true;
  for (const key of LEGACY_KEYS) {
    try {
      if (kvGet(key) !== null) kvDelete(key);
    } catch (err) {
      console.warn(`[mascot-phrases] could not delete legacy key ${key}:`, err);
    }
  }
}

// ── Cache I/O ──────────────────────────────────────────────────────────

function cacheKey(locale: string): string {
  return `${KV_PHRASE_PREFIX}${locale}`;
}

function readCache(locale: string): PhraseCacheEnvelope | null {
  const raw = kvGet(cacheKey(locale));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PhraseCacheEnvelope;
    if (!parsed || typeof parsed !== "object") return null;
    // Both timestamps, not just the first: `isStale` does arithmetic on each
    // of them, and `now - undefined` is NaN — which compares false against
    // every interval, so an envelope missing `lastTopUp` would silently never
    // top up again until the weekly full regen came round.
    if (!parsed.phrases) return null;
    if (typeof parsed.lastFullRegen !== "number" || typeof parsed.lastTopUp !== "number") return null;
    // A payload stored under one locale's key that claims another locale is
    // corrupt; treat it as absent rather than rendering it.
    if (parsed.locale !== locale) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(envelope: PhraseCacheEnvelope): void {
  kvSet(cacheKey(envelope.locale), JSON.stringify(envelope));
}

function deleteCache(locale: string): void {
  kvDelete(cacheKey(locale));
}

// ── Failure backoff ────────────────────────────────────────────────────

interface FailureRecord {
  at: number;
  kind: PhraseFailureKind;
}

function readFailure(locale: string): FailureRecord | null {
  const raw = kvGet(`${KV_FAILURE_PREFIX}${locale}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FailureRecord;
    if (!parsed || typeof parsed.at !== "number") return null;
    if (!(parsed.kind in FAILURE_BACKOFF_MS)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function recordFailure(locale: string, kind: PhraseFailureKind): void {
  kvSet(`${KV_FAILURE_PREFIX}${locale}`, JSON.stringify({ at: Date.now(), kind } satisfies FailureRecord));
}

function clearFailure(locale: string): void {
  kvDelete(`${KV_FAILURE_PREFIX}${locale}`);
}

function inFailureBackoff(locale: string): boolean {
  const failure = readFailure(locale);
  if (!failure) return false;
  return Date.now() - failure.at < FAILURE_BACKOFF_MS[failure.kind];
}

// ── Resource guards ────────────────────────────────────────────────────

/**
 * Does `pid` actually belong to a llama-server process?
 *
 * `isLlamaCppPidRunning` is `kill(pid, 0)`, which answers "some process has
 * this id", not "OUR process is still alive". The pid file outlives an
 * unclean shutdown — a Jetson losing power mid-run, an OOM kill, a crash
 * before `clearLlamaCppPid` — and Linux recycles pids, so after enough
 * process churn that stale number lands on something else entirely.
 *
 * The consequence was specific and bad: a recycled pid made
 * `isLlamaCppServerRunning` say yes, which is exactly the "server up ==
 * headroom" exemption below, so the memory gate was skipped and the box
 * cold-loaded a ~3.8GB model with as little as 400MB free. That is the swap
 * spiral the gate exists to prevent, on the hardware least able to survive it.
 *
 * Reading `/proc/<pid>/cmdline` costs one file read and settles it. Fails
 * CLOSED on purpose: if we cannot confirm the process is llama-server — no
 * /proc (a dev machine), a pid owned by another user, a race with exit — the
 * caller loses the exemption and falls back to measuring MemAvailable, which
 * is the safe direction to be wrong in.
 */
async function isLlamaServerCmdline(pid: number): Promise<boolean> {
  try {
    // argv is NUL-separated; argv[0] is the binary path.
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf-8");
    return cmdline.split("\0").some((arg) => arg.includes("llama-server"));
  } catch {
    return false;
  }
}

/**
 * Is the on-device llama.cpp server already running?
 *
 * If it is, its model is already in RAM and we are about to reuse that exact
 * process — no new multi-GB allocation happens, so there is nothing for the
 * memory gate to protect against. "That exact process" is the load-bearing
 * part, hence the cmdline check: a recycled pid is a different program.
 */
async function isLlamaCppServerRunning(): Promise<boolean> {
  try {
    const pid = await readLlamaCppPid();
    if (pid === null || !isLlamaCppPidRunning(pid)) return false;
    return await isLlamaServerCmdline(pid);
  } catch {
    return false;
  }
}

/**
 * True when the box has enough free RAM to LOAD Gemma without swapping.
 * Fails open on non-Linux (dev machines) or unreadable meminfo.
 *
 * The already-running case is the whole subtlety. A resident Gemma E2B eats
 * its own headroom: `llamacpp.ts` measures peak RSS at 3780MB and MemAvailable
 * settling around 3400-3670MB afterwards, i.e. permanently under this 3891MB
 * gate. Checking MemAvailable in that state measures the very model we intend
 * to reuse and always says no — so the ten-minute warm window after any chat,
 * the one moment when generating is nearly free, was the one moment the
 * mascot refused. Hence: server up == headroom, by definition.
 */
async function hasMemoryHeadroom(): Promise<boolean> {
  if (await isLlamaCppServerRunning()) return true;
  try {
    const meminfo = await fs.readFile("/proc/meminfo", "utf-8");
    const m = meminfo.match(/^MemAvailable:\s+(\d+)\s*kB/m);
    if (!m) return true;
    const availableKb = parseInt(m[1], 10);
    if (availableKb >= MIN_AVAILABLE_MEM_KB) return true;
    console.warn(`[mascot-phrases] skipping generation: only ${Math.round(availableKb / 1024)}MB RAM available`);
    return false;
  } catch {
    return true;
  }
}

/**
 * The local model is single-tenant. A mascot phrase refresh must never queue
 * behind — or in front of — something the user is actually waiting for.
 */
function isLocalAiBusy(): boolean {
  try {
    return getLocalAiRuntimeSnapshot("llamacpp").activeRequests > 0;
  } catch {
    return true; // cannot tell -> assume busy
  }
}

// ── Prompt ─────────────────────────────────────────────────────────────

export interface GenerationContext {
  locale: string;
  languageName: string;
  workspaceMemory: string;
  /** Locale-native examples the model should match the tone of. */
  toneReference: MascotPhraseSet;
}

/**
 * Everything the prompt is built from is read from THIS DEVICE only — the
 * language preference and the OpenClaw workspace memory. It is fed to the
 * on-device model and nowhere else.
 *
 * The owner's name is deliberately NOT here. `nameGreetings` are templates
 * carrying a literal `{name}` that the client substitutes at render time, so
 * the model has no use for the real name — and not reading `pref:ui_user_name`
 * at all is one fewer piece of personal data in a prompt.
 */
async function gatherContext(locale: string): Promise<GenerationContext> {
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

  return {
    locale,
    languageName: LANG_NAMES[locale] ?? "English",
    workspaceMemory,
    toneReference: await packFor(locale),
  };
}

/**
 * Build the model prompt from on-device context. Not exported: the prompt is
 * covered end-to-end through the batch the generator is handed
 * (`mascot-regeneration.test.ts` asserts on it), so there is no second reader.
 */
function buildPrompt(ctx: GenerationContext, mode: GenerationMode): string {
  const toneLines = PHRASE_CATEGORIES
    .map((cat) => `${cat}: ${ctx.toneReference[cat].slice(0, 6).map((s) => `"${s}"`).join(", ")}`)
    .join("\n");

  const memBlock = ctx.workspaceMemory
    ? `\nWHAT THE DEVICE KNOWS ABOUT THE USER (OpenClaw workspace memory):\n${ctx.workspaceMemory}\n`
    : "";

  const intent = mode === "topup"
    ? "Generate a FRESH BATCH of new phrases. The cache already has older phrases — produce different ones, varying mood and topic. Tie a few of them subtly to what the user has been working on (without quoting verbatim)."
    : "Generate a complete starter set of phrases for every category.";

  return `You are writing speech-bubble lines for a sarcastic crab mascot living on a private home AI device called ClawBox. The crab's vibe is "lazy, sarcastic, scandalous" — affectionate, terse, slightly chaotic.

${intent}

OUTPUT LANGUAGE: ${ctx.languageName} (${ctx.locale}). EVERY phrase must be written in ${ctx.languageName}. Do not answer in English unless ${ctx.languageName} IS English. Emoji are fine and encouraged. Keep short technical terms in English (e.g. "deploy", "bug", "404").

CONSTRAINTS:
- Each phrase must be SHORT — under 60 characters, fits in a small speech bubble.
- No URLs, no markdown, no triple backticks.
- For "nameGreetings": every entry MUST contain the literal token {name} (curly braces included). The crab will substitute the user's name at render time.
- For "nameFallbacks": single-word friendly placeholder names ONLY, in ${ctx.languageName}. These are used when the user hasn't set their name.
- Per category, produce ${mode === "topup" ? `${TARGET_NEW_PER_CATEGORY}-${TARGET_NEW_PER_CATEGORY + 4}` : "8-12"} unique entries.
- Do NOT copy the tone reference verbatim — it is a TONAL REFERENCE only.

TONE REFERENCE (already in ${ctx.languageName} — match the vibe, not the words):
${toneLines}
${memBlock}
Output ONLY a single JSON object, no prose, in this exact shape:
{
${PHRASE_CATEGORIES.map((cat) => `  "${cat}": [...]`).join(",\n")}
}`;
}

// ── Generation hook (local model only) ─────────────────────────────────

/**
 * Build the prompt from on-device context and hand it to the local model.
 *
 * The transport, the thinking switch, the JSON grammar, the timeout and the
 * runtime lifecycle all live in `mascot-generation-local.ts`. What stays here
 * is the one thing this module is responsible for: nothing in `ctx` — the
 * owner's name, their workspace memory — may leave the box, and it does not,
 * because the only consumer is a loopback POST to llama.cpp.
 */
async function generatePhraseBatch(ctx: GenerationContext, mode: GenerationMode) {
  return generatePhrasesLocally({ prompt: buildPrompt(ctx, mode), locale: ctx.locale });
}

// ── Schedule ───────────────────────────────────────────────────────────

function isStale(envelope: PhraseCacheEnvelope | null): { stale: boolean; mode: GenerationMode } {
  if (!envelope) return { stale: true, mode: "full" };
  if (envelope.validatorVersion !== VALIDATOR_VERSION) return { stale: true, mode: "full" };
  const now = Date.now();
  if (now - envelope.lastFullRegen >= FULL_REGEN_INTERVAL_MS) return { stale: true, mode: "full" };
  if (now - envelope.lastTopUp >= DAILY_TOPUP_INTERVAL_MS) return { stale: true, mode: "topup" };
  return { stale: false, mode: "topup" };
}

/**
 * Merge a freshly-generated batch into the existing cache. "full" replaces,
 * "topup" prepends (newest first) capped per category.
 */
function mergeBatch(
  existing: Partial<MascotPhraseSet>,
  fresh: Partial<MascotPhraseSet>,
  mode: GenerationMode,
): Partial<MascotPhraseSet> {
  if (mode === "full") return fresh;
  const merged: Partial<MascotPhraseSet> = { ...existing };
  for (const cat of PHRASE_CATEGORIES) {
    const freshCat = fresh[cat];
    if (!freshCat || freshCat.length === 0) continue;
    const seen = new Set<string>();
    const combined: string[] = [];
    for (const s of [...freshCat, ...(existing[cat] ?? [])]) {
      if (!seen.has(s)) { seen.add(s); combined.push(s); }
      if (combined.length >= MAX_PHRASES_PER_CATEGORY) break;
    }
    merged[cat] = combined;
  }
  return merged;
}

/** Total entries in a phrase set, whatever their type. */
function countEntries(set: Partial<MascotPhraseSet> | null | undefined): number {
  return PHRASE_CATEGORIES.reduce((total, category) => {
    const entries = set?.[category];
    return total + (Array.isArray(entries) ? entries.length : 0);
  }, 0);
}

/**
 * What `persistBatch` did. A reason rather than a bare `null`, because the two
 * ways a batch can fail to reach the cache are not the same thing to tell the
 * owner: "the model answered with junk" sends them looking for a broken
 * install, while "the model only repeated lines the crab already had" is a
 * model that worked and simply had nothing to add.
 */
type PersistOutcome =
  | { ok: true; phrases: Partial<MascotPhraseSet> }
  | { ok: false; reason: "malformed" | "no-new-phrases" };

/** Persist a batch, INV-6: nothing reaches the cache unvalidated. */
async function persistBatch(
  locale: string,
  cached: PhraseCacheEnvelope | null,
  fresh: Partial<MascotPhraseSet>,
  mode: GenerationMode,
): Promise<PersistOutcome> {
  // Echoes are stripped BEFORE validation, so the survivor count counts NEW
  // lines. See `stripEchoes` — the model copies the tone reference it is
  // shown, and echoes used to pad a near-worthless batch past the gate.
  //
  // The cached envelope counts as "already said" in TOP-UP mode only, and the
  // asymmetry is not an oversight. A top-up PREPENDS to the envelope, so a
  // line yesterday's run already put there adds nothing today. A full regen
  // REPLACES it, so the old lines are gone the moment this batch is written —
  // and a line the model produced again is the only reason it survives at
  // all. Stripping against the envelope there would delete lines for being
  // good enough to reproduce, and would make a second press of the refresh
  // button harder to pass than the first.
  const stripped = stripEchoes(fresh, await packFor(locale), mode === "topup" ? cached?.phrases : null);
  const validated = validateBatch(stripped, locale);
  if (!validated.ok) {
    const echoed = countEntries(fresh) - countEntries(stripped);
    // Precisely: a batch that WOULD have passed before the strip and does not
    // after it was defeated by echo, not by junk. Anything else is junk.
    const echoOnly = validated.reason === "too-few-categories" && validateBatch(fresh, locale).ok;
    const reason = echoOnly ? "no-new-phrases" : "malformed";
    console.warn(
      `[mascot-phrases] discarding ${locale} batch: ${reason} (${validated.reason}, ` +
        `${echoed} of ${countEntries(fresh)} entries already known, dropped ${validated.dropped})`,
    );
    recordFailure(locale, reason);
    return { ok: false, reason };
  }
  const now = Date.now();
  const phrases = mergeBatch(cached?.phrases ?? {}, validated.categories, mode);
  writeCache({
    phrases,
    locale,
    validatorVersion: VALIDATOR_VERSION,
    lastFullRegen: mode === "full" ? now : (cached?.lastFullRegen ?? now),
    lastTopUp: now,
  });
  clearFailure(locale);
  return { ok: true, phrases };
}

/** One in-flight background generation per locale. */
const inFlightGeneration = new Map<string, Promise<void>>();

/**
 * At most ONE mascot generation on the whole box, across every locale and
 * every entry point.
 *
 * The per-locale maps above only stop a locale racing itself. The box has a
 * single model and a single 180-second run, so N locales asked for at once —
 * a user auditioning languages in Settings (each switch re-fetches), two
 * browser tabs, or simply N crafted GETs — would each see `activeRequests === 0`,
 * each await the same shared `ensureLocalAiReady` promise, and then all POST.
 * llama-server serialises them, so the user's next chat turn ends up queued
 * behind up to N x 180s. That is precisely the contention every other guard in
 * this file exists to prevent.
 *
 * The loser does not queue, it skips: the next fetch for that locale picks it
 * up, and a cosmetic refresh is never worth making somebody wait.
 */
let generationInFlight = false;

/**
 * Why the lock said no. Two genuinely different situations that used to be
 * one `null`, and therefore one message to the user:
 *
 *  - `refresh-in-progress` — the crab is already regenerating its own
 *    phrases. Nobody's chat is involved. Telling the owner "the model is busy
 *    with your chat" here is simply false, and it is the LIKELIER of the two
 *    to be hit from a Settings button, because the page's own background
 *    refresh may well have claimed the lock a moment earlier.
 *  - `chat-busy` — the user's own chat owns the model. Their turn wins;
 *    a cosmetic refresh is never worth making somebody wait.
 */
type LockRefusal = "refresh-in-progress" | "chat-busy";

type LockOutcome<T> = { ran: true; value: T } | { ran: false; refusal: LockRefusal };

/**
 * Run `fn` iff no mascot generation is running anywhere and the model is idle,
 * and say which of the two stopped it otherwise.
 *
 * The busy re-check lives INSIDE the lock on purpose: `isLocalAiBusy` is
 * check-then-act around a 10-60s `ensureLocalAiReady`, so two callers reading
 * it independently both pass. Flag and check are both synchronous here, so
 * nothing can interleave between them.
 */
async function withGenerationLock<T>(fn: () => Promise<T>): Promise<LockOutcome<T>> {
  if (generationInFlight) return { ran: false, refusal: "refresh-in-progress" };
  if (isLocalAiBusy()) return { ran: false, refusal: "chat-busy" }; // the user's own chat always wins
  generationInFlight = true;
  try {
    return { ran: true, value: await fn() };
  } finally {
    generationInFlight = false;
  }
}

/**
 * Trigger a generation for `locale` if its cache is stale. No-ops if one is
 * already in flight. Never throws — failures are logged and the cache is left
 * untouched.
 */
export function maybeRegenerateInBackground(locale: string): Promise<void> {
  const existing = inFlightGeneration.get(locale);
  if (existing) return existing;
  const run = (async () => {
    // Yield once before doing anything, so the `finally` below can never run
    // before `inFlightGeneration.set` further down. Every early return in this
    // body (fresh cache, backoff, busy model) is reached without awaiting, and
    // an async function that returns without ever suspending runs its whole
    // try/finally synchronously — deleting the map entry BEFORE it was added,
    // and leaving the resolved promise parked there forever. That killed
    // background regeneration for the locale until the next process restart,
    // and the common case (a cache that is simply still fresh) triggered it.
    await Promise.resolve();
    try {
      // The cheapest gate first: a locale generation is switched off for never
      // reaches the model, the memory check or the failure store at all.
      if (!isGenerationLocale(locale)) return;
      const cached = readCache(locale);
      const { stale, mode } = isStale(cached);
      if (!stale) return;
      if (inFailureBackoff(locale)) return;

      await withGenerationLock(async () => {
        // Transient, self-clearing, and NOT a fault: the box is under memory
        // pressure right now. Recording a failure here armed a 12-hour backoff
        // for a condition that resolves itself within the model's 10-minute
        // idle-unload window — and it fired on the second locale of any
        // multi-locale box, so merely viewing the UI in another language
        // poisoned that language for half a day.
        if (!(await hasMemoryHeadroom())) return;

        const ctx = await gatherContext(locale);
        const outcome = await generatePhraseBatch(ctx, mode);
        // "deferred" means the user's own chat claimed the model between our
        // idle check and the call. Deliberately no recordFailure: that is a
        // busy box, not a broken one, and arming a 12h backoff for it would
        // punish exactly the people who use the device most.
        if (outcome.status === "deferred") return;
        if (outcome.status === "failed") {
          recordFailure(locale, outcome.failure);
          return;
        }
        await persistBatch(locale, cached, outcome.phrases, mode);
      });
    } catch (err) {
      // Best-effort: callers fire-and-forget this, so it must never reject.
      console.error("[mascot-phrases-server] maybeRegenerateInBackground failed:", err);
    } finally {
      inFlightGeneration.delete(locale);
    }
  })();
  inFlightGeneration.set(locale, run);
  return run;
}

/**
 * Why a forced regen ended the way it did. The caller shows one of these to a
 * human, so "the model is busy with your chat" and "the model answered with
 * junk" must not arrive as the same string: the first means "try again in a
 * minute", the second means something is wrong.
 */
export type ForceRegenerateReason =
  | "generated"
  /**
   * The user's own chat holds the model. NOT the same as the one below, and
   * conflating them is the bug: a Settings button that says "busy with your
   * chat" while the box is quietly refreshing its own phrases is telling the
   * owner something they can see is untrue.
   */
  | "chat-busy"
  /** Another MASCOT generation holds the model. Nobody's chat is involved. */
  | "refresh-in-progress"
  /** Generation does not run for this locale at all — see GENERATION_LOCALES. */
  | "generation-disabled-for-locale"
  /** Not enough free RAM to cold-load the model. Clears on its own. */
  | "low-memory"
  /** Local AI is switched off, or no model is provisioned. */
  | "unavailable"
  | "timeout"
  | "transport"
  /** The model answered, but not with a usable batch. */
  | "malformed"
  /**
   * The model answered with a well-formed batch that was entirely lines the
   * crab already had. Kept apart from "malformed" because it is not a broken
   * install and nothing is wrong with the box: the run worked and simply
   * added nothing. Telling the owner otherwise sends them debugging a model
   * that is fine.
   */
  | "no-new-phrases";

export interface ForceRegenerateResult {
  /** The new complete set, or null when nothing was generated. */
  phrases: MascotPhraseSet | null;
  reason: ForceRegenerateReason;
  locale: string;
}

/** One in-flight forced regen per locale — double-clicking Settings must not stack runs. */
const inFlightForceRegen = new Map<string, Promise<ForceRegenerateResult>>();

/**
 * Force a full regen regardless of cache age, and say what happened.
 *
 * Keyed on the RESOLVED locale, not on the raw argument: `POST /regenerate`
 * and `POST /regenerate?locale=en` name the same locale on an English box, and
 * keying on the argument let them run two concurrent full generations.
 *
 * Resolving the locale means awaiting the config store, so two calls that
 * arrive inside that await both miss the map. That is fine — the map is an
 * optimisation that lets the second caller share the first's answer, while
 * `withGenerationLock` is what actually guarantees a single run.
 */
export async function forceRegenerate(requestedLocale?: string | null): Promise<ForceRegenerateResult> {
  const locale = await resolveLocale(requestedLocale);
  // An explicit user action bypasses the failure backoff and the cache age,
  // but not the allowlist: no model run can make a language it does not speak
  // come out right, so this refuses immediately rather than spending three
  // minutes proving it.
  if (!isGenerationLocale(locale)) {
    return { phrases: null, reason: "generation-disabled-for-locale", locale };
  }
  const existing = inFlightForceRegen.get(locale);
  if (existing) return existing;

  const run = (async (): Promise<ForceRegenerateResult> => {
    // Yield before anything else, for the same reason as the background path:
    // an async function that returns without ever suspending runs its whole
    // try/finally synchronously, deleting the map entry BEFORE the `set`
    // below adds it — parking a resolved promise there forever. Every early
    // return in this body is reached without awaiting.
    await Promise.resolve();
    try {
      // An explicit user action bypasses the failure backoff, but still
      // refuses to load a model into a busy or memory-pressured box.
      const result = await withGenerationLock(async (): Promise<ForceRegenerateResult> => {
        if (!(await hasMemoryHeadroom())) return { phrases: null, reason: "low-memory", locale };
        const ctx = await gatherContext(locale);
        const outcome = await generatePhraseBatch(ctx, "full");
        // "deferred" is specifically the generator finding the model claimed
        // by a real request between our idle check and the call — a chat, not
        // another crab refresh.
        if (outcome.status === "deferred") return { phrases: null, reason: "chat-busy", locale };
        if (outcome.status === "failed") {
          recordFailure(locale, outcome.failure);
          return { phrases: null, reason: outcome.failure, locale };
        }
        const persisted = await persistBatch(locale, readCache(locale), outcome.phrases, "full");
        if (!persisted.ok) return { phrases: null, reason: persisted.reason, locale };
        return { phrases: await mergeWithPack(persisted.phrases, locale), reason: "generated", locale };
      });
      return result.ran ? result.value : { phrases: null, reason: result.refusal, locale };
    } finally {
      inFlightForceRegen.delete(locale);
    }
  })();

  inFlightForceRegen.set(locale, run);
  return run;
}

// ── Public read path ───────────────────────────────────────────────────

/**
 * Resolve the locale to serve: an explicitly requested one wins, then the
 * stored preference, then English.
 *
 * The stored preference is read straight from the config store, bypassing the
 * validation `/setup-api/preferences` applies, and it ends up interpolated
 * into a model prompt — so it is re-checked here. A value written before that
 * validation existed falls back to English instead of arriving as prompt text.
 */
async function resolveLocale(requested?: string | null): Promise<string> {
  if (isPreferenceLanguage(requested)) return requested;
  const stored = await config.get("pref:ui_language");
  return isPreferenceLanguage(stored) ? stored : "en";
}

/**
 * Read the phrase set for `requestedLocale`, kicking off a background regen
 * if the cache is stale. Always returns a complete, locale-correct set.
 */
export async function getMascotPhrases(
  requestedLocale?: string | null,
): Promise<{ phrases: MascotPhraseSet; meta: PhraseMeta }> {
  purgeLegacyKeys();
  const locale = await resolveLocale(requestedLocale);

  // Generation is switched off for this language, so the pack IS the answer —
  // complete, idiomatic, hand-written and reviewed. An envelope an older build
  // left behind is not served: it was produced by the path this allowlist
  // exists to stop trusting, and `meta.reason` would be lying about where the
  // lines came from if we handed it back.
  //
  // It is DELETED rather than merely ignored. Left on disk it would be
  // unreachable data that no code path can ever fix: the re-filter that
  // rewrites entries when VALIDATOR_VERSION moves lives further down this
  // function, so a skipped envelope would sit at an old validator version
  // forever, and the failure record beside it could never be cleared. The
  // lines in it are the ones this change exists to stop shipping, so there is
  // nothing to preserve.
  if (!isGenerationLocale(locale)) {
    if (kvGet(cacheKey(locale)) !== null) {
      deleteCache(locale);
      console.info(`[mascot-phrases] dropped ${locale} envelope: generation is English-only now`);
    }
    clearFailure(locale);
    return {
      phrases: await mergeWithPack(null, locale),
      meta: {
        source: "pack",
        reason: GENERATION_DISABLED_REASON,
        locale,
        validatorVersion: VALIDATOR_VERSION,
        lastFullRegen: null,
        lastTopUp: null,
      },
    };
  }

  const cached = readCache(locale);

  // Fire-and-forget: never make the mascot wait on the model.
  void maybeRegenerateInBackground(locale);

  if (!cached) {
    return {
      phrases: await mergeWithPack(null, locale),
      meta: {
        source: "pack",
        reason: "no-cache",
        locale,
        validatorVersion: VALIDATOR_VERSION,
        lastFullRegen: null,
        lastTopUp: null,
      },
    };
  }

  // INV-4: entries cached under older rules are re-filtered before they can
  // reach a bubble, and the cache is rewritten so it only happens once.
  let phrases = cached.phrases;
  let reason = "cache";
  if (cached.validatorVersion !== VALIDATOR_VERSION) {
    const revalidated = validateBatch(cached.phrases, locale, { stopwordProbe: false });
    if (revalidated.ok) {
      phrases = revalidated.categories;
      writeCache({ ...cached, phrases, validatorVersion: VALIDATOR_VERSION });
      reason = "revalidated";
    } else {
      deleteCache(locale);
      return {
        phrases: await mergeWithPack(null, locale),
        meta: {
          source: "pack",
          reason: `revalidation-failed:${revalidated.reason}`,
          locale,
          validatorVersion: VALIDATOR_VERSION,
          lastFullRegen: null,
          lastTopUp: null,
        },
      };
    }
  }

  return {
    phrases: await mergeWithPack(phrases, locale),
    meta: {
      source: "local",
      reason,
      locale,
      validatorVersion: VALIDATOR_VERSION,
      lastFullRegen: cached.lastFullRegen,
      lastTopUp: cached.lastTopUp,
    },
  };
}
