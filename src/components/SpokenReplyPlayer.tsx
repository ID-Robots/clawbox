'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'

/**
 * The player a spoken reply gets: ClawBox's own transport, not the browser's.
 *
 * The grey `<audio controls>` bar it replaces did work — play, pause, scrub,
 * duration — but in a 370-420px docked panel the one thing people actually do
 * with a spoken reply, scrub back four seconds to catch a number, had a 3px
 * track to aim at, and nothing on screen said "this is a voice, this long"
 * before it was pressed. So: a 36px play button, the clip's own waveform as
 * the scrub target with the played part filled, the clock, and a download.
 *
 * Everything the old element did for free is done here on purpose:
 *
 *  - The `<audio>` element is still the engine. It keeps `preload="metadata"`
 *    (the duration on screen without pulling the file down for a reply nobody
 *    listens to) and the box's own media route as its source, which answers
 *    Range requests — without that a custom scrubber is exactly as dead as the
 *    browser's was.
 *  - The KEYBOARD is not optional. The play button is a real `<button>`; the
 *    waveform is a `role="slider"` with `tabindex=0` that seeks with the arrow
 *    keys, jumps with Home/End and plays with Space — which is what the native
 *    control gave and what a `<div>` full of bars would have taken away.
 *  - The accessible name is the one the caller already computes (`audioLabel`,
 *    which strips the Markdown so a screen reader is not read the syntax),
 *    prefixed here with the verb of the NEXT press so the name always says
 *    what pressing will do.
 *  - The clock is `aria-hidden`. A live region ticking once a second
 *    re-announces itself over everything else — the exact mistake the
 *    recording clock in ChatPopup already documents. The slider's
 *    `aria-valuetext` carries the position, read on demand.
 *
 * Used by every surface that shows a spoken reply — the mascot chat, the chat
 * app, and the Voice tab's sample — so the three cannot drift apart again.
 */

/** Bars in the waveform. The mockup's number; ~6px each at the docked width. */
const BUCKETS = 56
/** What an arrow key moves, in seconds. */
const SEEK_STEP_SECONDS = 5
/** Bar heights, in px: a silent bucket is still a visible tick, not a gap. */
const BAR_MIN_HEIGHT = 3
const BAR_MAX_HEIGHT = 24
/**
 * How many clips' peaks are kept. A transcript holds at most four players per
 * message and releases its object URLs as it goes, so this only has to stop a
 * long session from growing the map without bound.
 */
const PEAK_CACHE_MAX = 32

/** Whether the bars are real, still being computed, or could not be had. */
type PeakState = 'placeholder' | 'ready' | 'unavailable'

/** Just enough of an AudioBuffer to bucket one. */
interface DecodedClip {
  getChannelData(channel: number): Float32Array
}
interface ClipDecoder {
  decodeAudioData(bytes: ArrayBuffer): Promise<DecodedClip>
}

const peakCache = new Map<string, number[] | null>()
const peaksInFlight = new Map<string, Promise<number[] | null>>()

/**
 * A decoder that does NOT open the box's audio hardware.
 *
 * `OfflineAudioContext` renders to a buffer, so it needs neither an output
 * device nor a user gesture — a live `AudioContext` created during render is
 * born suspended in every browser with an autoplay policy, and on some it
 * counts against the page's gesture budget. The live context stays as the
 * fallback for anything that only has that one; both expose `decodeAudioData`.
 */
function makeDecoder(): ClipDecoder | null {
  const scope = globalThis as unknown as {
    OfflineAudioContext?: new (channels: number, length: number, sampleRate: number) => ClipDecoder
    AudioContext?: new () => ClipDecoder
    webkitAudioContext?: new () => ClipDecoder
  }
  try {
    if (scope.OfflineAudioContext) return new scope.OfflineAudioContext(1, 1, 44100)
    const Live = scope.AudioContext ?? scope.webkitAudioContext
    return Live ? new Live() : null
  } catch {
    return null
  }
}

/** One peak per bucket, normalised — a quiet clip drawn full-scale is a line. */
function bucketPeaks(clip: DecodedClip): number[] {
  const samples = clip.getChannelData(0)
  if (!samples || samples.length === 0) return []
  const step = samples.length / BUCKETS
  const peaks: number[] = []
  let loudest = 0
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    const from = Math.floor(bucket * step)
    const to = Math.min(samples.length, Math.floor((bucket + 1) * step))
    let peak = 0
    for (let i = from; i < to; i++) {
      const value = Math.abs(samples[i])
      if (value > peak) peak = value
    }
    peaks.push(peak)
    if (peak > loudest) loudest = peak
  }
  return loudest > 0 ? peaks.map((peak) => peak / loudest) : peaks
}

function rememberPeaks(src: string, peaks: number[] | null): void {
  if (peakCache.size >= PEAK_CACHE_MAX) {
    const oldest = peakCache.keys().next()
    if (!oldest.done) peakCache.delete(oldest.value)
  }
  peakCache.set(src, peaks)
}

/**
 * The clip's peaks, once per URL.
 *
 * `null` — not a throw — is "this cannot be drawn": a clip in a container the
 * browser will not decode, a media route that refused, no Web Audio at all.
 * The player falls back to a plain progress bar for that, because a reply the
 * owner can still play beats a bar that is missing while a decode is retried.
 */
async function readPeaks(src: string): Promise<number[] | null> {
  const cached = peakCache.get(src)
  if (cached !== undefined) return cached
  const running = peaksInFlight.get(src)
  if (running) return running
  const job = (async () => {
    try {
      const decoder = makeDecoder()
      if (!decoder) return null
      const res = await fetch(src)
      if (!res.ok) return null
      const bytes = await res.arrayBuffer()
      const peaks = bucketPeaks(await decoder.decodeAudioData(bytes))
      return peaks.length > 0 ? peaks : null
    } catch {
      return null
    }
  })()
  peaksInFlight.set(src, job)
  const peaks = await job
  peaksInFlight.delete(src)
  rememberPeaks(src, peaks)
  return peaks
}

/** Test seam: a suite that renders the same URL twice starts from nothing. */
export function resetSpokenReplyPeakCache(): void {
  peakCache.clear()
  peaksInFlight.clear()
}

/** `0:08`. Never negative, never NaN — a clip whose duration is unknown is 0. */
function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export interface SpokenReplyPlayerProps {
  /** The clip. A media-route URL on a transcript, an object URL for a sample. */
  src: string
  /** The clip's accessible name, as the caller already computes it. */
  label: string
  /** What the download control names the file. */
  downloadName: string
  /** Start on mount — the Voice tab's sample, never a reply in a transcript. */
  autoPlay?: boolean
  /** The media element itself, for a caller that drives playback (the sample). */
  onAudioElement?: (element: HTMLAudioElement | null) => void
  /** `data-testid` for the media element; the surfaces are selected by it. */
  audioTestId?: string
  /** The element failed to load or play. */
  onError?: () => void
}

export default function SpokenReplyPlayer({
  src,
  label,
  downloadName,
  autoPlay,
  onAudioElement,
  audioTestId = 'chat-audio',
  onError,
}: SpokenReplyPlayerProps) {
  const { t } = useT()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(0)
  // Which clip the peaks in hand belong to, so a src that changes under this
  // element (a re-rendered transcript reusing it for another reply) falls back
  // to the placeholder during render rather than through a second setState.
  const [decoded, setDecoded] = useState<{ src: string; values: number[] | null } | null>(null)

  // The peaks are a NICETY and are read as one: the reply is on screen and
  // playable from the first frame, and the bars replace the placeholder
  // whenever the decode lands — or never, which is a plain bar, not an error.
  useEffect(() => {
    let current = true
    void readPeaks(src).then((values) => { if (current) setDecoded({ src, values }) })
    return () => { current = false }
  }, [src])

  const attach = useCallback((element: HTMLAudioElement | null) => {
    audioRef.current = element
    onAudioElement?.(element)
  }, [onAudioElement])

  // The element is the source of truth for all four numbers on screen: it is
  // also driven from outside (the Voice tab calls play() on it, the chat
  // pauses one reply when the next starts), so state that only followed this
  // component's own clicks would go stale the moment it was.
  useEffect(() => {
    const element = audioRef.current
    if (!element) return
    const sync = () => {
      setElapsed(element.currentTime || 0)
      setDuration(Number.isFinite(element.duration) ? element.duration : 0)
      setPlaying(!element.paused)
    }
    sync()
    const events = ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'durationchange', 'seeked']
    for (const event of events) element.addEventListener(event, sync)
    return () => { for (const event of events) element.removeEventListener(event, sync) }
  }, [src])

  const toggle = useCallback(() => {
    const element = audioRef.current
    if (!element) return
    if (element.paused) {
      const started = element.play()
      // A browser that wants the gesture and the sound in the same tick can
      // refuse; the control stays where it was rather than claiming to play.
      if (started && typeof started.catch === 'function') started.catch(() => { /* still pressable */ })
    } else {
      element.pause()
    }
  }, [])

  const seekTo = useCallback((seconds: number) => {
    const element = audioRef.current
    if (!element) return
    const total = Number.isFinite(element.duration) ? element.duration : 0
    const next = Math.max(0, Math.min(total, seconds))
    element.currentTime = next
    setElapsed(next)
  }, [])

  const onWaveKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const element = audioRef.current
    if (!element) return
    const at = element.currentTime || 0
    const total = Number.isFinite(element.duration) ? element.duration : 0
    switch (event.key) {
      case 'ArrowRight': case 'ArrowUp': seekTo(at + SEEK_STEP_SECONDS); break
      case 'ArrowLeft': case 'ArrowDown': seekTo(at - SEEK_STEP_SECONDS); break
      case 'Home': seekTo(0); break
      case 'End': seekTo(total); break
      case ' ': case 'Spacebar': case 'Enter': toggle(); break
      default: return
    }
    event.preventDefault()
  }, [seekTo, toggle])

  const scrubToPointer = useCallback((clientX: number, target: HTMLDivElement) => {
    const element = audioRef.current
    if (!element) return
    const box = target.getBoundingClientRect()
    if (!box.width) return
    const total = Number.isFinite(element.duration) ? element.duration : 0
    seekTo(((clientX - box.left) / box.width) * total)
  }, [seekTo])

  const onWavePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const wave = event.currentTarget
    try { wave.setPointerCapture(event.pointerId) } catch { /* not every browser, never fatal */ }
    scrubToPointer(event.clientX, wave)
  }, [scrubToPointer])

  const onWavePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.buttons === 0) return
    scrubToPointer(event.clientX, event.currentTarget)
  }, [scrubToPointer])

  const peaks = decoded && decoded.src === src ? decoded : null
  const peakState: PeakState = peaks ? (peaks.values ? 'ready' : 'unavailable') : 'placeholder'
  const played = duration > 0 ? Math.min(1, elapsed / duration) : 0
  const filledBars = Math.round(played * BUCKETS)
  const bars = peaks?.values ?? null
  const wholeElapsed = Math.round(elapsed)
  const wholeDuration = Math.round(duration)
  // The total at rest, elapsed and total once it has been played: a reply
  // shows how long it is before it is pressed, and where it is after.
  const clock = playing || elapsed > 0
    ? `${formatClock(elapsed)} / ${formatClock(duration)}`
    : formatClock(duration)
  const verb = playing ? t('chat.audioPause') : t('chat.audioPlay')

  return (
    <div className="spoken-reply-player" data-testid="spoken-reply-player">
      {/* The engine. No `controls`: everything they offered is above, and a
          second set of transport buttons inside our own would be two players.
          The `<a download>` child is the ancient no-<audio> fallback and the
          only text this element ever shows. */}
      <audio
        ref={attach}
        data-testid={audioTestId}
        preload="metadata"
        autoPlay={autoPlay}
        src={src}
        onError={onError}
        style={{ display: 'none' }}
      >
        <a href={src} download={downloadName}>{t('chat.downloadAudio')}</a>
      </audio>
      <button
        type="button"
        className="spoken-reply-play"
        data-testid="spoken-reply-play"
        onClick={toggle}
        // The verb of the NEXT press, in front of the name the caller computed.
        aria-label={`${verb} ${label}`}
        title={verb}
      >
        <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 18 }}>
          {playing ? 'pause' : 'play_arrow'}
        </span>
      </button>
      <div
        className="spoken-reply-wave"
        data-testid="spoken-reply-wave"
        data-peaks={peakState}
        role="slider"
        tabIndex={0}
        aria-label={t('chat.audioPosition')}
        aria-valuemin={0}
        aria-valuemax={wholeDuration}
        aria-valuenow={wholeElapsed}
        aria-valuetext={t('chat.audioPositionValue', { elapsed: wholeElapsed, total: wholeDuration })}
        onKeyDown={onWaveKeyDown}
        onPointerDown={onWavePointerDown}
        onPointerMove={onWavePointerMove}
      >
        {bars
          ? bars.map((peak, index) => (
            <span
              key={index}
              aria-hidden
              className={`spoken-reply-bar${index < filledBars ? ' on' : ''}`}
              style={{ height: Math.max(BAR_MIN_HEIGHT, Math.round(peak * BAR_MAX_HEIGHT)) }}
            />
          ))
          // No bars yet, or none to be had: the same control, drawn as the
          // plain progress bar the clip's shape would have decorated.
          : (
            <span aria-hidden className="spoken-reply-track">
              <span className="spoken-reply-track-fill" style={{ width: `${played * 100}%` }} />
            </span>
          )}
      </div>
      <span className="spoken-reply-clock" data-testid="spoken-reply-clock" aria-hidden="true">{clock}</span>
      <a
        className="spoken-reply-download"
        data-testid="spoken-reply-download"
        href={src}
        download={downloadName}
        aria-label={t('chat.downloadAudio')}
        title={t('chat.downloadAudio')}
      >
        <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 15 }}>download</span>
      </a>
    </div>
  )
}
