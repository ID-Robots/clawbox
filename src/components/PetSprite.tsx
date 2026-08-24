'use client'

import React, { memo } from 'react'
import { type MascotStateName } from '@/lib/pet-state-map'
import { petKeyframes, petLayout, PET_BODY_PX } from '@/lib/pet-layout'
import type { PetDescriptor } from '@/lib/pet-client'

// ── The pet body ──
//
// A Petdex sheet is a grid of 192x208 cells: one animation state per row,
// stepped frames per state, 1100 ms per loop. That is a frame-SELECTION
// animation, which is why none of the crab's keyframes can be reused here —
// `mascot-waddle` and friends transform a whole image, and applying one to a
// spritesheet would wobble the sheet, not step through it.
//
// Rendered with CSS keyframes over `background-position-x` rather than a
// canvas: it is what the Petdex web client itself does, it needs no rAF loop of
// its own (the mascot already runs one for roaming), and it keeps animating
// across React re-renders instead of restarting.
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
// The same animation now carries the frame's own foot offset in `bottom`, so
// frame selection and foot alignment can never drift out of phase.

export { PET_BODY_PX }

export interface PetSpriteProps {
  pet: PetDescriptor
  state: MascotStateName
  thinking?: boolean
  facing: 'left' | 'right'
}

function PetSpriteImpl({ pet, state, thinking, facing }: PetSpriteProps) {
  const layout = petLayout(pet, { state, thinking, facing })
  const { rowIndex, mirror, dispW, dispH, offsets, loopMs } = layout

  // The mascot shell already applies `scaleX(-1)` to face left. Codex sheets
  // carry dedicated `running-left` / `running-right` rows that face their own
  // way, so honouring both flips would mirror the pet the WRONG way while it
  // walks. Cancel the shell's flip here and apply only what the row needs.
  const shellFlip = facing === 'left' ? -1 : 1
  const flipX = (mirror ? -1 : 1) * shellFlip

  const { name: keyframe, css } = petKeyframes(layout)

  return (
    <>
      <style>{css}</style>
      <div
        data-pet={pet.slug}
        data-pet-row={rowIndex}
        data-pet-frames={layout.frames}
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '50%',
          // The animation overrides this per frame with that frame's own foot
          // offset; the static value is the un-measured floor.
          bottom: -offsets[0],
          width: dispW,
          height: dispH,
          // The squash on a hard landing rides the two custom properties, so it
          // can play without clobbering the centring or the facing flip.
          transform: `translateX(-50%) scaleX(${flipX}) scale(var(--pet-squash-x, 1), var(--pet-squash-y, 1))`,
          transformOrigin: '50% 100%',
          backgroundImage: `url(/setup-api/pets/sprite?slug=${encodeURIComponent(pet.slug)}&rev=${encodeURIComponent(pet.revision)})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${pet.cols * dispW}px ${pet.rows * dispH}px`,
          backgroundPositionX: 0,
          backgroundPositionY: -rowIndex * dispH,
          // Pixel art. Smoothing it turns a 192px sprite scaled to 96px into mush.
          imageRendering: 'pixelated',
          animation: `${keyframe} ${loopMs}ms step-end infinite`,
          willChange: 'background-position, bottom',
        }}
      />
    </>
  )
}

export default memo(PetSpriteImpl)
