'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SlashCommand } from '@/lib/chat-slash-commands'

/**
 * The composer's slash-command popover — one component, both chat surfaces.
 *
 * PORTALED and `position: fixed`, for the same reason `HeaderDropdown` is: the
 * mascot chat's window clips its content (`overflow: hidden`), and neither
 * composer container is a positioned ancestor — the mascot's inner wrapper is
 * `display: contents` on desktop, which is not one at all. An absolutely
 * positioned menu there anchors to the wrong box or is cut off entirely.
 *
 * FOCUS NEVER COMES HERE. The rows are `<div role="option">` rather than
 * buttons, and the whole popover is `aria-hidden`-free but untabbable: the
 * textarea keeps focus and owns the interaction through `aria-activedescendant`,
 * which is what lets the owner keep typing while the list narrows. A menu that
 * took focus would blur the composer on its first Arrow key.
 */

export interface SlashCommandMenuProps {
  /**
   * The composer the menu is anchored to and whose focus it borrows.
   *
   * A REF rather than the element: reading `inputRef.current` in the host's
   * render is reading a ref during render, which React has no guarantee about
   * and the lint rightly refuses. The element is needed for a measurement, and
   * a measurement belongs in a layout effect — where the ref is exactly what
   * one is allowed to read.
   */
  anchorRef: RefObject<HTMLTextAreaElement | null>
  commands: readonly SlashCommand[]
  /** Index into `commands`; the row rendered as highlighted. */
  activeIndex: number
  /** The listbox's DOM id — the textarea points at it with `aria-controls`. */
  listboxId: string
  /** `${listboxId}-${index}` for the active row, as the textarea advertises. */
  optionId: (index: number) => string
  onPick: (command: SlashCommand) => void
  /** Pointer hover moves the highlight, so Enter takes what the eye is on. */
  onHover: (index: number) => void
  ariaLabel: string
  emptyLabel: string
  /** Hermes edition: the portaled node sits outside the skin's ancestor. */
  hermes?: boolean
}

interface Coords {
  left: number
  width: number
  /** One of the two is a number; the other is null. See the flip below. */
  top: number | null
  bottom: number | null
  maxHeight: number
}

/** Breathing room from the viewport edge, and from the composer. */
const MARGIN = 8
const GAP = 6
/** Tall enough for the eight rows the source caps a filtered list at. */
const MAX_DESIRED = 320
/** Below this there is no room under the composer at all, whatever is above. */
const MIN_SPACE_BELOW = 160

export default function SlashCommandMenu({
  anchorRef,
  commands,
  activeIndex,
  listboxId,
  optionId,
  onPick,
  onHover,
  ariaLabel,
  emptyLabel,
  hermes,
}: SlashCommandMenuProps) {
  const [coords, setCoords] = useState<Coords | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Measured from the anchor every time the list changes shape, and again on
  // scroll and resize — the mascot chat is a window the owner drags.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const compute = () => {
      const rect = anchor.getBoundingClientRect()
      const width = Math.max(200, Math.min(rect.width, window.innerWidth - MARGIN * 2))
      const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN))
      const spaceAbove = rect.top - MARGIN - GAP
      const spaceBelow = window.innerHeight - rect.bottom - MARGIN - GAP
      // A composer sits at the BOTTOM of a chat, so the menu opens UPWARD —
      // over the transcript, which is the room there is — whenever there is
      // more of it above than below. Measured on the box first: the
      // dropdown-style rule (flip only once the space below drops under a
      // floor) kept the menu below a composer with 210px under it, which is a
      // cap of three rows out of eight with the rest behind a scrollbar and
      // the list hanging over the shelf. Below is still what a composer at the
      // TOP of its container gets.
      //
      // Anchored by `bottom` rather than by a top derived from maxHeight: a
      // list that then renders shorter than its cap would otherwise float away
      // from the composer it belongs to.
      const above = spaceAbove > spaceBelow || spaceBelow < MIN_SPACE_BELOW
      return {
        left,
        width,
        top: above ? null : Math.round(rect.bottom + GAP),
        bottom: above ? Math.round(window.innerHeight - rect.top + GAP) : null,
        maxHeight: Math.max(96, Math.min(MAX_DESIRED, above ? spaceAbove : spaceBelow)),
      }
    }
    // The same identity-preserving update `HeaderDropdown` makes, for the same
    // reason: scrolling the popover itself reaches this capture-phase listener
    // and leaves the anchor's rect untouched, so every scroll event would
    // otherwise re-render the list to the numbers it already had.
    const apply = () => {
      const next = compute()
      setCoords((prev) =>
        prev
        && prev.left === next.left
        && prev.top === next.top
        && prev.bottom === next.bottom
        && prev.maxHeight === next.maxHeight
        && prev.width === next.width
          ? prev
          : next,
      )
    }
    apply()
    window.addEventListener('resize', apply)
    // Capture: the transcript scrolls inside the chat, not on the window.
    window.addEventListener('scroll', apply, true)
    return () => {
      window.removeEventListener('resize', apply)
      window.removeEventListener('scroll', apply, true)
    }
  }, [anchorRef, commands.length])

  // Keep the highlighted row in view as Arrow keys walk past the fold. The
  // textarea has focus, so nothing here can rely on `:focus` scrolling it.
  useLayoutEffect(() => {
    const row = popoverRef.current?.querySelector<HTMLElement>('[data-slash-active="true"]')
    row?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, commands])

  if (!coords || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={popoverRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      data-testid="chat-slash-menu"
      {...(hermes ? { 'data-agent': 'hermes' } : {})}
      // The composer is a drag handle in the mascot chat; a pointer that lands
      // on the menu must not start moving the window behind it.
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
      className="header-dropdown-popover slash-command-menu"
      style={{
        position: 'fixed',
        left: coords.left,
        ...(coords.top !== null
          ? { top: coords.top, bottom: 'auto' as const }
          : { top: 'auto' as const, bottom: coords.bottom ?? 0 }),
        width: coords.width,
        maxHeight: coords.maxHeight,
        // Above the mascot chat window (10010) and level with the header
        // pickers, which are the only other things that can be open here.
        zIndex: 10050,
      }}
    >
      {commands.length === 0 ? (
        <div className="slash-command-empty" data-testid="chat-slash-empty">{emptyLabel}</div>
      ) : (
        commands.map((command, index) => (
          <div
            key={command.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            data-slash-active={index === activeIndex ? 'true' : 'false'}
            className={`header-dropdown-option${index === activeIndex ? ' is-active' : ''}`}
            // `onPointerDown` and not `onClick`: a click fires after a blur,
            // and by then the composer has lost focus and the menu has closed.
            onPointerDown={(e) => { e.preventDefault(); onPick(command) }}
            onPointerMove={() => onHover(index)}
          >
            <span className="header-dropdown-option-main">
              <span className="slash-command-usage">{command.usage}</span>
            </span>
            {command.description ? (
              <span className="slash-command-description">{command.description}</span>
            ) : null}
          </div>
        ))
      )}
    </div>,
    document.body,
  )
}
