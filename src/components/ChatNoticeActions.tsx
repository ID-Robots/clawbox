'use client'

import React from 'react'

import type { ChatNoticeActions as NoticeActions } from '@/lib/chat-history-cache'
import { modelAvailabilityText } from '@/lib/model-fallback-chat'

// ── The buttons under a calm chat notice ──
//
// A notice says something about the owner's account the box cannot fix on its
// own — a provider with no API quota right now (src/lib/model-fallback-chat.ts)
// — and these are the two things the owner can do about it without leaving the
// conversation: open Settings → Providers, or move the chat to another provider
// the box already has set up. Shared by both chat surfaces, so the mascot chat
// and the full-page chat offer the same two buttons in the same words.

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface ChatNoticeActionsProps {
  actions: NoticeActions | undefined
  t: Translate
  onOpenProviders?: () => void
  onSwitchTo?: (target: NonNullable<NoticeActions['switchTo']>) => void
}

const BUTTON: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 8,
  border: '1px solid rgba(147,197,253,0.35)',
  background: 'rgba(59,130,246,0.12)',
  color: '#dbeafe',
  fontSize: 12,
  lineHeight: 1.4,
  cursor: 'pointer',
}

export default function ChatNoticeActions({ actions, t, onOpenProviders, onSwitchTo }: ChatNoticeActionsProps) {
  const switchTo = actions?.switchTo
  const showSwitch = !!switchTo && !!onSwitchTo
  const showProviders = !!actions?.openProviders && !!onOpenProviders
  if (!showSwitch && !showProviders) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {showSwitch && switchTo && (
        <button type="button" data-testid="chat-notice-switch" style={BUTTON} onClick={() => onSwitchTo?.(switchTo)}>
          {modelAvailabilityText(t, 'chat.modelUnavailableSwitchTo', { provider: switchTo.label })}
        </button>
      )}
      {showProviders && (
        <button type="button" data-testid="chat-notice-providers" style={BUTTON} onClick={() => onOpenProviders?.()}>
          {modelAvailabilityText(t, 'chat.modelUnavailableOpenProviders')}
        </button>
      )}
    </div>
  )
}
