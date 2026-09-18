'use client'

import React, { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'
import { formatFileSize, mediaDisplayName, mediaDownloadUrl, mediaFileSize } from '@/lib/chat-media'

/**
 * A file the agent sent that the chat cannot render inline — a PDF, a zip, a
 * CSV, a video. Shown as a card with its name, its size and a download button.
 *
 * The size comes from a HEAD request against the box's own media route, so the
 * card never downloads the file just to describe it. A remote URL is not
 * probed (CORS would usually refuse it anyway), nor is a gateway media URL (the
 * `/api/*` proxy forwards no Content-Length); either shows the size the
 * attachment payload carried, if it carried one.
 *
 * Laid out to shrink: the name truncates with an ellipsis and the button keeps
 * its size, so the card holds up in a 320px-wide portrait phone.
 */
export default function ChatFileCard({ src }: { src: string }) {
  const { t } = useT()
  const name = mediaDisplayName(src)
  const href = mediaDownloadUrl(src)
  const [size, setSize] = useState<number | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!src.startsWith('/setup-api/chat/media?')) return
    const controller = new AbortController()
    fetch(href, { method: 'HEAD', signal: controller.signal, credentials: 'same-origin' })
      .then(res => {
        if (!res.ok) { setMissing(true); return }
        const length = Number(res.headers.get('Content-Length'))
        if (Number.isFinite(length)) setSize(length)
      })
      .catch(() => { /* aborted or offline: show the card without a size */ })
    return () => controller.abort()
  }, [src, href])

  // What is on disk beats what the payload said; the payload beats nothing. A
  // file the probe found gone claims no size at all.
  const shownSize = missing ? null : size ?? mediaFileSize(src)
  const extension = name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : ''

  return (
    <div
      data-testid="chat-file-card"
      role="group"
      aria-label={`${t('chat.fileFromAssistant')}: ${name}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', maxWidth: 360, minWidth: 0, boxSizing: 'border-box',
        padding: '8px 10px', borderRadius: 10,
        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
        opacity: missing ? 0.55 : 1,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          flexShrink: 0, width: 36, height: 36, borderRadius: 8,
          background: 'rgba(249,115,22,0.15)', color: '#fb923c',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 18, lineHeight: 1 }}>description</span>
        {extension && <span style={{ fontSize: 8, fontWeight: 700, lineHeight: 1, marginTop: 1 }}>{extension}</span>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          title={name}
          style={{
            fontSize: 13, color: 'rgba(255,255,255,0.9)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {name}
        </div>
        {shownSize !== null && (
          <div data-testid="chat-file-size" style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)' }}>
            {formatFileSize(shownSize)}
          </div>
        )}
      </div>
      <a
        href={href}
        download={name}
        title={t('chat.downloadFile')}
        aria-label={`${t('chat.downloadFile')}: ${name}`}
        {...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        style={{
          flexShrink: 0, width: 36, height: 36, borderRadius: 8,
          background: 'rgba(255,255,255,0.08)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none',
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 20 }}>download</span>
      </a>
    </div>
  )
}
