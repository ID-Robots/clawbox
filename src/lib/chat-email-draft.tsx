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
  from?: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo?: string[]
  subject: string
  body: string
  bodyTruncated: boolean
  /** The subject or an attachment name was cut to fit: no Send, like a cut body. */
  headerTruncated?: boolean
  attachments: { name: string; size: number | null }[]
  hiddenCharacters?: boolean
}

export const CARD_ROUTE = '/setup-api/email/draft-approval/card'
export const DECIDE_ROUTE = '/setup-api/email/draft-approval/decide'

/** Characters of the body shown before "Show all". */
export const BODY_CLAMP_CHARS = 600
/** The longest change request the card sends on. */
export const MAX_CHANGE_CHARS = 2000

type Action = 'send' | 'keep' | 'revise'
/**
 * Answered: `sent`, `kept`, `revised`; or not offered again on a plain look:
 * `sending` (a Send in flight) and `uncertain` (its answer was lost — the mail
 * may have gone; only an explicit "Review again" asks again).
 */
type Settled = 'sent' | 'kept' | 'revised' | 'sending' | 'uncertain'
const SETTLED: readonly string[] = ['sent', 'kept', 'revised', 'sending', 'uncertain']

type Phase =
  | { kind: 'loading' }
  // `notice`: a sentence shown instead of the usual "nothing is sent until…",
  // e.g. why a card whose Send got no answer is offered again.
  | { kind: 'open'; draft: EmailDraftView; token: string; busy: Action | null; notice?: string }
  // `notice`: a sentence shown instead of the state's own, e.g. a Send the
  // backend confirmed that ClawBox could not record on disk. `uncertainty`:
  // on `uncertain`, the identifier of the lost Send this card warns about —
  // its "Review again" names it back, so the server hands out a card that can
  // send only for the warning the person actually saw.
  | { kind: 'settled'; state: Settled; draft: EmailDraftView | null; notice?: string; uncertainty?: number }
  | { kind: 'refused'; reason: string; draft: EmailDraftView | null }
  | { kind: 'failed'; reason: string }
  // A Send whose answer never arrived: it may have gone. `checking` while the
  // card asks ClawBox what it recorded.
  | { kind: 'unknown'; draft: EmailDraftView | null; checking: boolean }

type Answer = { status: number; json: Record<string, unknown> }

/** The card route's answer as a phase, when it is one: an open card or a settled state. */
function cardPhase({ status, json }: Answer): Extract<Phase, { kind: 'open' | 'settled' }> | null {
  const draft = isDraftView(json.draft) ? json.draft : null
  if (status === 200 && json.state === 'open' && typeof json.token === 'string' && draft) {
    return { kind: 'open', draft, token: json.token, busy: null }
  }
  if (status === 200 && typeof json.state === 'string' && SETTLED.includes(json.state)) {
    return { kind: 'settled', state: json.state as Settled, draft, ...uncertaintyOf(json) }
  }
  return null
}

/** An `uncertain` answer's warning identifier, as a phase field — nothing when it names none. */
function uncertaintyOf(json: Record<string, unknown>): { uncertainty?: number } {
  return json.state === 'uncertain' && typeof json.uncertainty === 'number' && Number.isFinite(json.uncertainty)
    ? { uncertainty: json.uncertainty }
    : {}
}

/** The state the server answers when it did what the person asked. */
const DONE: Record<Action, Settled> = { send: 'sent', keep: 'kept', revise: 'revised' }

/** True when the server answered that it did `action`: a 200 naming that state. */
function answerDone(answer: Answer | null, action: Action): boolean {
  return answer !== null && answer.status === 200 && answer.json.state === DONE[action]
}

/**
 * True when a decide answer is not ClawBox's own word on the card: no answer
 * at all (the connection dropped), or one that neither says it was done nor
 * names a refusal kind (a proxy's error page, a request that crashed, a page
 * some redirect ended on — even one answered 200). For a Send that says
 * nothing about the mail: it may have gone.
 */
function answerLost(answer: Answer | null, action: Action): boolean {
  return answer === null || (!answerDone(answer, action) && typeof answer.json.kind !== 'string')
}

/** The sentence for a refusal kind the server (or the network) answered. */
export function refusalKey(kind: string, state?: unknown): string {
  switch (kind) {
    case 'disabled': return 'chat.emailDraft.error.disabled'
    case 'gone': return 'chat.emailDraft.error.gone'
    case 'backend_unreachable':
    case 'backend_auth':
    case 'backend_bad': return 'chat.emailDraft.error.backend'
    case 'changed': return 'chat.emailDraft.error.changed'
    case 'too_long': return 'chat.emailDraft.tooLong'
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

/**
 * Refusals after which the CURRENT version can be fetched and approved afresh.
 * `no_room`: the ledger had no room for another approval, which clears as its
 * settled records age out — the server says "try again later", so the card
 * offers that rather than a dead end.
 */
const RELOADABLE = new Set(['changed', 'too_long', 'expired', 'backend_unreachable', 'backend_bad', 'unavailable', 'network', 'no_room'])

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

  // The words of a "Tell me what to change" whose answer never arrived. The
  // server may have closed the card as revised all the same; if a later look
  // says so, the words go to the assistant then, once — never before the
  // server has closed the card.
  const lostRevision = useRef<string | null>(null)
  // Read through a ref: `load` runs on mount from an effect keyed on it, and
  // a parent's `t` that is a new function each render must not reload the card.
  const tRef = useRef(t)
  useEffect(() => { tRef.current = t }, [t])

  /**
   * Reads the card. `reopen` is the person's "Review again"; `acknowledged`,
   * the lost-Send warning this card showed, which that Review again answers.
   * A reopen naming no warning, or an older one, is answered `uncertain` with
   * the current warning, never with a card that can send.
   */
  const load = useCallback(async (reopen: boolean, acknowledged?: number) => {
    setPhase({ kind: 'loading' })
    let answer: Answer
    try {
      answer = await post(
        CARD_ROUTE,
        !reopen ? { draftId } : acknowledged === undefined ? { draftId, reopen: true } : { draftId, reopen: true, acknowledged },
      )
    } catch {
      if (alive.current) setPhase({ kind: 'failed', reason: 'network' })
      return
    }
    if (!alive.current) return
    const next = cardPhase(answer)
    if (next?.kind === 'settled' && next.state === 'revised' && next.draft && lostRevision.current !== null) {
      dispatchChatMessage(revisionMessage(tRef.current, next.draft, lostRevision.current))
      setChange('')
    }
    if (next) lostRevision.current = null
    setPhase(next ?? { kind: 'failed', reason: typeof answer.json.kind === 'string' ? answer.json.kind : 'unavailable' })
  }, [draftId])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- the card reads its draft from the server when it appears: an external system, which `load` also shows as `loading`
  useEffect(() => { void load(false) }, [load])

  /**
   * After a Send whose answer never arrived: what ClawBox RECORDED for the
   * draft, by a plain look. The card never says "nothing was sent" here — until
   * a look answers, the outcome is unknown, and the person is told to check
   * the Sent folder. A look that finds the card still open means ClawBox never
   * claimed that Send: offering it again is safe, since a second Send of one
   * draft is refused while another is running or has gone
   * (mail-draft-approval.ts `sendBlocker`).
   */
  const recheck = useCallback(async (draft: EmailDraftView | null) => {
    setPhase({ kind: 'unknown', draft, checking: true })
    let answer: Answer | null = null
    try {
      answer = await post(CARD_ROUTE, { draftId })
    } catch {
      answer = null
    }
    if (!alive.current) return
    const next = answer && cardPhase(answer)
    if (next?.kind === 'open') {
      setPhase({ ...next, notice: 'chat.emailDraft.sendNotRecorded' })
    } else if (next) {
      setPhase(next)
    } else if (answer?.json.kind === 'gone') {
      // No longer in the mailbox: sent or deleted, and the card says exactly that.
      setPhase({ kind: 'refused', reason: 'gone', draft })
    } else {
      setPhase({ kind: 'unknown', draft, checking: false })
    }
  }, [draftId])

  const decide = useCallback(async (action: Action) => {
    if (phase.kind !== 'open' || phase.busy) return
    const { draft, token } = phase
    const changeText = change.trim()
    if (action === 'revise' && !changeText) return
    setPhase({ kind: 'open', draft, token, busy: action })
    let answer: Answer | null = null
    try {
      answer = await post(DECIDE_ROUTE, { token, action })
    } catch {
      answer = null
    }
    const done = answerDone(answer, action)
    // The server closed the card: only now does the change request go to the
    // assistant, so the chat never says "revised" over a card that is still
    // open and sendable on the next look. Sent even when the card has gone from
    // the screen meanwhile (another chat opened): the server has closed it, and
    // the words are the person's next message either way.
    if (done && action === 'revise') dispatchChatMessage(revisionMessage(t, draft, changeText))
    if (!alive.current) return

    if (action === 'send' && answerLost(answer, action)) {
      void recheck(draft)
      return
    }
    lostRevision.current = action === 'revise' && answerLost(answer, action) ? changeText : null
    if (done) {
      if (action === 'revise') setChange('')
      // `recorded: false` on a Send: the mail went and the ledger says it did
      // not. Said as both halves, because a later look at this draft may ask
      // about it again until that record is written.
      const notice = action === 'send' && answer?.json.recorded === false ? 'chat.emailDraft.sentNotRecorded' : undefined
      setPhase({ kind: 'settled', state: DONE[action], draft, notice })
      return
    }
    const kind = answer !== null && typeof answer.json.kind === 'string' ? answer.json.kind : answer === null ? 'network' : 'unavailable'

    // What the server says became of this draft's Send — this card's or
    // another card's for the same draft — shown as that state, with its own
    // way on: a Send in flight can be looked at again, and one whose answer
    // was lost offers "Review again" once the person has checked Sent.
    const state = answer?.json.state
    if (kind === 'send_uncertain' || (kind === 'reused' && state === 'uncertain')) {
      const uncertainty = answer?.json.uncertainty
      setPhase({
        kind: 'settled',
        state: 'uncertain',
        draft,
        ...(typeof uncertainty === 'number' && Number.isFinite(uncertainty) ? { uncertainty } : {}),
      })
      return
    }
    if (kind === 'reused' && state === 'sending') {
      setPhase({ kind: 'settled', state: 'sending', draft })
      return
    }
    setPhase({ kind: 'refused', reason: kind === 'reused' && state === 'sent' ? 'already_sent' : kind, draft })
  }, [phase, change, t, recheck])

  const draft = phase.kind === 'open' || phase.kind === 'settled' || phase.kind === 'refused' || phase.kind === 'unknown' ? phase.draft : null
  const busy = phase.kind === 'open' ? phase.busy : null
  const open = phase.kind === 'open'
  const settledLook = phase.kind === 'settled' || phase.kind === 'refused' || phase.kind === 'failed' || phase.kind === 'unknown'
  // The change request stays on the card, read-only, when the card could not
  // be closed — so the person sees it and can ask again once the card reopens.
  const keptChange = (phase.kind === 'refused' || phase.kind === 'failed') && change.trim() !== ''

  const longBody = draft !== null && draft.body.length > BODY_CLAMP_CHARS
  const shownBody = draft === null ? '' : longBody && !expanded ? `${draft.body.slice(0, BODY_CLAMP_CHARS).trimEnd()}…` : draft.body

  const statusText = (() => {
    switch (phase.kind) {
      case 'loading': return t('chat.emailDraft.loading')
      case 'open': return busy === 'send' ? t('chat.emailDraft.sending') : busy ? t('chat.emailDraft.saving') : t(phase.notice ?? 'chat.emailDraft.onlyYou')
      case 'settled':
        return phase.notice !== undefined ? t(phase.notice)
          : phase.state === 'uncertain' ? t('chat.emailDraft.error.sendUncertain')
          : phase.state === 'sending' ? t('chat.emailDraft.sending')
          : t(`chat.emailDraft.${phase.state}`)
      case 'refused': return phase.reason === 'already_sent' ? t('chat.emailDraft.error.alreadySent') : t(refusalKey(phase.reason))
      case 'failed': return t(refusalKey(phase.reason))
      case 'unknown': return phase.checking ? t('chat.emailDraft.sendUnknownChecking') : t('chat.emailDraft.sendUnknown')
    }
  })()
  const isError = phase.kind === 'refused' || phase.kind === 'failed' || phase.kind === 'unknown'
    || (phase.kind === 'settled' && (phase.state === 'uncertain' || phase.notice !== undefined))
    || (phase.kind === 'open' && phase.notice !== undefined && busy === null)
  // A body, subject or attachment name the server could not show whole is not
  // offered for Send: the person would approve a tail they never saw.
  const tooLong = draft?.bodyTruncated === true || draft?.headerTruncated === true
  const reloadable = (phase.kind === 'refused' || phase.kind === 'failed') && RELOADABLE.has(phase.reason)
  const reviewable = phase.kind === 'settled' && phase.state !== 'sent'
  const reviewLabel = phase.kind === 'settled' && phase.state === 'sending' ? t('chat.emailDraft.reload') : t('chat.emailDraft.reviewAgain')
  // A Send with no answer: ask ClawBox again what it recorded (a plain look).
  const checkable = phase.kind === 'unknown' && !phase.checking

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
      data-state={
        phase.kind === 'settled' ? phase.state
          : phase.kind === 'refused' || phase.kind === 'failed' ? phase.reason
            : phase.kind === 'unknown' ? (phase.checking ? 'send_unknown_checking' : 'send_unknown')
              : phase.kind
      }
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
          {draft.from && line(t('chat.emailDraft.from'), [draft.from], 'chat-email-draft-from')}
          {line(t('chat.emailDraft.to'), draft.to, 'chat-email-draft-to')}
          {draft.cc.length > 0 && line(t('chat.emailDraft.cc'), draft.cc, 'chat-email-draft-cc')}
          {draft.bcc.length > 0 && line(t('chat.emailDraft.bcc'), draft.bcc, 'chat-email-draft-bcc')}
          {draft.replyTo && draft.replyTo.length > 0 && line(t('chat.emailDraft.replyTo'), draft.replyTo, 'chat-email-draft-reply-to')}
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
      {draft?.hiddenCharacters && (
        <div data-testid="chat-email-draft-hidden-chars" style={{ fontSize: 11.5, lineHeight: 1.45, color: ERROR_FG }}>
          {t('chat.emailDraft.hiddenChars')}
        </div>
      )}
      {draft && longBody && (
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
        </div>
      )}
      {tooLong && (
        <div data-testid="chat-email-draft-too-long" style={{ fontSize: 11.5, lineHeight: 1.45, color: ERROR_FG }}>
          {t('chat.emailDraft.tooLong')}
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            data-testid="chat-email-draft-send"
            aria-disabled={busy !== null || tooLong}
            onClick={() => { if (!tooLong) void decide('send') }}
            style={button(true, busy !== null || tooLong)}
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
      )}
      {(open || keptChange) && (
        <form
          // decide() answers only an OPEN card: a kept change request is
          // shown, never sent, until a look reopens the card.
          onSubmit={(e) => { e.preventDefault(); if (open) void decide('revise') }}
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
            onChange={(e) => { if (open) setChange(e.target.value) }}
            disabled={busy !== null}
            readOnly={!open}
            aria-readonly={!open}
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
          {open && (
            <button
              type="submit"
              data-testid="chat-email-draft-change-submit"
              aria-disabled={busy !== null || !change.trim()}
              style={button(false, busy !== null || !change.trim())}
            >
              {t('chat.emailDraft.changeSubmit')}
            </button>
          )}
        </form>
      )}

      <div
        data-testid="chat-email-draft-status"
        role="status"
        aria-live="polite"
        style={{ fontSize: 11.5, lineHeight: 1.45, color: isError ? ERROR_FG : MUTED_FG }}
      >
        {statusText}
      </div>

      {(reloadable || reviewable || checkable) && (
        <div>
          <button
            type="button"
            data-testid="chat-email-draft-reload"
            // Asking again about an ANSWERED draft is the explicit reopen; a
            // refusal's "current version", a retry and a check after a Send
            // with no answer are a plain look. A reopen names the lost-Send
            // warning this card showed, if it showed one.
            onClick={() => {
              if (phase.kind === 'unknown') void recheck(phase.draft)
              else {
                void load(
                  reviewable && !(phase.kind === 'settled' && phase.state === 'sending'),
                  phase.kind === 'settled' && phase.state === 'uncertain' ? phase.uncertainty : undefined,
                )
              }
            }}
            style={button(false, false)}
          >
            {checkable
              ? t('chat.emailDraft.checkAgain')
              : reviewable
                ? reviewLabel
                : phase.kind === 'failed' ? t('chat.emailDraft.retry') : t('chat.emailDraft.reload')}
          </button>
        </div>
      )}
    </section>
  )
}
