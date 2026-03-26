'use client'

import React, { useState, useEffect, useRef, useCallback, memo } from 'react'

// ── Gateway WebSocket chat widget ──
// Connects directly to the OpenClaw gateway, no iframe.

interface ChatPopupProps {
  isOpen: boolean
  onClose: () => void
  onOpenFull?: () => void
  onThinkingChange?: (thinking: boolean) => void
  mascotX?: number
  mobile?: boolean
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  timestamp: number
}

// Simple markdown-ish rendering: bold, italic, code, links
function renderText(text: string) {
  // Split into code blocks vs rest
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const code = part.slice(3, -3).replace(/^\w*\n/, '') // strip language hint
      return <pre key={i} style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 8, padding: '8px 12px', margin: '6px 0', fontSize: 12, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{code}</pre>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px', fontSize: '0.9em' }}>{part.slice(1, -1)}</code>
    }
    // Inline: bold, italic, links
    const inlined = part.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g)
    return inlined.map((seg, j) => {
      if (seg.startsWith('**') && seg.endsWith('**')) return <strong key={`${i}-${j}`}>{seg.slice(2, -2)}</strong>
      if (seg.startsWith('*') && seg.endsWith('*')) return <em key={`${i}-${j}`}>{seg.slice(1, -1)}</em>
      const linkMatch = seg.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (linkMatch) return <a key={`${i}-${j}`} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" style={{ color: '#f97316', textDecoration: 'underline' }}>{linkMatch[1]}</a>
      return <span key={`${i}-${j}`}>{seg}</span>
    })
  })
}

// Strip gateway wrapper tags like <final>, <thinking>, etc.
function stripGatewayTags(text: string): string {
  return text
    .replace(/<\/?(?:final|thinking|response|answer|reply)>/gi, '')
    .trim()
}

// Extract text content from gateway message object
function extractText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const m = msg as Record<string, unknown>
  if (typeof m.text === 'string') return stripGatewayTags(m.text)
  if (typeof m.content === 'string') return stripGatewayTags(m.content)
  if (Array.isArray(m.content)) {
    const raw = m.content
      .map((block: unknown) => {
        if (!block || typeof block !== 'object') return ''
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') return b.text
        if (b.type === 'thinking') return ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
    return stripGatewayTags(raw)
  }
  return ''
}

// uuid() requires secure context (HTTPS).
// Fall back for HTTP deployments.
function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

const DEFAULT_SIZE = { w: 400, h: 500 }

function ChatPopup({ isOpen, onClose, onOpenFull, onThinkingChange, mascotX, mobile = false }: ChatPopupProps) {
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [sending, setSending] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // ── Drag + resize state ──
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>(DEFAULT_SIZE)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Reset position and size when reopened
  useEffect(() => { if (isOpen) { setPos(null); setSize(DEFAULT_SIZE) } }, [isOpen])

  const onDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const el = popupRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      setPos({ x: d.origX + (ev.clientX - d.startX), y: d.origY + (ev.clientY - d.startY) })
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const handleResizeStart = useCallback((edge: string, e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const el = popupRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Snap to absolute x/y positioning so all edges work correctly
    setPos({ x: rect.left, y: rect.top })
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
    const start = { x: clientX, y: clientY, w: rect.width, h: rect.height, left: rect.left, top: rect.top }
    const onMove = (ev: MouseEvent | TouchEvent) => {
      const cx = 'touches' in ev ? ev.touches[0].clientX : (ev as MouseEvent).clientX
      const cy = 'touches' in ev ? ev.touches[0].clientY : (ev as MouseEvent).clientY
      const dx = cx - start.x
      const dy = cy - start.y
      let newW = start.w, newH = start.h, newX = start.left, newY = start.top
      if (edge.includes('r')) newW = Math.max(280, start.w + dx)
      if (edge.includes('b')) newH = Math.max(250, start.h + dy)
      if (edge.includes('l')) { newW = Math.max(280, start.w - dx); newX = start.left + (start.w - newW) }
      if (edge.includes('t')) { newH = Math.max(250, start.h - dy); newY = start.top + (start.h - newH) }
      setSize({ w: newW, h: newH })
      setPos({ x: newX, y: newY })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onMove)
    window.addEventListener('touchend', onUp)
  }, [])

  const wsRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef<Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(new Map())
  const sessionKeyRef = useRef<string>('')
  const runIdRef = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const connectedOnceRef = useRef(false)

  // Auto-scroll to bottom — instant jump, no smooth animation
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, streaming, scrollToBottom])
  useEffect(() => { if (visible) scrollToBottom() }, [visible, scrollToBottom])


  // Send a request over WS
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
      // Timeout after 30s
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id)
          reject(new Error('Request timeout'))
        }
      }, 30000)
    })
  }, [])

  // Connect to gateway
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

    // Fetch WS config from server (gets the token)
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

    // Define handlers BEFORE creating the WebSocket so no events are missed
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

      // Handle responses
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

      // Handle events
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
              setMessages(prev => [...prev, { role: 'assistant', text, timestamp: Date.now() }])
            }
            setStreaming('')
            runIdRef.current = null
            setSending(false)
          } else if (state === 'aborted' || state === 'error') {
            setStreaming(prev => {
              if (prev.trim() && !/^\s*NO_REPLY\s*$/.test(prev)) {
                setMessages(msgs => [...msgs, { role: 'assistant', text: prev, timestamp: Date.now() }])
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

    // Create WebSocket AFTER all handlers are defined to avoid race conditions
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

  // Load chat history, auto-greet if empty
  const greetedRef = useRef(false)
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
        const cleaned = role === 'user' ? text.replace(/^\[[^\]]+\]\s*/, '') : text
        chatMsgs.push({ role: role as 'user' | 'assistant', text: cleaned, timestamp: (m.timestamp as number) || 0 })
      }
      setMessages(chatMsgs)

      // Auto-send a greeting if no history exists (first conversation)
      if (chatMsgs.length === 0 && !greetedRef.current) {
        greetedRef.current = true
        setSending(true)
        setStreaming('')
        const idempotencyKey = uuid()
        runIdRef.current = idempotencyKey
        try {
          await wsRequest('chat.send', {
            sessionKey: sessionKeyRef.current,
            message: 'hi',
            deliver: false,
            idempotencyKey,
          })
        } catch {
          setSending(false)
          runIdRef.current = null
        }
      }
    } catch (err) {
      console.error('Failed to load history:', err)
    }
  }, [wsRequest])

  // Send a message
  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', text, timestamp: Date.now() }])
    setSending(true)
    setStreaming('')

    const idempotencyKey = uuid()
    runIdRef.current = idempotencyKey

    try {
      await wsRequest('chat.send', {
        sessionKey: sessionKeyRef.current,
        message: text,
        deliver: false,
        idempotencyKey,
      })
    } catch (err) {
      setSending(false)
      runIdRef.current = null
      setMessages(prev => [...prev, { role: 'system', text: `Error: ${(err as Error).message}`, timestamp: Date.now() }])
    }
  }, [input, sending, wsRequest])

  // Abort generation
  const abort = useCallback(async () => {
    try {
      await wsRequest('chat.abort', { sessionKey: sessionKeyRef.current })
    } catch {}
  }, [wsRequest])

  // Connect/disconnect on open/close
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connect()
      }
    } else {
      setVisible(false)
    }
  }, [isOpen, connect])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && visible && status === 'connected') {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen, visible, status])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  // Notify parent of thinking state
  useEffect(() => { onThinkingChange?.(sending) }, [sending, onThinkingChange])

  // Handle Enter to send
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  if (!isOpen) return null

  // Default position: above mascot (desktop only)
  const defaultLeft = Math.max(8, Math.min((mascotX ?? 15) / 100 * (typeof window !== 'undefined' ? window.innerWidth : 1000) - 200, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 416))
  const posStyle: React.CSSProperties = mobile
    ? { left: 0, top: 0, right: 0, bottom: 220 }
    : pos
      ? { left: pos.x, top: pos.y, bottom: 'auto' }
      : { left: defaultLeft, bottom: 170 }

  return (
    <div
      ref={popupRef}
      style={{
        position: 'fixed',
        ...posStyle,
        ...(mobile ? { width: 'auto', height: 'auto', maxHeight: 'none', borderRadius: 0 } : { width: size.w, height: size.h, maxHeight: 'calc(100vh - 60px)', borderRadius: 16 }),
        zIndex: 10010,
        overflow: 'hidden',
        boxShadow: mobile ? 'none' : '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
        background: '#0d1117',
        display: 'flex',
        flexDirection: 'column',
        opacity: visible ? 1 : 0,
        transform: visible ? 'scale(1) translateY(0)' : (mobile ? 'translateY(100%)' : 'scale(0.92) translateY(16px)'),
        transition: dragRef.current ? 'none' : 'opacity 0.2s ease, transform 0.2s ease',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      {/* Header — drag handle (desktop) / simple bar (mobile) */}
      <div
        onPointerDown={mobile ? undefined : onDragStart}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          background: 'linear-gradient(135deg, rgba(249,115,22,0.15) 0%, rgba(17,24,39,0.95) 100%)',
          borderBottom: '1px solid rgba(249,115,22,0.2)',
          flexShrink: 0,
          userSelect: 'none',
          cursor: mobile ? 'default' : 'grab',
          touchAction: 'none',
        }}>
        <div style={{ flex: 1 }} />
        {status === 'connecting' && (
          <div style={{
            width: 12, height: 12,
            border: '2px solid rgba(249,115,22,0.3)',
            borderTopColor: '#f97316',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
        )}
        {status === 'connected' && (
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.5)' }} />
        )}
        {onOpenFull && (
          <button
            onClick={() => { onOpenFull(); onClose() }}
            title="Open full UI"
            style={{
              background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)',
              cursor: 'pointer', padding: 4, borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.background = 'none' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
          </button>
        )}
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)',
            cursor: 'pointer', padding: 4, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.background = 'none' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Messages area */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 10,
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(255,255,255,0.1) transparent',
      }}>
        {status === 'connecting' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12, color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
            <div style={{ width: 24, height: 24, border: '2px solid rgba(249,115,22,0.2)', borderTopColor: '#f97316', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            Connecting to gateway...
          </div>
        )}

        {status === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12, color: 'rgba(255,255,255,0.5)', fontSize: 13, textAlign: 'center', padding: 20 }}>
            <span style={{ fontSize: 28 }}>⚠️</span>
            <span>{errorMsg || 'Connection failed'}</span>
            <button
              onClick={connect}
              style={{
                background: 'rgba(249,115,22,0.2)', border: '1px solid rgba(249,115,22,0.3)',
                color: '#f97316', borderRadius: 8, padding: '6px 16px', cursor: 'pointer',
                fontSize: 13, fontWeight: 500,
              }}
            >Retry</button>
          </div>
        )}

        {status === 'connected' && messages.length === 0 && !streaming && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>
            <img src="/clawbox-crab.png" alt="" style={{ width: 48, height: 48, opacity: 0.4 }} />
            <span>Say something!</span>
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
              {msg.role === 'user' ? msg.text : renderText(msg.text)}
            </div>
          </div>
        ))}

        {/* Streaming message */}
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
              <span style={{ display: 'inline-block', width: 6, height: 14, background: '#f97316', borderRadius: 1, marginLeft: 2, animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom' }} />
              <style>{`@keyframes blink { 50% { opacity: 0 } }`}</style>
            </div>
          </div>
        )}

        {/* Typing indicator when sending but no stream yet */}
        {sending && !streaming && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              padding: '10px 16px',
              borderRadius: '14px 14px 14px 4px',
              background: 'rgba(255,255,255,0.06)',
              display: 'flex', gap: 4, alignItems: 'center',
            }}>
              <style>{`@keyframes bounce-dot { 0%, 80%, 100% { transform: translateY(0) } 40% { transform: translateY(-5px) } }`}</style>
              {[0, 0.15, 0.3].map((delay, i) => (
                <div key={i} style={{
                  width: 6, height: 6, borderRadius: '50%', background: 'rgba(249,115,22,0.6)',
                  animation: `bounce-dot 1s ${delay}s ease-in-out infinite`,
                }} />
              ))}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={{
        padding: '10px 14px 12px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.2)',
        display: 'flex', gap: 8, alignItems: 'flex-end',
      }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={status === 'connected' ? 'Type a message...' : 'Connecting...'}
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
            title="Stop"
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
            title="Send"
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

      {/* Resize edges — desktop only */}
      {!mobile && <>
        <div className="absolute top-0 left-2 right-2 h-1 cursor-n-resize" onMouseDown={(e) => handleResizeStart("t", e)} onTouchStart={(e) => handleResizeStart("t", e)} />
        <div className="absolute bottom-0 left-2 right-2 h-1 cursor-s-resize" onMouseDown={(e) => handleResizeStart("b", e)} onTouchStart={(e) => handleResizeStart("b", e)} />
        <div className="absolute left-0 top-2 bottom-2 w-1 cursor-w-resize" onMouseDown={(e) => handleResizeStart("l", e)} onTouchStart={(e) => handleResizeStart("l", e)} />
        <div className="absolute right-0 top-2 bottom-2 w-1 cursor-e-resize" onMouseDown={(e) => handleResizeStart("r", e)} onTouchStart={(e) => handleResizeStart("r", e)} />
        <div className="absolute top-0 left-0 w-3 h-3 cursor-nw-resize" onMouseDown={(e) => handleResizeStart("tl", e)} onTouchStart={(e) => handleResizeStart("tl", e)} />
        <div className="absolute top-0 right-0 w-3 h-3 cursor-ne-resize" onMouseDown={(e) => handleResizeStart("tr", e)} onTouchStart={(e) => handleResizeStart("tr", e)} />
        <div className="absolute bottom-0 left-0 w-3 h-3 cursor-sw-resize" onMouseDown={(e) => handleResizeStart("bl", e)} onTouchStart={(e) => handleResizeStart("bl", e)} />
        <div className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize" onMouseDown={(e) => handleResizeStart("br", e)} onTouchStart={(e) => handleResizeStart("br", e)} />
      </>}
    </div>
  )
}

export default memo(ChatPopup)
