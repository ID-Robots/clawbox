'use client'

import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const activeOption = options.find(o => o.id === value)

  const close = useCallback(() => setOpen(false), [])

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
      {open && (
        <div
          ref={popoverRef}
          role="listbox"
          aria-label={ariaLabel}
          className="header-dropdown-popover"
          style={{ width: popoverWidth }}
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
        </div>
      )}
    </div>
  )
}
