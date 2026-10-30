'use client'

import React from 'react'

import type { ChatNoticeActions as NoticeActions } from '@/lib/chat-history-cache'
import { modelAvailabilityText, signInToClawaiAgain } from '@/lib/model-fallback-chat'

// ── The buttons under a chat system row ──
//
// A notice says something about the owner's account the box cannot fix on its
// own — a provider with no API quota right now (src/lib/model-fallback-chat.ts)
// — and these are the things the owner can do about it without leaving the
// conversation: open Settings → Providers, or move the chat to another provider
// the box already has set up. A failed turn whose ClawBox AI sign-in is gone,
// refused or not covered by the plan carries the one that fixes it: sign in to
// ClawBox AI again. Shared by both chat surfaces, so the mascot chat and the
// full-page chat offer the same buttons in the same words.

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface ChatNoticeActionsProps {
  actions: NoticeActions | undefined
  t: Translate
  onOpenProviders?: () => void
  onSwitchTo?: (target: NonNullable<NoticeActions['switchTo']>) => void
  /** Settings → AI with the ClawBox AI sign-in started. Defaults to `signInToClawaiAgain`. */
  onSignInClawai?: () => void
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

export default function ChatNoticeActions({ actions, t, onOpenProviders, onSwitchTo, onSignInClawai = signInToClawaiAgain }: ChatNoticeActionsProps) {
  const switchTo = actions?.switchTo
  const showSwitch = !!switchTo && !!onSwitchTo
  const showProviders = !!actions?.openProviders && !!onOpenProviders
  const showSignIn = !!actions?.signInClawai
  if (!showSwitch && !showProviders && !showSignIn) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {showSignIn && (
        <button type="button" data-testid="chat-notice-clawai-sign-in" style={BUTTON} onClick={() => onSignInClawai()}>
          {modelAvailabilityText(t, 'chat.modelUnavailableClawaiSignIn')}
        </button>
      )}
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
