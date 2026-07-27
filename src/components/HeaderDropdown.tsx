'use client'

import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface HeaderDropdownOption {
  id: string
  label: string
  hint?: string
  disabled?: boolean
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
  /** Maximum trigger width before the label truncates with "...". */
  triggerMaxWidth?: number
  /** Width of the popover when open. Defaults to a comfortable 220px so
   * full model names fit even when the trigger pill is squeezed. */
  popoverWidth?: number
  disabled?: boolean
  /** Stop pointer events from bubbling to the chat header drag handler.
   * Pass through whatever the chat popup uses. */
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
}

/**
 * Custom popover dropdown for the chat header pills. Replaces native
 * <select> so the trigger pill can stay compact (truncating with ...
 * when the panel is narrow) while the open menu shows full labels +
 * hints in a wider floating card. Native selects also can't render
 * multi-line option content or match the dark theme reliably across
 * Windows / macOS / Linux.
 */
export function HeaderDropdown({
  value,
  options,
  onChange,
  ariaLabel,
  triggerLabel,
  triggerMaxWidth,
  popoverWidth = 220,
  disabled = false,
  onPointerDown,
}: HeaderDropdownProps) {
  const [open, setOpen] = useState(false)
  // Viewport-space (position: fixed) coordinates for the open popover.
  // The popover is portaled to <body> so it can't be clipped by the chat
  // window's `overflow: hidden` — see the flip/shift logic below.
  const [coords, setCoords] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const activeOption = options.find(o => o.id === value)
  const listboxId = useId()

  const close = useCallback(() => setOpen(false), [])

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

      // Horizontal: align the popover's left edge to the trigger, but pull
      // it back inside if `popoverWidth` would overrun the right edge.
      let left = t.left
      if (left + popoverWidth > vw - margin) {
        left = t.right - popoverWidth
      }
      left = Math.max(margin, Math.min(left, vw - popoverWidth - margin))

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

      setCoords({ left, top, maxHeight: Math.max(maxHeight, 0) })
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
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', handlePointer, true)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('pointerdown', handlePointer, true)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open, close])

  const handleSelect = useCallback((id: string) => {
    if (id !== value) onChange(id)
    close()
  }, [value, onChange, close])

  return (
    <div
      className="header-dropdown"
      onPointerDown={onPointerDown}
      style={{ position: 'relative' }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        className="header-dropdown-trigger"
        style={triggerMaxWidth ? { maxWidth: triggerMaxWidth } : undefined}
      >
        <span className="header-dropdown-trigger-label">
          {triggerLabel ?? activeOption?.label ?? value}
        </span>
        <span
          className="material-symbols-rounded header-dropdown-trigger-chevron"
          aria-hidden="true"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
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
          className="header-dropdown-popover"
          onPointerDown={onPointerDown}
          style={{
            position: 'fixed',
            left: coords.left,
            top: coords.top,
            width: popoverWidth,
            maxHeight: coords.maxHeight,
            // Above the chat popup (zIndex 10010) so it is never clipped.
            zIndex: 10050,
          }}
        >
          {options.map(option => {
            const isActive = option.id === value
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={isActive}
                disabled={option.disabled}
                onClick={() => !option.disabled && handleSelect(option.id)}
                className={`header-dropdown-option${isActive ? ' is-active' : ''}`}
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
                {option.hint && (
                  <span className="header-dropdown-option-hint">{option.hint}</span>
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
