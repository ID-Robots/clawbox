'use client'

import React, { memo } from 'react'
import { petFrameFor, type MascotStateName } from '@/lib/pet-state-map'
import type { PetDescriptor } from '@/lib/pet-client'

// ── The pet body ──
//
// A Petdex sheet is a grid of 192x208 cells: one animation state per row, six
// stepped frames per state, 1100 ms per loop. That is a frame-SELECTION
// animation, which is why none of the crab's keyframes can be reused here —
// `mascot-waddle` and friends transform a whole image, and applying one to a
// spritesheet would wobble the sheet, not step through it.
//
// Rendered with CSS `steps()` over `background-position-x` rather than a
// canvas: it is what the Petdex web client itself does, it needs no rAF loop of
// its own (the mascot already runs one for roaming), and it keeps animating
// across React re-renders instead of restarting.

/** Rendered cell height, in px.
 *
 *  Deliberately SMALLER than the crab's 150px body. Matching the crab was the
 *  original choice, so that every offset in Mascot.tsx kept working untouched —
 *  but the two bodies are not the same shape. The crab is one illustration that
 *  fills its box; a Petdex cell is 192x208 with the character inset inside it,
 *  so at 150 the pet read as oversized next to its own speech bubble and left
 *  no room above its head. Mascot.tsx sizes the pet branch off THIS number, so
 *  changing it moves the bubble and the effects with it.
 *
 *  Hermes' own `display.pet.scale` (0.33) is still not used: it is a shared
 *  scalar tuned for a terminal corner sprite, and writing to it would resize
 *  the CLI and TUI too. */
export const PET_BODY_PX = 112

const TARGET_H = PET_BODY_PX

export interface PetSpriteProps {
  pet: PetDescriptor
  state: MascotStateName
  thinking?: boolean
  facing: 'left' | 'right'
}

function PetSpriteImpl({ pet, state, thinking, facing }: PetSpriteProps) {
  const scale = TARGET_H / pet.frameH
  const dispW = pet.frameW * scale
  const dispH = pet.frameH * scale
  const frames = Math.max(1, pet.framesPerState)

  const { rowIndex, mirror } = petFrameFor({ state, thinking, facing }, pet.rows)

  // The mascot shell already applies `scaleX(-1)` to face left. Codex sheets
  // carry dedicated `running-left` / `running-right` rows that face their own
  // way, so honouring both flips would mirror the pet the WRONG way while it
  // walks. Cancel the shell's flip here and apply only what the row needs.
  const shellFlip = facing === 'left' ? -1 : 1
  const flipX = (mirror ? -1 : 1) * shellFlip

  const travel = Math.round(frames * dispW)
  const keyframe = `pet-steps-${frames}-${travel}`

  return (
    <>
      <style>{`@keyframes ${keyframe}{from{background-position-x:0px}to{background-position-x:-${travel}px}}`}</style>
      <div
        data-pet={pet.slug}
        data-pet-row={rowIndex}
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 0,
          width: dispW,
          height: dispH,
          transform: `translateX(-50%) scaleX(${flipX})`,
          backgroundImage: `url(/setup-api/pets/sprite?slug=${encodeURIComponent(pet.slug)}&rev=${encodeURIComponent(pet.revision)})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${pet.cols * dispW}px ${pet.rows * dispH}px`,
          backgroundPositionX: 0,
          backgroundPositionY: -rowIndex * dispH,
          // Pixel art. Smoothing it turns a 192px sprite scaled to 138px into mush.
          imageRendering: 'pixelated',
          animation: `${keyframe} ${pet.loopMs}ms steps(${frames}) infinite`,
          willChange: 'background-position',
        }}
      />
    </>
  )
}

export default memo(PetSpriteImpl)
