'use client'

// The send-approval card for one e-mail draft the assistant prepared.
//
// Under the reply that named the draft (`EMAIL_DRAFT:<id>`, chat-email-draft-refs.ts)
// the chat shows the draft as the MAILBOX holds it — recipients, subject, the
// body — and three answers:
//
//   Send              the server re-reads the draft and sends it, once
//   Keep as draft     nothing is sent; the draft stays in the Drafts folder
//   Tell me what to change
//                     the words go to the assistant as the person's next
//                     message, and it shows a new card for the new version
//
// Shaped like the other "the box is waiting for you" cards (chat-clarify,
// chat-approvals, chat-ask-user): the same palette, the same settled state that
// says what happened instead of vanishing.
//
// WHAT THIS CARD CAN AND CANNOT DO. It holds the one-time approval the server
// issued for exactly this person and exactly this version of the draft, and
// hands it back on Send. Every decision is the server's
// (src/lib/mail-draft-approval.ts): a changed draft, a used or expired approval
// or another user's card is refused there, whatever this component believes.
//
// Everything shown is text from the mailbox — written by the assistant, and
// through it possibly by whoever wrote what it read. Rendered as text, never as
// markup, never acted on.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { dispatchChatMessage } from '@/lib/ui-events'
import {
  BODY_FG,
  CARD_BG,
  CARD_BORDER,
  CHOICE_BG,
  CHOICE_BORDER,
  ERROR_FG,
  INPUT_BG,
  MUTED_FG,
  PRIMARY_BG,
  PRIMARY_BORDER,
  TITLE_FG,
} from '@/lib/chat-card-style'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** The draft as the server sends it (src/lib/mail-draft-backend.ts `DraftView`). */
export interface EmailDraftView {
  id: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  bodyTruncated: boolean
  attachments: { name: string; size: number | null }[]
}

export const CARD_ROUTE = '/setup-api/email/draft-approval/card'
export const DECIDE_ROUTE = '/setup-api/email/draft-approval/decide'

/** Characters of the body shown before "Show all". */
export const BODY_CLAMP_CHARS = 600
/** The longest change request the card sends on. */
export const MAX_CHANGE_CHARS = 2000

type Action = 'send' | 'keep' | 'revise'
type Settled = 'sent' | 'kept' | 'revised'

type Phase =
  | { kind: 'loading' }
  | { kind: 'open'; draft: EmailDraftView; token: string; busy: Action | null }
  | { kind: 'settled'; state: Settled; draft: EmailDraftView | null }
  | { kind: 'refused'; reason: string; draft: EmailDraftView | null }
  | { kind: 'failed'; reason: string }

/** The sentence for a refusal kind the server (or the network) answered. */
export function refusalKey(kind: string, state?: unknown): string {
  switch (kind) {
    case 'disabled': return 'chat.emailDraft.error.disabled'
    case 'gone': return 'chat.emailDraft.error.gone'
    case 'backend_unreachable':
    case 'backend_auth':
    case 'backend_bad': return 'chat.emailDraft.error.backend'
    case 'changed': return 'chat.emailDraft.error.changed'
    case 'expired': return 'chat.emailDraft.error.expired'
    case 'reused': return state === 'sent' ? 'chat.emailDraft.error.alreadySent' : 'chat.emailDraft.error.reused'
    case 'other_user': return 'chat.emailDraft.error.otherUser'
    case 'forged':
    case 'no_approval': return 'chat.emailDraft.error.forged'
    case 'send_refused': return 'chat.emailDraft.error.sendRefused'
    case 'send_uncertain': return 'chat.emailDraft.error.sendUncertain'
    case 'network': return 'chat.emailDraft.error.network'
    default: return 'chat.emailDraft.error.unavailable'
  }
}

/** Refusals after which the CURRENT version can be fetched and approved afresh. */
const RELOADABLE = new Set(['changed', 'expired', 'backend_unreachable', 'backend_bad', 'unavailable', 'network'])

function isDraftView(value: unknown): value is EmailDraftView {
  const v = value as Partial<EmailDraftView> | null
  const strings = (list: unknown) => Array.isArray(list) && list.every((x) => typeof x === 'string')
  return (
    typeof v === 'object' && v !== null
    && typeof v.id === 'string' && strings(v.to) && strings(v.cc) && strings(v.bcc)
    && typeof v.subject === 'string' && typeof v.body === 'string'
    && Array.isArray(v.attachments)
  )
}

async function post(url: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
  })
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = await res.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
  } catch {
    // An unreadable answer is read by its status alone.
  }
  return { status: res.status, json }
}

/** The message the assistant receives for "Tell me what to change". */
export function revisionMessage(t: Translate, draft: EmailDraftView, text: string): string {
  return t('chat.emailDraft.reviseMessage', {
    subject: draft.subject || t('chat.emailDraft.noSubject'),
    id: draft.id,
    text: text.trim(),
  })
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface EmailDraftCardProps {
  draftId: string
  t: Translate
}

export function EmailDraftCard({ draftId, t }: EmailDraftCardProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [expanded, setExpanded] = useState(false)
  const [change, setChange] = useState('')
  const idPrefix = useId()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (reopen: boolean) => {
    setPhase({ kind: 'loading' })
    let answer: { status: number; json: Record<string, unknown> }
    try {
      answer = await post(CARD_ROUTE, reopen ? { draftId, reopen: true } : { draftId })
    } catch {
      if (alive.current) setPhase({ kind: 'failed', reason: 'network' })
      return
    }
    if (!alive.current) return
    const { status, json } = answer
    const draft = isDraftView(json.draft) ? json.draft : null
    if (status === 200 && json.state === 'open' && typeof json.token === 'string' && draft) {
      setPhase({ kind: 'open', draft, token: json.token, busy: null })
    } else if (status === 200 && (json.state === 'sent' || json.state === 'kept' || json.state === 'revised')) {
      setPhase({ kind: 'settled', state: json.state, draft })
    } else {
      setPhase({ kind: 'failed', reason: typeof json.kind === 'string' ? json.kind : 'unavailable' })
    }
  }, [draftId])

  useEffect(() => { void load(false) }, [load])

  const decide = useCallback(async (action: Action) => {
    if (phase.kind !== 'open' || phase.busy) return
    const { draft, token } = phase
    const changeText = change.trim()
    if (action === 'revise' && !changeText) return
    setPhase({ ...phase, busy: action })
    let answer: { status: number; json: Record<string, unknown> } | null = null
    try {
      answer = await post(DECIDE_ROUTE, { token, action })
    } catch {
      answer = null
    }
    if (!alive.current) return
    const kind = answer === null ? 'network' : answer.status === 200 ? null : (typeof answer.json.kind === 'string' ? answer.json.kind : 'unavailable')

    if (action === 'revise') {
      // The change request is the person's next message whether or not the old
      // approval could still be closed — unless the draft is already gone out,
      // or this card was never theirs to answer.
      const blocked = kind === 'other_user' || kind === 'forged' || (kind === 'reused' && answer?.json.state === 'sent')
      if (!blocked) {
        dispatchChatMessage(revisionMessage(t, draft, changeText))
        setChange('')
        setPhase({ kind: 'settled', state: 'revised', draft })
        return
      }
    } else if (kind === null) {
      setPhase({ kind: 'settled', state: action === 'send' ? 'sent' : 'kept', draft })
      return
    }
    const reason = kind ?? 'unavailable'
    setPhase({ kind: 'refused', reason: reason === 'reused' && answer?.json.state === 'sent' ? 'already_sent' : reason, draft })
  }, [phase, change, t])

  const draft = phase.kind === 'open' || phase.kind === 'settled' || phase.kind === 'refused' ? phase.draft : null
  const busy = phase.kind === 'open' ? phase.busy : null
  const open = phase.kind === 'open'
  const settledLook = phase.kind === 'settled' || phase.kind === 'refused' || phase.kind === 'failed'

  const longBody = draft !== null && draft.body.length > BODY_CLAMP_CHARS
  const shownBody = draft === null ? '' : longBody && !expanded ? `${draft.body.slice(0, BODY_CLAMP_CHARS).trimEnd()}…` : draft.body

  const statusText = (() => {
    switch (phase.kind) {
      case 'loading': return t('chat.emailDraft.loading')
      case 'open': return busy === 'send' ? t('chat.emailDraft.sending') : busy ? t('chat.emailDraft.saving') : t('chat.emailDraft.onlyYou')
      case 'settled': return t(`chat.emailDraft.${phase.state}`)
      case 'refused': return phase.reason === 'already_sent' ? t('chat.emailDraft.error.alreadySent') : t(refusalKey(phase.reason))
      case 'failed': return t(refusalKey(phase.reason))
    }
  })()
  const isError = phase.kind === 'refused' || phase.kind === 'failed'
  const reloadable = (phase.kind === 'refused' || phase.kind === 'failed') && RELOADABLE.has(phase.reason)
  const reviewable = phase.kind === 'settled' && phase.state !== 'sent'

  const button = (primary: boolean, disabled: boolean): React.CSSProperties => ({
    padding: '6px 14px',
    borderRadius: 8,
    background: primary ? PRIMARY_BG : CHOICE_BG,
    border: primary ? PRIMARY_BORDER : CHOICE_BORDER,
    color: primary ? TITLE_FG : BODY_FG,
    fontSize: 12.5,
    fontWeight: primary ? 600 : 500,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  })

  const line = (label: string, values: string[], testId: string) => (
    <div data-testid={testId} style={{ display: 'flex', gap: 6, fontSize: 12.5, lineHeight: 1.45, color: BODY_FG, minWidth: 0 }}>
      <span style={{ color: MUTED_FG, flex: '0 0 auto', minWidth: 52 }}>{label}</span>
      <span style={{ wordBreak: 'break-word', minWidth: 0 }}>{values.length ? values.join(', ') : t('chat.emailDraft.noRecipients')}</span>
    </div>
  )

  return (
    <section
      data-testid="chat-email-draft"
      data-draft-id={draftId}
      data-state={phase.kind === 'settled' ? phase.state : phase.kind === 'refused' || phase.kind === 'failed' ? phase.reason : phase.kind}
      aria-labelledby={`${idPrefix}-title`}
      style={{
        alignSelf: 'flex-start',
        width: '100%',
        maxWidth: 560,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 8,
        padding: '10px 12px',
        borderRadius: 12,
        background: CARD_BG,
        border: CARD_BORDER,
        opacity: settledLook && phase.kind !== 'failed' ? 0.85 : 1,
      }}
    >
      <h3
        id={`${idPrefix}-title`}
        style={{ display: 'flex', alignItems: 'center', gap: 6, color: TITLE_FG, fontSize: 12, fontWeight: 600, margin: 0 }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15 }}>
          {phase.kind === 'settled' && phase.state === 'sent' ? 'mark_email_read' : 'outgoing_mail'}
        </span>
        <span>{t('chat.emailDraft.title')}</span>
      </h3>

      {draft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {line(t('chat.emailDraft.to'), draft.to, 'chat-email-draft-to')}
          {draft.cc.length > 0 && line(t('chat.emailDraft.cc'), draft.cc, 'chat-email-draft-cc')}
          {draft.bcc.length > 0 && line(t('chat.emailDraft.bcc'), draft.bcc, 'chat-email-draft-bcc')}
          <div data-testid="chat-email-draft-subject" style={{ display: 'flex', gap: 6, fontSize: 12.5, lineHeight: 1.45, minWidth: 0 }}>
            <span style={{ color: MUTED_FG, flex: '0 0 auto', minWidth: 52 }}>{t('chat.emailDraft.subject')}</span>
            <span style={{ color: 'rgba(255,255,255,0.92)', fontWeight: 600, wordBreak: 'break-word', minWidth: 0 }}>
              {draft.subject || t('chat.emailDraft.noSubject')}
            </span>
          </div>
        </div>
      )}

      {draft && (
        <div
          data-testid="chat-email-draft-body"
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 12.5,
            lineHeight: 1.5,
            color: BODY_FG,
            background: INPUT_BG,
            borderRadius: 8,
            padding: '8px 10px',
            maxHeight: expanded ? 360 : undefined,
            overflowY: expanded ? 'auto' : undefined,
          }}
        >
          {shownBody || <span style={{ color: MUTED_FG }}>{t('chat.emailDraft.emptyBody')}</span>}
        </div>
      )}
      {draft && (longBody || draft.bodyTruncated) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: MUTED_FG }}>
          {longBody && (
            <button
              type="button"
              data-testid="chat-email-draft-expand"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              style={{ background: 'none', border: 'none', padding: 0, color: TITLE_FG, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {expanded ? t('chat.emailDraft.showLess') : t('chat.emailDraft.showMore')}
            </button>
          )}
          {draft.bodyTruncated && expanded && <span>{t('chat.emailDraft.previewShortened')}</span>}
        </div>
      )}
      {draft && draft.attachments.length > 0 && (
        <div data-testid="chat-email-draft-attachments" style={{ fontSize: 12, color: BODY_FG, display: 'flex', gap: 6 }}>
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14, color: MUTED_FG }}>attach_file</span>
          <span style={{ wordBreak: 'break-word' }}>
            {draft.attachments.map((a) => (a.size === null ? a.name : `${a.name} (${formatSize(a.size)})`)).join(', ')}
          </span>
        </div>
      )}

      {open && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              data-testid="chat-email-draft-send"
              aria-disabled={busy !== null}
              onClick={() => { void decide('send') }}
              style={button(true, busy !== null)}
            >
              {busy === 'send' ? t('chat.emailDraft.sending') : t('chat.emailDraft.send')}
            </button>
            <button
              type="button"
              data-testid="chat-email-draft-keep"
              aria-disabled={busy !== null}
              onClick={() => { void decide('keep') }}
              style={button(false, busy !== null)}
            >
              {t('chat.emailDraft.keep')}
            </button>
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); void decide('revise') }}
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          >
            <label htmlFor={`${idPrefix}-change`} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
              {t('chat.emailDraft.changePlaceholder')}
            </label>
            <input
              id={`${idPrefix}-change`}
              data-testid="chat-email-draft-change"
              type="text"
              value={change}
              maxLength={MAX_CHANGE_CHARS}
              placeholder={t('chat.emailDraft.changePlaceholder')}
              onChange={(e) => setChange(e.target.value)}
              disabled={busy !== null}
              style={{
                flex: '1 1 200px',
                minWidth: 0,
                padding: '6px 10px',
                borderRadius: 8,
                background: INPUT_BG,
                border: CHOICE_BORDER,
                color: 'rgba(255,255,255,0.92)',
                fontSize: 12.5,
                fontFamily: 'inherit',
              }}
            />
            <button
              type="submit"
              data-testid="chat-email-draft-change-submit"
              aria-disabled={busy !== null || !change.trim()}
              style={button(false, busy !== null || !change.trim())}
            >
              {t('chat.emailDraft.changeSubmit')}
            </button>
          </form>
        </>
      )}

      <div
        data-testid="chat-email-draft-status"
        role="status"
        aria-live="polite"
        style={{ fontSize: 11.5, lineHeight: 1.45, color: isError ? ERROR_FG : MUTED_FG }}
      >
        {statusText}
      </div>

      {(reloadable || reviewable) && (
        <div>
          <button
            type="button"
            data-testid="chat-email-draft-reload"
            onClick={() => { void load(true) }}
            style={button(false, false)}
          >
            {reviewable
              ? t('chat.emailDraft.reviewAgain')
              : phase.kind === 'failed' ? t('chat.emailDraft.retry') : t('chat.emailDraft.reload')}
          </button>
        </div>
      )}
    </section>
  )
}
