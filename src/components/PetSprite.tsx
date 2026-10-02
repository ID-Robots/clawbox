'use client'

import React, { memo, useEffect, useRef } from 'react'
import { type MascotStateName } from '@/lib/pet-state-map'
import { petFrameMs, petFrameTransforms, petLayout, PET_BODY_PX } from '@/lib/pet-layout'
import type { PetDescriptor } from '@/lib/pet-client'

// ── The pet body ──
//
// A Petdex sheet is a grid of 192x208 cells: one animation state per row,
// stepped frames per state, 1100 ms per loop. That is a frame-SELECTION
// animation, which is why none of the crab's keyframes can be reused here —
// `mascot-waddle` and friends transform a whole image, and applying one to a
// spritesheet would wobble the sheet, not step through it.
//
// A STRIP of the row's frames slides under a clip, one `transform` per frame,
// stepped by a timer at the row's own frame rate (petFrameTransforms). Not a
// CSS animation: stepping `background-position-x` and `bottom` (what the
// Petdex web client does, and what this did) repainted the desktop's root
// layer on every step, and any running CSS animation — even a composited
// `step-end` one — has the browser recalculate style 60 times a second for a
// picture that changes six times a second. A transform on the strip's own
// layer is one cheap composite per step and nothing in between. The timer
// keeps its place across React re-renders (it restarts only when the row
// changes), holds the first frame under reduced motion, and sleeps while the
// desktop is hidden.
//
// Two things the naive version of this got wrong, both fixed by the per-row
// measurements in the descriptor (see src/lib/pet-sheet-metrics.ts):
//
//   - it stepped a sheet-wide SIX frames over every row. The atlases are
//     ragged — `waving` draws four, `jumping` five — so the last steps landed
//     on empty cells and the pet disappeared for 183-367 ms every loop.
//   - it pinned the CELL's bottom edge to the ground line, not the artwork's.
//     Every sheet insets its character, by a different amount per row and per
//     frame, so the feet floated 3-30 px above the taskbar and the pet bobbed
//     whenever the state changed.
//
// The same animation carries the frame's own foot offset in the transform's Y,
// so frame selection and foot alignment can never drift out of phase. The clip
// reaches `maxOffset` below the ground line, so a frame lowered by its offset
// is never cut off.

export { PET_BODY_PX }

export interface PetSpriteProps {
  pet: PetDescriptor
  state: MascotStateName
  thinking?: boolean
  facing: 'left' | 'right'
}

function PetSpriteImpl({ pet, state, thinking, facing }: PetSpriteProps) {
  const layout = petLayout(pet, { state, thinking, facing })
  const { rowIndex, mirror, dispW, dispH, offsets } = layout

  // The mascot shell already applies `scaleX(-1)` to face left. Codex sheets
  // carry dedicated `running-left` / `running-right` rows that face their own
  // way, so honouring both flips would mirror the pet the WRONG way while it
  // walks. Cancel the shell's flip here and apply only what the row needs.
  const shellFlip = facing === 'left' ? -1 : 1
  const flipX = (mirror ? -1 : 1) * shellFlip

  const transforms = petFrameTransforms(layout)
  const frameMs = petFrameMs(layout)
  // How far below the ground line any frame of this row reaches.
  const maxOffset = Math.max(0, ...offsets)
  const stripRef = useRef<HTMLDivElement>(null)
  useFrameSteps(stripRef, transforms, frameMs)

  return (
    <>
      <div
        data-pet={pet.slug}
        data-pet-row={rowIndex}
        data-pet-frames={layout.frames}
        data-pet-frame-ms={frameMs}
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '50%',
          // The clip: one cell wide, from the cell's top down to the lowest
          // foot offset below the ground line.
          bottom: -maxOffset,
          width: dispW,
          height: dispH + maxOffset,
          overflow: 'hidden',
          // The squash on a hard landing rides the two custom properties, so it
          // can play without clobbering the centring or the facing flip. It
          // squashes about the ground line, where the feet are.
          transform: `translateX(-50%) scaleX(${flipX}) scale(var(--pet-squash-x, 1), var(--pet-squash-y, 1))`,
          transformOrigin: `50% ${dispH}px`,
        }}
      >
        <div
          ref={stripRef}
          data-pet-strip=""
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            // The row's frames side by side; the keyframes slide it under the clip.
            width: layout.frames * dispW,
            height: dispH,
            backgroundImage: `url(/setup-api/pets/sprite?slug=${encodeURIComponent(pet.slug)}&rev=${encodeURIComponent(pet.revision)})`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: `${pet.cols * dispW}px ${pet.rows * dispH}px`,
            backgroundPositionX: 0,
            backgroundPositionY: -rowIndex * dispH,
            // Pixel art. Smoothing it turns a 192px sprite scaled to 96px into mush.
            imageRendering: 'pixelated',
            // The first frame; useFrameSteps takes it from here.
            transform: transforms[0],
            willChange: 'transform',
          }}
        />
      </div>
    </>
  )
}

/**
 * Step `el`'s transform through `transforms`, one every `frameMs`. The frame
 * shown when the row changes is the row's first; under reduced motion it stays
 * there, and while the document is hidden nothing runs at all.
 */
function useFrameSteps(ref: React.RefObject<HTMLDivElement | null>, transforms: string[], frameMs: number) {
  const key = transforms.join('|')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const frames = key.split('|')
    el.style.transform = frames[0]
    if (frames.length < 2) return
    const reduce = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    let i = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const still = () => document.visibilityState === 'hidden' || reduce?.matches === true
    const tick = () => {
      timer = null
      if (still()) return
      i = (i + 1) % frames.length
      el.style.transform = frames[i]
      timer = setTimeout(tick, frameMs)
    }
    const resume = () => {
      if (reduce?.matches) {
        i = 0
        el.style.transform = frames[0]
      }
      if (timer === null && !still()) timer = setTimeout(tick, frameMs)
    }
    resume()
    document.addEventListener('visibilitychange', resume)
    reduce?.addEventListener?.('change', resume)
    return () => {
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
      reduce?.removeEventListener?.('change', resume)
    }
  }, [ref, key, frameMs])
}

export default memo(PetSpriteImpl)
