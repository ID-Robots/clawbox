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
 *    browser's was. Drawing the waveform DOES cost the whole body, so it is
 *    paid on the same terms: once the player is on screen, one clip at a time,
 *    and never for a reply nobody has scrolled to.
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

/**
 * Peaks kept per clip. The mockup's number, and the CEILING on what is drawn:
 * how many bars actually appear is decided from the measured width, because 56
 * of them do not fit a 340px chat (see `barsForWidth`).
 */
const BUCKETS = 56
/** Space each bar needs to read as a bar rather than as a hairline, in px. */
const PX_PER_BAR = 5
/** Never fewer than this many, however narrow — below it, it is not a shape. */
const MIN_BARS = 12
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
/**
 * The rate the clip is decoded AT — not the rate it plays at.
 *
 * `decodeAudioData` resamples to the context's rate, and all this decode is
 * for is a 56-bucket envelope: at 44.1 kHz a 100-second reply (the cap
 * `speech-text.ts` puts on what is spoken) is ~17.6 MB of Float32 held while
 * it is bucketed, on a board with 8 GB shared with the model. 8 kHz is the
 * floor every browser accepts and 5.5x less of it, and an envelope drawn from
 * it is indistinguishable at 56 buckets.
 */
const DECODE_SAMPLE_RATE = 8000

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
let decoder: ClipDecoder | null | undefined
function makeDecoder(): ClipDecoder | null {
  // ONE per document, not one per clip. A live `AudioContext` is hard-capped
  // by the browser (~6 in Chrome, ~4 in Safari), so a context per reply made
  // the fifth clip of a session throw — and the `null` that produced was then
  // cached as "this cannot be drawn" for every clip after it.
  if (decoder !== undefined) return decoder
  const scope = globalThis as unknown as {
    OfflineAudioContext?: new (channels: number, length: number, sampleRate: number) => ClipDecoder
    AudioContext?: new () => ClipDecoder
    webkitAudioContext?: new () => ClipDecoder
  }
  try {
    if (scope.OfflineAudioContext) {
      decoder = new scope.OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE)
    } else {
      const Live = scope.AudioContext ?? scope.webkitAudioContext
      decoder = Live ? new Live() : null
    }
  } catch {
    decoder = null
  }
  return decoder
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
 * ONE decode at a time, for the whole document.
 *
 * Drawing the envelope means pulling the clip's bytes down and decoding them,
 * and a transcript is many clips: fired in parallel they are many megabytes in
 * flight and as many decode buffers alive at once, through the box's own
 * Next.js server, on a Jetson. Serialised they are one at a time, and the
 * player is fully usable throughout — the bars are the last thing to arrive
 * and nothing waits for them.
 */
let decodeQueue: Promise<unknown> = Promise.resolve()

/**
 * The clip's peaks, once per URL.
 *
 * `null` — not a throw — is "this cannot be drawn": a container the browser
 * will not decode, no Web Audio at all, a route that refused. The player falls
 * back to a plain progress bar for that, because a reply the owner can still
 * play beats a bar that is missing while a decode is retried.
 *
 * Only a DEFINITIVE verdict is remembered. A dropped connection or a 5xx from
 * the media route is the box being busy, not a clip that cannot be drawn, and
 * caching it would leave a bare bar for the life of the page — the
 * false-failure shape. Those are answered `null` and left uncached, so the
 * next mount tries again.
 */
async function readPeaks(src: string): Promise<number[] | null> {
  const cached = peakCache.get(src)
  if (cached !== undefined) return cached
  const running = peaksInFlight.get(src)
  if (running) return running
  const job = decodeQueue.then(async (): Promise<number[] | null> => {
    // Whether the answer is about the CLIP (remember it) or about the moment
    // (a dropped connection, a 5xx — ask again next time).
    let definitive = true
    let peaks: number[] | null = null
    try {
      const decode = makeDecoder()
      if (!decode) {
        definitive = false // no Web Audio here; another surface may have it
      } else {
        let res: Response
        try {
          res = await fetch(src)
        } catch {
          definitive = false // the wire, not the clip
          return null
        }
        if (!res.ok) {
          definitive = res.status < 500
          return null
        }
        const bytes = await res.arrayBuffer()
        const bucketed = bucketPeaks(await decode.decodeAudioData(bytes))
        peaks = bucketed.length > 0 ? bucketed : null
      }
      return peaks
    } catch {
      // The decoder refused these bytes: that is about the clip.
      return null
    } finally {
      peaksInFlight.delete(src)
      if (definitive) rememberPeaks(src, peaks)
    }
  })
  peaksInFlight.set(src, job)
  // The queue must not stop at a rejection; `job` resolves either way.
  decodeQueue = job.catch(() => null)
  return job
}

/** Test seam: a suite that renders the same URL twice starts from nothing. */
export function resetSpokenReplyPeakCache(): void {
  peakCache.clear()
  peaksInFlight.clear()
  decodeQueue = Promise.resolve()
}

/**
 * How many bars a track this wide can actually show.
 *
 * 56 of them do not fit every chat: the panel goes down to 340px, where the
 * bubble leaves the track under 90px — and a bar cannot be narrower than a
 * hairline and still read as a bar. So the peaks are bucketed once at 56 and
 * RESAMPLED down to what fits, which is also what stops the control looking
 * like a picket fence of gaps on a phone.
 */
function barsForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return BUCKETS
  return Math.max(MIN_BARS, Math.min(BUCKETS, Math.floor(width / PX_PER_BAR)))
}

/** The same envelope, drawn with fewer bars: the peak of each wider slice. */
function resample(peaks: number[], count: number): number[] {
  if (count >= peaks.length) return peaks
  const step = peaks.length / count
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * step)
    const to = Math.max(from + 1, Math.floor((i + 1) * step))
    let peak = 0
    for (let j = from; j < to && j < peaks.length; j++) if (peaks[j] > peak) peak = peaks[j]
    out.push(peak)
  }
  return out
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
  // The clip itself could not be loaded — the element said so. Kept apart from
  // the peaks: "no waveform" is cosmetic, "no sound" is the control lying.
  // WHICH clip the element refused to load, rather than a bare flag, so a src
  // that changes under this element clears during render instead of through a
  // second setState.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const failed = failedSrc === src
  const waveRef = useRef<HTMLDivElement | null>(null)
  const [waveWidth, setWaveWidth] = useState(0)

  // The peaks are a NICETY and are read as one: the reply is on screen and
  // playable from the first frame, and the bars replace the placeholder
  // whenever the decode lands — or never, which is a plain bar, not an error.
  //
  // Read only once the player is ON SCREEN, and one clip at a time (see
  // readPeaks). Drawing the envelope costs the clip's whole body and a decode
  // buffer, and a replayed transcript can hold fifty of them: eagerly that is
  // tens of megabytes pulled through the box's own server to draw bars nobody
  // has scrolled to. `preload="metadata"` on the element says the same thing
  // about the audio; this is the same promise kept for the picture of it.
  //
  // No IntersectionObserver (an old browser, jsdom) means no way to tell, and
  // then the honest thing is to read it now rather than never.
  useEffect(() => {
    let current = true
    const want = () => { void readPeaks(src).then((values) => { if (current) setDecoded({ src, values }) }) }
    const target = waveRef.current
    const Observer = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver
    if (!target || !Observer) { want(); return () => { current = false } }
    const observer = new Observer((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      want()
    }, { rootMargin: '200px' })
    observer.observe(target)
    return () => { current = false; observer.disconnect() }
  }, [src])

  // How wide the track actually is, so the bar count can follow it. Without a
  // ResizeObserver the full set is drawn, which is what every browser that has
  // one also does at the widths this control was designed for.
  useEffect(() => {
    const target = waveRef.current
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    if (!target || !Observer) return
    const observer = new Observer((entries) => {
      const width = entries[0]?.contentRect?.width
      if (typeof width === 'number') setWaveWidth(width)
    })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  // Held in a ref so the callback ref itself is STABLE: a caller that passes an
  // inline arrow (the Voice tab does) would otherwise hand React a new
  // function every render, and React detaches and re-attaches a ref whose
  // identity changed — calling the caller back with null on every commit.
  const onAudioElementRef = useRef(onAudioElement)
  useEffect(() => { onAudioElementRef.current = onAudioElement }, [onAudioElement])
  const attach = useCallback((element: HTMLAudioElement | null) => {
    audioRef.current = element
    onAudioElementRef.current?.(element)
  }, [])

  // The element is the source of truth for all four numbers on screen: it is
  // also driven from OUTSIDE — the Voice tab calls play() on it through
  // `onAudioElement` — so state that only followed this component's own clicks
  // would go stale the moment it was. (The chat's automatic playback is a
  // detached `new Audio(src)` of its own and never touches this element; that
  // is why a reply can be audibly playing while this transport still reads
  // "play". Pre-existing, and named in the PR body.)
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
  // As many bars as the track can actually show, from the peaks already read.
  const bars = peaks?.values ? resample(peaks.values, barsForWidth(waveWidth)) : null
  const filledBars = Math.round(played * (bars?.length ?? BUCKETS))
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
      {/* The engine, and only that. No `controls`: everything they offered is
          drawn above, and a second set of transport buttons inside our own
          would be two players. It carries no `<a download>` child either — the
          element is `display: none`, so nothing inside it could ever be seen;
          the download beside the clock is the real one. */}
      <audio
        ref={attach}
        data-testid={audioTestId}
        preload="metadata"
        autoPlay={autoPlay}
        src={src}
        // THE definitive answer about the sound, and the one the browser's own
        // bar used to show for us: a transcript keeps its media URLs, and the
        // file behind one can be cleaned up or the session behind it expire.
        // Without this the bubble drew play / 0:00 / a download over a clip
        // that was already known to be gone, and pressing it did nothing and
        // said nothing — the false-success shape, on the one control whose
        // whole job is to be pressable.
        onError={() => { setFailedSrc(src); onError?.() }}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        className="spoken-reply-play"
        data-testid="spoken-reply-play"
        onClick={toggle}
        disabled={failed}
        // The verb of the NEXT press, in front of the name the caller computed.
        aria-label={`${verb} ${label}`}
        title={verb}
      >
        <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 18 }}>
          {playing ? 'pause' : 'play_arrow'}
        </span>
      </button>
      {/* A clip the element could not load says so, in the place the shape
          would have been, and the transport goes with it: a control that is
          still pressable over a missing file is a control that lies. */}
      {failed ? (
        <span className="spoken-reply-gone" data-testid="spoken-reply-unavailable">
          {t('chat.audioUnavailable')}
        </span>
      ) : (
      <div
        ref={waveRef}
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
      )}
      {!failed && (
        <>
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
        </>
      )}
    </div>
  )
}
