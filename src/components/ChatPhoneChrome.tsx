'use client'

import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTr } from '@/lib/i18n-floor'
import {
  DEFAULT_CHAT_TEXT_SCALE,
  chatTextScalePercent,
  isLargestChatTextScale,
  isSmallestChatTextScale,
  stepChatTextScale,
  type ChatTextScale,
} from '@/lib/chat-phone-layout'
import { useModalDialog } from '@/hooks/useModalDialog'
import { CHAT_MOBILE_BACK, useMobileBack } from '@/lib/mobile-back'
import type { HeaderDropdownOption } from '@/components/HeaderDropdown'

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
  /** The steps' height: 36 under the header, 44 in the portrait menu. */
  stepSize?: number
}

/**
 * The conversation's text size, a step at a time: smaller, the current size
 * (pressing it goes back to 100%), larger. In the flow under the header, so the
 * transcript it resizes stays in view while the owner picks.
 */
export function ChatTextSizeBar({ id, scale, onChange, stepSize = 36 }: TextSizeBarProps) {
  const tr = useTr()
  const percent = chatTextScalePercent(scale)
  const stepStyle: React.CSSProperties = {
    minWidth: 44, height: stepSize, borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)',
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
      {/* The value; pressing it resets to 100%. Its name carries the value,
          since a button's content is presentational and a live region inside
          it goes unheard. */}
      <button
        type="button"
        onClick={() => onChange(DEFAULT_CHAT_TEXT_SCALE)}
        aria-label={`${tr('chat.view.textReset', 'Reset text size')} (${percent}%)`}
        title={tr('chat.view.textReset', 'Reset text size')}
        data-testid="chat-text-size-reset"
        style={{ ...stepStyle, minWidth: 64, fontVariantNumeric: 'tabular-nums', fontSize: 13, background: 'transparent', border: '1px solid transparent' }}
      >
        <span aria-hidden="true" data-testid="chat-text-size-value">{percent}%</span>
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
      {/* Outside every button, so a screen reader hears where each A− or A+
          press landed. */}
      <span className="sr-only" role="status" aria-live="polite" data-testid="chat-text-size-status">
        {`${tr('chat.view.textSize', 'Text size')} ${percent}%`}
      </span>
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
        // Every new press starts clean: a swipe whose finger never produced a
        // click must not eat the next real tap.
        swallowClick.current = false
        // Touch and pen only: a mouse press is a click, handled below.
        if (e.pointerType === 'mouse') return
        swipeStartY.current = e.clientY
      }}
      // Nor the next Enter or Space on the toggle, which comes with no press.
      onKeyDown={() => { swallowClick.current = false }}
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

// ── A phone held upright (TASK-2778) ────────────────────────────────────────
//
// Portrait trades the header for one slim bar — a menu button and, once there
// is a conversation, its title — and the composer for one row: "+", the model,
// the microphone and Send. What the header and the folded options held is still
// one tap away: the menu slides in from the left with a new chat, the open
// chats, the way to the desktop and the text size; "+" and the model pill each
// open a bottom sheet. ChatPopup draws these only while its phone is upright;
// landscape keeps the header, the strip and the fold above, the desktop none.

/** The phone's touch target: nothing here is smaller than 40px. */
const PHONE_TARGET = 44

const SHEET_CLOSE_STYLE: React.CSSProperties = {
  width: PHONE_TARGET, height: PHONE_TARGET, borderRadius: 12, border: 'none',
  background: 'transparent', color: 'rgba(255,255,255,0.75)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
  fontFamily: 'inherit', flexShrink: 0,
}

interface PhoneOverlayProps {
  placement: 'left' | 'bottom'
  id: string
  /** The dialog's visible title, or `label` when it has none. */
  labelledBy?: string
  label?: string
  testId: string
  onClose: () => void
  children: React.ReactNode
}

/**
 * A modal over the phone chat: a backdrop whose tap dismisses, and the dialog
 * panel on it. The desktop's one modal behaviour (focus in, Tab trapped, focus
 * back to the opener, everything behind inert, Escape closes) and the phone's
 * Back, which page.tsx gives the chat's own overlay before the chat itself.
 * Mounted only while open. Portalled to <body> at the chat's image preview's
 * layer, so the desktop's notices, which may stand over the chat, never stand
 * over a modal that has made them inert.
 */
function PhoneOverlay({ placement, id, labelledBy, label, testId, onClose, children }: PhoneOverlayProps) {
  const panelRef = useModalDialog<HTMLDivElement>({ onClose })
  useMobileBack(true, onClose, 1, CHAT_MOBILE_BACK)
  const left = placement === 'left'
  return createPortal(
    <div
      data-testid={`${testId}-backdrop`}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 10020, background: 'rgba(0,0,0,0.55)',
        display: 'flex', flexDirection: left ? 'row' : 'column', justifyContent: left ? 'flex-start' : 'flex-end',
      }}
    >
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        data-testid={testId}
        // A tap inside the panel is not a tap on the backdrop.
        onClick={(e) => e.stopPropagation()}
        style={left ? {
          width: 'min(320px, 86%)', height: '100%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', overflowY: 'auto',
          background: '#0d1117', borderRight: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '8px 0 32px rgba(0,0,0,0.45)',
          paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          animation: 'chat-phone-menu-in 0.22s cubic-bezier(0.22, 1, 0.36, 1)',
        } : {
          width: '100%', maxHeight: '85%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', overflowY: 'auto',
          background: '#1a1f2e', borderTop: '1px solid rgba(255,255,255,0.12)', borderRadius: '20px 20px 0 0',
          paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))',
          animation: 'slide-up 0.24s ease-out',
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

interface PhoneBarProps {
  menuOpen: boolean
  /** The id of the menu this opens. */
  menuId: string
  onOpenMenu: () => void
  /** The conversation's name — only once it has messages. */
  title?: string
  /** Another conversation is answering, or holds a reply nobody has read. */
  activity?: 'busy' | 'unread' | null
}

/** The portrait header: the menu button, and the conversation's title centred. */
export function ChatPhoneBar({ menuOpen, menuId, onOpenMenu, title, activity }: PhoneBarProps) {
  const tr = useTr()
  const label = tr('chat.phone.menu', 'Menu')
  return (
    <div
      data-testid="chat-phone-bar"
      style={{
        flexShrink: 0, minHeight: 52, display: 'grid', gridTemplateColumns: `${PHONE_TARGET + 4}px 1fr ${PHONE_TARGET + 4}px`,
        alignItems: 'center', padding: '0 6px', background: 'rgba(0,0,0,0.2)',
        borderBottom: '1px solid rgba(255,255,255,0.06)', userSelect: 'none',
      }}
    >
      <button
        type="button"
        // Focused first, so the menu hands focus back here when it closes (a
        // tap does not focus a button in Safari).
        onClick={(e) => { e.currentTarget.focus(); onOpenMenu() }}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-label={label}
        title={label}
        data-testid="chat-phone-menu-button"
        style={{ ...SHEET_CLOSE_STYLE, position: 'relative' }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 24 }}>menu</span>
        {activity && (
          <span
            data-testid={`chat-phone-menu-${activity}`}
            aria-hidden="true"
            style={{
              position: 'absolute', top: 9, right: 9, width: 8, height: 8, borderRadius: '50%',
              background: activity === 'busy' ? '#f97316' : '#22c55e', boxShadow: '0 0 0 2px #0d1117',
            }}
          />
        )}
      </button>
      <div
        data-testid={title ? 'chat-phone-title' : undefined}
        style={{
          minWidth: 0, textAlign: 'center', fontSize: 15, fontWeight: 600, color: 'rgba(255,255,255,0.88)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      <span aria-hidden="true" />
    </div>
  )
}

/** One conversation in the menu: main first, then the tabs. */
export interface ChatPhoneMenuChat {
  key: string
  label: string
  /** What it is announced as — its name, and whether it is answering or unread. */
  name: string
  main: boolean
  active: boolean
  busy: boolean
  unread: boolean
}

interface PhoneMenuProps {
  id: string
  onClose: () => void
  chats: ChatPhoneMenuChat[]
  onNewChat: () => void
  /** A new chat or a switch needs the box connected. */
  connected: boolean
  onSelectChat: (key: string) => void
  onCloseChat: (key: string) => void
  onRestart: () => void
  restartDisabled?: boolean
  onShowDesktop: () => void
  textSizeId: string
  textScale: ChatTextScale
  onTextScaleChange: (scale: ChatTextScale) => void
}

const MENU_ROW_STYLE: React.CSSProperties = {
  flex: 1, minWidth: 0, minHeight: PHONE_TARGET, display: 'flex', alignItems: 'center', gap: 10,
  padding: '0 12px', border: 'none', borderRadius: 12, background: 'transparent',
  color: 'rgba(255,255,255,0.85)', fontFamily: 'inherit', fontSize: 14.5, textAlign: 'left', cursor: 'pointer',
}

/**
 * Everything the portrait bar leaves out, in a menu that slides in from the
 * left: a new chat, the open conversations (each with its busy/unread dot; the
 * open one with its close, or main's restart — the same controls the tab strip
 * gives it), the way to the desktop, and the text size.
 */
export function ChatPhoneMenu({
  id, onClose, chats, onNewChat, connected, onSelectChat, onCloseChat, onRestart, restartDisabled,
  onShowDesktop, textSizeId, textScale, onTextScaleChange,
}: PhoneMenuProps) {
  const tr = useTr()
  const listId = `${id}-chats`
  // The open conversation in view when the menu opens, however long the list.
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView?.({ block: 'nearest' })
  }, [])
  return (
    <PhoneOverlay placement="left" id={id} label={tr('chat.phone.menu', 'Menu')} testId="chat-phone-menu" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minHeight: 52, padding: '0 6px', flexShrink: 0 }}>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('window.close', 'Close')}
          title={tr('window.close', 'Close')}
          data-testid="chat-phone-menu-close"
          style={SHEET_CLOSE_STYLE}
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 22 }}>close</span>
        </button>
      </div>
      <div style={{ padding: '0 10px', flexShrink: 0 }}>
        <button
          type="button"
          onClick={onNewChat}
          disabled={!connected}
          data-testid="chat-phone-menu-new"
          style={{
            ...MENU_ROW_STYLE, width: '100%', background: 'rgba(249,115,22,0.14)', color: connected ? '#f97316' : 'rgba(249,115,22,0.45)',
            fontWeight: 600, cursor: connected ? 'pointer' : 'default',
          }}
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 22 }}>edit_square</span>
          <span>{tr('chat.tabNew', 'New chat')}</span>
        </button>
      </div>
      <div
        id={listId}
        style={{ padding: '16px 18px 6px', fontSize: 12, fontWeight: 600, letterSpacing: 0.3, color: 'rgba(255,255,255,0.45)', flexShrink: 0 }}
      >
        {tr('chat.tabList', 'Chats')}
      </div>
      {/* The only part that scrolls: a box with a long list of chats keeps
          Desktop and the text size in place under it. */}
      <ul ref={listRef} aria-labelledby={listId} data-testid="chat-phone-menu-chats" style={{ listStyle: 'none', margin: 0, padding: '0 10px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {chats.map(chat => (
          <li
            key={chat.main ? 'main' : chat.key}
            data-testid="chat-phone-menu-chat"
            data-session-key={chat.key}
            data-active={chat.active || undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 2, borderRadius: 12, marginBottom: 2,
              background: chat.active ? 'rgba(255,255,255,0.08)' : 'transparent',
            }}
          >
            <button
              type="button"
              onClick={() => onSelectChat(chat.key)}
              disabled={!chat.active && !connected}
              aria-current={chat.active ? 'true' : undefined}
              aria-label={chat.name}
              title={chat.label}
              data-testid="chat-phone-menu-select"
              style={{ ...MENU_ROW_STYLE, color: chat.active ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.7)', fontWeight: chat.active ? 600 : 500 }}
            >
              <span aria-hidden="true" style={{ width: 8, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                {chat.busy && (
                  <span data-testid="chat-phone-chat-busy" style={{ width: 7, height: 7, borderRadius: '50%', background: '#f97316', animation: 'clawHeaderPulse 1.2s ease-in-out infinite' }} />
                )}
                {!chat.busy && chat.unread && (
                  <span data-testid="chat-phone-chat-unread" style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e' }} />
                )}
              </span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{chat.label}</span>
            </button>
            {chat.active && !chat.main && (
              <button
                type="button"
                onClick={() => onCloseChat(chat.key)}
                aria-label={tr('chat.tabClose', 'Close tab')}
                title={tr('chat.tabClose', 'Close tab')}
                data-testid="chat-phone-menu-close-chat"
                style={SHEET_CLOSE_STYLE}
              >
                <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 20 }}>close</span>
              </button>
            )}
            {chat.active && chat.main && (
              <button
                type="button"
                onClick={onRestart}
                disabled={restartDisabled}
                aria-label={tr('chat.tabRestart', 'New session')}
                title={tr('chat.tabRestart', 'New session')}
                data-testid="chat-phone-menu-restart"
                style={{ ...SHEET_CLOSE_STYLE, opacity: restartDisabled ? 0.4 : 1, cursor: restartDisabled ? 'default' : 'pointer' }}
              >
                <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 20 }}>restart_alt</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      <div style={{ flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.06)', padding: '10px 10px 6px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* On a phone the chat is where the page lands, so leaving it is going
            to the desktop behind it — said in words, as the header said it. */}
        <button
          type="button"
          onClick={onShowDesktop}
          aria-label={tr('chat.showDesktop', 'Show the desktop')}
          title={tr('chat.showDesktop', 'Show the desktop')}
          data-testid="chat-phone-menu-desktop"
          style={{ ...MENU_ROW_STYLE, width: '100%', flex: 'none' }}
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 22 }}>apps</span>
          <span>{tr('chat.desktop', 'Desktop')}</span>
        </button>
      </div>
      <ChatTextSizeBar id={textSizeId} scale={textScale} onChange={onTextScaleChange} stepSize={PHONE_TARGET} />
    </PhoneOverlay>
  )
}

interface PhoneSheetProps {
  id: string
  title: string
  testId: string
  onClose: () => void
  children: React.ReactNode
}

/** A bottom sheet over the phone chat: a close button, a title, its content. */
export function ChatPhoneSheet({ id, title, testId, onClose, children }: PhoneSheetProps) {
  const tr = useTr()
  const titleId = `${id}-title`
  return (
    <PhoneOverlay placement="bottom" id={id} labelledBy={titleId} testId={testId} onClose={onClose}>
      <span aria-hidden="true" style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.18)', margin: '8px auto 0', flexShrink: 0 }} />
      <div style={{ display: 'grid', gridTemplateColumns: `${PHONE_TARGET}px 1fr ${PHONE_TARGET}px`, alignItems: 'center', minHeight: 52, padding: '0 8px', flexShrink: 0 }}>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('window.close', 'Close')}
          title={tr('window.close', 'Close')}
          data-testid={`${testId}-close`}
          style={SHEET_CLOSE_STYLE}
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 22 }}>close</span>
        </button>
        <h2 id={titleId} style={{ margin: 0, textAlign: 'center', fontSize: 16, fontWeight: 600, color: 'rgba(255,255,255,0.92)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title}
        </h2>
      </div>
      <div style={{ padding: '4px 14px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {children}
      </div>
    </PhoneOverlay>
  )
}

interface SheetActionProps {
  icon: string
  label: string
  onClick: () => void
  disabled?: boolean
  /** Why it is disabled, or what it does, as the hover/long-press hint. */
  title?: string
  /** A toggle's state (Create's planner open). */
  pressed?: boolean
  testId: string
}

/** One of the "+" sheet's actions: a labelled tile. */
export function ChatPhoneSheetAction({ icon, label, onClick, disabled, title, pressed, testId }: SheetActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      data-testid={testId}
      style={{
        flex: '1 1 0', minWidth: 0, minHeight: 92, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 8, padding: '12px 6px', borderRadius: 16,
        border: `1px solid ${pressed ? 'rgba(249,115,22,0.4)' : 'rgba(255,255,255,0.08)'}`,
        background: pressed ? 'rgba(249,115,22,0.14)' : 'rgba(255,255,255,0.05)',
        color: disabled ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.88)',
        cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: PHONE_TARGET, height: PHONE_TARGET, borderRadius: '50%', background: 'rgba(255,255,255,0.08)',
          color: disabled ? 'inherit' : '#f97316', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 22 }}>{icon}</span>
      </span>
      <span style={{ textAlign: 'center', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{label}</span>
    </button>
  )
}

interface ModelPillProps {
  /** The model, or the provider where it has no model to choose. */
  label: string
  /** The effort or thinking level, where there is one. */
  detail?: string
  open: boolean
  /** The id of the sheet this opens. */
  controls: string
  onOpen: () => void
}

/** The composer's model, as a pill that opens the model sheet. */
export function ChatModelPill({ label, detail, open, controls, onOpen }: ModelPillProps) {
  const tr = useTr()
  return (
    <button
      type="button"
      // Focused first, so the sheet hands focus back here when it closes.
      onClick={(e) => { e.currentTarget.focus(); onOpen() }}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      // The name is what it shows; this says what that is.
      title={tr('chat.phone.model', 'Model')}
      data-testid="chat-model-pill"
      style={{
        maxWidth: '100%', minWidth: 0, minHeight: PHONE_TARGET, display: 'flex', alignItems: 'center', gap: 5,
        padding: '0 8px 0 12px', borderRadius: 22, border: '1px solid rgba(255,255,255,0.1)',
        background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.88)', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 13.5, fontWeight: 600,
      }}
    >
      {/* On a narrow phone the effort gives way first: the model is the answer. */}
      <span style={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {detail && (
        <span style={{ flex: '0 100 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 500, color: 'rgba(255,255,255,0.5)' }}>{detail}</span>
      )}
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18, flexShrink: 0, color: 'rgba(255,255,255,0.45)' }}>expand_more</span>
    </button>
  )
}

/** One of the composer's pickers, as the model sheet lists it. */
export interface ChatPhonePicker {
  id: string
  label: string
  value: string
  options: HeaderDropdownOption[]
  onChange: (id: string) => void
  disabled?: boolean
  /** A short scale (effort, thinking) is a row of chips; a list is ticked rows. */
  chips?: boolean
}

/**
 * A picker in the model sheet, built from the same options and handler as its
 * pill: rows with the current one ticked, or a row of chips. A pick that is
 * already current changes nothing (the pills' rule), and a row pick closes
 * the sheet (`onPicked`); a chip leaves it open.
 */
export function ChatPhonePickerGroup({ picker, onPicked }: { picker: ChatPhonePicker; onPicked: () => void }) {
  const labelId = `chat-phone-picker-${picker.id}`
  const pick = (option: HeaderDropdownOption) => {
    if (picker.disabled || option.disabled) return
    if (option.id !== picker.value) picker.onChange(option.id)
    if (!picker.chips) onPicked()
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span id={labelId} style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.3, color: 'rgba(255,255,255,0.5)', padding: '0 4px' }}>
        {picker.label}
      </span>
      {/* A group of buttons, the current one pressed: every choice is a Tab
          stop of its own, so there is no listbox's arrow-key promise to keep. */}
      <div
        role="group"
        aria-labelledby={labelId}
        aria-disabled={picker.disabled || undefined}
        data-testid={`chat-model-sheet-${picker.id}`}
        style={picker.chips
          ? { display: 'flex', flexWrap: 'wrap', gap: 8 }
          : { display: 'flex', flexDirection: 'column', borderRadius: 16, overflow: 'hidden', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        {picker.options.map((option, i) => {
          const selected = option.id === picker.value
          const off = !!(picker.disabled || option.disabled)
          const note = option.disabled && option.unavailableReason ? option.unavailableReason : option.hint
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              // aria-disabled, not disabled: still reachable, and the reason
              // under it still read out (HeaderDropdown's rule).
              aria-disabled={off || undefined}
              onClick={() => pick(option)}
              title={picker.chips ? note : undefined}
              data-testid="chat-model-sheet-option"
              data-option-id={option.id}
              style={picker.chips ? {
                minHeight: PHONE_TARGET, padding: '0 16px', borderRadius: 22, fontFamily: 'inherit', fontSize: 13.5, fontWeight: 600,
                border: `1px solid ${selected ? 'rgba(249,115,22,0.55)' : 'rgba(255,255,255,0.1)'}`,
                background: selected ? 'rgba(249,115,22,0.18)' : 'rgba(255,255,255,0.05)',
                color: selected ? '#f97316' : off ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.8)',
                cursor: off ? 'default' : 'pointer',
              } : {
                width: '100%', minHeight: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                border: 'none', borderTop: i > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                background: selected ? 'rgba(249,115,22,0.08)' : 'transparent', fontFamily: 'inherit', textAlign: 'left',
                cursor: off ? 'default' : 'pointer',
              }}
            >
              {picker.chips ? option.label : (
                <>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 15, fontWeight: 500, color: off ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.92)', overflowWrap: 'anywhere' }}>
                      {option.label}
                    </span>
                    {note && (
                      <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.45)' }}>{note}</span>
                    )}
                  </span>
                  {selected && (
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 22, color: '#f97316', flexShrink: 0 }}>check</span>
                  )}
                </>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
