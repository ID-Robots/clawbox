'use client'

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface HeaderDropdownOption {
  id: string
  label: string
  hint?: string
  disabled?: boolean
  /** Why this option cannot be picked. Rendered in place of `hint` on a
   * disabled row so the list says WHY rather than just greying out — a
   * silently dead row reads as a bug, and a silently missing one is worse. */
  unavailableReason?: string
}

interface HeaderDropdownProps {
  value: string
  options: HeaderDropdownOption[]
  onChange: (id: string) => void
  ariaLabel?: string
  /** Optional override for the text rendered inside the closed trigger
   * pill. Useful when the popover should show the full label
   * ("OpenAI Codex") but the pill itself wants a compact form
   * ("Codex") to fit a narrow header. Falls back to the active
   * option's `label`. */
  triggerLabel?: string
  /** Material Symbols ligature rendered as a small leading glyph inside the
   * closed trigger, e.g. "neurology" on the reasoning-effort pill. Use it when
   * the value alone ("Medium") would not say WHICH control it belongs to: at
   * 13px the glyph costs ~11px of row where the equivalent word prefix
   * ("Thinking: ") cost ~55px and truncated the value away. Purely decorative
   * — the accessible name still comes from `ariaLabel` + the label text. */
  triggerIcon?: string
  /** Maximum trigger width before the label truncates with "...". */
  triggerMaxWidth?: number
  /** Width of the popover when open. Defaults to a comfortable 220px for a
   * pill (so full model names fit even when the trigger is squeezed) and to
   * the trigger's own measured width for a `field`. */
  popoverWidth?: number | 'trigger'
  disabled?: boolean
  /** DOM id for the trigger, so a visible <label htmlFor> names it. */
  id?: string
  /** `pill` (default) is the compact chat-header pill. `field` is the
   * full-width, 48px-tall form control the setup wizard puts under a
   * label — same component, form proportions and 44px+ touch rows. */
  variant?: 'pill' | 'field'
  /** Hermes edition. Stamps `data-agent="hermes"` on the container AND on the
   * portaled popover — the popover mounts on <body>, outside the wizard's
   * skin ancestor, so it has to carry the marker itself. Same pattern as
   * ReconnectStage and CredentialsWriteDownDialog. The colours themselves
   * live in globals.css, next to the block documenting the wizard's Hermes
   * rules; nothing here re-types a hex. */
  hermes?: boolean
  /** Stop pointer events from bubbling to the chat header drag handler.
   * Pass through whatever the chat popup uses. */
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
}

const TYPEAHEAD_RESET_MS = 700

/**
 * Custom popover dropdown. Replaces native <select> wherever the option
 * list has to be readable: native <option> elements cannot be themed —
 * every browser paints its own popup (white ground, near-invisible pale
 * text on our dark wizard) and none of them render a second hint line or
 * an honest "why is this row dead" reason.
 *
 * Used by the chat header pills (compact `pill` variant, trigger truncates
 * with "..." while the open menu shows full labels) and by the setup
 * wizard's provider model picker (`field` variant, full-width form control).
 *
 * Keyboard: the trigger opens on Enter/Space/Arrow keys; the open list is a
 * roving-tabindex listbox (Arrow/Home/End move, Enter/Space pick, Escape
 * closes and returns focus to the trigger, printable characters type-ahead).
 */
export function HeaderDropdown({
  value,
  options,
  onChange,
  ariaLabel,
  triggerLabel,
  triggerIcon,
  triggerMaxWidth,
  variant = 'pill',
  popoverWidth = variant === 'field' ? 'trigger' : 220,
  disabled = false,
  id,
  hermes = false,
  onPointerDown,
}: HeaderDropdownProps) {
  const [open, setOpen] = useState(false)
  // Viewport-space (position: fixed) coordinates for the open popover.
  // The popover is portaled to <body> so it can't be clipped by the chat
  // window's `overflow: hidden` — see the flip/shift logic below.
  const [coords, setCoords] = useState<{ left: number; top: number; maxHeight: number; width: number } | null>(null)
  // Index of the option that currently holds DOM focus inside the open list.
  const [activeIndex, setActiveIndex] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef<{ query: string; at: number }>({ query: '', at: 0 })
  const activeOption = options.find(o => o.id === value)
  const listboxId = useId()
  const labelText = triggerLabel ?? activeOption?.label ?? value
  // `ariaLabel` names the CONTROL ("Reasoning effort"); on its own as
  // aria-label it REPLACED the visible text, so a screen-reader user heard
  // which dial it was but never its value. Compose both.
  const accessibleName = ariaLabel ? `${ariaLabel}: ${labelText}` : labelText
  const isField = variant === 'field'
  const agent = hermes ? 'hermes' : undefined

  // Arrow keys walk EVERY row, unavailable ones included: they are the rows
  // that carry the reason they cannot be picked, and skipping them would hide
  // that reason from exactly the users who cannot see the greyed styling.
  const wrap = useCallback(
    (index: number) => {
      if (options.length === 0) return -1
      return ((index % options.length) + options.length) % options.length
    },
    [options.length],
  )

  /** Row to LAND on when the list opens: the first selectable one walking in
   * `step`'s direction, falling back to row 0 when every row is unavailable.
   * Named for what it returns, not for what it looks for. */
  const landingIndex = useCallback(
    (from: number, step: 1 | -1) => {
      if (options.length === 0) return -1
      let i = wrap(from)
      for (let n = 0; n < options.length; n += 1) {
        if (!options[i].disabled) return i
        i = wrap(i + step)
      }
      return 0
    },
    [options, wrap],
  )

  /** The only place open-state is torn down. `refocus` is for the paths where
   * the customer is still driving the control (Escape, a pick) rather than
   * clicking or tabbing away from it. */
  const close = useCallback((refocus = false) => {
    setOpen(false)
    setActiveIndex(-1)
    if (refocus) triggerRef.current?.focus()
  }, [])

  const openList = useCallback(
    (seek: 'active' | 'last') => {
      if (disabled) return
      const current = options.findIndex(o => o.id === value && !o.disabled)
      const next = seek === 'last'
        ? landingIndex(options.length - 1, -1)
        : current >= 0 ? current : landingIndex(0, 1)
      setActiveIndex(next)
      setOpen(true)
    },
    [disabled, options, value, landingIndex],
  )

  // Position the open popover in viewport coordinates, flipping above the
  // trigger when there isn't room below and shifting horizontally so it
  // never spills past a viewport edge. Recomputes on scroll/resize so it
  // stays glued to the trigger while the chat window moves.
  useLayoutEffect(() => {
    if (!open) return
    const compute = () => {
      const t = triggerRef.current?.getBoundingClientRect()
      if (!t) return
      const margin = 8
      const gap = 6
      const maxDesired = 320
      const vw = window.innerWidth
      const vh = window.innerHeight
      // A `field` dropdown is as wide as the control it drops out of; a pill
      // uses the fixed roomy width so a long model name isn't squeezed into
      // whatever the header left it. Either way it never exceeds the viewport.
      const desiredWidth = popoverWidth === 'trigger' ? t.width : popoverWidth
      const width = Math.max(160, Math.min(desiredWidth, vw - margin * 2))

      // Horizontal: align the popover's left edge to the trigger, but pull
      // it back inside if `width` would overrun the right edge.
      let left = t.left
      if (left + width > vw - margin) {
        left = t.right - width
      }
      left = Math.max(margin, Math.min(left, vw - width - margin))

      // Vertical: prefer opening below; flip above when there's more room
      // there. Cap `maxHeight` to the available space so the list scrolls
      // internally instead of being clipped.
      const spaceBelow = vh - t.bottom - gap - margin
      const spaceAbove = t.top - gap - margin
      let top: number
      let maxHeight: number
      const minPreferredHeight = 160
      if (spaceBelow >= minPreferredHeight || spaceBelow >= spaceAbove) {
        top = t.bottom + gap
        maxHeight = Math.min(maxDesired, spaceBelow)
      } else {
        maxHeight = Math.min(maxDesired, spaceAbove)
        top = Math.max(margin, t.top - gap - maxHeight)
      }

      const next = { left, top, maxHeight: Math.max(maxHeight, 0), width }
      // Scrolling the popover itself reaches this listener (capture phase, on
      // window) and leaves the trigger rect untouched. Without this bail-out
      // every scroll event re-rendered the whole list to the same numbers.
      setCoords((prev) =>
        prev
        && prev.left === next.left
        && prev.top === next.top
        && prev.maxHeight === next.maxHeight
        && prev.width === next.width
          ? prev
          : next,
      )
    }
    compute()
    window.addEventListener('resize', compute)
    // Capture-phase so scrolling any ancestor (e.g. the chat body) repositions.
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [open, popoverWidth])

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return
    const handlePointer = (e: PointerEvent) => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      close()
    }
    // On window, bubble phase: Escape from inside the portaled list reaches it
    // too, so this is the ONE Escape handler — including for an empty list,
    // where no row ever took focus.
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    window.addEventListener('pointerdown', handlePointer, true)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('pointerdown', handlePointer, true)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open, close])

  // Move real DOM focus onto the active row. Roving tabindex rather than
  // aria-activedescendant: the rows are <button>s, so the browser's own
  // focus ring and scroll-into-view do the work, and a screen reader
  // announces the row it lands on.
  //
  // Read out of the live popover rather than a ref array — one query per
  // keystroke costs nothing, where a per-row ref callback was re-attaching
  // every row on every render of a list that can be 340 models long.
  useEffect(() => {
    if (!open || activeIndex < 0) return
    const el = popoverRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[activeIndex]
    if (!el) return
    el.focus()
    // Guarded: jsdom (and older WebViews) ship an Element without it, and a
    // missing convenience must not take the whole picker down.
    el.scrollIntoView?.({ block: 'nearest' })
    // `options.length`, not `options`: the array is a fresh literal from the
    // caller on every parent render, and re-stealing focus (plus the reflow
    // scrollIntoView forces) because the parent re-rendered is not the job.
  }, [open, activeIndex, options.length])

  const handleSelect = useCallback((option: HeaderDropdownOption) => {
    if (option.disabled) return
    if (option.id !== value) onChange(option.id)
    close(true)
  }, [value, onChange, close])

  const handleTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return
      // Enter and Space are NOT handled here: the trigger is a <button>, so
      // the browser already synthesises a click for both, and onClick opens.
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        openList('active')
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        openList('last')
      }
    },
    [disabled, openList],
  )

  const handleListKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case 'Tab':
          // Let focus leave, but don't leave a menu hanging over the page — and
          // put focus on the TRIGGER first. The focused row is about to be
          // unmounted with the portal, and the browser resolves the next tab
          // stop from wherever focus is standing; without this it falls back to
          // <body> and a keyboard user restarts from the top of the wizard.
          close(true)
          return
        case 'ArrowDown':
          e.preventDefault()
          setActiveIndex(i => wrap(i + 1))
          return
        case 'ArrowUp':
          e.preventDefault()
          setActiveIndex(i => wrap(i - 1))
          return
        case 'Home':
          e.preventDefault()
          setActiveIndex(0)
          return
        case 'End':
          e.preventDefault()
          setActiveIndex(options.length - 1)
          return
        case 'Enter':
        case ' ': {
          e.preventDefault()
          const option = options[activeIndex]
          if (option) handleSelect(option)
          return
        }
        default:
          break
      }
      // Type-ahead: jump to the next option whose label starts with what the
      // user has typed. A native <select> does this and customers expect it.
      if (e.key.length !== 1 || e.altKey || e.ctrlKey || e.metaKey) return
      const now = Date.now()
      const query = (now - typeahead.current.at > TYPEAHEAD_RESET_MS ? '' : typeahead.current.query) + e.key.toLowerCase()
      typeahead.current = { query, at: now }
      const start = activeIndex < 0 ? 0 : activeIndex
      for (let n = 1; n <= options.length; n += 1) {
        const i = (start + (query.length > 1 ? n - 1 : n)) % options.length
        const option = options[i]
        if (option.label.toLowerCase().startsWith(query)) {
          e.preventDefault()
          setActiveIndex(i)
          return
        }
      }
    },
    [activeIndex, close, handleSelect, options, wrap],
  )

  return (
    <div
      className={`header-dropdown${isField ? ' header-dropdown--field' : ''}`}
      data-agent={agent}
      onPointerDown={onPointerDown}
      style={{ position: 'relative' }}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-label={accessibleName}
        title={accessibleName}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openList('active'))}
        onKeyDown={handleTriggerKeyDown}
        className="header-dropdown-trigger"
        style={{
          ...(triggerMaxWidth ? { maxWidth: triggerMaxWidth } : null),
          // Tighter than globals.css's 12/24 default. Measured on-device: this
          // buys ~4px per pill back for the LABELS, which is what lets all
          // three render un-truncated at the 400px docked default. The chevron
          // below shrinks to match, so the clearance around it is unchanged.
          // A pill with a leading glyph gives up most of its left padding —
          // the glyph is the visual inset. The `field` variant is a form
          // control, not a pill, and keeps the stylesheet's roomier padding.
          ...(isField ? null : { paddingLeft: triggerIcon ? 5 : 10, paddingRight: 20 }),
        }}
      >
        {triggerIcon && (
          <span
            className="material-symbols-rounded"
            aria-hidden="true"
            style={{ fontSize: 13, marginRight: 4, flexShrink: 0, opacity: 0.75 }}
          >
            {triggerIcon}
          </span>
        )}
        <span className="header-dropdown-trigger-label">
          {labelText}
        </span>
        <span
          className="material-symbols-rounded header-dropdown-trigger-chevron"
          aria-hidden="true"
          style={{
            ...(isField ? null : { fontSize: 14, right: 3 }),
            transform: open ? 'rotate(180deg)' : undefined,
          }}
        >
          expand_more
        </span>
      </button>
      {open && coords && createPortal(
        <div
          ref={popoverRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className={`header-dropdown-popover${isField ? ' header-dropdown-popover--field' : ''}`}
          data-agent={agent}
          onPointerDown={onPointerDown}
          onKeyDown={handleListKeyDown}
          style={{
            position: 'fixed',
            left: coords.left,
            top: coords.top,
            width: coords.width,
            maxHeight: coords.maxHeight,
            // Above the chat popup (zIndex 10010) so it is never clipped.
            zIndex: 10050,
          }}
        >
          {options.map((option, index) => {
            const isActive = option.id === value
            const secondary = option.disabled
              ? (option.unavailableReason ?? option.hint)
              : option.hint
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={isActive}
                aria-disabled={option.disabled || undefined}
                tabIndex={index === activeIndex ? 0 : -1}
                // `aria-disabled` rather than `disabled`: a disabled button is
                // unfocusable, so an unavailable row (and the reason it
                // carries) would be invisible to a keyboard or screen-reader
                // user — the exact "silently absent" failure this list exists
                // to avoid. The click handler still refuses it.
                onClick={() => handleSelect(option)}
                className={`header-dropdown-option${isActive ? ' is-active' : ''}${option.disabled ? ' is-unavailable' : ''}`}
              >
                <span className="header-dropdown-option-main">
                  <span className="header-dropdown-option-label">{option.label}</span>
                  {isActive && (
                    <span
                      className="material-symbols-rounded header-dropdown-option-check"
                      aria-hidden="true"
                    >
                      check
                    </span>
                  )}
                </span>
                {secondary && (
                  <span className="header-dropdown-option-hint">{secondary}</span>
                )}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}
