'use client'

// ── The full message, in the chat ────────────────────────────────────────────
//
// The agent's answer to "read my last five emails" is a SUMMARY, and a summary
// is the right default — but it is the agent's account of the mail, not the
// mail. This is the way to the real thing: a compact card under the reply for
// each message the agent surfaced, and a panel that opens the whole message
// with its header block and its actual formatting.
//
// WHY A CARD THAT OPENS A PANEL, rather than expanding in place: it is the
// shape this chat already uses for exactly this problem. A generated image is a
// thumbnail in the bubble that opens a full-screen preview (ChatPopup.tsx), for
// the same reason — the bubble is 85% of a narrow popup and a real email does
// not fit in it. Making mail behave like a second, different thing would be a
// worse answer than reusing the one people have already learned.
//
// NOTHING IN HERE IS MARKUP FROM THE MESSAGE. The panel renders `EmailNode[]`,
// a tree the device built and sanitised (src/lib/email-html.ts), by calling
// `createElement` with tag names from OUR union type. There is no
// `dangerouslySetInnerHTML` on this path and no HTML string to escape, so mail
// content cannot become elements however it is written.
//
// AND IT IS DATA, NOT INSTRUCTIONS. Everything shown here was written by
// whoever sent the mail. It is displayed to the owner and never fed back to the
// agent, never used to choose what the app does, and never treated as anything
// but text to look at.

import { useCallback, useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalDialog } from '@/hooks/useModalDialog'
import type { EmailNode } from '@/lib/email-html'
import type { EmailAddress, FullMessage } from '@/lib/email-mime'

// The shapes come from the module that BUILDS them, as types only — erased at
// build time, so this pulls in none of that module's server-side code and the
// two cannot drift into disagreeing about the payload.
export type { EmailAddress, EmailAttachment, FullMessage } from '@/lib/email-mime'

type Translate = (key: string, vars?: Record<string, string | number>) => string

// ── Rendering the tree ───────────────────────────────────────────────────────

/**
 * Per-tag styling, applied by US.
 *
 * The message contributes structure and nothing else: every `style=` and
 * `class=` was dropped by the sanitiser, so these are the only rules in play.
 * That is what keeps a hostile mail from restyling the dashboard, and it is
 * also why a plain-text mail and an HTML one look like the same feature.
 */
const TAG_STYLE: Partial<Record<string, React.CSSProperties>> = {
  p: { margin: '0 0 10px' },
  h1: { margin: '14px 0 8px', fontSize: 18, fontWeight: 600 },
  h2: { margin: '14px 0 8px', fontSize: 16, fontWeight: 600 },
  h3: { margin: '12px 0 6px', fontSize: 15, fontWeight: 600 },
  h4: { margin: '12px 0 6px', fontSize: 14, fontWeight: 600 },
  h5: { margin: '12px 0 6px', fontSize: 13.5, fontWeight: 600 },
  h6: { margin: '12px 0 6px', fontSize: 13, fontWeight: 600 },
  ul: { margin: '0 0 10px', paddingLeft: 22 },
  ol: { margin: '0 0 10px', paddingLeft: 22 },
  li: { margin: '2px 0' },
  blockquote: {
    margin: '0 0 10px',
    paddingLeft: 10,
    borderLeft: '2px solid rgba(255,255,255,0.18)',
    color: 'rgba(255,255,255,0.62)',
  },
  pre: {
    margin: '0 0 10px',
    padding: 8,
    borderRadius: 6,
    background: 'rgba(0,0,0,0.28)',
    // A <pre> from a stranger is the one place a single unbroken line can be
    // arbitrarily long, so it scrolls itself rather than widening the panel.
    overflowX: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
  },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    background: 'rgba(0,0,0,0.24)',
    borderRadius: 4,
    padding: '1px 4px',
  },
  table: { borderCollapse: 'collapse', margin: '0 0 10px', maxWidth: '100%' },
  td: { border: '1px solid rgba(255,255,255,0.12)', padding: '4px 8px', verticalAlign: 'top' },
  th: {
    border: '1px solid rgba(255,255,255,0.12)',
    padding: '4px 8px',
    textAlign: 'left',
    fontWeight: 600,
  },
  hr: { border: 0, borderTop: '1px solid rgba(255,255,255,0.12)', margin: '12px 0' },
}

/**
 * One node.
 *
 * The `tag` reaching `createElement` is a member of the sanitiser's union, so
 * the set of elements this can ever build is fixed at compile time.
 */
function renderNode(node: EmailNode, key: number, t: Translate): React.ReactNode {
  if (node.type === 'text') return node.text

  if (node.type === 'image') {
    if (node.src) {
      return (
        // next/image optimises through a loader that expects a real URL it
        // may re-fetch. This src is a `data:` URI built from the message's own
        // bytes (or from one fetch the owner already consented to), so there is
        // nothing to re-fetch and nothing that should touch the network again.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={key}
          src={node.src}
          alt={node.alt}
          // The message does not get to choose how big its pictures are.
          style={{ maxWidth: '100%', height: 'auto', borderRadius: 4, display: 'block' }}
        />
      )
    }
    // A picture that would cost a network request. It is drawn as a labelled
    // placeholder so the layout still makes sense and the reader can see that
    // something was withheld and why.
    return (
      <span
        key={key}
        data-testid="email-blocked-image"
        title={node.remoteHost ? t('chat.email.imageFrom', { host: node.remoteHost }) : undefined}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 7px',
          margin: '2px 0',
          borderRadius: 6,
          border: '1px dashed rgba(255,255,255,0.22)',
          color: 'rgba(255,255,255,0.45)',
          fontSize: 11,
          verticalAlign: 'middle',
        }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 13 }}>
          image
        </span>
        {node.alt || node.remoteHost || t('chat.email.blockedImage')}
      </span>
    )
  }

  const children = node.children.map((child, i) => renderNode(child, i, t))
  const style = TAG_STYLE[node.tag]

  if (node.tag === 'a') {
    // `href` is present only when the device's own protocol check passed. A
    // link with none is rendered as the words it wrapped, which is what a
    // `javascript:` link becomes.
    if (!node.href) return <span key={key}>{children}</span>
    return (
      <a
        key={key}
        href={node.href}
        target="_blank"
        // noopener so the opened page cannot reach back through `window.opener`;
        // noreferrer so it is not told which page sent the reader.
        rel="noopener noreferrer nofollow"
        style={{ color: '#fdba74', textDecoration: 'underline' }}
      >
        {children}
      </a>
    )
  }

  if (node.tag === 'br' || node.tag === 'hr') {
    return node.tag === 'br' ? <br key={key} /> : <hr key={key} style={style} />
  }

  const Tag = node.tag as keyof React.JSX.IntrinsicElements
  return (
    <Tag key={key} style={style}>
      {children}
    </Tag>
  )
}

function EmailBody({ nodes, t }: { nodes: EmailNode[]; t: Translate }): React.ReactElement {
  return <>{nodes.map((node, i) => renderNode(node, i, t))}</>
}

// ── Small pieces of the header block ─────────────────────────────────────────

/** `Jane Doe <jane@example.com>`, with the name and the address both visible. */
function Address({ value }: { value: EmailAddress }): React.ReactElement {
  if (!value.name) return <span>{value.address}</span>
  return (
    <span>
      <span style={{ color: 'rgba(255,255,255,0.88)' }}>{value.name}</span>
      {value.address ? (
        <span style={{ color: 'rgba(255,255,255,0.45)' }}> &lt;{value.address}&gt;</span>
      ) : null}
    </span>
  )
}

function AddressList({ values }: { values: EmailAddress[] }): React.ReactElement {
  return (
    <>
      {values.map((value, i) => (
        <span key={`${value.address}-${i}`}>
          {i > 0 ? ', ' : ''}
          <Address value={value} />
        </span>
      ))}
    </>
  )
}

const ROW_LABEL: React.CSSProperties = {
  color: 'rgba(255,255,255,0.4)',
  fontSize: 11.5,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  whiteSpace: 'nowrap',
  paddingRight: 10,
  verticalAlign: 'top',
}

const ROW_VALUE: React.CSSProperties = {
  fontSize: 12.5,
  color: 'rgba(255,255,255,0.75)',
  wordBreak: 'break-word',
}

/** Bytes as something a person reads. */
function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

// ── The card in the transcript ───────────────────────────────────────────────

/**
 * The compact row under the reply.
 *
 * A real `<button>`, so Enter and Space work and it lands in the tab order
 * without anything bespoke — the same reason the image thumbnail is a button.
 */
export function EmailCard({
  uid,
  onOpen,
  t,
}: {
  uid: number
  onOpen: (uid: number) => void
  t: Translate
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid="chat-email-card"
      onClick={() => onOpen(uid)}
      aria-label={t('chat.email.openFull')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        marginTop: 6,
        padding: '7px 10px',
        borderRadius: 8,
        border: '1px solid rgba(249,115,22,0.25)',
        background: 'rgba(249,115,22,0.10)',
        color: '#fdba74',
        font: 'inherit',
        fontSize: 12,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>
        mail
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{t('chat.email.openFull')}</span>
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>
        open_in_full
      </span>
    </button>
  )
}

// ── The panel ────────────────────────────────────────────────────────────────

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; message: FullMessage }
  | { phase: 'error' }

const PANEL_BUTTON: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.06)',
  color: 'rgba(255,255,255,0.8)',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

/**
 * The whole message.
 *
 * Fetched rather than carried in the transcript, and deliberately: the
 * transcript holds the agent's prose, not the mailbox, and a full HTML body
 * stored in every replayed turn would put the owner's mail into browser storage
 * for as long as the history lives. Asking the device when the panel opens
 * keeps mail on the device until the moment it is looked at.
 */
export function EmailFullView({
  uid,
  onClose,
  t,
}: {
  uid: number
  onClose: () => void
  t: Translate
}): React.ReactElement {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [withImages, setWithImages] = useState(false)
  const [loadingImages, setLoadingImages] = useState(false)
  const titleId = useId()
  const panelRef = useModalDialog<HTMLDivElement>({ onClose })

  const load = useCallback(
    async (images: boolean, signal?: AbortSignal) => {
      if (images) setLoadingImages(true)
      try {
        const query = `uid=${encodeURIComponent(String(uid))}&view=full${images ? '&images=1' : ''}`
        const response = await fetch(`/setup-api/email/messages?${query}`, {
          cache: 'no-store',
          signal,
        })
        if (!response.ok) throw new Error(`status ${response.status}`)
        const data = (await response.json()) as { message?: FullMessage }
        if (!data.message) throw new Error('no message')
        setState({ phase: 'ready', message: data.message })
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        // Nothing from the failure is shown: an error string from a mail server
        // can carry the address or the mailbox name, and this panel is not the
        // place that debugging happens.
        setState({ phase: 'error' })
      } finally {
        setLoadingImages(false)
      }
    },
    [uid],
  )

  useEffect(() => {
    const controller = new AbortController()
    setState({ phase: 'loading' })
    setWithImages(false)
    void load(false, controller.signal)
    return () => controller.abort()
  }, [load])

  const onLoadImages = useCallback(() => {
    setWithImages(true)
    void load(true)
  }, [load])

  const message = state.phase === 'ready' ? state.message : null

  return createPortal(
    <div
      // Portalled to <body> for the same reason the image preview is: the chat
      // root carries a transform, which makes it the containing block for a
      // fixed-position child and would trap this inside the popup.
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10030,
        background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="email-full-view"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 'min(720px, 100%)',
          maxHeight: '100%',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.10)',
          background: '#101725',
          color: 'rgba(255,255,255,0.85)',
          overflow: 'hidden',
        }}
      >
        {/* ── Header block ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '12px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              id={titleId}
              style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#fff', wordBreak: 'break-word' }}
            >
              {message ? message.subject || t('chat.email.noSubject') : t('chat.email.title')}
            </h2>
            {message && (
              <table style={{ marginTop: 8, borderCollapse: 'collapse' }}>
                <tbody>
                  <tr>
                    <td style={ROW_LABEL}>{t('chat.email.from')}</td>
                    <td style={ROW_VALUE}>
                      <Address value={message.from} />
                    </td>
                  </tr>
                  {message.to.length > 0 && (
                    <tr>
                      <td style={ROW_LABEL}>{t('chat.email.to')}</td>
                      <td style={ROW_VALUE}>
                        <AddressList values={message.to} />
                      </td>
                    </tr>
                  )}
                  {message.cc.length > 0 && (
                    <tr>
                      <td style={ROW_LABEL}>{t('chat.email.cc')}</td>
                      <td style={ROW_VALUE}>
                        <AddressList values={message.cc} />
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td style={ROW_LABEL}>{t('chat.email.date')}</td>
                    <td style={ROW_VALUE}>{message.date}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('chat.email.close')}
            data-testid="email-full-close"
            style={{ ...PANEL_BUTTON, padding: 6, flexShrink: 0 }}
          >
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>
              close
            </span>
          </button>
        </div>

        {/* ── Body ──
            Its own scroller with a minimum height, so a long message scrolls
            inside the panel and can never stretch the chat behind it. */}
        <div
          data-testid="email-full-body"
          role="region"
          aria-label={t('chat.email.bodyRegion')}
          aria-busy={state.phase === 'loading'}
          tabIndex={0}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: 14,
            fontSize: 13.5,
            lineHeight: 1.5,
          }}
        >
          {state.phase === 'loading' && (
            <p role="status" style={{ color: 'rgba(255,255,255,0.5)' }}>
              {t('chat.email.loading')}
            </p>
          )}
          {state.phase === 'error' && (
            <div role="alert">
              <p style={{ color: '#fca5a5' }}>{t('chat.email.failed')}</p>
              <button type="button" style={PANEL_BUTTON} onClick={() => void load(withImages)}>
                {t('chat.email.retry')}
              </button>
            </div>
          )}
          {message && (
            <>
              {message.blockedImages > 0 && (
                <div
                  data-testid="email-images-blocked"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginBottom: 12,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.10)',
                    background: 'rgba(255,255,255,0.04)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 180, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                    {t('chat.email.imagesBlocked')}
                  </span>
                  <button
                    type="button"
                    data-testid="email-load-images"
                    onClick={onLoadImages}
                    disabled={loadingImages}
                    style={{ ...PANEL_BUTTON, opacity: loadingImages ? 0.6 : 1 }}
                  >
                    {loadingImages ? t('chat.email.loadingImages') : t('chat.email.loadImages')}
                  </button>
                </div>
              )}

              <EmailBody nodes={message.body} t={t} />

              {message.truncated && (
                <p
                  data-testid="email-truncated"
                  style={{ marginTop: 12, fontSize: 12, color: 'rgba(255,255,255,0.5)', fontStyle: 'italic' }}
                >
                  {t('chat.email.truncated')}
                </p>
              )}
            </>
          )}
        </div>

        {/* ── Attachments ──
            NAMED, not offered. There is no route on this device that serves an
            attachment's bytes to the browser, and inventing one to make a
            download button work would be adding a way to pull arbitrary
            message parts out of the mailbox for the sake of an affordance.
            Saying what arrived is the honest half that costs nothing. */}
        {message && message.attachments.length > 0 && (
          <div
            data-testid="email-attachments"
            style={{
              flexShrink: 0,
              padding: '10px 14px',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(0,0,0,0.18)',
            }}
          >
            <div style={{ ...ROW_LABEL, paddingRight: 0, marginBottom: 6 }}>
              {t('chat.email.attachments')}
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {message.attachments.map((file, i) => (
                <li
                  key={`${file.filename}-${i}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    borderRadius: 6,
                    background: 'rgba(255,255,255,0.06)',
                    fontSize: 11.5,
                    color: 'rgba(255,255,255,0.72)',
                    maxWidth: '100%',
                  }}
                >
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>
                    attach_file
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.filename}
                  </span>
                  {file.size >= 0 && (
                    <span style={{ color: 'rgba(255,255,255,0.4)' }}>{formatBytes(file.size)}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
