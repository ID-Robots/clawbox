'use client'

import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, memo } from 'react'
import * as kv from '@/lib/client-kv'
import { useT } from '@/lib/i18n'
import { type MascotPhraseSet } from '@/lib/mascot-phrases'
import { isPhraseCompatible } from '@/lib/mascot-language'
import { NEUTRAL_PACK } from '@/lib/mascot-packs'
import { frenzyQuotesFor } from '@/lib/mascot-frenzy'
import { fetchUserName, fetchPhraseSet, initialPhraseSet, clearPhraseCache, pickNameGreeting, type MascotLine } from '@/lib/mascot-client'
import { MASCOT_KEYFRAMES } from '@/lib/mascot-styles'
import { fetchPetStatus, PET_CHANGED_EVENT, type PetStatus } from '@/lib/pet-client'
import { PET_NEUTRAL_PACK, petSafePhrasesSync } from '@/lib/mascot-pet-voice'
import PetSprite from '@/components/PetSprite'
import EggMascot from '@/components/EggMascot'
import { petLayout, widestFreeSpan, PET_BODY_PX, MASCOT_SHELF_Z_INDEX, type PetLayout, type Span } from '@/lib/pet-layout'
import { pickSpinnerVerb } from '@/lib/spinner-verbs'

// ── ClawBox Mascot — lazy, sarcastic, scandalous ──
//
// Speech-bubble phrases come from `/setup-api/mascot-lines` in the locale the
// UI is currently rendering; the hand-written pack for that locale is the
// fallback, and the language-free neutral pack is the floor (it is what the
// crab says on the very first tick, before the fetch resolves — never
// English, which would be wrong on nine of the ten locales).
//
// Every bubble passes through the language gate in `say()`: a string that is
// not script-compatible with the current locale is not rendered at all.

type MascotState = 'waddle' | 'idle' | 'jump' | 'celebrate' | 'sleep' | 'sass' | 'look' | 'dance' | 'facepalm' | 'frenzy'
const MASCOT_ACTIONS: { state: MascotState; dur: [number, number]; weight: number }[] = [
  { state: 'waddle',    dur: [6000, 12000], weight: 45 },
  { state: 'idle',      dur: [3000, 5000],  weight: 15 },
  { state: 'jump',      dur: [1500, 1500],  weight: 5 },
  { state: 'celebrate', dur: [3000, 3000],  weight: 3 },
  { state: 'sleep',     dur: [6000, 12000], weight: 12 },
  { state: 'sass',      dur: [3500, 5000],  weight: 15 },
  { state: 'look',      dur: [3000, 5000],  weight: 5 },
  { state: 'dance',     dur: [3000, 4000],  weight: 3 },
  { state: 'facepalm',  dur: [3000, 4000],  weight: 2 },
]

const POWER_PARTICLES = [
  { bottom: 24, left: 38, duration: 1.2, delay: 0.15 },
  { bottom: 42, left: 76, duration: 1.5, delay: 0.55 },
  { bottom: 30, left: 108, duration: 1.35, delay: 0.95 },
]

// ── The ground the mascot stands on ──
//
// The crab lives on the desktop floor: `bottom: 8`, in front of the shelf,
// feet hidden behind it. A pet instead walks the TOP EDGE of the bottom bar,
// so it reads as standing ON the shelf.
//
// The bar is `ChromeShelf.tsx`, which carries `data-mascot-ground` — NOT
// `Taskbar.tsx`, which is not mounted by any surface in this app. Its height
// is `56px + env(safe-area-inset-bottom)`, so the ground line is measured off
// the live element rather than written down here: the inset is a device
// property and the whole bar re-lays out on resize.
const CRAB_GROUND_PX = 8
/** Roaming range, in vw of the body's CENTRE. */
const CRAB_WALK_RANGE = { min: 5, max: 88 }
/** Drag/physics range — wider than roaming, the crab may be thrown further. */
const CRAB_BOUNDS = { min: 2, max: 92 }
/** The crab's own body box. A pet's is `PET_BODY_PX`, which is smaller. */
const CRAB_BODY_PX = 150
/**
 * How the crab ART sits inside that box.
 *
 * Every offset in this file — the bubble at `bottom: 155`, the thinking dots,
 * the ZZZ cluster, the 60px drag hit-box, the ground line the feet stand on —
 * was measured against the original artwork, whose PNG carried a third of its
 * height as transparent padding below the crab: drawn `contain` into the
 * 150px box, the visible crab was ~73px wide and ~61px tall with its feet
 * 50px above the box's bottom edge (i.e. standing on the shelf's top edge,
 * the box overlapping the bar). `public/clawbox-crab.png` is now a tight
 * square (186x146 px of crab in 192x192), so the same footprint is reproduced
 * explicitly: a 78px square whose art lands ~76px wide, ~59px tall, with its
 * feet 42 + 8.5 ≈ 50px up. Change these together with the artwork, never one
 * without the other.
 */
const CRAB_ART_PX = 78
const CRAB_ART_BOTTOM_PX = 42

/**
 * Clearance between the top of the pet's VISIBLE ART and its bubble.
 *
 * Measured off the drawing, not the cell. A Petdex sheet insets its character
 * inside the 192x208 cell by an amount that differs per pet and per animation
 * row, so anchoring to the cell made the same 26px read as anything from 29px
 * (boba) to 56px (cash-cuy facepalming). `petLayout().headPx` is how far the
 * row's tallest frame actually reaches above the ground line, so the gap above
 * the head is now the same number for every pet in every state. Large enough to
 * swallow the bubble's own 6px tail and still leave an obvious gap.
 */
const PET_BUBBLE_GAP_PX = 26
/** Breathing room between a bubble and the edge of the screen. */
const BUBBLE_EDGE_MARGIN_PX = 8

/**
 * Where the mascot paints.
 *
 * The pet's layer (`MASCOT_SHELF_Z_INDEX`, shared with the fresh-box egg) is
 * defined in `pet-layout.ts` next to `PET_BODY_PX`. The crab keeps its own:
 * it sits above the shelf (10000) and always has — it is ClawBox's own
 * decoration and OpenClaw's rendering does not move.
 */
const PET_Z_INDEX = MASCOT_SHELF_Z_INDEX
const CRAB_Z_INDEX = 10001

/**
 * A pet falls harder than the crab.
 *
 * The crab's 800 px/s² is a deliberately floaty, cartoon arc for a mascot that
 * lives on the open desktop. A pet is thrown at a taskbar a few hundred pixels
 * below it, and the same numbers left it drifting: ~390 px above the bar 2.6 s
 * after release, ~6 s to settle. These land it in about a second without
 * turning the throw into a drop.
 */
const PET_PHYSICS = { gravity: 2400, friction: 420, bounciness: 0.42 }
/** The crab's, unchanged — its arc is part of how OpenClaw's desktop reads. */
const CRAB_PHYSICS = { gravity: 800, friction: 200, bounciness: 0.6 }

/** A pet strolls at a fixed px/s, so it does not sprint on a wide screen. */
const PET_WALK_SPEED_PX_S = 42
/** How far one stroll travels, in px, before the lane clamps it. */
const PET_WALK_DISTANCE_PX = { min: 90, max: 280 }
const PET_WALK_MS = { min: 2500, max: 12000 }

interface Range { min: number; max: number }

/**
 * Take pointer capture, tolerating a pointer id that is not live.
 *
 * `setPointerCapture` throws `NotFoundError` when no active pointer carries the
 * id — a programmatic `element.click()` and an assistive-technology activation
 * both reach the handler with one. The optional call only ever guarded a
 * MISSING METHOD, so those paths surfaced an uncaught error out of the mascot.
 */
function capturePointer(e: React.PointerEvent) {
  try {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  } catch {
    // Nothing to capture. Real pointers are unaffected; a synthetic click has
    // no drag to retarget in the first place.
  }
}

const clampTo = (range: Range, v: number) => Math.min(range.max, Math.max(range.min, v))

/** The tighter of two ranges, collapsed to a point if they do not overlap. */
function intersectRange(a: Range, b: Range): Range {
  const min = Math.max(a.min, b.min)
  const max = Math.min(a.max, b.max)
  return min < max ? { min, max } : { min: (min + max) / 2, max: (min + max) / 2 }
}

function ClawBoxMascot({ onTap, frozen, thinking, onPositionChange, rightInset }: { onTap?: (x?: number) => void; frozen?: boolean; thinking?: boolean; onPositionChange?: (x: number) => void; rightInset?: number } = {}) {
  const { locale, localeResolved } = useT()
  // The verb at the thinking dots, picked once per thinking episode so it
  // reads as one word for one wait, not a slot machine.
  const [thinkingVerb, setThinkingVerb] = useState<string | null>(null)
  useEffect(() => {
    if (!thinking) { setThinkingVerb(null); return }
    setThinkingVerb((prev) => pickSpinnerVerb(prev))
  }, [thinking])
  // Read by `say()` — the language gate must judge against the locale the UI
  // is rendering RIGHT NOW, and `say` is a stable callback.
  //
  // Empty until the provider's `pref:ui_language` fetch lands. Every
  // I18nProvider starts at a PROVISIONAL "en", and the first bubble is
  // scheduled 500ms (sleep-resume) to 2000ms after mount — squarely inside
  // that window. Gating against the provisional value would wave English
  // through on a Bulgarian box; gating against "" fails closed, so only
  // script-neutral lines (the neutral pack) render until the language is
  // known. See `isPhraseCompatible`: an unknown locale allows "neutral" only.
  const gateLocale = localeResolved ? locale : ''
  const localeRef = useRef(gateLocale)
  localeRef.current = gateLocale
  const frozenRef = useRef(false)
  const onPositionChangeRef = useRef(onPositionChange)
  onPositionChangeRef.current = onPositionChange
  // ─── All mutable state in refs to avoid stale closures ───
  const DEFAULT_POS = { x: 85 }
  const savedPos = useRef<{ x: number } | null>(null)
  if (savedPos.current === null) {
    savedPos.current = kv.getJSON<{ x: number }>('clawbox-crab-pos') ?? DEFAULT_POS
  }
  const xRef = useRef(savedPos.current?.x ?? DEFAULT_POS.x)
  const [mounted, setMounted] = useState(false)

  // Speech
  const [speech, setSpeech] = useState('')
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((line: string | MascotLine | null | undefined, ms = 3000) => {
    // Call sites index phrase-category arrays; an empty category yields
    // `undefined`, and the destructuring below would throw from inside a timer
    // (the frenzy and sleep cycles both call `say` on an interval). Bail here,
    // once, rather than guarding every call site.
    if (line == null) return
    const template = typeof line === 'string' ? line : line.template
    const text = typeof line === 'string' ? line : line.text
    // ── INV-1 render gate ──
    // Nothing reaches a bubble unless it is script-compatible with the UI
    // locale. Judged on the TEMPLATE, before `{name}` was substituted: the
    // owner's name may be in any script and must not silence the crab.
    if (!isPhraseCompatible(template, localeRef.current)) return
    // Clear any in-flight clear timer first: without this, an older bubble's
    // timeout fires and blanks a newer bubble early (visible flicker during
    // frenzy / rapid taps), and a late fire can setState after unmount.
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current)
    setSpeech(text)
    speechTimerRef.current = setTimeout(() => setSpeech(''), ms)
  }, [])
  const sayRef = useRef<((line: string | MascotLine, ms?: number) => void) | null>(null)
  sayRef.current = say

  // Simple sleeping state (no tamagotchi engine)
  const [isSleeping, setIsSleeping] = useState(false)
  const isSleepingRef = useRef(false)
  isSleepingRef.current = isSleeping

  // Hidden state (persisted) + context menu
  const [hidden, setHidden] = useState(() => {
    if (typeof window === 'undefined') return false
    return kv.get('clawbox-mascot-hidden') === '1'
  })
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxOpenedAt = useRef(0)

  // ── Which body this mascot wears ──
  //
  // OpenClaw boxes wear the crab and nothing here changes for them: the route
  // answers `supported: false` from the edition lock, so no pet code runs.
  // Hermes boxes wear the pet the user picked in Settings — the crab is
  // ClawBox's own brand and is not offered on a device that does not run
  // ClawBox's own harness.
  //
  // `null` means "not known yet". We hold the whole mascot back for that one
  // round-trip rather than painting a crab and swapping it: a Hermes box must
  // never flash the crab, and on OpenClaw the delay is a local fetch on a
  // decoration that idles for two seconds before its first move anyway.
  //
  // A fresh Hermes box has no pet installed (upstream installs none, and the
  // first one is a ~2.2 MB download), so `supported && !active` wears the
  // fresh-box egg (`EggMascot`) instead — a placeholder that sits on the shelf
  // and hatches a random curated pet when clicked (the picker still changes it). Still no crab: that is
  // ClawBox's own brand, not a stand-in on someone else's harness. The body
  // choice itself is the guard ladder just above the render (search
  // `EggMascot`).
  const [petStatus, setPetStatus] = useState<PetStatus | null>(null)
  const petStatusRef = useRef<PetStatus | null>(null)
  petStatusRef.current = petStatus
  useEffect(() => {
    let cancelled = false
    const load = () => { fetchPetStatus().then(s => { if (!cancelled) setPetStatus(s) }) }
    load()
    window.addEventListener(PET_CHANGED_EVENT, load)
    return () => { cancelled = true; window.removeEventListener(PET_CHANGED_EVENT, load) }
  }, [])
  const pet = petStatus?.supported ? petStatus.active : null

  // ── Where this body may go ──
  //
  // Three numbers, all of which differ between the crab and a pet: the ground
  // line, the roaming range and the drag/physics bounds. Refs because the
  // movement code runs inside rAF loops and stable callbacks; `groundPx` is
  // mirrored into state because the resting `bottom` is a rendered style.
  const groundRef = useRef(CRAB_GROUND_PX)
  const [groundPx, setGroundPx] = useState(CRAB_GROUND_PX)
  const walkRangeRef = useRef<Range>({ ...CRAB_WALK_RANGE })
  const boundsRef = useRef<Range>({ ...CRAB_BOUNDS })
  /** The body box currently worn. Read by the physics loop, which used to
   *  hardcode the crab's 150 and stopped a flung pet 38px short of the ceiling. */
  const bodyPxRef = useRef(CRAB_BODY_PX)
  bodyPxRef.current = pet ? PET_BODY_PX : CRAB_BODY_PX
  /**
   * How far the body is ABOVE its ground line, in px.
   *
   * The single vertical truth. It used to be split between an imperative
   * `bottom: 0px` + `translateY(-posY)` written by the physics loop and a
   * declarative `bottom: physicsActive ? 0 : groundPx` written by React, and
   * the two disagreed on every path where one ran without the other: the
   * mascot settled 56px INTO the taskbar (the imperative `bottom` stuck while
   * the translateY was gone), or dropped a whole ground height the instant
   * physics turned on with a stale `posY`. Now `bottom` is always `groundPx`
   * and every writer — physics, drag, the jump hop, the React render — puts
   * its offset here, so there is nothing left to desynchronise.
   */
  const liftRef = useRef(0)
  /** Re-run the ground/lane measurement. Set by the effect below. */
  const measureRef = useRef<(() => boolean) | null>(null)

  // The ground line and the roaming lane are LAID OUT, not animated, so this is
  // a layout effect: an ordinary effect let the pet paint one frame at the
  // crab's 8px desktop floor and then visibly jump onto the bar.
  useLayoutEffect(() => {
    if (!pet) {
      groundRef.current = CRAB_GROUND_PX
      walkRangeRef.current = { ...CRAB_WALK_RANGE }
      boundsRef.current = { ...CRAB_BOUNDS }
      measureRef.current = null
      setGroundPx(CRAB_GROUND_PX)
      return
    }
    let observer: ResizeObserver | null = null
    let observed: Element | null = null
    let watchable = true
    // Wrapped because this is decoration: a runtime without ResizeObserver —
    // or with a partial stand-in for one — must cost the mascot a live
    // remeasure, not its whole existence. An effect that throws unmounts the
    // tree, and the desktop would lose its mascot over a resize listener.
    const watch = (el: Element) => {
      if (observed === el || !watchable) return
      try {
        if (typeof ResizeObserver !== 'function') { watchable = false; return }
        observer?.disconnect()
        observer = new ResizeObserver(() => { measure() })
        observer.observe(el)
        observed = el
      } catch (err) {
        // Said once: `measure` runs on every resize, and a runtime with a
        // half-implemented stand-in would otherwise log on each one.
        console.warn('[mascot] could not watch the shelf for resizes:', err)
        watchable = false
        observer = null
        observed = null
      }
    }

    const measure = (): boolean => {
      const el = document.querySelector('[data-mascot-ground]') as HTMLElement | null
      if (!el) return false
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth || 1
      if (rect.width <= 0 || rect.height <= 0) return false
      // The shelf can REMOUNT (the dock re-renders when an app is installed),
      // which left the observer holding a detached node and only
      // `window.resize` still working. Re-point it at what is on screen now.
      watch(el)
      // The pet's feet sit on the bar's top edge; `bottom` is measured from
      // the viewport bottom, which is what the mascot's `position: fixed` uses.
      const ground = Math.max(0, Math.round(window.innerHeight - rect.top))
      groundRef.current = ground
      setGroundPx(ground)

      // The desktop icon grid's bottom padding is exactly the bar height, so
      // its lowest icons stand IN the pet's band — the pet covered the bottom
      // icon and, at a body box of `pointer-events: auto`, swallowed its clicks.
      // Subtract whatever actually intrudes rather than assuming a column
      // width: the grid is centred and its geometry changes with the viewport.
      const half = PET_BODY_PX / 2
      const bandTop = rect.top - PET_BODY_PX
      const blockers: Span[] = []
      document.querySelectorAll('[data-desktop-icon-id]').forEach((node) => {
        const r = (node as HTMLElement).getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return
        if (r.bottom <= bandTop || r.top >= rect.top) return
        blockers.push({ lo: r.left, hi: r.right })
      })
      const free = widestFreeSpan(rect.left, rect.right, blockers)
      // Only honour the gap if a pet can actually stroll in it; a desktop
      // packed edge to edge should leave it on the bar, not pin it to a point.
      const usable = free.hi - free.lo >= PET_BODY_PX * 3 ? free : { lo: rect.left, hi: rect.right }

      // The shelf is full-bleed today, so this mostly reproduces the crab's
      // own range — but it is derived from the bar rather than assumed, which
      // is what keeps the pet ON it if the bar is ever inset or centred.
      const onBar: Range = {
        min: ((usable.lo + half) / vw) * 100,
        max: ((usable.hi - half) / vw) * 100,
      }
      // Mutated in place, never replaced: an in-flight walk captures the range
      // object once and clamps against it for the next 6-12 s, so handing out
      // a NEW object on resize left that walk driving the pet off the new bar.
      const walk = intersectRange(onBar, CRAB_WALK_RANGE)
      walkRangeRef.current.min = walk.min
      walkRangeRef.current.max = walk.max
      const bounds = intersectRange(onBar, CRAB_BOUNDS)
      boundsRef.current.min = bounds.min
      boundsRef.current.max = bounds.max
      xRef.current = clampTo(boundsRef.current, xRef.current)
      updateCrabPosRef.current?.()
      return true
    }
    measureRef.current = measure

    // The shelf can mount after the mascot does. A single failed
    // querySelector used to leave the pet standing at the crab's 8px floor,
    // behind the bar, for the rest of the session — this effect only re-runs
    // when the PET changes, which it never did.
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const attempt = () => {
      timer = null
      if (measure()) return
      if (++retries > 40) {
        console.warn('[mascot] no [data-mascot-ground] on this surface; the pet keeps the desktop floor')
        return
      }
      timer = setTimeout(attempt, 100)
    }
    attempt()

    const onResize = () => { measure() }
    window.addEventListener('resize', onResize)
    return () => {
      if (timer) clearTimeout(timer)
      measureRef.current = null
      window.removeEventListener('resize', onResize)
      try { observer?.disconnect() } catch { /* same reason as above */ }
    }
  }, [pet])

  // Categorized phrase set for the current locale. Starts on whatever can be
  // had synchronously — the locale's pack if it is already in memory, the
  // language-free neutral pack otherwise — so the first bubble is never in
  // the wrong language. Re-fetches when the locale changes so a language
  // switch flips the bag immediately instead of at the next midnight expiry.
  const phrasesRef = useRef<MascotPhraseSet>(NEUTRAL_PACK)
  const sassLinesRef = useRef<string[]>(NEUTRAL_PACK.sass)

  // ── Crab lines are the crab's ──
  //
  // A pet never speaks a crab-literal line, in any category or locale. The
  // route already filters what it serves, but the filter is repeated here
  // because the client has two other sources the server never sees: the
  // synchronous first set (`initialPhraseSet`, drawn straight from the pack)
  // and the neutral floor. It also has to survive a pet being picked AFTER
  // the phrases were fetched — Settings fires PET_CHANGED_EVENT, and
  // re-deriving from the raw set is cheaper and quicker than another fetch.
  const rawPhrasesRef = useRef<MascotPhraseSet>(NEUTRAL_PACK)
  const petVoiceRef = useRef(false)
  /** The floor every category falls back to — crab-free while a pet is worn. */
  const neutralRef = useRef<MascotPhraseSet>(NEUTRAL_PACK)
  const applyVoice = useCallback((raw: MascotPhraseSet, loc: string) => {
    rawPhrasesRef.current = raw
    const next = petVoiceRef.current ? petSafePhrasesSync(raw, loc) : raw
    phrasesRef.current = next
    sassLinesRef.current = next.sass
  }, [])
  useEffect(() => {
    petVoiceRef.current = !!pet
    neutralRef.current = pet ? PET_NEUTRAL_PACK : NEUTRAL_PACK
    applyVoice(rawPhrasesRef.current, locale)
  }, [pet, locale, applyVoice])

  // Per-effect token so a slow fetch from a stale locale (e.g. en→bg→en in
  // quick succession) can't overwrite the phrase set with the wrong language.
  const phraseFetchTokenRef = useRef(0)
  useEffect(() => {
    // Wait for the real locale. Seeding from the provisional "en" would hand
    // a non-English box the full ENGLISH pack (`packForSync('en')` — `en` is
    // the one pack bundled statically, so it is always "already loaded"), and
    // the fetch would ask the server for `?locale=en`, which unconditionally
    // kicks off a ~3 minute on-device generation for a language this box will
    // never show — and leaves the model busy when the real locale's request
    // arrives moments later. The refs stay on NEUTRAL_PACK until then.
    if (!localeResolved) return
    const load = () => {
      const myToken = ++phraseFetchTokenRef.current
      applyVoice(initialPhraseSet(locale), locale)
      fetchPhraseSet(locale).then((phrases) => {
        if (myToken !== phraseFetchTokenRef.current) return
        applyVoice(phrases, locale)
      })
    }
    load()
    // Settings just had the device generate a new batch. The client cache is
    // keyed by day, so without dropping it the new lines would not show up
    // until tomorrow — which reads as the button having done nothing. The
    // reloaded set goes through `applyVoice` like every other one, so a worn
    // pet does not start speaking crab lines just because they are new.
    const onRegenerated = () => { clearPhraseCache(); load() }
    window.addEventListener('clawbox-mascot-phrases-changed', onRegenerated)
    return () => window.removeEventListener('clawbox-mascot-phrases-changed', onRegenerated)
  }, [locale, localeResolved, applyVoice])

  // User name (from `ui_user_name` preference) — used in occasional name
  // greetings. Falls back to a randomly-picked friendly placeholder so
  // popups still feel personal even before the user sets a name.
  const userNameRef = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchUserName().then(name => { if (!cancelled) userNameRef.current = name })
    const onChanged = () => { fetchUserName().then(name => { if (!cancelled) userNameRef.current = name }) }
    window.addEventListener('clawbox-user-name-changed', onChanged)
    return () => { cancelled = true; window.removeEventListener('clawbox-user-name-changed', onChanged) }
  }, [])

  // Resolve a name to use right now: the configured one, or a random
  // fallback from the current phrase set so the same placeholder doesn't
  // get stuck on screen.
  const resolveName = useCallback((): string => {
    if (userNameRef.current) return userNameRef.current
    const fallbacks = phrasesRef.current.nameFallbacks.length > 0
      ? phrasesRef.current.nameFallbacks
      : neutralRef.current.nameFallbacks
    return fallbacks[Math.floor(Math.random() * fallbacks.length)]
  }, [])

  // Close context menu on click/right-click elsewhere
  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: Event) => {
      if (Date.now() - ctxOpenedAt.current < 100) return
      e.preventDefault()
      setCtxMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
  }, [ctxMenu])

  // ─── DOM refs for direct manipulation (no React re-renders during animation) ───
  const crabElRef = useRef<HTMLDivElement>(null)
  const jumpYRef = useRef(0)
  const facingRef = useRef<'left' | 'right'>('right')
  /** The pet's bubble, its measured width, and the clamp that keeps it on
   *  screen — see `positionBubble`. */
  const bubbleElRef = useRef<HTMLDivElement>(null)
  const bubbleWRef = useRef(0)
  const positionBubbleRef = useRef<(() => void) | null>(null)

  // ─── Render state (only for things that need React re-render) ───
  const [powerStance, setPowerStance] = useState(false)
  const [facing, setFacing] = useState<'left' | 'right'>('right')
  const [state, setState] = useState<MascotState>('idle')
  const [frenzy, setFrenzy] = useState(false)
  // Read by `doAction`, which is a stable callback and would otherwise close
  // over a stale `frenzy`. See the bail-out there.
  const frenzyRef = useRef(false)
  const [moneyParticles, setMoneyParticles] = useState<{id: number; x: number; delay: number; duration: number; emoji: string}[]>([])
  const [damageFloaters, setDamageFloaters] = useState<{id: number; dmg: number; x: number}[]>([])
  const stateTimeout = useRef<ReturnType<typeof setTimeout>>(null)
  const sleepZzzRef = useRef<ReturnType<typeof setInterval>>(null)
  const walkInterval = useRef<ReturnType<typeof setInterval>>(null)
  const powerStanceRef = useRef(false)
  const frenzyTimeout = useRef<ReturnType<typeof setTimeout>>(null)
  const frenzyIntervalsRef = useRef<ReturnType<typeof setInterval>[]>([])
  const doActionRef = useRef<() => void>(() => {})
  const draggingRef = useRef(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  // ImpactJS-style physics engine state
  const physicsRef = useRef({
    active: false,
    velX: 0,        // px/s
    velY: 0,        // px/s
    posY: 0,        // px from bottom of screen
    /** Ignore platforms until the next real landing — how the mascot steps
     *  OFF a desktop icon it settled on instead of re-landing on it forever. */
    dropThrough: false,
    gravity: 800,   // px/s² — lighter, more floaty
    friction: 200,  // px/s decel — less friction, slides more
    bounciness: 0.6,
    minBounceVel: 40,
    maxVel: 2500,   // higher max so you can really fling it
    lastTime: 0,
    lastPointerX: 0,
    lastPointerY: 0,
    lastPointerTime: 0,
  })
  const physicsRAF = useRef<number>(0)

  // ─── Direct DOM update for position (bypasses React render cycle) ───
  const saveCrabPos = useCallback(() => {
    kv.setJSON('clawbox-crab-pos', { x: xRef.current })
  }, [])

  /**
   * The mascot's transform, and the only place it is written.
   *
   * `translateY` is not optional here. It used to be missing from this path
   * entirely, so `jumpYRef` was written 60x/s by the jump and frenzy loops and
   * read by nothing — the pet played its `jumping` row glued to the ground
   * line. And `scaleX` used to be missing from the PHYSICS path, so a bubble
   * that spoke mid-throw (an impact reaction does) counter-flipped a flip that
   * was not applied and rendered its text mirror-reversed.
   */
  const writeCrabTransform = useCallback(() => {
    const el = crabElRef.current
    if (!el) return
    const scaleX = facingRef.current === 'left' ? -1 : 1
    const y = jumpYRef.current - liftRef.current
    el.style.transform = `translateX(calc(${xRef.current}vw - 50%)) translateY(${y.toFixed(2)}px) scaleX(${scaleX})`
    positionBubbleRef.current?.()
  }, [])

  const updateCrabPos = useCallback(() => {
    writeCrabTransform()
    saveCrabPos()
  }, [writeCrabTransform, saveCrabPos])

  /**
   * Keep the pet's bubble on screen.
   *
   * It is centred on the body and capped at 210px with nothing clamping it
   * against the viewport, so at the left end of the lane it ran off the edge —
   * border, corner and leading glyph sliced off at x=0. Wrapping caps the
   * WIDTH; it never repositions. The shift is expressed in the shell's own
   * coordinate space, which is mirrored when the pet faces left, hence the sign.
   *
   * Imperative for the same reason the position is: the pet walks inside a rAF
   * loop that deliberately never re-renders React.
   */
  const bubbleTransformRef = useRef('')
  const positionBubble = useCallback(() => {
    const el = bubbleElRef.current
    const width = bubbleWRef.current
    if (!el || width <= 0) return
    const vw = window.innerWidth || 1
    const centre = (xRef.current / 100) * vw
    const m = BUBBLE_EDGE_MARGIN_PX
    let shift = 0
    if (centre - width / 2 < m) shift = m - (centre - width / 2)
    else if (centre + width / 2 > vw - m) shift = vw - m - (centre + width / 2)
    const mirrored = facingRef.current === 'left'
    const local = (shift * (mirrored ? -1 : 1)).toFixed(2)
    const next = `translateX(calc(-50% + ${local}px)) scaleX(${mirrored ? -1 : 1})`
    // Called from the position writer, which runs every animation frame; most
    // frames do not move the bubble at all.
    if (next === bubbleTransformRef.current) return
    bubbleTransformRef.current = next
    el.style.transform = next
  }, [])
  positionBubbleRef.current = positionBubble
  // The ground/lane measurement runs before this callback exists in source
  // order, and re-clamps the mascot into the taskbar the moment it resolves.
  const updateCrabPosRef = useRef<(() => void) | null>(null)
  updateCrabPosRef.current = updateCrabPos

  // Wrapper setters that update refs + DOM directly (no React setState for position)
  const setX = useCallback((v: number | ((p: number) => number)) => {
    if (typeof v === 'function') xRef.current = v(xRef.current)
    else xRef.current = v
    updateCrabPos()
  }, [updateCrabPos])

  const setJumpY = useCallback((v: number) => {
    jumpYRef.current = v
    // Position has not changed — no reason to touch localStorage 60x/s.
    writeCrabTransform()
  }, [writeCrabTransform])

  /**
   * Face a direction. Ref AND state, always.
   *
   * The rendered transform reads the ref; the speech bubble's counter-flip
   * reads the state. The physics loop used to write only the ref, so after a
   * throw changed direction the two disagreed and the bubble rendered its text
   * (and its tail) mirrored until something else called this.
   */
  const faceTowards = useCallback((dir: 'left' | 'right') => {
    if (facingRef.current === dir) return
    facingRef.current = dir
    setFacing(dir)
  }, [])

  const setFacingDirect = useCallback((dir: 'left' | 'right') => {
    faceTowards(dir)
    updateCrabPos()
  }, [faceTowards, updateCrabPos])

  /**
   * The landing squash.
   *
   * The crab deforms its `<img>`. A pet has no `<img>` — it is a
   * background-image div carrying its own centring and facing transform — so
   * the crab's version silently never played for one, and a pet landed dead
   * flat. The pet rides two custom properties the sprite's transform already
   * multiplies in, so the squash cannot clobber the centring or the flip.
   */
  const squashBody = useCallback(() => {
    const root = crabElRef.current
    if (!root) return
    const img = root.querySelector('img')
    if (img) {
      img.style.transition = 'transform 0.1s'
      img.style.transform = 'scaleY(0.7) scaleX(1.3)'
      setTimeout(() => { img.style.transform = ''; img.style.transition = '' }, 150)
      return
    }
    const sprite = root.querySelector('[data-pet]') as HTMLElement | null
    if (!sprite) return
    sprite.style.transition = 'transform 0.1s'
    sprite.style.setProperty('--pet-squash-x', '1.3')
    sprite.style.setProperty('--pet-squash-y', '0.7')
    setTimeout(() => {
      sprite.style.removeProperty('--pet-squash-x')
      sprite.style.removeProperty('--pet-squash-y')
      sprite.style.transition = ''
    }, 150)
  }, [])

  // A pet is thrown AT a bar a few hundred pixels below it, where the crab's
  // deliberately floaty arc read as drifting: ~390px above the bar 2.6s after
  // release and ~6s to come to rest. The crab keeps its own numbers exactly.
  useEffect(() => {
    const p = physicsRef.current
    const tuning = pet ? PET_PHYSICS : CRAB_PHYSICS
    p.gravity = tuning.gravity
    p.friction = tuning.friction
    p.bounciness = tuning.bounciness
  }, [pet])

  // ─── Impact damage: take health damage when hitting surfaces at high speed ───
  const IMPACT_THRESHOLD = 600  // px/s — below this, no damage
  const IMPACT_DAMAGE_SCALE = 0.025 // damage per px/s above threshold
  const applyImpactDamage = useCallback((impactVel: number) => {
    const speed = Math.abs(impactVel)
    if (speed < IMPACT_THRESHOLD) return
    const dmg = (speed - IMPACT_THRESHOLD) * IMPACT_DAMAGE_SCALE
    // Spawn floating damage number
    const id = Date.now() + Math.random()
    const x = -20 + Math.random() * 40
    setDamageFloaters(prev => [...prev, { id, dmg: Math.round(dmg), x }])
    setTimeout(() => setDamageFloaters(prev => prev.filter(f => f.id !== id)), 1200)
    // Emoji-only on purpose: an impact reaction has to work in every locale,
    // and the phrase packs have no "ouch" category.
    if (speed > 1200) say('💀💥', 1500)
    else if (speed > 800) say('🤕', 1200)
  }, [say])

  // ─── ImpactJS-style physics tick (runs after drop) ───
  const physicsLoop = useCallback(function runPhysicsLoop() {
    const p = physicsRef.current
    if (!p.active || draggingRef.current) return

    const now = performance.now()
    const dt = Math.min((now - p.lastTime) / 1000, 0.05) // cap delta to avoid spiral
    p.lastTime = now

    // Apply gravity (ImpactJS: vel.y += gravity * tick * gravityFactor)
    p.velY += p.gravity * dt

    // Apply friction to X (ImpactJS getNewVelocity with friction)
    if (p.velX > 0) {
      p.velX = Math.max(0, p.velX - p.friction * dt)
    } else if (p.velX < 0) {
      p.velX = Math.min(0, p.velX + p.friction * dt)
    }

    // Clamp velocity
    p.velX = Math.max(-p.maxVel, Math.min(p.maxVel, p.velX))
    p.velY = Math.max(-p.maxVel, Math.min(p.maxVel, p.velY))

    // Move
    const vw = window.innerWidth
    const vh = window.innerHeight
    xRef.current += (p.velX * dt / vw) * 100
    p.posY -= p.velY * dt // posY = height from ground, velY positive = falling

    // ─── Collision: platforms (desktop icons with data-crab-platform) ───
    const crabPxX = (xRef.current / 100) * vw
    const crabBottom = vh - p.posY  // crab's feet in screen coords (from top)
    // Crab hitbox: narrower than the full 150px image — just the body (~60px wide, centered)
    const crabHitW = 60
    const crabLeft = crabPxX - crabHitW / 2
    const crabRight = crabPxX + crabHitW / 2
    let landedOnPlatform = false

    const platforms: Element[] = p.dropThrough
      ? []
      : Array.from(document.querySelectorAll('[data-crab-platform]'))
    platforms.forEach((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect()
      // Horizontal overlap check with tight hitbox
      if (crabRight > rect.left && crabLeft < rect.right) {
        const platformTop = rect.top
        // A "platform" at or below the ground line is not one — the shelf's own
        // app buttons carry `data-crab-platform` and their tops sit a few px
        // INSIDE the bar, which is how a pet ended up resting sunk into it.
        if (platformTop >= vh - groundRef.current) return
        // Falling onto platform: crab feet crossing platform top
        if (p.velY > 0 && crabBottom >= platformTop && crabBottom <= platformTop + rect.height * 0.5) {
          p.posY = vh - platformTop
          landedOnPlatform = true
        }
        // Already standing on platform
        if (Math.abs(crabBottom - platformTop) < 5 && p.velY >= 0) {
          p.posY = vh - platformTop
          landedOnPlatform = true
        }
      }
    })

    if (landedOnPlatform) {
      applyImpactDamage(p.velY)
      if (p.bounciness > 0 && Math.abs(p.velY) > p.minBounceVel) {
        p.velY *= -p.bounciness
        squashBody()
      } else {
        p.velY = 0
        if (Math.abs(p.velX) < 5) {
          // Perch. The resting height lives in `liftRef` like every other
          // vertical offset, so settling on an icon no longer means "settle,
          // then get teleported down to the shelf by the next React render" —
          // there IS a state for standing on a platform now. The next action
          // steps off it (see doAction).
          p.active = false
          liftRef.current = Math.max(0, p.posY - groundRef.current)
          updateCrabPos()
          setTimeout(() => doActionRef.current(), 2000)
          return
        }
      }
    }

    // ─── Collision: floor ───
    // Floor (crab feet on shelf — crab image hangs below anchor point)
    const crabFloor = groundRef.current
    if (p.posY <= crabFloor) {
      p.posY = crabFloor
      applyImpactDamage(p.velY)
      if (p.bounciness > 0 && Math.abs(p.velY) > p.minBounceVel) {
        p.velY *= -p.bounciness
        squashBody()
      } else {
        p.velY = 0
        // Landed — stop physics if X vel is also ~0
        if (Math.abs(p.velX) < 5) {
          p.active = false
          p.dropThrough = false
          liftRef.current = 0
          updateCrabPos()
          setTimeout(() => doActionRef.current(), 2000)
          return
        }
      }
    }

    // ─── Collision: ceiling ───
    const crabVh = window.innerHeight
    // The body box, not the crab's 150: a pet's is smaller, and hardcoding the
    // crab's stopped a flung pet nearly 40px short of the ceiling.
    const bodyBox = bodyPxRef.current
    if (p.posY >= crabVh - bodyBox) {
      p.posY = crabVh - bodyBox
      applyImpactDamage(p.velY)
      if (Math.abs(p.velY) > p.minBounceVel) p.velY = Math.abs(p.velY) * p.bounciness
      else p.velY = 0
    }
    // ─── Collision: walls ───
    // For a pet the walls are the ends of the taskbar it lives on, so a throw
    // bounces along the bar instead of dropping it beside one.
    const bounds = boundsRef.current
    if (xRef.current <= bounds.min) {
      xRef.current = bounds.min
      applyImpactDamage(p.velX)
      if (Math.abs(p.velX) > p.minBounceVel) {
        p.velX *= -p.bounciness
      } else {
        p.velX = 0
      }
    }
    if (xRef.current >= bounds.max) {
      xRef.current = bounds.max
      applyImpactDamage(p.velX)
      if (Math.abs(p.velX) > p.minBounceVel) {
        p.velX *= -p.bounciness
      } else {
        p.velX = 0
      }
    }

    // Update facing based on velocity. `faceTowards` no-ops unless the
    // direction really changed, so this is one setState per turn, not per frame.
    if (p.velX > 30) faceTowards('right')
    else if (p.velX < -30) faceTowards('left')

    // Render. `bottom` is never touched — it is `groundPx` for the whole life
    // of the element and the height lives in the transform.
    liftRef.current = p.posY - groundRef.current
    writeCrabTransform()

    physicsRAF.current = requestAnimationFrame(runPhysicsLoop)
  }, [updateCrabPos, applyImpactDamage, faceTowards, squashBody, writeCrabTransform])

  // ─── Crab drag + tap detection ───
  const dragStartPos = useRef({ x: 0, y: 0 })
  const didDragRef = useRef(false)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Right-click — let onContextMenu handle it, don't start drag/tap
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    // A press is not yet a drag: real drag/physics only starts once the pointer
    // crosses the threshold in handlePointerMove, so a plain TAP (to open the
    // chat) leaves the mascot exactly where it stands.
    draggingRef.current = true
    didDragRef.current = false
    dragStartPos.current = { x: e.clientX, y: e.clientY }
    const p = physicsRef.current
    p.active = false
    p.dropThrough = false
    // Seed the physics' idea of where the body is. A stale `posY` of 0 was
    // read by the very next render and dropped the mascot a whole ground
    // height before the loop corrected it.
    p.posY = groundRef.current + liftRef.current
    if (physicsRAF.current) cancelAnimationFrame(physicsRAF.current)
    if (stateTimeout.current) clearTimeout(stateTimeout.current)
    if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
    powerStanceRef.current = false; setPowerStance(false)
    const rect = crabElRef.current?.getBoundingClientRect()
    if (rect) dragOffsetRef.current = { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
    p.lastPointerX = e.clientX; p.lastPointerY = e.clientY; p.lastPointerTime = performance.now()
    p.velX = 0; p.velY = 0
    capturePointer(e)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return
    e.preventDefault()
    // Detect actual drag vs tap
    const dx = e.clientX - dragStartPos.current.x, dy = e.clientY - dragStartPos.current.y
    // Below the drag threshold we treat this as a potential tap: keep the crab
    // perfectly still (no physics mode, no transform rewrite) so clicking to
    // open the chat never nudges it. Only on crossing the threshold do we enter
    // physics/drag mode and re-baseline the velocity tracking to here.
    if (!didDragRef.current) {
      if (dx * dx + dy * dy <= 25) return
      didDragRef.current = true
      const pp = physicsRef.current
      pp.lastPointerX = e.clientX; pp.lastPointerY = e.clientY; pp.lastPointerTime = performance.now()
    }
    const vw = window.innerWidth, vh = window.innerHeight, now = performance.now()
    const p = physicsRef.current
    const dt = (now - p.lastPointerTime) / 1000
    if (dt > 0.005) {
      p.velX = (e.clientX - p.lastPointerX) / dt
      p.velY = (e.clientY - p.lastPointerY) / dt
      p.lastPointerX = e.clientX; p.lastPointerY = e.clientY; p.lastPointerTime = now
    }
    xRef.current = clampTo(boundsRef.current, ((e.clientX - dragOffsetRef.current.x) / vw) * 100)
    onPositionChangeRef.current?.(xRef.current)
    const posY = Math.max(0, vh - e.clientY - 20)
    physicsRef.current.posY = posY
    liftRef.current = posY - groundRef.current
    writeCrabTransform()
  }, [writeCrabTransform])

  const handlePointerUp = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false

    // Tap detection — if pointer barely moved, trigger sass/chat
    if (!didDragRef.current) {
      // Open chat on tap — works even when sleeping
      if (onTap) onTap(xRef.current)
      if (!isSleepingRef.current) {
        const sl = sassLinesRef.current; say(sl[Math.floor(Math.random() * sl.length)], 3000)
        // Restart the action loop so mascot doesn't freeze after tap
        if (stateTimeout.current) clearTimeout(stateTimeout.current)
        stateTimeout.current = setTimeout(() => doActionRef.current(), 3500)
      }
      return
    }

    // Drag-and-drop while sleeping wakes the mascot
    if (isSleepingRef.current) {
      wakeSleepRef.current?.()
      // Let physics play out the drop, then resume normal actions
      const p = physicsRef.current
      p.velX = Math.max(-p.maxVel, Math.min(p.maxVel, p.velX))
      p.velY = Math.max(-p.maxVel, Math.min(p.maxVel, p.velY))
      p.lastTime = performance.now()
      p.active = true
      physicsRAF.current = requestAnimationFrame(physicsLoop)
      return
    }

    const p = physicsRef.current
    p.velX = Math.max(-p.maxVel, Math.min(p.maxVel, p.velX))
    p.velY = Math.max(-p.maxVel, Math.min(p.maxVel, p.velY))
    p.lastTime = performance.now()
    p.active = true
    physicsRAF.current = requestAnimationFrame(physicsLoop)
  }, [physicsLoop])

  const randRange = (min: number, max: number) => min + Math.random() * (max - min)

  const getSpeech = (st: MascotState): string | MascotLine | null => {
    const phrases = phrasesRef.current
    const lines: Record<string, string[]> = {
      sass: sassLinesRef.current,
      idle: phrases.idle,
      sleep: phrases.sleep,
      jump: phrases.jump,
      dance: phrases.dance,
      facepalm: phrases.facepalm,
      // celebrate / look are inline: short, action-specific, and not part of
      // the phrase-set contract. Kept emoji-only so they render in every
      // locale instead of being dropped by the language gate.
      celebrate: ['🎉', '💰💰💰', '🤑🎉'],
      look: ['👀', '🔍', '👀❓'],
    }
    const opts = lines[st]
    if (!opts || opts.length === 0) return null
    if (st !== 'sass' && Math.random() > 0.5) return null
    // Sometimes greet the user by name during sass / idle. Roll *after* the
    // skip-chance above so name greetings stay on the same overall cadence
    // as the regular lines (just rerouted to a personalised variant).
    if ((st === 'sass' || st === 'idle') && Math.random() < 0.25) {
      return pickNameGreeting(resolveName(), phrases)
    }
    return opts[Math.floor(Math.random() * opts.length)]
  }

  // The clamp needs the bubble's real width, and only its TEXT can change it.
  // Measured once per bubble rather than read back every animation frame.
  useLayoutEffect(() => {
    const el = bubbleElRef.current
    if (!el) { bubbleWRef.current = 0; bubbleTransformRef.current = ''; return }
    bubbleWRef.current = el.offsetWidth
    bubbleTransformRef.current = ''
    positionBubble()
  }, [speech, pet, positionBubble])

  const pickAction = useCallback(() => {
    const total = MASCOT_ACTIONS.reduce((s, a) => s + a.weight, 0)
    let r = Math.random() * total
    for (const a of MASCOT_ACTIONS) { r -= a.weight; if (r <= 0) return a }
    return MASCOT_ACTIONS[0]
  }, [])

  const SLEEP_KEY = 'clawbox-mascot-sleep'

  // Start or resume sleep for a given remaining duration (ms)
  const startSleep = useCallback((remainingMs: number) => {
    if (stateTimeout.current) clearTimeout(stateTimeout.current)
    if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
    if (sleepZzzRef.current) clearInterval(sleepZzzRef.current)
    setState('sleep')
    // From the locale's own pack — these used to be hardcoded English.
    const zzzLines = phrasesRef.current.sleep
    let zIdx = 0
    say(zzzLines[0], 4000)
    sleepZzzRef.current = setInterval(() => {
      zIdx = (zIdx + 1) % zzzLines.length
      say(zzzLines[zIdx], 4000)
    }, 30000)
    stateTimeout.current = setTimeout(() => {
      if (sleepZzzRef.current) { clearInterval(sleepZzzRef.current); sleepZzzRef.current = null }
      setSpeech('')
      setState('idle')
      setIsSleeping(false)
      kv.remove(SLEEP_KEY)
      setTimeout(() => doActionRef.current(), 1000)
    }, remainingMs) as ReturnType<typeof setTimeout>
  }, [say])

  // Wake from sleep — clears all sleep state
  const wakeSleep = useCallback(() => {
    if (sleepZzzRef.current) { clearInterval(sleepZzzRef.current); sleepZzzRef.current = null }
    if (stateTimeout.current) clearTimeout(stateTimeout.current)
    setSpeech('')
    setState('idle')
    setIsSleeping(false)
    kv.remove(SLEEP_KEY)
    say('😤☀️', 2500)
  }, [say])
  const wakeSleepRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    wakeSleepRef.current = wakeSleep
  }, [wakeSleep])

  // mascotSleep — stops movement, sleeps for 10-15 min (or until dragged), shows zzz bubbles
  const mascotSleep = useCallback(() => {
    setIsSleeping(true)
    const sleepDuration = (10 + Math.random() * 5) * 60 * 1000
    const wakeAt = Date.now() + sleepDuration
    kv.setJSON(SLEEP_KEY, wakeAt)
    startSleep(sleepDuration)
  }, [startSleep])

  const doAction = useCallback(() => {
    if (frozenRef.current) return // Don't start new actions while frozen
    if (isSleepingRef.current) return // No random actions while sleeping
    // A frenzy owns the crab for its whole 60 s — its own rAF run, its quote
    // cycle, its jumps. `handleNewOrder` cancels the pending `stateTimeout`,
    // but not the mount's own first-action timer, so the ambient loop used to
    // wake up mid-celebration: it cleared the frenzy's walk rAF (the crab
    // stopped dead and strolled off) and dropped an idle/sleep line — "💤" —
    // into the bubble between two frenzy quotes. Skipping without rescheduling
    // is safe: the 60 s end-timer calls `doAction` again, and so does an
    // unfreeze.
    if (frenzyRef.current) return
    if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }

    // The lane comes from live geometry — the bar, and the desktop icons that
    // stand in the pet's band. Both move (a resize, a dragged icon), so re-read
    // them before committing to a 6-12 s walk.
    measureRef.current?.()

    // Standing on a desktop icon rather than the ground? Step off first: the
    // resting `bottom` is the shelf, and walking from up here is walking on air.
    // The physics settle schedules the next action, so this just defers.
    if (liftRef.current > 0.5) {
      const pp = physicsRef.current
      pp.velX = 0
      pp.velY = 0
      pp.posY = groundRef.current + liftRef.current
      // Fall THROUGH the icon that is currently underfoot, or the collision
      // test would land the mascot straight back on it, every two seconds.
      pp.dropThrough = true
      pp.lastTime = performance.now()
      pp.active = true
      if (physicsRAF.current) cancelAnimationFrame(physicsRAF.current)
      physicsRAF.current = requestAnimationFrame(physicsLoop)
      return
    }

    const action = pickAction()
    const duration = randRange(action.dur[0], action.dur[1])
    /** What the next action is scheduled off — a walk sets its own. */
    let actionMs = duration

    // ─── Leave the power stance: only if we WERE in it ───
    if (powerStanceRef.current && action.state !== 'idle') {
      powerStanceRef.current = false
      setPowerStance(false)
    }

    setState(action.state)

    // Speech (not for power stance — that has its own)
    if (!(action.state === 'idle' && !powerStanceRef.current)) {
      const line = getSpeech(action.state)
      if (line) say(line, Math.min(duration - 500, 4000))
    }

    // ─── POWER STANCE: idle + 15% chance ───
    if (action.state === 'idle' && !powerStanceRef.current && Math.random() < 0.15) {
      powerStanceRef.current = true
      setPowerStance(true)
      // Struck where the body already stands.
      setFacingDirect(Math.random() > 0.5 ? 'left' : 'right')
      // `phrasesRef` is already crab-free while a pet is worn, so this reads
      // the same for both bodies — see `applyVoice`.
      const powerLines = phrasesRef.current.power.length > 0
        ? phrasesRef.current.power
        : neutralRef.current.power
      say(powerLines[Math.floor(Math.random() * powerLines.length)], 3500)
    } else if (action.state === 'idle') {
      const line = getSpeech('idle')
      if (line) say(line, Math.min(duration - 500, 3000))
    }

    if (action.state === 'waddle') {
      const startX = xRef.current
      const walk = walkRangeRef.current // live object — mutated in place by measure()

      // The body strolls up and down its stretch of the desktop.
      //
      // Distance is picked in PIXELS and the duration follows from it, so the
      // stroll reads at one speed on every screen. The old `randRange(-18,18)`
      // vw over a fixed 6-12 s covered 345px on a 1920 desktop and 144px on
      // an 800 one — the same pet, sprinting or crawling by viewport width.
      const vw = window.innerWidth || 1
      const distPx = randRange(PET_WALK_DISTANCE_PX.min, PET_WALK_DISTANCE_PX.max)
      const dir = Math.random() < 0.5 ? -1 : 1
      let newTarget = clampTo(walk, startX + ((dir * distPx) / vw) * 100)
      // Already flat against that end of the lane? Turn round, rather than
      // "walking" nowhere for ten seconds.
      if (Math.abs(newTarget - startX) < 0.2) {
        newTarget = clampTo(walk, startX - ((dir * distPx) / vw) * 100)
      }
      const travelPx = (Math.abs(newTarget - startX) / 100) * vw
      actionMs = Math.min(
        PET_WALK_MS.max,
        Math.max(PET_WALK_MS.min, (travelPx / PET_WALK_SPEED_PX_S) * 1000),
      )
      // Facing follows the actual travel, not the intent. A target that clamped
      // onto the pet's own position used to send it LEFT (`88 > 88` is false)
      // and play the running-left row for the whole walk without moving — a
      // moonwalk in place at the end of the lane.
      if (Math.abs(newTarget - startX) >= 0.05) {
        setFacingDirect(newTarget > startX ? 'right' : 'left')
      }

      // Use requestAnimationFrame for smooth GPU-friendly movement
      const startTime = performance.now()
      const animate = (now: number) => {
        const elapsed = now - startTime
        const t = Math.min(elapsed / actionMs, 1)
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
        // Read the lane every frame. Captured once, a mid-walk resize left this
        // clamping against a range the bar no longer has.
        const cx = clampTo(walkRangeRef.current, startX + (newTarget - startX) * ease)
        xRef.current = cx
        setX(cx)

        if (t < 1) {
          walkInterval.current = requestAnimationFrame(animate) as unknown as ReturnType<typeof setInterval>
        } else {
          xRef.current = clampTo(walkRangeRef.current, newTarget)
          setX(xRef.current)
        }
      }
      walkInterval.current = requestAnimationFrame(animate) as unknown as ReturnType<typeof setInterval>
    } else if (action.state === 'jump') {
      const jumpStart = performance.now()
      const jumpDuration = 750 // 25 frames * 30ms
      const jumpLoop = (now: number) => {
        const t = Math.min((now - jumpStart) / jumpDuration, 1)
        setJumpY(-Math.sin(t * Math.PI) * 50)
        if (t < 1) requestAnimationFrame(jumpLoop)
        else setJumpY(0)
      }
      requestAnimationFrame(jumpLoop)
    }

    stateTimeout.current = setTimeout(() => doActionRef.current(), actionMs + randRange(2000, 6000))
  }, [pickAction, physicsLoop])
  useEffect(() => {
    doActionRef.current = doAction
  }, [doAction])

  // Listen for new order events — FRENZY MODE
  // Randomize positions on mount to avoid hydration mismatch
  useEffect(() => {
    // Positions already loaded from localStorage in ref init
    updateCrabPos()
    setMounted(true)
  }, [updateCrabPos])

  useEffect(() => {
    if (!mounted || !onPositionChange) return
    onPositionChange(xRef.current)
  }, [mounted, onPositionChange])

  useEffect(() => {
    const moneyEmojis = ['💰', '💵', '💸', '🤑', '💎', '🪙', '💲', '€']

    const handleNewOrder = () => {
      // Skip the frenzy (60s of autonomous running + spawns) when motion is
      // reduced or the crab is frozen (chat open) — frozenRef reflects
      // `frozen || reducedMotion`, so this honours the OS reduce-motion setting.
      if (frozenRef.current) return
      // Cancel current action
      if (stateTimeout.current) clearTimeout(stateTimeout.current)
      if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
      if (frenzyTimeout.current) clearTimeout(frenzyTimeout.current)

      // FRENZY MODE — 60 seconds of excited running + quotes + money
      setFrenzy(true)
      frenzyRef.current = true
      setState('frenzy')
      setPowerStance(false)
      powerStanceRef.current = false

      // Excited fast walk — bounce across screen
      let frenzyDir: 'left' | 'right' = Math.random() > 0.5 ? 'right' : 'left'
      setFacingDirect(frenzyDir)

      let lastFrenzyFrame = 0
      const frenzyAnimate = (now: number) => {
        if (frozenRef.current) return // stop rescheduling once frozen mid-frenzy
        if (!lastFrenzyFrame) lastFrenzyFrame = now
        const dt = now - lastFrenzyFrame
        if (dt >= 16) { // ~60fps cap
          lastFrenzyFrame = now
          const speed = 0.4 * (dt / 25) // normalize speed to frame time
          // The measured lane, not a hardcoded 5-88: those are the CRAB's vw
          // margins, and at a narrow viewport 5vw hangs a third of a pet's body
          // off the screen. For the crab the two are the same numbers.
          const lane = walkRangeRef.current
          const next = xRef.current + (frenzyDir === 'right' ? speed : -speed)
          xRef.current = clampTo(lane, next)
          setX(xRef.current)
          if (next >= lane.max) { frenzyDir = 'left'; setFacingDirect('left') }
          if (next <= lane.min) { frenzyDir = 'right'; setFacingDirect('right') }
        }
        walkInterval.current = requestAnimationFrame(frenzyAnimate) as unknown as ReturnType<typeof setInterval>
      }
      walkInterval.current = requestAnimationFrame(frenzyAnimate) as unknown as ReturnType<typeof setInterval>

      // The frenzy quotes are a hardcoded easter egg that only exists in two
      // languages, so they are keyed BY LANGUAGE. Every other locale shouts
      // its own pack's power lines. (This used to filter one flat array by
      // SCRIPT, which let all 19 English lines through on de/es/fr/it/nl/sv.)
      const quotes = frenzyQuotesFor(localeRef.current, phrasesRef.current, neutralRef.current, petVoiceRef.current)

      // Cycle through quotes every 5 seconds — longer display for readability
      let quoteIdx = 0
      say(quotes[0], 4500)
      frenzyIntervalsRef.current.forEach(clearInterval)
      frenzyIntervalsRef.current = []
      const quoteInterval = setInterval(() => {
        quoteIdx = (quoteIdx + 1) % quotes.length
        say(quotes[quoteIdx], 4500)
      }, 5000)

      // Spawn money waves every 3 seconds
      const spawnMoney = () => {
        const particles = Array.from({ length: 15 }, (_, i) => ({
          id: Date.now() + i,
          x: Math.random() * 180 - 40,
          delay: Math.random() * 1,
          duration: 2 + Math.random() * 1.5,
          emoji: moneyEmojis[Math.floor(Math.random() * moneyEmojis.length)],
        }))
        setMoneyParticles(particles)
      }
      spawnMoney()
      const moneyInterval = setInterval(spawnMoney, 3000)

      // Random jumps during frenzy
      const jumpInterval = setInterval(() => {
        if (Math.random() < 0.4) {
          const jStart = performance.now()
          const jLoop = (now: number) => {
            if (frozenRef.current) { setJumpY(0); return } // freeze cancels an in-flight jump
            const t = Math.min((now - jStart) / 375, 1) // 15 frames * 25ms
            setJumpY(-Math.sin(t * Math.PI) * 35)
            if (t < 1) requestAnimationFrame(jLoop)
            else setJumpY(0)
          }
          requestAnimationFrame(jLoop)
        }
      }, 2000)

      frenzyIntervalsRef.current = [quoteInterval, moneyInterval, jumpInterval]

      // End frenzy after 60 seconds
      frenzyTimeout.current = setTimeout(() => {
        stopFrenzy()
        doActionRef.current()
      }, 60000)
    }

    window.addEventListener('clawbox-new-order', handleNewOrder)
    return () => window.removeEventListener('clawbox-new-order', handleNewOrder)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Restore saved position (from localStorage via savedPos ref), or randomize on first visit
    updateCrabPos()
    // Random facing
    const dir = Math.random() > 0.5 ? 'right' : 'left'
    facingRef.current = dir
    setFacing(dir)

    // Resume sleep if mascot was sleeping before refresh
    let savedSleep = 0
    savedSleep = kv.getJSON<number>('clawbox-mascot-sleep') ?? 0
    const remaining = savedSleep - Date.now()
    const startDelay = remaining > 1000
      ? setTimeout(() => { setIsSleeping(true); startSleep(remaining) }, 500)
      : setTimeout(doAction, 2000)
    // Clean up expired sleep key
    if (savedSleep && remaining <= 1000) kv.remove('clawbox-mascot-sleep')
    return () => {
      clearTimeout(startDelay)
      if (stateTimeout.current) clearTimeout(stateTimeout.current)
      if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
      if (sleepZzzRef.current) clearInterval(sleepZzzRef.current)
      if (frenzyTimeout.current) clearTimeout(frenzyTimeout.current)
      frenzyIntervalsRef.current.forEach(clearInterval)
      if (physicsRAF.current) cancelAnimationFrame(physicsRAF.current)
      if (speechTimerRef.current) clearTimeout(speechTimerRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const bodyAnim = (() => {
    // A pet animates by STEPPING THROUGH SPRITESHEET FRAMES, so none of these
    // keyframes apply to it: every one of them transforms a whole image
    // (rotate/translate/skew), which would wobble the sheet rather than select
    // a frame. PetSprite carries its own animation; the shell adds none.
    if (pet) return undefined
    // Thinking animation overrides when bot is processing
    if (thinking) return 'mascot-thinking 1.5s ease-in-out infinite'
    switch (state) {
      case 'waddle': return 'mascot-waddle 1.2s ease-in-out infinite'
      case 'jump': return 'mascot-squish 0.4s ease'
      case 'celebrate': return 'mascot-celebrate 0.5s ease-in-out infinite'
      case 'sleep': return 'mascot-sleep 3s ease-in-out infinite'
      case 'sass': return 'mascot-sass 0.8s ease-in-out infinite'
      case 'look': return 'mascot-look 1.5s ease-in-out infinite'
      case 'dance': return 'mascot-dance 0.4s ease-in-out infinite'
      case 'facepalm': return 'mascot-facepalm 1s ease'
      case 'frenzy': return 'mascot-frenzy 0.5s ease-in-out infinite'
      default: return powerStance ? 'mascot-powerup 1.5s ease-in-out infinite' : 'mascot-idle 3s ease-in-out infinite'
    }
  })()

  // Honor the OS "reduce motion" setting. The global CSS guard neutralizes the
  // crab's keyframe animations, but its autonomous walking/dancing is driven by
  // a JS rAF loop — continuous motion a vestibular-sensitive user can't stop.
  // Reuse the freeze mechanism to hold the crab still under reduced-motion.
  const [reducedMotion, setReducedMotion] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])

  // Tear down an in-flight frenzy: the rAF walk loop, the quote/money/jump
  // intervals, the 60s end-timer, and the visual state they drove. Safe to call
  // when no frenzy is running. Used both by the natural 60s end and when the
  // crab freezes mid-frenzy (chat opens, or reduced-motion turns on) — without
  // it those intervals would keep firing say()/money/jumps for up to a minute
  // after the crab was supposed to hold still. (An already-scheduled jump rAF
  // can't be cancelled by handle here, so its jLoop also bails on frozenRef.)
  const stopFrenzy = useCallback(() => {
    if (frenzyTimeout.current) { clearTimeout(frenzyTimeout.current); frenzyTimeout.current = null }
    frenzyIntervalsRef.current.forEach(clearInterval)
    frenzyIntervalsRef.current = []
    if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current); walkInterval.current = null }
    setFrenzy(false)
    frenzyRef.current = false
    setMoneyParticles([])
    setJumpY(0)
  }, [])

  // Freeze/unfreeze mascot (chat popup open, or reduced-motion) — enter power stance
  useEffect(() => {
    const effFrozen = frozen || reducedMotion
    frozenRef.current = effFrozen
    if (effFrozen) {
      // Stop all movement — stay in place
      if (stateTimeout.current) clearTimeout(stateTimeout.current)
      stopFrenzy() // cancel an active frenzy, not just block new ones
      setState('idle')
      setSpeech('')
    } else {
      // Remove power-up and resume action loop. The ref goes with the state —
      // doAction only enters a power stance from `idle` when the ref is false,
      // so leaving it set here would skip the transition until some non-idle
      // action happened to clear it.
      powerStanceRef.current = false
      setPowerStance(false)
      if (stateTimeout.current) clearTimeout(stateTimeout.current)
      stateTimeout.current = setTimeout(() => doActionRef.current(), 1000)
    }
  }, [frozen, reducedMotion, stopFrenzy])

  // ─── Keep the crab clear of a docked chat panel ───
  // When the chat opens as a vertical side panel (rightInset = its width in px),
  // the crab must stay on the visible desktop to the LEFT of the panel — the
  // panel has a higher z-index, so anything under it is hidden. If the crab
  // would sit behind the panel, glide it into view. When the panel closes
  // (inset back to 0) we leave the crab where it is — no snapping.
  useEffect(() => {
    const inset = rightInset ?? 0
    if (inset <= 0) return
    const vw = window.innerWidth
    // Half the body — a pet's is narrower than the crab's.
    const HALF = (pet ? PET_BODY_PX : CRAB_BODY_PX) / 2
    const GAP = 24       // breathing room between mascot and panel edge
    const maxCenterPx = vw - inset - GAP - HALF
    // Clamped into the lane rather than to a bare 5vw floor, so a wide chat
    // panel cannot push the mascot past the left end of the bar it stands on.
    const lane = walkRangeRef.current
    const maxXvw = Math.max(lane.min, Math.min(lane.max, (maxCenterPx / vw) * 100))

    const startCrab = xRef.current
    const targetCrab = Math.min(startCrab, maxXvw)
    if (targetCrab >= startCrab) return

    // Face left as it retreats from the panel so the walk reads naturally.
    setFacingDirect('left')
    let raf = 0
    const t0 = performance.now()
    const dur = 520
    const step = (now: number) => {
      const t = Math.min((now - t0) / dur, 1)
      const e = 1 - Math.pow(1 - t, 3) // easeOutCubic
      xRef.current = clampTo(boundsRef.current, startCrab + (targetCrab - startCrab) * e)
      updateCrabPos()
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => { if (raf) cancelAnimationFrame(raf) }
  }, [rightInset, pet, updateCrabPos, setFacingDirect])

  // Listen for show/hide mascot events from desktop context menu
  useEffect(() => {
    const showHandler = () => { setHidden(prev => { if (!prev) return prev; kv.remove('clawbox-mascot-hidden'); return false }) }
    const hideHandler = () => { setHidden(prev => { if (prev) return prev; kv.set('clawbox-mascot-hidden', '1'); return true }) }
    window.addEventListener('clawbox-show-mascot', showHandler)
    window.addEventListener('clawbox-hide-mascot', hideHandler)
    return () => { window.removeEventListener('clawbox-show-mascot', showHandler); window.removeEventListener('clawbox-hide-mascot', hideHandler) }
  }, [])

  if (!mounted) return null // avoid hydration mismatch — render only on client
  if (hidden) return null
  // Waiting on /setup-api/pets — see the petStatus comment above.
  if (petStatus === null) return null
  // Hermes edition with nothing picked yet: no crab — that is ClawBox's own
  // brand and is not worn on someone else's harness — but an egg, so a fresh
  // box does not read as a broken one and the picker is one click away.
  //
  // This is the ONLY way `EggMascot` is reached, which is what keeps it off
  // OpenClaw: `supported` is true only when the server confirmed a Hermes
  // harness, and every fail-open path in `pet-client.ts` answers
  // `supported: false` — an unreachable pets route keeps the crab.
  if (petStatus.supported && !pet) return <EggMascot />

  /** The body box this mascot occupies. Every offset below is relative to it. */
  const bodyPx = pet ? PET_BODY_PX : CRAB_BODY_PX
  const bodyHalf = bodyPx / 2
  /**
   * Where the pet's ART is inside that box, for the pose being drawn.
   *
   * The cell is 192x208 with the character inset inside it by a different
   * amount per pet, per row and per frame, so anything hung off the CELL —
   * the bubble, the thinking dots, the ZZZ cluster, the drag hit-box — was
   * hung off empty space. `headPx` is how far the drawing really reaches above
   * the ground line; `artInsetPx` is how far in from the cell's sides it sits.
   */
  const layout: PetLayout | null = pet ? petLayout(pet, { state, thinking, facing }, bodyPx) : null
  /** Where the visible head is, measured from the body box's TOP. */
  const headTopPx = layout ? Math.max(0, bodyPx - layout.headPx) : 0

  return (
    <>
      <style>{MASCOT_KEYFRAMES}</style>
      <div ref={crabElRef}
        data-mascot={pet ? 'pet' : 'crab'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          ctxOpenedAt.current = Date.now()
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }}
        style={{
        position: 'fixed', left: 0,
        // The crab's shelf is the desktop floor; a pet's is the taskbar's top
        // edge, measured from the bar itself. This is the ONLY thing that sets
        // the element's `bottom` — every vertical offset (drag, throw, hop,
        // perching on an icon) is carried in the transform below, so the
        // imperative and declarative paths cannot contradict each other.
        bottom: groundPx,
        // Written from the same refs, in the same shape, as
        // `writeCrabTransform` — a re-render during a drag or a throw must
        // reproduce the frame the rAF loop just drew, not a different one.
        transform: `translateX(calc(${xRef.current}vw - 50%)) translateY(${(jumpYRef.current - liftRef.current).toFixed(2)}px) scaleX(${facing === 'left' ? -1 : 1})`,
        zIndex: pet ? PET_Z_INDEX : CRAB_Z_INDEX,
        // A pet's box is mostly transparent, and at `auto` its 104px square
        // took the click meant for whatever stands behind it — a desktop icon's
        // label, most visibly. Only the drawn art is grabbable; see the hit box
        // inside the body div. The crab fills its own box, so it keeps `auto`.
        pointerEvents: pet ? 'none' : 'auto',
        cursor: 'grab',
        touchAction: 'none',
        willChange: 'transform, filter',
        filter: isSleeping
          ? 'drop-shadow(0 0 10px rgba(147,197,253,0.3))'
          : frenzy
            ? 'drop-shadow(0 0 20px rgba(251,191,36,0.8))'
            : thinking
              ? 'drop-shadow(0 0 12px rgba(99,179,237,0.6))'
              : powerStance
                ? 'drop-shadow(0 0 15px rgba(249,115,22,0.6))'
                : 'none',
      }}>
        {/* Body. A pet's box is smaller than the crab's, and everything
            anchored to it — bubble, damage numbers, power effects — is
            measured off `bodyPx` rather than the crab's 150 so the whole
            composition scales together. */}
        <div data-frenzy={frenzy ? '1' : undefined} style={{ animation: bodyAnim, width: bodyPx, height: bodyPx, position: 'relative', willChange: 'transform' }}>
          {pet && layout ? (
            <>
              <PetSprite pet={pet} state={state} thinking={thinking} facing={facing} />
              {/* Grab handle: the drawn art, not the cell. Symmetric on
                  purpose — the sprite cancels the shell's flip on directional
                  rows, so a left/right-specific box would land on the wrong
                  side of the pet half the time. */}
              <div
                data-mascot-hit=""
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: bodyHalf - layout.dispW / 2 + layout.artInsetPx,
                  width: Math.max(24, layout.dispW - layout.artInsetPx * 2),
                  height: Math.max(24, layout.headPx),
                  pointerEvents: 'auto',
                  cursor: 'grab',
                  touchAction: 'none',
                }}
              />
            </>
          ) : (
            <img src="/clawbox-crab.png" alt="" style={{
              position: 'absolute', bottom: CRAB_ART_BOTTOM_PX, left: (CRAB_BODY_PX - CRAB_ART_PX) / 2,
              width: CRAB_ART_PX, height: CRAB_ART_PX, objectFit: 'contain',
            }} />
          )}
          {/* FRENZY MODE — money rain + shockwaves */}
          {frenzy && (
            <>
              {moneyParticles.map(p => (
                <div key={p.id} style={{
                  position: 'absolute', bottom: 50, left: p.x,
                  fontSize: '2rem',
                  animation: `money-rain ${p.duration}s ease-out ${p.delay}s both`,
                  pointerEvents: 'none',
                }}>{p.emoji}</div>
              ))}
              {[0, 0.6].map(delay => (
                <div key={delay} style={{
                  position: 'absolute', top: '50%', left: '50%',
                  width: 80, height: 80, borderRadius: '50%',
                  border: '3px solid rgba(251,191,36,0.7)',
                  animation: `frenzy-ring 1s ease-out ${delay}s infinite`,
                  pointerEvents: 'none',
                }} />
              ))}
            </>
          )}
          {/* Power-stance effects */}
          {powerStance && (
            <>
              {/* Energy rings */}
              {[0, 0.7].map(delay => (
                <div key={delay} style={{
                  position: 'absolute', top: '50%', left: '50%',
                  width: 60, height: 60, borderRadius: '50%',
                  border: '2px solid rgba(249,115,22,0.6)',
                  animation: `power-ring 1.5s ease-out ${delay}s infinite`,
                  pointerEvents: 'none',
                }} />
              ))}
              {/* Floating particles. Placed for the crab's 150px box, so they
                  are scaled into a pet's smaller one rather than escaping it. */}
              {POWER_PARTICLES.map((particle, i) => (
                <div key={i} style={{
                  position: 'absolute',
                  bottom: Math.round(particle.bottom * bodyPx / CRAB_BODY_PX),
                  left: Math.round(particle.left * bodyPx / CRAB_BODY_PX),
                  width: 4, height: 4, borderRadius: '50%',
                  background: i % 2 === 0 ? '#f97316' : '#fbbf24',
                  animation: `power-particles ${particle.duration}s ease-out ${particle.delay}s infinite`,
                  pointerEvents: 'none',
                }} />
              ))}
            </>
          )}
        </div>
        {/* Floating damage numbers */}
        {damageFloaters.map(f => (
          <div key={f.id} style={{
            position: 'absolute', bottom: bodyPx - 30, left: bodyHalf + f.x,
            transform: 'translateX(-50%)',
            pointerEvents: 'none', zIndex: 11,
            animation: 'damage-float 1.2s ease-out forwards',
          }}>
            <span style={{
              color: '#ef4444', fontSize: '1.4rem', fontWeight: 900,
              textShadow: '0 0 8px rgba(239,68,68,0.8), 0 2px 4px rgba(0,0,0,0.5)',
              whiteSpace: 'nowrap',
            }}>-{f.dmg} HP</span>
          </div>
        ))}
        {/* Speech bubble — OUTSIDE body div so it doesn't wobble.
            Two dialects. The crab's is unchanged: a wide, round, solid-colour
            lozenge sized for a 150px illustration that fills its box and for
            lines that never wrap. A Petdex sprite is a 192x208 pixel-art cell
            with real headroom above the character, so the same bubble floats a
            long way over the pet's head, and its 400px nowrap slab dwarfs a
            ~138px body. The pet's bubble therefore sits lower, wraps inside a
            width close to the sprite's own, and is drawn the way the art is:
            hard 2px edge, 4px corners, a solid offset shadow instead of a
            blur, and a square tail rotated to a point. */}
        {speech && (() => {
          const accent = frenzy ? 'rgba(251,191,36,0.95)'
            : state === 'sass' ? 'rgba(220,38,38,0.9)'
            : state === 'facepalm' ? 'rgba(100,100,100,0.9)'
            : 'rgba(249,115,22,0.92)'
          const flip = `translateX(-50%) scaleX(${facing === 'left' ? -1 : 1})`

          if (pet) {
            const bg = frenzy ? 'rgba(41,27,3,0.96)' : 'rgba(17,19,26,0.96)'
            const vw = typeof window !== 'undefined' ? window.innerWidth : 0
            return (
              <div ref={bubbleElRef} style={{
                // Off the top of the DRAWING, so the gap above the head reads
                // the same 26px for a pet that fills its cell and one that sits
                // low in it. Off the cell it measured 29px for boba and 56px
                // for cash-cuy mid-facepalm.
                position: 'absolute', bottom: (layout?.headPx ?? bodyPx) + PET_BUBBLE_GAP_PX, left: bodyHalf,
                // Overwritten by `positionBubble` as soon as the width is
                // known; this is the un-clamped first paint.
                transform: flip,
                zIndex: 10,
                // `width: max-content` is load-bearing. The shell is only as
                // wide as the 150px body, so an auto-width absolute child at
                // left:75 gets a 75px containing block and every line wraps
                // into a column one word wide. The crab never hit this because
                // its bubble is `nowrap` and simply overflows. Sizing to the
                // content first, then capping, wraps at 210px instead.
                width: 'max-content',
                // Never wider than the screen it has to fit inside.
                maxWidth: vw > 0 ? Math.min(210, vw - BUBBLE_EDGE_MARGIN_PX * 2) : 210,
              }}>
                <div data-speech="1" style={{
                  background: bg,
                  color: '#fff',
                  padding: '7px 12px',
                  border: `2px solid ${accent}`,
                  borderRadius: 4,
                  boxShadow: '0 3px 0 rgba(0,0,0,0.45)',
                  fontSize: frenzy ? '1rem' : '0.95rem',
                  fontWeight: 600,
                  letterSpacing: '0.2px',
                  // Wraps instead of running off the screen — a pet stands at
                  // the shelf's edge as often as its middle.
                  whiteSpace: 'normal',
                  overflowWrap: 'anywhere',
                  lineHeight: 1.35,
                  animation: 'speech-pop 0.3s ease-out forwards',
                  textAlign: 'center' as const,
                }}>
                  {speech}
                  {/* A rotated square, so the tail carries the same 2px edge
                      as the bubble rather than being a borderless triangle. */}
                  <div style={{
                    position: 'absolute', bottom: -6, left: '50%',
                    width: 10, height: 10,
                    transform: 'translateX(-50%) rotate(45deg)',
                    background: bg,
                    borderRight: `2px solid ${accent}`,
                    borderBottom: `2px solid ${accent}`,
                  }} />
                </div>
              </div>
            )
          }

          return (
            <div style={{
              position: 'absolute', bottom: 155, left: bodyHalf,
              transform: flip,
              zIndex: 10,
            }}>
              <div data-speech="1" style={{
                background: accent,
                color: frenzy ? '#000' : '#fff',
                padding: frenzy ? '10px 20px' : '8px 18px',
                borderRadius: 12, fontSize: frenzy ? '1.2rem' : '1.1rem', fontWeight: 700,
                whiteSpace: 'nowrap',
                lineHeight: 1.3,
                animation: 'speech-pop 0.3s ease-out forwards',
                textAlign: 'center' as const,
              }}>
                {speech}
                <div style={{ position: 'absolute', bottom: -8, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '8px solid transparent', borderRight: '8px solid transparent', borderTop: `8px solid ${accent}` }} />
              </div>
            </div>
          )
        })()}
        {/* ZZZ floating animation when sleeping */}
        {isSleeping && (
          <div style={{
            // 30/15 were measured against the crab's 150px illustration. A pet
            // is a smaller box with the art inset inside it, so the cluster is
            // hung off the drawn head instead.
            position: 'absolute',
            top: pet ? headTopPx + 4 : 30,
            right: pet ? Math.round(bodyPx * 0.12) : 15,
            pointerEvents: 'none', zIndex: 11,
          }}>
            {[0, 1.2, 2.4].map((delay, i) => (
              <div key={i} style={{
                position: 'absolute',
                fontSize: [14, 18, 24][i],
                fontWeight: 900,
                color: 'rgba(147,197,253,0.9)',
                textShadow: '0 0 8px rgba(147,197,253,0.5)',
                animation: `zzz-float 3s ${delay}s ease-out infinite`,
                left: i * 6,
                top: -i * 4,
              }}>Z</div>
            ))}
          </div>
        )}
        {/* Thinking indicator — dots above mascot head, and for the crab a
            spinner verb beside them ("Percolating…", "Scuttling…") — the same
            deliberately-English whimsy vocabulary the chat's status line
            draws on (src/lib/spinner-verbs.ts). Picked once per thinking
            episode; the pet keeps plain dots, spinner whimsy is crab voice. */}
        {thinking && (
          <div style={{
            position: 'absolute', top: pet ? headTopPx - 14 : -5, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', gap: 5, alignItems: 'center', zIndex: 11,
            pointerEvents: 'none',
          }}>
            {[0, 0.2, 0.4].map((delay, i) => (
              <div key={i} style={{
                width: 8, height: 8, borderRadius: '50%',
                background: 'rgba(99,179,237,0.9)',
                boxShadow: '0 0 6px rgba(99,179,237,0.5)',
                animation: `think-dot 1.2s ${delay}s ease-in-out infinite`,
              }} />
            ))}
            {!pet && thinkingVerb && (
              <div data-testid="mascot-thinking-verb" style={{
                marginLeft: 4, padding: '2px 8px', borderRadius: 999,
                background: 'rgba(13,17,23,0.85)', border: '1px solid rgba(99,179,237,0.35)',
                color: 'rgba(191,219,254,0.95)', fontSize: 11, fontWeight: 600,
                whiteSpace: 'nowrap',
              }}>
                {thinkingVerb}…
              </div>
            )}
          </div>
        )}

      </div>

      {/* Mascot right-click context menu */}
      {ctxMenu && (
        <div
          className="fixed z-[99999] min-w-[220px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 240),
            top: ctxMenu.y - 8,
            transform: 'translateY(-100%)',
          }}
          onClick={() => setCtxMenu(null)}
        >
          {!isSleeping && (
            <button
              onClick={() => { mascotSleep(); setCtxMenu(null) }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
            >
              <span className="text-base">💤</span> Sleep
            </button>
          )}
          <button
            onClick={() => { setHidden(true); kv.set('clawbox-mascot-hidden', '1'); setCtxMenu(null); window.dispatchEvent(new Event('clawbox-hide-mascot')) }}
            className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3 text-red-400"
          >
            <span className="text-base">👁️‍🗨️</span> Hide mascot
          </button>
        </div>
      )}
    </>
  )
}


export default memo(ClawBoxMascot)
