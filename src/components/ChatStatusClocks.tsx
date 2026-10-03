'use client'

import { useEffect, useState } from 'react'

import { formatRecordingClock } from '@/lib/chat-voice-input'

// ── The mascot chat's ticking counters ──
//
// Each one owns its own interval. They used to be state in ChatPopup, so every
// tick — once a second for the whole of a turn, even with the chat closed,
// once a second while a reply was being spoken, five times a second while the
// microphone was recording — re-rendered the entire popup to change two
// characters. Here a tick re-renders a span.

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The wall clock, re-read every `everyMs` for as long as the caller is mounted.
 * The interval is re-armed when `since` changes, so a counter handed a new
 * start ticks a whole period after it; until then the reading is older than the
 * new start, which the callers clamp to 0 — exactly what a fresh count shows.
 */
function useNow(since: number, everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [since, everyMs])
  return now
}

/**
 * "· 12s" / "· 3m 5s" after the status line, for the turn that started at
 * `startedAt` (epoch ms). Ticked every second, which is the cadence the
 * popup's own interval had, and rounded as it rounded.
 *
 * aria-hidden for the reason the line gives: it sits in a live region, and a
 * region that re-announced itself every second would talk over the answer.
 */
export function TurnClock({ startedAt }: { startedAt: number }) {
  const now = useNow(startedAt, 1000)
  const s = Math.max(0, Math.round((now - startedAt) / 1000))
  return <span aria-hidden="true">· {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>
}

/**
 * "Speaking the reply… {seconds}s" since `since` (epoch ms) — the moment the
 * box started working on THIS reply's sound. Whole seconds, floored, like the
 * counter it replaces. A new `since` starts the count again from 0, as the
 * popup's reset to 0 did for every reply.
 */
export function SpeakingReplyLabel({ since, t }: { since: number; t: Translate }) {
  const now = useNow(since, 1000)
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return <span>{t("chat.speakingReply", { seconds })}</span>
}

/**
 * The microphone's elapsed time, `m:ss`, counted from the moment it is mounted
 * — which is the moment the composer enters `recording` (the popup mounts it
 * with that state, and a new recording is a new mount).
 *
 * Looked at five times a second so the second turns over within a fifth of a
 * second of the real one, as before; only a reading that changes what is shown
 * is a render, and it is this span's alone. The ten-minute ceiling is NOT
 * here: it is the popup's own timer, armed once per recording, and nothing
 * this clock does can move it.
 *
 * aria-hidden for the same reason as the turn clock: the row is an atomic
 * `role="status"`, and a ticking time inside it would be re-read in full every
 * second.
 */
export function RecordingClock() {
  const [startedAt] = useState(() => Date.now())
  const [shown, setShown] = useState(() => formatRecordingClock(0))
  useEffect(() => {
    // An unchanged string is a state React skips, so four looks in five cost
    // nothing.
    const id = setInterval(() => setShown(formatRecordingClock(Date.now() - startedAt)), 200)
    return () => clearInterval(id)
  }, [startedAt])
  return <span aria-hidden data-testid="voice-clock">{shown}</span>
}
