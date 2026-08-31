"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import type {
  VoiceChoice,
  VoiceEngine,
  VoiceEngineId,
  VoiceOutputStatus,
} from "@/lib/voice-output";
import { cloudVoicesFor, LOCAL_VOICES, SAMPLE_MAX_CHARS, sampleSentence, VOICE_LANGUAGES } from "@/lib/voice-catalog";

/**
 * Settings → Voice: three dropdowns and a sentence to hear.
 *
 *  - Speak from: the cloud voice or the voice on this box. The gateway always
 *    falls through to the other one when the first cannot speak, so this is
 *    "which one goes first" — cloud-first is the `auto` choice the tts route
 *    has always written, box-first is `local`.
 *  - Language: which language the sample sentence comes in.
 *  - Voice: the engine's own list, read from the box.
 *  - Hear it: a text box with a sample sentence and a Play button that speaks
 *    THAT text with THAT engine and voice, through /setup-api/tts/sample.
 *
 * Everything the old panel said about primaries, fallbacks and check history is
 * gone from here on the owner's request; the Local AI tab still carries the
 * engines' state. The one line about the fallback that stays is the privacy
 * one: when the box's own voice goes first but the cloud is still behind it,
 * the text can still leave the box, and the owner who picked "This box"
 * believing otherwise is told so in one muted sentence.
 */

const ENGINE_ORDER: VoiceEngineId[] = ["local", "cloud"];

function isEngine(value: unknown): value is VoiceEngine {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return ENGINE_ORDER.includes(e.id as VoiceEngineId) && typeof e.configured === "boolean";
}

function isDisclosure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (d.kind === "uses-cloud" || d.kind === "may-use-cloud")
    && Array.isArray(d.providers) && d.providers.every((p) => typeof p === "string");
}

/**
 * Validate every field the render reads — and only those. A payload that
 * passes the envelope check and throws one render later would take the whole
 * Settings window down (TASK-398); a panel that cannot read the box keeps its
 * last good reading instead.
 */
export function isVoiceStatus(value: unknown): value is VoiceOutputStatus {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  if (!["auto", "local", "cloud"].includes(s.choice as string)) return false;
  if (!Array.isArray(s.engines) || !s.engines.every(isEngine)) return false;
  if (typeof s.drifted !== "boolean") return false;
  if (s.warning !== null && typeof s.warning !== "string") return false;
  // Optional: a status from before the notice was structured still renders,
  // with its English sentence.
  if (s.disclosure != null && !isDisclosure(s.disclosure)) return false;
  if (typeof s.language !== "string") return false;
  const voice = s.voice as Record<string, unknown> | undefined;
  if (!voice || typeof voice !== "object") return false;
  return ENGINE_ORDER.every((id) => typeof voice[id] === "string");
}

/**
 * The box says the whole feature is absent on this SKU. Read as its own field
 * rather than inferred from a missing engine list: "no voice is installed" and
 * "this edition has no voice at all" are different answers.
 */
function isEditionUnsupported(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as { supportedOnEdition?: unknown }).supportedOnEdition === false;
}

/**
 * The refusal codes the tts routes answer with, and the key that says each in
 * the owner's language. A code not listed here (or a refusal from an older
 * server with no code at all) shows the box's English sentence instead — a
 * refusal must never be lost to a missing translation.
 */
const REFUSAL_KEYS: Record<string, string> = {
  local_memory: "settings.voice.error.localMemory",
  local_failed: "settings.voice.error.localFailed",
  local_timeout: "settings.voice.error.localTimeout",
  no_local_voice: "settings.voice.error.noLocalVoice",
  cloud_not_set_up: "settings.voice.error.cloudNotSetUp",
  cloud_no_answer: "settings.voice.error.cloudNoAnswer",
  cloud_refused: "settings.voice.error.cloudRefused",
  cloud_no_audio: "settings.voice.error.cloudNoAudio",
  busy: "settings.voice.error.busy",
  not_available: "settings.voice.error.notAvailable",
  no_voice: "settings.voice.error.noVoice",
  cannot_change: "settings.voice.error.cannotChange",
};

/** How long a local sample may take before the panel says the voice is warming up. */
const WARMING_AFTER_SECONDS = 3;

const CARD = "rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5";
const ROW = "flex items-center justify-between gap-4";
const SELECT = "min-w-[12rem] max-w-[60%] rounded-lg border border-white/10 bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] disabled:opacity-50";
const LABEL = "text-sm font-medium text-[var(--text-primary)]";
const MUTED = "text-xs text-[var(--text-muted)]";

export default function VoiceOutputPanel({ active }: { active: boolean }) {
  const { t } = useT();
  const [status, setStatus] = useState<VoiceOutputStatus | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"post" | "play" | null>(null);
  // What the write in flight is for, so the wait can be named: "Saving…" for
  // the owner's own change, and a different line for the one the panel
  // starts by itself (the Auto reconcile below).
  const [writing, setWriting] = useState<"save" | "reconcile" | null>(null);
  const [speakingFor, setSpeakingFor] = useState(0);
  const [sample, setSample] = useState<string | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const clipUrlRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/tts", { cache: "no-store" });
      const data = await res.json();
      if (isEditionUnsupported(data)) {
        setUnsupported(true);
        return;
      }
      if (!isVoiceStatus(data)) return;
      setStatus(data);
    } catch {
      /* keep the last good reading rather than blanking the panel */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    load();
  }, [active, load]);

  // Release the last clip's object URL when the panel goes away.
  useEffect(() => () => {
    if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
  }, []);

  /**
   * Start the clip the moment it arrives, and say so when the browser refuses.
   *
   * A browser may decline programmatic playback — Safari and every browser in
   * a stricter mode want the gesture and the sound in the same tick, and an
   * await for the audio breaks that. That refusal used to be the end of it:
   * the panel said "Could not play that here" and the owner had nothing to
   * press. The player below is rendered either way, so a refusal costs one
   * click on a real control rather than the feature.
   */
  useEffect(() => {
    if (!clipUrl) return;
    // Pre-2016 browsers and jsdom return nothing from play().
    const started = playerRef.current?.play();
    if (started && typeof started.catch === "function") {
      started.catch(() => setAutoplayBlocked(true));
    }
  }, [clipUrl]);

  // A sample on the box pays a full Kokoro cold start whenever kokoro-server
  // is off — 13-17 s measured on an Orin Nano — and "Speaking…" alone for
  // that long reads as a hang. Count the seconds, so the wait is visibly
  // progressing, and name the reason once it is clearly a cold start.
  useEffect(() => {
    if (busy !== "play") return;
    setSpeakingFor(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSpeakingFor(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  /**
   * A refusal in the owner's language when the box sent a code for it, its
   * own English sentence when it did not, and the caller's fallback when it
   * sent nothing readable at all.
   */
  const refusalText = useCallback((data: unknown, fallback: string): string => {
    const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const key = typeof body.code === "string" ? REFUSAL_KEYS[body.code] : undefined;
    if (key) {
      const params: Record<string, string | number> = {};
      for (const name of ["available", "needed", "status"]) {
        if (body[name] != null) params[name] = String(body[name]);
      }
      const text = t(key, params);
      return typeof body.reason === "string" ? `${text} (${body.reason})` : text;
    }
    return typeof body.error === "string" ? body.error : fallback;
  }, [t]);

  /**
   * Drop the clip. A sample made with one engine, voice and language sitting
   * under controls that now say another reads as a sample of the new ones —
   * and, if it was still playing, keeps speaking in the old voice through the
   * switch. The ref is cleared too, so the unmount cleanup cannot revoke it a
   * second time.
   */
  const clearClip = useCallback(() => {
    if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    clipUrlRef.current = null;
    setClipUrl(null);
    setAutoplayBlocked(false);
  }, []);

  const post = useCallback(async (body: Record<string, unknown>, reason: "save" | "reconcile" = "save") => {
    setBusy("post");
    setWriting(reason);
    setError(null);
    try {
      const res = await fetch("/setup-api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(refusalText(data, t("settings.voice.error.changeFailed")));
        return;
      }
      if (isVoiceStatus(data)) setStatus(data);
    } catch {
      setError(t("settings.voice.error.unreachable"));
    } finally {
      setBusy(null);
      setWriting(null);
    }
  }, [refusalText, t]);

  // Auto is a standing instruction, not a one-off write: if the engine it
  // resolves to is not the one the box is configured for, move the box rather
  // than telling the customer to click their own choice again. Once per mount,
  // so a write that does not clear the drift cannot become a loop.
  const reconciled = useRef(false);
  useEffect(() => {
    if (!active || !status || busy) return;
    if (status.choice !== "auto" || !status.drifted) return;
    if (reconciled.current) return;
    reconciled.current = true;
    void post({ action: "select", choice: "auto" }, "reconcile");
  }, [active, status, busy, post]);

  const play = useCallback(async (engine: VoiceEngineId, voice: string, text: string) => {
    setBusy("play");
    setError(null);
    setAutoplayBlocked(false);
    try {
      const res = await fetch("/setup-api/tts/sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, engine, voice }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(refusalText(data, t("settings.voice.error.sampleHttp", { status: res.status })));
        return;
      }
      const blob = await res.blob();
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = URL.createObjectURL(blob);
      setClipUrl(clipUrlRef.current);
    } catch (err) {
      // The reason, not a shrug: a request the network dropped and a browser
      // that would not hand over the bytes are different faults with
      // different fixes, and "could not play that here" named neither.
      setError(t("settings.voice.error.sampleFetch", { reason: err instanceof Error ? err.message : "unknown error" }));
    } finally {
      setBusy(null);
    }
  }, [refusalText, t]);

  if (unsupported) {
    return (
      <div className="max-w-2xl" data-testid="voice-output-unsupported">
        <div className={`${CARD} space-y-2`}>
          <div className="flex items-center gap-2">
            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 22 }} aria-hidden="true">
              voice_over_off
            </span>
            <h2 className="font-semibold text-[var(--text-primary)]">{t("settings.voice.unsupported.title")}</h2>
          </div>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            {t("settings.voice.unsupported.body")}
          </p>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="max-w-2xl space-y-3" data-testid="voice-output-loading">
        {[0, 1].map(i => (
          <div key={i} className={`${CARD} animate-pulse`}>
            <div className="h-3 w-40 rounded bg-white/[0.08]" />
            <div className="h-2 w-64 rounded bg-white/[0.06] mt-3" />
          </div>
        ))}
      </div>
    );
  }

  const engineById = (id: VoiceEngineId) => status.engines.find(e => e.id === id) ?? null;
  /**
   * The engine that goes first. `cloud` (explicit, legacy) reads as
   * cloud-first; `auto` reads as whatever the box resolved it to, because on a
   * box with no cloud voice `auto` means "the local one" — and a select that
   * showed the disabled "not available" option as chosen, over a list of cloud
   * voices the box cannot speak with, would be describing a different box.
   */
  const source: VoiceEngineId =
    status.choice === "local" || (status.choice === "auto" && status.preferredEngine === "local") ? "local" : "cloud";
  const cloud = engineById("cloud");
  const local = engineById("local");
  const voice = status.voice[source];
  // Only the voices the configured cloud model accepts: tts-1 refuses two of
  // the eleven, and a dropdown entry that plays an error is not a voice.
  const voices = source === "local" ? LOCAL_VOICES : cloudVoicesFor(status.cloudModel);
  const text = sample ?? sampleSentence(status.language);
  const disabled = busy !== null;
  // An engine the box does not have cannot audition. `choice: "cloud"` is a
  // legacy value the panel still honours, so the source CAN be an engine
  // whose option is greyed out — and a Play that then asked the box to speak
  // with it only produced a refusal to read.
  const canSpeak = engineById(source)?.configured === true;

  // The privacy notice, in the owner's language when the box sent the fact
  // behind it, in the box's English when it only sent the sentence. Amber
  // where the cloud speaks first — the text leaves the box — and one muted
  // line where the box's own voice goes first and the cloud stands behind it.
  const disclosure = status.disclosure ?? null;
  const notice = disclosure
    ? t(disclosure.kind === "uses-cloud" ? "settings.voice.notice.usesCloud" : "settings.voice.notice.mayUseCloud", {
      providers: disclosure.providers.join(", "),
    })
    : status.warning;
  const cloudSpeaksFirst = source === "cloud" || disclosure?.kind === "uses-cloud";

  const optionLabel = (engine: VoiceEngine | null, nameKey: string, missingKey: string) =>
    engine?.configured ? t(nameKey) : `${t(nameKey)} — ${t(missingKey)}`;

  const chooseSource = (next: VoiceEngineId) => {
    const choice: VoiceChoice = next === "local" ? "local" : "auto";
    clearClip();
    void post({ action: "select", choice });
  };

  return (
    <div className="max-w-2xl space-y-4" data-testid="voice-panel">
      {error && (
        <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className={`${CARD} space-y-4`}>
        <div className={ROW}>
          <label htmlFor="voice-source" className={LABEL}>{t("settings.voice.speakFrom")}</label>
          <select
            id="voice-source"
            data-testid="voice-source"
            className={SELECT}
            value={source}
            disabled={disabled}
            onChange={(e) => chooseSource(e.target.value as VoiceEngineId)}
          >
            <option value="cloud" disabled={!cloud?.configured}>
              {optionLabel(cloud, "settings.voice.source.cloud", "settings.voice.source.cloudMissing")}
            </option>
            <option value="local" disabled={!local?.configured}>
              {optionLabel(local, "settings.voice.source.local", "settings.voice.source.localMissing")}
            </option>
          </select>
        </div>
        {/* The wait is the openclaw CLI's 8-12 s cold start per write. The
            select keeps showing the box's answer rather than an optimistic
            one — the route can refuse — so the wait is named instead. */}
        {busy === "post" && (
          <p role="status" aria-busy="true" className={MUTED} data-testid="voice-saving">
            {writing === "reconcile" ? t("settings.voice.restoringAuto") : t("settings.voice.saving")}
          </p>
        )}
        {notice && cloudSpeaksFirst && (
          <p className="text-xs text-amber-200" data-testid="voice-cloud-warning">{notice}</p>
        )}
        {notice && !cloudSpeaksFirst && (
          <p className={MUTED} data-testid="voice-cloud-fallback-note">{notice}</p>
        )}

        <div className={ROW}>
          <label htmlFor="voice-language" className={LABEL}>{t("settings.voice.language")}</label>
          <select
            id="voice-language"
            data-testid="voice-language"
            className={SELECT}
            value={status.language}
            disabled={disabled}
            onChange={(e) => {
              setSample(null);
              clearClip();
              void post({ action: "language", language: e.target.value });
            }}
          >
            {VOICE_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>

        <div className={ROW}>
          <label htmlFor="voice-voice" className={LABEL}>{t("settings.voice.voice")}</label>
          <select
            id="voice-voice"
            data-testid="voice-voice"
            className={SELECT}
            value={voice}
            disabled={disabled}
            onChange={(e) => {
              clearClip();
              void post({ action: "voice", engine: source, voice: e.target.value });
            }}
          >
            {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </div>
        {source === "local" && status.language !== "en" && (
          <p className={MUTED} data-testid="voice-local-english-only">
            {t("settings.voice.localEnglishOnly")}
          </p>
        )}
      </div>

      <div className={`${CARD} space-y-3`}>
        <label htmlFor="voice-sample-text" className={LABEL}>{t("settings.voice.hearIt")}</label>
        <textarea
          id="voice-sample-text"
          data-testid="voice-sample-text"
          className="w-full rounded-lg border border-white/10 bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] resize-y min-h-[4.5rem]"
          maxLength={SAMPLE_MAX_CHARS}
          value={text}
          onChange={(e) => setSample(e.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <span className={MUTED}>{text.length}/{SAMPLE_MAX_CHARS}</span>
          <button
            type="button"
            data-testid="voice-play"
            disabled={disabled || !canSpeak || !text.trim()}
            aria-busy={busy === "play"}
            onClick={() => { if (canSpeak) void play(source, voice, text); }}
            className="rounded-xl bg-[var(--coral-bright)] px-4 py-2 text-sm font-semibold text-white cursor-pointer disabled:opacity-50 shrink-0"
          >
            {busy === "play" ? t("settings.voice.speakingFor", { seconds: speakingFor }) : t("settings.voice.play")}
          </button>
        </div>
        {busy === "play" && source === "local" && speakingFor >= WARMING_AFTER_SECONDS && (
          <p role="status" className={MUTED} data-testid="voice-local-warming">
            {t("settings.voice.localWarming")}
          </p>
        )}

        {/* Keyed by the URL so each clip gets its own element — a reused one
            keeps the previous decode and will not start the new sound. */}
        {clipUrl && (
          <div className="space-y-1">
            <audio
              key={clipUrl}
              ref={playerRef}
              data-testid="voice-sample-audio"
              aria-label={t("settings.voice.sampleAudio")}
              controls
              autoPlay
              src={clipUrl}
              onError={() => setError(t("settings.voice.error.playerFailed"))}
              style={{ width: "100%", height: 34 }}
            />
            {autoplayBlocked && (
              <p className={MUTED} data-testid="voice-autoplay-blocked">
                {t("settings.voice.autoplayBlocked")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
