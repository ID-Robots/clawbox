'use client'

import React, { useState, useEffect, useRef, useCallback, memo } from 'react'
import * as kv from '@/lib/client-kv'
import { useClawboxLogin } from '@/lib/use-clawbox-login'
import { PORTAL_LOGIN_URL } from '@/lib/max-subscription'

// ── Gateway WebSocket chat app ──
// Full-window chat component (fills parent container).
// Extracted from ChatPopup for use as a proper app window.

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  timestamp: number
  images?: string[] // data URLs for display
}

import { renderText } from '@/lib/chat-markdown'
import { useT } from '@/lib/i18n'

function extractText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const m = msg as Record<string, unknown>
  if (typeof m.text === 'string') return m.text
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .map((block: unknown) => {
        if (!block || typeof block !== 'object') return ''
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') return b.text
        if (b.type === 'thinking') return ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// Protocol sentinels the gateway/LLM sometimes emits as a standalone chat
// reply (sibling of NO_REPLY, which we drop entirely). They have no signal
// for the user, so we swap them for a fun mascot-style line — mix of
// emoji and emoji-free entries so the chat doesn't feel emoji-spammy.
//
// Match ONLY transport-level sentinels with a clear protocol shape — i.e.
// `HEARTBEAT` optionally followed by an underscored upper-case suffix
// (HEARTBEAT_OK, HEARTBEAT_PONG, …). Earlier we also matched bare tokens
// like "OK" / "DONE" / "ACK" — those are legitimate things a model might
// reply to a user, so prettifying them was corrupting real chat history.
const PROTOCOL_SENTINEL_RE = /^\s*HEARTBEAT(?:_[A-Z]+)?\s*$/
const PROTOCOL_SENTINEL_REPLIES = [
  'still here, scuttling around 🦀',
  'all good, boss',
  'pulse normal — claws warm',
  '*waves a claw*',
  'standing by 👂',
  'reporting for duty',
  'mhm. carry on.',
  'box secured. crab secured.',
  'I exist and I\'m vibing ✨',
  'crab.exe responded successfully',
  'you got it 👍',
  'check, check — mic still works',
  '*nods sagely*',
  'I heard that, by the way 🦀',
  'OK but make it cooler:',
  'roger that 🛰️',
  'yep, alive. promise.',
  'system: somewhat caffeinated ☕',
]
function prettifyAssistantText(text: string): string {
  if (!PROTOCOL_SENTINEL_RE.test(text)) return text
  return PROTOCOL_SENTINEL_REPLIES[Math.floor(Math.random() * PROTOCOL_SENTINEL_REPLIES.length)]
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

interface ChatAppProps {
  onThinkingChange?: (thinking: boolean) => void
  hideHeader?: boolean
}

function ChatApp({ onThinkingChange, hideHeader = false }: ChatAppProps) {
  const { t } = useT()
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  // Welcome-to-portal banner: show in the chat empty state when the user
  // hasn't signed in to a ClawBox account yet. Dismissible, persisted in
  // client-kv so the nudge isn't repeated after the user explicitly closes
  // it. The login state itself flips out of the gate as soon as the user
  // signs in on the portal in another tab — no manual refresh needed.
  const clawboxLogin = useClawboxLogin()
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return kv.get('clawbox-portal-welcome-dismissed') === '1'
  })
  const dismissWelcome = useCallback(() => {
    setWelcomeDismissed(true)
    kv.set('clawbox-portal-welcome-dismissed', '1')
  }, [])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [sending, setSending] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [pendingImages, setPendingImages] = useState<{ dataUrl: string; mimeType: string; base64: string }[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef<Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(new Map())
  const sessionKeyRef = useRef<string>('')
  const runIdRef = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const connectedOnceRef = useRef(false)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, streaming, scrollToBottom])

  const wsRequest = useCallback((method: string, params: unknown): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'))
        return
      }
      const id = uuid()
      pendingRef.current.set(id, { resolve, reject })
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id)
          reject(new Error('Request timeout'))
        }
      }, 30000)
    })
  }, [])

  const gatewayTokenRef = useRef('')

  const connect = useCallback(async () => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    pendingRef.current.clear()
    setStatus('connecting')
    setErrorMsg('')
    connectedOnceRef.current = false

    let token: string
    let wsUrl: string
    try {
      const res = await fetch('/setup-api/gateway/ws-config')
      const config = await res.json()
      token = config.token
      wsUrl = config.wsUrl
      gatewayTokenRef.current = token
    } catch {
      setStatus('error')
      setErrorMsg('Failed to get gateway config')
      return
    }

    let connectSent = false
    let ws: WebSocket

    const sendConnect = (nonce: string) => {
      if (connectSent || !ws || ws.readyState !== WebSocket.OPEN) return
      connectSent = true

      const id = uuid()
      pendingRef.current.set(id, {
        resolve: (hello: unknown) => {
          setStatus('connected')
          connectedOnceRef.current = true
          const h = hello as Record<string, unknown>
          const snapshot = h.snapshot as Record<string, unknown> | undefined
          const sessionDefaults = snapshot?.sessionDefaults as Record<string, unknown> | undefined
          const mainSessionKey = (sessionDefaults?.mainSessionKey as string) || 'main'
          sessionKeyRef.current = mainSessionKey
          loadHistory()
        },
        reject: (err: Error) => {
          setStatus('error')
          setErrorMsg(err.message || 'Auth failed')
        },
      })
      ws.send(JSON.stringify({
        type: 'req', id, method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'openclaw-control-ui',
            version: 'clawbox-chat',
            platform: navigator.platform || 'web',
            mode: 'webchat',
            instanceId: uuid(),
          },
          role: 'operator',
          scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
          caps: ['tool-events'],
          auth: { token },
          userAgent: navigator.userAgent,
          locale: navigator.language,
        },
      }))
    }

    const onMessage = (event: MessageEvent) => {
      let data: Record<string, unknown>
      try { data = JSON.parse(String(event.data)) } catch { return }

      if (data.type === 'res') {
        const id = data.id as string
        const pending = pendingRef.current.get(id)
        if (pending) {
          pendingRef.current.delete(id)
          if (data.ok) {
            pending.resolve(data.payload)
          } else {
            const err = data.error as Record<string, unknown> | undefined
            pending.reject(new Error((err?.message as string) || 'Request failed'))
          }
        }
        return
      }

      if (data.type === 'event') {
        const eventName = data.event as string

        if (eventName === 'connect.challenge') {
          const payload = data.payload as Record<string, unknown> | undefined
          const nonce = (payload?.nonce as string) || ''
          sendConnect(nonce)
          return
        }

        if (eventName === 'chat') {
          const payload = data.payload as Record<string, unknown>
          if (!payload) return
          const sk = payload.sessionKey as string
          if (sk !== sessionKeyRef.current) return

          const state = payload.state as string
          const msg = payload.message

          if (state === 'delta') {
            const text = extractText(msg)
            if (text) setStreaming(text)
          } else if (state === 'final') {
            const text = extractText(msg)
            if (text && !/^\s*NO_REPLY\s*$/.test(text)) {
              setMessages(prev => [...prev, { role: 'assistant', text: prettifyAssistantText(text), timestamp: Date.now() }])
            }
            setStreaming('')
            runIdRef.current = null
            setSending(false)
          } else if (state === 'aborted' || state === 'error') {
            setStreaming(prev => {
              if (prev.trim() && !/^\s*NO_REPLY\s*$/.test(prev)) {
                setMessages(msgs => [...msgs, { role: 'assistant', text: prettifyAssistantText(prev), timestamp: Date.now() }])
              }
              return ''
            })
            runIdRef.current = null
            setSending(false)
            if (state === 'error') {
              const errMsg = (payload.errorMessage as string) || 'Chat error'
              setMessages(prev => [...prev, { role: 'system', text: `Error: ${errMsg}`, timestamp: Date.now() }])
            }
          }
        }
      }
    }

    const onClose = () => {
      wsRef.current = null
      if (!connectedOnceRef.current) {
        setStatus('error')
        setErrorMsg('Could not connect to gateway')
      }
    }

    try {
      ws = new WebSocket(wsUrl)
    } catch {
      setStatus('error')
      setErrorMsg('WebSocket creation failed')
      return
    }
    wsRef.current = ws
    ws.onmessage = onMessage
    ws.onclose = onClose
    ws.onerror = () => {}
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadHistory = useCallback(async () => {
    try {
      const result = await wsRequest('chat.history', { sessionKey: sessionKeyRef.current, limit: 50 }) as Record<string, unknown>
      const msgs = (result.messages as unknown[]) || []
      const chatMsgs: ChatMessage[] = []
      for (const msg of msgs) {
        const m = msg as Record<string, unknown>
        const role = (m.role as string)?.toLowerCase()
        if (role !== 'user' && role !== 'assistant') continue
        const text = extractText(m)
        if (!text || /^\s*NO_REPLY\s*$/.test(text)) continue
        const cleaned = role === 'user' ? text.replace(/^\[[^\]]+\]\s*/, '') : prettifyAssistantText(text)
        chatMsgs.push({ role: role as 'user' | 'assistant', text: cleaned, timestamp: (m.timestamp as number) || 0 })
      }
      setMessages(chatMsgs)
    } catch (err) {
      console.error('Failed to load history:', err)
    }
  }, [wsRequest])

  // Handle file/image selection
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(',')[1] || ''
        setPendingImages(prev => [...prev, { dataUrl, mimeType: file.type, base64 }])
      }
      reader.readAsDataURL(file)
    })
    e.target.value = ''
  }, [])

  const removePendingImage = useCallback((index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    const hasImages = pendingImages.length > 0
    if ((!text && !hasImages) || sending) return

    const displayText = text || (hasImages ? `📷 ${pendingImages.length} image${pendingImages.length > 1 ? 's' : ''}` : '')
    setInput('')
    const imagesToSend = [...pendingImages]
    setPendingImages([])
    setMessages(prev => [...prev, {
      role: 'user',
      text: displayText,
      timestamp: Date.now(),
      images: imagesToSend.map(img => img.dataUrl),
    }])
    setSending(true)
    setStreaming('')

    const idempotencyKey = uuid()
    runIdRef.current = idempotencyKey

    try {
      const params: Record<string, unknown> = {
        sessionKey: sessionKeyRef.current,
        message: text || 'What do you see in this image?',
        deliver: false,
        idempotencyKey,
      }
      if (imagesToSend.length > 0) {
        params.attachments = imagesToSend.map(img => ({
          mimeType: img.mimeType,
          content: img.base64,
        }))
      }
      await wsRequest('chat.send', params)
    } catch (err) {
      setSending(false)
      runIdRef.current = null
      setMessages(prev => [...prev, { role: 'system', text: `Error: ${(err as Error).message}`, timestamp: Date.now() }])
    }
  }, [input, sending, wsRequest, pendingImages])

  const abort = useCallback(async () => {
    try {
      await wsRequest('chat.abort', { sessionKey: sessionKeyRef.current })
    } catch {}
  }, [wsRequest])

  // Connect on mount
  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      connect()
    }
    return () => {
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [connect])

  // Focus input when connected
  useEffect(() => {
    if (status === 'connected') {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [status])



  // Notify parent of thinking state
  useEffect(() => { onThinkingChange?.(sending) }, [sending, onThinkingChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#0d1117',
      overflow: 'hidden',
    }}>
      {/* Connection status bar — hidden when parent provides its own header */}
      {!hideHeader && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 14px',
          background: 'linear-gradient(135deg, rgba(249,115,22,0.12) 0%, rgba(13,17,23,0.95) 100%)',
          borderBottom: '1px solid rgba(249,115,22,0.15)',
          flexShrink: 0,
        }}>
          <img src="/clawbox-crab.png" alt="" style={{ width: 20, height: 20, objectFit: 'contain', opacity: 0.7 }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{t("chat.title")}</span>
          {status === 'connecting' && (
            <div style={{
              width: 10, height: 10,
              border: '2px solid rgba(249,115,22,0.3)',
              borderTopColor: '#f97316',
              borderRadius: '50%',
              animation: 'chatapp-spin 0.8s linear infinite',
            }} />
          )}
          {status === 'connected' && (
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.5)' }} />
          )}
          {status === 'error' && (
            <button
              onClick={connect}
              style={{
                background: 'rgba(249,115,22,0.2)', border: '1px solid rgba(249,115,22,0.3)',
                color: '#f97316', borderRadius: 6, padding: '2px 10px', cursor: 'pointer',
                fontSize: 12, fontWeight: 500,
              }}
            >{t("chat.reconnect")}</button>
          )}
        </div>
      )}

      {/* Messages area */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 10,
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(255,255,255,0.1) transparent',
      }}>
        <style>{`@keyframes chatapp-spin { to { transform: rotate(360deg) } } @keyframes chatapp-blink { 50% { opacity: 0 } } @keyframes chatapp-bounce-dot { 0%, 80%, 100% { transform: translateY(0) } 40% { transform: translateY(-5px) } }`}</style>

        {status === 'connecting' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12, color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
            <div style={{ width: 24, height: 24, border: '2px solid rgba(249,115,22,0.2)', borderTopColor: '#f97316', borderRadius: '50%', animation: 'chatapp-spin 0.8s linear infinite' }} />
            {t("chat.connectingGateway")}
          </div>
        )}

        {status === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12, color: 'rgba(255,255,255,0.5)', fontSize: 13, textAlign: 'center', padding: 20 }}>
            <span style={{ fontSize: 28 }}>⚠️</span>
            <span>{errorMsg || t("chat.connectionFailed")}</span>
            <button
              onClick={connect}
              style={{
                background: 'rgba(249,115,22,0.2)', border: '1px solid rgba(249,115,22,0.3)',
                color: '#f97316', borderRadius: 8, padding: '6px 16px', cursor: 'pointer',
                fontSize: 13, fontWeight: 500,
              }}
            >{t("chat.retry")}</button>
          </div>
        )}

        {status === 'connected' && messages.length === 0 && !streaming && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12, color: 'rgba(255,255,255,0.3)', fontSize: 13, padding: '0 16px' }}>
            <img src="/clawbox-crab.png" alt="" style={{ width: 48, height: 48, objectFit: 'contain', opacity: 0.4 }} />
            <span>{t("chat.saySomething")}</span>
            {!clawboxLogin.loading && !clawboxLogin.loggedIn && !welcomeDismissed && (
              <div style={{
                marginTop: 8,
                padding: '12px 14px',
                background: 'linear-gradient(135deg, rgba(249,115,22,0.12), rgba(249,115,22,0.04))',
                border: '1px solid rgba(249,115,22,0.35)',
                borderRadius: 12,
                color: 'rgba(255,255,255,0.85)',
                fontSize: 12.5,
                lineHeight: 1.5,
                maxWidth: 360,
                position: 'relative',
              }}>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={dismissWelcome}
                  style={{
                    position: 'absolute', top: 6, right: 8,
                    background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)',
                    fontSize: 14, lineHeight: 1, cursor: 'pointer', padding: 4,
                  }}
                >×</button>
                <div style={{ fontWeight: 600, color: '#fff', marginBottom: 4 }}>👋 Welcome to ClawBox</div>
                <div style={{ marginBottom: 10 }}>
                  Sign in to the ClawBox portal to unlock all features — Remote Control, ClawKeep cloud backups, and more.
                </div>
                <a
                  href={PORTAL_LOGIN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', borderRadius: 8,
                    background: 'linear-gradient(135deg, #f97316, #ea580c)',
                    color: '#fff', fontWeight: 600, textDecoration: 'none', fontSize: 12.5,
                  }}
                >
                  Open ClawBox Portal →
                </a>
              </div>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{
            display: 'flex',
            justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
          }}>
            <div style={{
              maxWidth: '85%',
              padding: msg.role === 'system' ? '6px 12px' : '8px 14px',
              borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
              background: msg.role === 'user'
                ? 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)'
                : msg.role === 'system'
                  ? 'rgba(239,68,68,0.15)'
                  : 'rgba(255,255,255,0.06)',
              color: msg.role === 'user' ? '#fff' : msg.role === 'system' ? '#ef4444' : 'rgba(255,255,255,0.85)',
              fontSize: 13.5,
              lineHeight: 1.45,
              wordBreak: 'break-word',
            }}>
              {msg.images && msg.images.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: msg.text ? 6 : 0 }}>
                  {msg.images.map((src, j) => (
                    <img key={j} src={src} alt="" style={{ maxWidth: 180, maxHeight: 140, borderRadius: 8, objectFit: 'cover' }} />
                  ))}
                </div>
              )}
              {msg.role === 'user' ? msg.text : renderText(msg.text)}
            </div>
          </div>
        ))}

        {streaming && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              maxWidth: '85%', padding: '8px 14px',
              borderRadius: '14px 14px 14px 4px',
              background: 'rgba(255,255,255,0.06)',
              color: 'rgba(255,255,255,0.85)',
              fontSize: 13.5, lineHeight: 1.45, wordBreak: 'break-word',
            }}>
              {renderText(streaming)}
              <span style={{ display: 'inline-block', width: 6, height: 14, background: '#f97316', borderRadius: 1, marginLeft: 2, animation: 'chatapp-blink 1s step-end infinite', verticalAlign: 'text-bottom' }} />
            </div>
          </div>
        )}

        {sending && !streaming && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              padding: '10px 16px',
              borderRadius: '14px 14px 14px 4px',
              background: 'rgba(255,255,255,0.06)',
              display: 'flex', gap: 4, alignItems: 'center',
            }}>
              {[0, 0.15, 0.3].map((delay, i) => (
                <div key={i} style={{
                  width: 6, height: 6, borderRadius: '50%', background: 'rgba(249,115,22,0.6)',
                  animation: `chatapp-bounce-dot 1s ${delay}s ease-in-out infinite`,
                }} />
              ))}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFileSelect} />

      {/* Pending images preview */}
      {pendingImages.length > 0 && (
        <div style={{
          padding: '8px 14px 0',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(0,0,0,0.2)',
          display: 'flex', gap: 6, overflowX: 'auto', flexShrink: 0,
        }}>
          {pendingImages.map((img, i) => (
            <div key={i} style={{ position: 'relative', flexShrink: 0 }}>
              <img src={img.dataUrl} alt="" style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.1)' }} />
              <button
                onClick={() => removePendingImage(i)}
                style={{
                  position: 'absolute', top: -6, right: -6,
                  width: 18, height: 18, borderRadius: '50%',
                  background: '#ef4444', border: 'none', color: '#fff',
                  fontSize: 11, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  lineHeight: 1,
                }}
              >×</button>
            </div>
          ))}
        </div>
      )}

      {/* Input area */}
      <div style={{
        padding: '10px 14px 12px',
        borderTop: pendingImages.length > 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.2)',
        display: 'flex', gap: 8, alignItems: 'flex-end',
      }}>
        {/* Attachment buttons */}
        <div style={{ display: 'flex', gap: 2, flexShrink: 0, alignItems: 'flex-end' }}>
          <button
            onClick={() => fileInputRef.current?.click()}
            title={t("chat.attachImage")}
            style={{
              width: 32, height: 32, borderRadius: 8, border: 'none',
              background: 'transparent', color: 'rgba(255,255,255,0.35)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.7)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.35)'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>
          <button
            onClick={() => cameraInputRef.current?.click()}
            title={t("chat.takePhoto")}
            style={{
              width: 32, height: 32, borderRadius: 8, border: 'none',
              background: 'transparent', color: 'rgba(255,255,255,0.35)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.7)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.35)'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </button>
        </div>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={status === 'connected' ? t("chat.messagePlaceholder") : t("chat.connectingPlaceholder")}
          disabled={status !== 'connected'}
          rows={1}
          style={{
            flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12, padding: '8px 12px', color: '#fff', fontSize: 13.5,
            resize: 'none', outline: 'none', maxHeight: 100, lineHeight: 1.4,
            fontFamily: 'inherit',
          }}
          onInput={(e) => {
            const el = e.currentTarget
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 100) + 'px'
          }}
        />
        {sending ? (
          <button
            onClick={abort}
            title={t("chat.stop")}
            style={{
              width: 36, height: 36, borderRadius: 10, border: 'none',
              background: 'rgba(239,68,68,0.2)', color: '#ef4444',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239,68,68,0.35)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(239,68,68,0.2)'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            onClick={sendMessage}
            disabled={!input.trim() || status !== 'connected'}
            title={t("chat.send")}
            style={{
              width: 36, height: 36, borderRadius: 10, border: 'none',
              background: input.trim() ? 'linear-gradient(135deg, #f97316, #ea580c)' : 'rgba(255,255,255,0.06)',
              color: input.trim() ? '#fff' : 'rgba(255,255,255,0.2)',
              cursor: input.trim() ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'all 0.15s',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

export default memo(ChatApp)
