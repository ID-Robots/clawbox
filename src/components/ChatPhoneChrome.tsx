'use client'

import React, { useRef } from 'react'
import { useTr } from '@/lib/i18n-floor'
import {
  DEFAULT_CHAT_TEXT_SCALE,
  chatTextScalePercent,
  isLargestChatTextScale,
  isSmallestChatTextScale,
  stepChatTextScale,
  type ChatTextScale,
} from '@/lib/chat-phone-layout'

/**
 * The phone chat's view controls (TASK-1157), shared by both chat surfaces —
 * the mascot chat (ChatPopup, where a phone lands) and the full page at
 * /app/clawbox (ChatApp) — so the two cannot drift on how fullscreen chat or
 * the text size is offered. Only ever rendered in a phone layout; the desktop
 * never draws any of this.
 *
 * Every control is a native button with its own name, so what fullscreen hides
 * is always one focusable, announced control away: the strip's toggle says
 * whether the header is open (`aria-expanded`) and which element it opens
 * (`aria-controls`), the fullscreen switch says its state (`aria-pressed`), and
 * the text size bar is a labelled group whose value is read out as it changes.
 */

/** The small, square icon button every control here is drawn as. */
function iconButtonStyle(active: boolean, size: number): React.CSSProperties {
  return {
    width: size, height: size, minWidth: size, borderRadius: 10, border: 'none',
    background: active ? 'rgba(249,115,22,0.2)' : 'transparent',
    color: active ? '#f97316' : 'rgba(255,255,255,0.55)',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, padding: 0, fontFamily: 'inherit',
  }
}

interface FullscreenButtonProps {
  fullscreen: boolean
  onToggle: () => void
  /** 40 in the header, 32 in the strip. Both clear the 24px minimum target. */
  size?: number
}

/** Enter or leave fullscreen chat — one control, its state in `aria-pressed`. */
export function ChatFullscreenButton({ fullscreen, onToggle, size = 40 }: FullscreenButtonProps) {
  const tr = useTr()
  const label = fullscreen
    ? tr('chat.view.exitFullscreen', 'Exit fullscreen chat')
    : tr('chat.view.fullscreen', 'Fullscreen chat')
  return (
    <button
      type="button"
      onClick={onToggle}
      onPointerDown={(e) => e.stopPropagation()}
      aria-pressed={fullscreen}
      aria-label={label}
      title={label}
      data-testid="chat-fullscreen-toggle"
      className="chat-view-button"
      style={iconButtonStyle(false, size)}
    >
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 20 }}>
        {fullscreen ? 'fullscreen_exit' : 'fullscreen'}
      </span>
    </button>
  )
}

interface TextSizeButtonProps {
  open: boolean
  onToggle: () => void
  /** The id of the text size bar this opens. */
  controls: string
  size?: number
}

/** Opens the text size bar under the header. */
export function ChatTextSizeButton({ open, onToggle, controls, size = 40 }: TextSizeButtonProps) {
  const tr = useTr()
  const label = tr('chat.view.textSize', 'Text size')
  return (
    <button
      type="button"
      onClick={onToggle}
      onPointerDown={(e) => e.stopPropagation()}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={label}
      title={label}
      data-testid="chat-text-size-toggle"
      className="chat-view-button"
      style={iconButtonStyle(open, size)}
    >
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 20 }}>format_size</span>
    </button>
  )
}

interface TextSizeBarProps {
  id: string
  scale: ChatTextScale
  onChange: (scale: ChatTextScale) => void
}

/**
 * The conversation's text size, a step at a time: smaller, the current size
 * (pressing it goes back to 100%), larger. In the flow under the header, so the
 * transcript it resizes stays in view while the owner picks.
 */
export function ChatTextSizeBar({ id, scale, onChange }: TextSizeBarProps) {
  const tr = useTr()
  const percent = chatTextScalePercent(scale)
  const stepStyle: React.CSSProperties = {
    minWidth: 44, height: 36, borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'inherit', fontWeight: 600, padding: '0 10px',
  }
  return (
    <div
      id={id}
      role="group"
      aria-label={tr('chat.view.textSize', 'Text size')}
      data-testid="chat-text-size-bar"
      style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 12px', background: 'rgba(0,0,0,0.2)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <span aria-hidden="true" style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {tr('chat.view.textSize', 'Text size')}
      </span>
      <button
        type="button"
        onClick={() => onChange(stepChatTextScale(scale, -1))}
        disabled={isSmallestChatTextScale(scale)}
        aria-label={tr('chat.view.textSmaller', 'Smaller text')}
        title={tr('chat.view.textSmaller', 'Smaller text')}
        data-testid="chat-text-size-smaller"
        style={{ ...stepStyle, fontSize: 13, opacity: isSmallestChatTextScale(scale) ? 0.4 : 1, cursor: isSmallestChatTextScale(scale) ? 'default' : 'pointer' }}
      >
        A−
      </button>
      {/* The value, as a live region, so a screen reader hears where each
          press landed; pressing it resets to 100%. */}
      <button
        type="button"
        onClick={() => onChange(DEFAULT_CHAT_TEXT_SCALE)}
        aria-label={tr('chat.view.textReset', 'Reset text size')}
        title={tr('chat.view.textReset', 'Reset text size')}
        data-testid="chat-text-size-reset"
        style={{ ...stepStyle, minWidth: 64, fontVariantNumeric: 'tabular-nums', fontSize: 13, background: 'transparent', border: '1px solid transparent' }}
      >
        <span aria-live="polite" data-testid="chat-text-size-value">{percent}%</span>
      </button>
      <button
        type="button"
        onClick={() => onChange(stepChatTextScale(scale, 1))}
        disabled={isLargestChatTextScale(scale)}
        aria-label={tr('chat.view.textLarger', 'Larger text')}
        title={tr('chat.view.textLarger', 'Larger text')}
        data-testid="chat-text-size-larger"
        style={{ ...stepStyle, fontSize: 16, opacity: isLargestChatTextScale(scale) ? 0.4 : 1, cursor: isLargestChatTextScale(scale) ? 'default' : 'pointer' }}
      >
        A+
      </button>
    </div>
  )
}

/** How far a finger has to travel on the strip before it counts as a swipe. */
export const STRIP_SWIPE_PX = 24

interface HeaderStripProps {
  /** The id of the header this strip opens. */
  headerId: string
  headerOpen: boolean
  onToggleHeader: (open: boolean) => void
  /** What the header's title says — the active conversation's name. */
  label: string
  /** Another conversation is answering, or holds a reply nobody has read. */
  activity?: 'busy' | 'unread' | null
  /** The folded pickers' answer ("Claude · Medium"), while they are folded. */
  summary?: string
  /** The strip's other controls: the text size and fullscreen buttons. */
  children?: React.ReactNode
}

/**
 * What stays of the header in fullscreen chat: one slim row whose main control
 * opens the full header (tabs, new chat, the way to the desktop) under it.
 * A tap toggles it; so does a swipe down (open) or up (close) along the strip.
 */
export function ChatHeaderStrip({ headerId, headerOpen, onToggleHeader, label, activity, summary, children }: HeaderStripProps) {
  const tr = useTr()
  const swipeStartY = useRef<number | null>(null)
  // A swipe that toggled already must not have its trailing click undo it.
  const swallowClick = useRef(false)
  const name = headerOpen
    ? tr('chat.view.hideHeader', 'Hide chat header')
    : tr('chat.view.showHeader', 'Show chat header')
  return (
    <div
      data-testid="chat-header-strip"
      className="chat-header-strip"
      onPointerDown={(e) => {
        // Touch and pen only: a mouse press is a click, handled below.
        if (e.pointerType === 'mouse') return
        swipeStartY.current = e.clientY
      }}
      onPointerUp={(e) => {
        const start = swipeStartY.current
        swipeStartY.current = null
        if (start === null) return
        const dy = e.clientY - start
        if (dy >= STRIP_SWIPE_PX && !headerOpen) {
          swallowClick.current = true
          onToggleHeader(true)
        } else if (dy <= -STRIP_SWIPE_PX && headerOpen) {
          swallowClick.current = true
          onToggleHeader(false)
        }
      }}
      onPointerCancel={() => { swipeStartY.current = null }}
      style={{
        flexShrink: 0, minHeight: 32, display: 'flex', alignItems: 'center', gap: 4,
        padding: '0 6px 0 4px', background: 'rgba(0,0,0,0.2)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        // The strip owns vertical drags so a swipe reads as a swipe rather than
        // as the page trying to scroll.
        touchAction: 'pan-x', userSelect: 'none',
      }}
    >
      <button
        type="button"
        onClick={() => {
          if (swallowClick.current) { swallowClick.current = false; return }
          onToggleHeader(!headerOpen)
        }}
        aria-expanded={headerOpen}
        aria-controls={headerId}
        aria-label={name}
        title={name}
        data-testid="chat-header-toggle"
        style={{
          flex: 1, minWidth: 0, minHeight: 32, display: 'flex', alignItems: 'center', gap: 6,
          padding: '0 8px', border: 'none', borderRadius: 8, background: 'transparent',
          color: 'rgba(255,255,255,0.75)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
        }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 20, flexShrink: 0 }}>
          {headerOpen ? 'expand_less' : 'expand_more'}
        </span>
        <span aria-hidden="true" style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
        {activity && (
          <span
            data-testid={`chat-header-strip-${activity}`}
            aria-hidden="true"
            style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: activity === 'busy' ? '#f97316' : '#22c55e',
            }}
          />
        )}
        {summary && (
          <span data-testid="chat-pill-summary" className="chat-pill-summary" aria-hidden="true" style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.45)' }}>
            {summary}
          </span>
        )}
      </button>
      {children}
    </div>
  )
}
