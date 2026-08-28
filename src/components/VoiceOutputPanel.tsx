"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * engines' state.
 */

const ENGINE_ORDER: VoiceEngineId[] = ["local", "cloud"];

function isEngine(value: unknown): value is VoiceEngine {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return ENGINE_ORDER.includes(e.id as VoiceEngineId) && typeof e.configured === "boolean";
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

const CARD = "rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5";
const ROW = "flex items-center justify-between gap-4";
const SELECT = "min-w-[12rem] max-w-[60%] rounded-lg border border-white/10 bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] disabled:opacity-50";
const LABEL = "text-sm font-medium text-[var(--text-primary)]";

export default function VoiceOutputPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<VoiceOutputStatus | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"post" | "play" | null>(null);
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

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy("post");
    setError(null);
    try {
      const res = await fetch("/setup-api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Could not change the voice.");
        return;
      }
      if (isVoiceStatus(data)) setStatus(data);
    } catch {
      setError("Could not reach the box.");
    } finally {
      setBusy(null);
    }
  }, []);

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
    void post({ action: "select", choice: "auto" });
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
        setError(typeof data?.error === "string" ? data.error : `The box could not speak that (HTTP ${res.status}).`);
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
      setError(`Could not fetch the sample: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }, []);

  if (unsupported) {
    return (
      <div className="max-w-2xl" data-testid="voice-output-unsupported">
        <div className={`${CARD} space-y-2`}>
          <div className="flex items-center gap-2">
            <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 22 }} aria-hidden="true">
              voice_over_off
            </span>
            <h2 className="font-semibold text-[var(--text-primary)]">Not available on this edition</h2>
          </div>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            Speaking out loud is an OpenClaw feature, and this ClawBox does not run OpenClaw.
            The box will answer in text.
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
  /** The engine that goes first: `cloud` (explicit, legacy) reads as cloud-first. */
  const source: VoiceEngineId = status.choice === "local" ? "local" : "cloud";
  const cloud = engineById("cloud");
  const local = engineById("local");
  const voice = status.voice[source];
  // Only the voices the configured cloud model accepts: tts-1 refuses two of
  // the eleven, and a dropdown entry that plays an error is not a voice.
  const voices = source === "local" ? LOCAL_VOICES : cloudVoicesFor(status.cloudModel);
  const text = sample ?? sampleSentence(status.language);
  const disabled = busy !== null;

  const chooseSource = (next: VoiceEngineId) => {
    const choice: VoiceChoice = next === "local" ? "local" : "auto";
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
          <label htmlFor="voice-source" className={LABEL}>Speak from</label>
          <select
            id="voice-source"
            data-testid="voice-source"
            className={SELECT}
            value={source}
            disabled={disabled}
            onChange={(e) => chooseSource(e.target.value as VoiceEngineId)}
          >
            <option value="cloud" disabled={!cloud?.configured}>
              ClawBox cloud{cloud?.configured ? "" : " — not available"}
            </option>
            <option value="local" disabled={!local?.configured}>
              This box{local?.configured ? "" : " — no voice installed"}
            </option>
          </select>
        </div>
        {source === "cloud" && status.warning && (
          <p className="text-xs text-amber-200" data-testid="voice-cloud-warning">{status.warning}</p>
        )}

        <div className={ROW}>
          <label htmlFor="voice-language" className={LABEL}>Language</label>
          <select
            id="voice-language"
            data-testid="voice-language"
            className={SELECT}
            value={status.language}
            disabled={disabled}
            onChange={(e) => {
              setSample(null);
              void post({ action: "language", language: e.target.value });
            }}
          >
            {VOICE_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>

        <div className={ROW}>
          <label htmlFor="voice-voice" className={LABEL}>Voice</label>
          <select
            id="voice-voice"
            data-testid="voice-voice"
            className={SELECT}
            value={voice}
            disabled={disabled}
            onChange={(e) => void post({ action: "voice", engine: source, voice: e.target.value })}
          >
            {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </div>
        {source === "local" && status.language !== "en" && (
          <p className="text-xs text-[var(--text-muted)]" data-testid="voice-local-english-only">
            The voice on this box speaks English only. Pick ClawBox cloud for other languages.
          </p>
        )}
      </div>

      <div className={`${CARD} space-y-3`}>
        <label htmlFor="voice-sample-text" className={LABEL}>Hear it</label>
        <textarea
          id="voice-sample-text"
          data-testid="voice-sample-text"
          className="w-full rounded-lg border border-white/10 bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] resize-y min-h-[4.5rem]"
          maxLength={SAMPLE_MAX_CHARS}
          value={text}
          onChange={(e) => setSample(e.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--text-muted)]">{text.length}/{SAMPLE_MAX_CHARS}</span>
          <button
            type="button"
            data-testid="voice-play"
            disabled={disabled || !text.trim()}
            aria-busy={busy === "play"}
            onClick={() => void play(source, voice, text)}
            className="rounded-xl bg-[var(--coral-bright)] px-4 py-2 text-sm font-semibold text-white cursor-pointer disabled:opacity-50 shrink-0"
          >
            {busy === "play" ? "Speaking…" : "Play"}
          </button>
        </div>

        {/* Keyed by the URL so each clip gets its own element — a reused one
            keeps the previous decode and will not start the new sound. */}
        {clipUrl && (
          <div className="space-y-1">
            <audio
              key={clipUrl}
              ref={playerRef}
              data-testid="voice-sample-audio"
              aria-label="The spoken sample"
              controls
              autoPlay
              src={clipUrl}
              onError={() => setError("This browser could not play the audio the box sent.")}
              style={{ width: "100%", height: 34 }}
            />
            {autoplayBlocked && (
              <p className="text-xs text-[var(--text-muted)]" data-testid="voice-autoplay-blocked">
                Your browser would not start it by itself — press play above.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
