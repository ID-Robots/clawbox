'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import { announcePetChanged } from '@/lib/pet-client'
import { CURATED_PETS } from '@/lib/pet-curated'
import { MASCOT_SHELF_Z_INDEX } from '@/lib/pet-layout'

// ── The fresh-box egg ──
//
// A Hermes box ships with no pet installed (upstream installs none, and the
// first one is a ~2.2 MB download). The desktop used to answer that empty
// state with nothing at all — no crab (that is ClawBox's own brand, not a
// stand-in on someone else's harness) and no pet (none is picked yet). A blank
// shelf gives the owner no hint that a companion is one click away, so the
// empty state now wears an egg.
//
// It is a placeholder, not a mascot: it does not roam, it is not draggable, it
// has no physics, it never speaks and it carries no ClawBox prop. It sits on
// the shelf and waits to be clicked; the moment a pet is picked the mascot
// re-reads `/setup-api/pets` and this component is gone. It is HERMES-ONLY —
// the single caller is the body-choice guard in `Mascot.tsx` (search
// `EggMascot`), which reaches it only when the server confirmed a Hermes
// harness; that comment owns the full argument.

// The art: `public/pet-egg-sheet.png`, copied byte-for-byte from upstream's
// MIT-licensed Hermes agent — provenance and the retained notice live in
// `public/pet-egg-sheet.LICENSE.txt`. It is the only pet-flavoured art ClawBox
// may legally bundle, and it is bundled: nothing here touches the Petdex CDN
// at build or at runtime, so the egg draws on a box that has never had a network.
const SHEET_URL = '/pet-egg-sheet.png'

/** 32x384: twelve 32x32 cells stacked VERTICALLY, so a frame is a y offset. */
const SHEET_FRAMES = 12

/** On-screen size. The brief asks for a small egg — 48-64px effective. */
const EGG_PX = 56

/** Where the egg waits if the shelf never turns up — the crab's desktop floor. */
const DESKTOP_FLOOR_PX = 8

const IDLE_KEYFRAME = 'clawbox-egg-idle'
const SPRITE_CLASS = 'clawbox-egg-sprite'

/**
 * One long rest, then a fast six-frame bounce, forever (~4.2 s round trip).
 *
 * Upstream's egg rests on frame 0 for a long randomised gap so it reads as
 * "occasionally stirs" rather than "constantly animating". A lone placeholder
 * has no neighbours to desynchronise from, so the same feel comes from a fixed
 * CSS cycle with no rAF loop and no JS timer.
 */
const IDLE_CYCLE_MS = 4200

/**
 * The sheet's shell is mid-gray, and mid-gray on the dark wallpaper reads as a
 * smudge rather than an egg.
 *
 * Upstream hits its warm white/creme shell by drawing each frame to a canvas
 * and remapping luminance through a 256-entry LUT. That buys a per-pixel ramp
 * we do not need and a canvas loop we would have to write: this egg animates by
 * stepping a background position, so it never touches a canvas at all. A filter
 * gets to the same creme in one declaration — brightness lifts the shell off
 * the midtone, sepia warms it, and the light saturate/contrast keeps the
 * outline dark instead of muddying it toward the fill.
 */
const CREME_FILTER = 'brightness(1.14) sepia(0.38) saturate(1.25) contrast(1.05)'

/**
 * Hold frame 0 for ~84% of the cycle, play 1-5 over the tail, settle back on 0.
 *
 * Frames 0-5 only, never 6-11: the sheet's back half is the hatch (9-11 crack
 * and burst), and nothing is hatching here — the owner has not picked a pet —
 * so a cracked shell would be a lie. 0-8 are in fact only two alternating
 * squash/stretch poses (verified pixel-wise: 0/2/4/6/8 are identical, 1/3/5/7
 * too), and 0-5 is the range upstream itself calls the intact bounce.
 *
 * `step-end` because these are discrete cells — interpolating would slide the
 * sheet and show two half-eggs. Reduced motion is honoured by the global `*`
 * rule in `globals.css` (as `PetSprite` also relies on), which collapses the
 * loop to its frame-0 rest pose.
 */
/** The hatch: crack, crack wider, burst — the back half of the sheet the idle
 *  loop must never reach on its own. Stepped by JS state, not by a keyframe,
 *  so the "no cracked shell at rest" invariant stays checkable in the CSS. */
const HATCH_FRAMES = [9, 10, 11]
const HATCH_FRAME_MS = 280
/** The pause on the burst frame before the pet takes the shelf. */
const HATCH_SETTLE_MS = 340
/** What reduced motion gets instead of a cracking shell: a plain fade-swap. */
const FADE_SWAP_MS = 240
const ERROR_HINT_MS = 4000

const WOBBLE_KEYFRAME = 'clawbox-egg-wobble'
const HATCHING_CLASS = 'clawbox-egg-hatching'

type HatchPhase = 'idle' | 'hatching' | 'burst' | 'fading'

const idleCss = (() => {
  const at = (frame: number) => `background-position-y:${-frame * EGG_PX}px`
  return `@keyframes ${IDLE_KEYFRAME}{` +
    `0%,84%{${at(0)}}85%{${at(1)}}87%{${at(2)}}89%{${at(3)}}91%{${at(4)}}93%{${at(5)}}95%,100%{${at(0)}}` +
    `}.${SPRITE_CLASS}{animation:${IDLE_KEYFRAME} ${IDLE_CYCLE_MS}ms step-end infinite}` +
    `@keyframes ${WOBBLE_KEYFRAME}{0%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}100%{transform:rotate(-8deg)}}` +
    `.${HATCHING_CLASS}{animation:${WOBBLE_KEYFRAME} 340ms ease-in-out infinite;transform-origin:50% 92%}`
})()

/**
 * The shelf's top edge, in px up from the viewport bottom.
 *
 * The same source of truth the pet stands on — `[data-mascot-ground]`, carried
 * by `ChromeShelf.tsx` — so the egg and the pet that replaces it share one
 * ground line. `bottom` is measured from the viewport bottom, which is what
 * `position: fixed` uses.
 *
 * NOTE (known debt): the observe/retry/remeasure scaffolding below is the same
 * mechanism as the pet's ground effect in `Mascot.tsx` (its `useLayoutEffect`
 * keyed on `[pet]`), minus the roaming-lane math the egg does not need. The
 * pet's copy is entangled with the physics loop's refs, so the two were not
 * merged here; if a third reader appears, lift this into a shared hook.
 */
function useShelfGround(): number {
  // A layout effect, not an ordinary one: the shelf is already mounted by the
  // time the pets fetch resolves, so a plain effect would paint the egg once at
  // the 8px floor (behind the shelf, forcing its blur to re-rasterise) and then
  // jump it onto the bar. Mascot's pet version is a layout effect for the same
  // reason.
  const [ground, setGround] = useState(DESKTOP_FLOOR_PX)

  useLayoutEffect(() => {
    let observer: ResizeObserver | null = null
    let observed: Element | null = null
    let watchable = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let raf: number | null = null
    let retries = 0

    const watch = (el: Element) => {
      if (observed === el || !watchable || typeof ResizeObserver !== 'function') return
      // Wrapped because this is decoration: a runtime with a partial
      // ResizeObserver stand-in must lose only the live remeasure, not the egg.
      try {
        observer?.disconnect()
        observer = new ResizeObserver(scheduleMeasure)
        observer.observe(el)
        observed = el
      } catch {
        watchable = false
        observer = null
        observed = null
      }
    }

    const measure = (): boolean => {
      // Reuse the node the observer already holds; only re-query when it has
      // detached (the dock remounts the shelf when an app is installed).
      const el = (observed?.isConnected ? observed : document.querySelector('[data-mascot-ground]')) as HTMLElement | null
      if (!el) return false
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      watch(el)
      // Repeated identical values do not re-render — React bails on the rounded
      // primitive — so the resize path is free when the safe-area inset is stable.
      setGround(Math.max(0, Math.round(window.innerHeight - rect.top)))
      return true
    }

    // The shelf is full-bleed, so a horizontal resize fires BOTH the observer
    // and window.resize; coalesce them to one measure per frame.
    const scheduleMeasure = () => {
      if (raf != null) return
      raf = requestAnimationFrame(() => { raf = null; measure() })
    }

    // The shelf can mount after the mascot does. One failed querySelector would
    // otherwise leave the egg on the desktop floor, behind the bar, all session.
    const attempt = () => {
      timer = null
      if (measure()) return
      if (++retries > 40) return
      timer = setTimeout(attempt, 100)
    }
    attempt()

    window.addEventListener('resize', scheduleMeasure)
    return () => {
      if (timer) clearTimeout(timer)
      if (raf != null) cancelAnimationFrame(raf)
      window.removeEventListener('resize', scheduleMeasure)
      try { observer?.disconnect() } catch { /* same reason as `watch` */ }
    }
  }, [])

  return ground
}

export default function EggMascot() {
  const { t } = useT()
  const ground = useShelfGround()
  const [hinting, setHinting] = useState(false)
  const [phase, setPhase] = useState<HatchPhase>('idle')
  const [burstFrame, setBurstFrame] = useState(HATCH_FRAMES[0])
  const [failed, setFailed] = useState(false)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  // The pet's arrival unmounts this component mid-sequence; stale timers must
  // not fire state updates after that.
  useEffect(() => () => { timersRef.current.forEach(clearTimeout) }, [])

  const later = (fn: () => void, ms: number) => { timersRef.current.push(setTimeout(fn, ms)) }

  const reducedMotion = (): boolean => {
    // Wrapped like every other decoration probe: a runtime without matchMedia
    // loses the fancy hatch, never the hatch itself.
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
  }

  // ── The hatch ──
  //
  // Clicking the egg no longer opens the picker — it HATCHES: a random pet off
  // the curated shortlist, equal odds, and "no pet" is a Settings decision that
  // is never a hatch outcome. The pick persists through the SAME route the
  // Settings picker writes (`hermes pets install` + `select` behind
  // /setup-api/pets/select), so a hatched pet survives a reload exactly the way
  // a picked one does — and the picker stays the way to change it later.
  //
  // The sequence: wobble while the box downloads (~2.2 MB, so the wobble is the
  // honest wait state), then crack → burst (frames 9-11, the sheet's real hatch
  // cells), then the pet takes the shelf via `announcePetChanged` — the same
  // signal a Settings pick fires. Reduced motion gets a short fade-swap
  // instead: the global reduced-motion rule already freezes the CSS loops, and
  // stepping crack frames by hand would repaint exactly what that rule exists
  // to suppress.
  const hatch = () => {
    if (phase !== 'idle') return
    setFailed(false)
    const slug = CURATED_PETS[Math.floor(Math.random() * CURATED_PETS.length)].slug
    setPhase('hatching')
    fetch('/setup-api/pets/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`select answered ${res.status}`)
        if (reducedMotion()) {
          setPhase('fading')
          later(() => announcePetChanged(), FADE_SWAP_MS)
          return
        }
        setPhase('burst')
        HATCH_FRAMES.forEach((frame, i) => later(() => setBurstFrame(frame), i * HATCH_FRAME_MS))
        later(() => setPhase('fading'), HATCH_FRAMES.length * HATCH_FRAME_MS)
        later(() => announcePetChanged(), HATCH_FRAMES.length * HATCH_FRAME_MS + HATCH_SETTLE_MS)
      })
      .catch(() => {
        // Back to waiting, and say why — the same string the picker shows for
        // the same failure. The egg is still there; nothing was lost.
        setPhase('idle')
        setBurstFrame(HATCH_FRAMES[0])
        setFailed(true)
        later(() => setFailed(false), ERROR_HINT_MS)
      })
  }


  const label = t('settings.mascot.eggHatch')
  const hintText = failed ? t('settings.mascot.petInstallFailed') : label

  return (
    <div
      data-mascot="egg"
      data-egg-phase={phase}
      style={{
        position: 'fixed',
        left: '50%',
        bottom: ground,
        transform: 'translateX(-50%)',
        zIndex: MASCOT_SHELF_Z_INDEX,
        // The egg is the only thing here that should take a click; the wrapper
        // must not shadow the shelf around it.
        pointerEvents: 'none',
      }}
    >
      <style>{idleCss}</style>
      {(hinting || failed) && (
        <div
          data-egg-hint
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: EGG_PX + 10,
            left: '50%',
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            padding: '4px 9px',
            borderRadius: 7,
            fontSize: 12,
            lineHeight: 1.3,
            fontWeight: 500,
            color: '#fdf9ee',
            background: 'rgba(24,20,17,0.92)',
            border: '1px solid rgba(253,249,238,0.16)',
            boxShadow: '0 2px 10px rgba(0,0,0,0.34)',
            pointerEvents: 'none',
          }}
        >
          {hintText}
        </div>
      )}
      <button
        type="button"
        data-egg-hatch
        aria-label={label}
        onClick={hatch}
        disabled={phase !== 'idle'}
        aria-busy={phase !== 'idle'}
        className={phase === 'hatching' ? HATCHING_CLASS : undefined}
        onMouseEnter={() => setHinting(true)}
        onMouseLeave={() => setHinting(false)}
        onFocus={() => setHinting(true)}
        onBlur={() => setHinting(false)}
        style={{
          display: 'block',
          width: EGG_PX,
          height: EGG_PX,
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: phase === 'idle' ? 'pointer' : 'default',
          pointerEvents: 'auto',
        }}
      >
        <span
          data-egg-sprite
          className={phase === 'burst' ? undefined : SPRITE_CLASS}
          aria-hidden="true"
          style={{
            display: 'block',
            width: EGG_PX,
            height: EGG_PX,
            backgroundImage: `url(${SHEET_URL})`,
            backgroundRepeat: 'no-repeat',
            // A vertical strip: one cell wide by twelve tall, frame chosen on y.
            backgroundSize: `${EGG_PX}px ${EGG_PX * SHEET_FRAMES}px`,
            // The resting frame. Left stated so the reduced-motion pose (the
            // global rule leaves the specified value in place) reads as frame 0.
            backgroundPositionY: phase === 'burst' ? -burstFrame * EGG_PX : 0,
            opacity: phase === 'fading' ? 0 : 1,
            transition: phase === 'fading' ? `opacity ${FADE_SWAP_MS}ms ease-out` : undefined,
            // Pixel art. Smoothing a 32px cell blown up to 56px turns it to mush.
            imageRendering: 'pixelated',
            filter: CREME_FILTER,
          }}
        />
      </button>
    </div>
  )
}
