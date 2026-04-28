'use client'

import React, { useState, useEffect, useRef, useCallback, memo } from 'react'

// ── Gateway WebSocket chat widget ──
// Connects directly to the OpenClaw gateway, no iframe.

// Save short assistant snippets for mascot speech lines via client-kv
import * as kv from '@/lib/client-kv'

const MASCOT_LINES_KEY = 'clawbox-mascot-convo-lines'
const MAX_RETRIES = 8
// During a skill install the gateway restarts to load the new skill, so
// extend the retry budget to quadruple so the chat reconnects automatically
// once it comes back instead of forcing the user to click Try again.
const SKILL_INSTALL_MAX_RETRIES = MAX_RETRIES * 4
const RETRY_DELAY = 3000
const SPINNER_STYLE: React.CSSProperties = { width: 24, height: 24, border: '2px solid rgba(249,115,22,0.2)', borderTopColor: '#f97316', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }
function saveMascotSnippet(text: string) {
  if (!text || text.length < 10) return
  const sentences = text
    .replace(/\n+/g, '. ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 10 && s.length <= 80)
    .filter(s => !/^(here|sure|ok|yes|no|let me|i'll|i can|```)/i.test(s))
    .filter(s => !s.includes('```') && !s.includes('http') && !s.includes('**'))
  if (sentences.length === 0) return
  const picks = sentences.slice(0, 2)
  const existing = kv.getJSON<{ lines: string[]; date: string }>(MASCOT_LINES_KEY) || { lines: [], date: '' }
  const today = new Date().toISOString().slice(0, 10)
  if (existing.date !== today) { existing.lines = []; existing.date = today }
  let changed = false
  for (const p of picks) {
    if (!existing.lines.includes(p)) { existing.lines.push(p); changed = true }
  }
  if (!changed) return
  if (existing.lines.length > 50) existing.lines = existing.lines.slice(-50)
  kv.setJSON(MASCOT_LINES_KEY, existing)
}

interface ChatPopupProps {
  isOpen: boolean
  onClose: () => void
  onOpenFull?: () => void
  onOpenSettingsSection?: (section: 'ai' | 'localAi') => void
  onThinkingChange?: (thinking: boolean) => void
  onPanelModeChange?: (panelWidth: number) => void
  initialPanelWidth?: number
  mascotX?: number
  mobile?: boolean
  trayMode?: boolean
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  timestamp: number
  /**
   * Visual variant for `system` role messages. "error" is the default
   * (red pill) and is what surfaces for WebSocket failures, model-switch
   * errors, and similar user-visible problems. "success" (green pill)
   * is for confirmations — e.g. "Switched chat to X" after the user
   * picks a new model. Ignored for 'user' and 'assistant' roles.
   */
  variant?: 'success' | 'error'
}

interface ChatModelState {
  activeOptionId: string | null
  activeModel: string | null
  activeSource: 'primary' | 'local' | null
  activeLabel: string | null
  options: Array<{
    id: string
    label: string
    model: string | null
    provider: string | null
    available: boolean
    settingsSection: 'ai' | 'localAi'
    isLocal: boolean
  }>
  primary: { available: boolean; label: string | null; model: string | null }
  local: { available: boolean; label: string | null; model: string | null }
}

// Left dropdown is the provider selector — always show the friendly
// provider label (e.g. "Anthropic Claude", "OpenAI GPT") so users don't
// see a raw fully-qualified model id. When the provider has multiple
// curated models a secondary dropdown appears next to this one for
// model selection (see renderProviderModelPicker).
function getChatModelOptionText(option: ChatModelState['options'][number]) {
  if (!option.available) return `${option.label} - Set up in Settings`
  return option.label || option.id
}

import { renderText } from '@/lib/chat-markdown'
import { useT } from '@/lib/i18n'
import {
  extractProviderModelId,
  getProviderCatalog,
} from '@/lib/provider-models'

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
const DEFAULT_PANEL_WIDTH = DEFAULT_SIZE.w

function ChatPopup({ isOpen, onClose, onOpenFull, onOpenSettingsSection, onThinkingChange, onPanelModeChange, initialPanelWidth, mascotX, mobile = false, trayMode = false }: ChatPopupProps) {
  const { t } = useT()
  const [panelWidth, setPanelWidth] = useState<number | null>(initialPanelWidth && initialPanelWidth > 0 ? initialPanelWidth : null)
  const panelMode = panelWidth !== null
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [sending, setSending] = useState(false)
  const [isBootstrappingHistory, setIsBootstrappingHistory] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [chatModelState, setChatModelState] = useState<ChatModelState | null>(null)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [thinkingLevel, setThinkingLevel] = useState<string>(() => {
    if (typeof window === 'undefined') return 'high'
    return window.localStorage?.getItem('clawbox:chat:thinkingLevel') || 'high'
  })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<{ name: string; path: string; type: string }[]>([])

  // ── Drag + resize state ──
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>(DEFAULT_SIZE)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Reset position and size when reopened
  useEffect(() => { if (isOpen) { setPos(null); setSize(DEFAULT_SIZE) } }, [isOpen])

  // Sync panel width from parent (handles async preferences load after mount)
  useEffect(() => {
    if (initialPanelWidth && initialPanelWidth > 0 && panelWidth === null) {
      setPanelWidth(initialPanelWidth)
    }
  }, [initialPanelWidth]) // eslint-disable-line react-hooks/exhaustive-deps -- panelWidth excluded: one-way sync from parent, must not re-trigger on local resize

  // Exit panel mode when closed
  useEffect(() => { if (!isOpen && panelMode) { setPanelWidth(null); onPanelModeChange?.(0) } }, [isOpen, panelMode, onPanelModeChange])

  const togglePanelMode = useCallback(() => {
    if (panelMode) {
      setPanelWidth(null)
      onPanelModeChange?.(0)
    } else {
      setPanelWidth(DEFAULT_PANEL_WIDTH)
      onPanelModeChange?.(DEFAULT_PANEL_WIDTH)
    }
    setPos(null)
    setSize(DEFAULT_SIZE)
  }, [panelMode, onPanelModeChange])

  const handlePanelResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const startW = popupRef.current?.getBoundingClientRect().width ?? DEFAULT_PANEL_WIDTH
    const onMove = (ev: MouseEvent | TouchEvent) => {
      const cx = 'touches' in ev ? ev.touches[0].clientX : (ev as MouseEvent).clientX
      const newW = Math.max(280, Math.min(startW - (cx - startX), window.innerWidth * 0.6))
      // Direct DOM update during drag — no React re-renders
      if (popupRef.current) popupRef.current.style.width = newW + 'px'
    }
    const onUp = (ev: MouseEvent | TouchEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
      // Commit final width to React state + notify parent
      const cx = 'changedTouches' in ev ? ev.changedTouches[0].clientX : (ev as MouseEvent).clientX
      const finalW = Math.max(280, Math.min(startW - (cx - startX), window.innerWidth * 0.6))
      setPanelWidth(finalW)
      onPanelModeChange?.(finalW)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onMove)
    window.addEventListener('touchend', onUp)
  }, [onPanelModeChange])

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

  // Push the latest thinkingLevel to the gateway whenever it changes or the
  // WS reconnects. chat.send resolves thinking from the session entry, so
  // patching the entry keeps every subsequent send aligned with the picker.
  useEffect(() => {
    if (status !== 'connected') return
    const key = sessionKeyRef.current
    if (!key) return
    void wsRequest('sessions.patch', { key, thinkingLevel }).catch(() => {})
  }, [status, thinkingLevel, wsRequest])

  const handleThinkingLevelChange = useCallback((next: string) => {
    setThinkingLevel(next)
    try { window.localStorage?.setItem('clawbox:chat:thinkingLevel', next) } catch {}
  }, [])

  // Connect to gateway
  const gatewayTokenRef = useRef('')
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshChatModelState = useCallback(async () => {
    try {
      const res = await fetch('/setup-api/chat/model', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json() as ChatModelState
      setChatModelState(data)
    } catch {
      // Ignore toggle-state refresh failures and keep the current option list.
    }
  }, [])

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
      // Auto-retry if gateway config not ready yet. Extend the budget
      // during skill-install windows so the chat silently recovers once
      // the restarted gateway finishes reloading skills.
      const maxRetries = skillInstalledRef.current ? SKILL_INSTALL_MAX_RETRIES : MAX_RETRIES
      if (retryCountRef.current < maxRetries) {
        retryCountRef.current++
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
        retryTimerRef.current = setTimeout(() => connect(), RETRY_DELAY)
        return
      }
      setStatus('error')
      setErrorMsg('Failed to get gateway config')
      return
    }

    // Define handlers BEFORE creating the WebSocket so no events are missed
    let connectSent = false
    let ws: WebSocket

    const sendConnect = () => {
      if (connectSent || !ws || ws.readyState !== WebSocket.OPEN) return
      connectSent = true

      const id = uuid()
      pendingRef.current.set(id, {
        resolve: (hello: unknown) => {
          setStatus('connected')
          connectedOnceRef.current = true
          retryCountRef.current = 0
          const h = hello as Record<string, unknown>
          const snapshot = h.snapshot as Record<string, unknown> | undefined
          const sessionDefaults = snapshot?.sessionDefaults as Record<string, unknown> | undefined
          const mainSessionKey = (sessionDefaults?.mainSessionKey as string) || 'main'
          sessionKeyRef.current = mainSessionKey
          // If a skill was just installed/uninstalled, start fresh session.
          // Provider changes re-use the same flag for retry-budget + overlay
          // purposes, but we skip the auto-send prompt for them (no skill
          // changed, there's nothing to confirm) — just reset and hand
          // control back to the user.
          if (skillInstalledRef.current) {
            const wasProviderChange = reloadReasonRef.current === 'provider'
            skillInstalledRef.current = false
            reloadReasonRef.current = 'skill' // reset for next reload
            // Only reset the transcript for skill install/uninstall/etc.
            // Provider changes keep the visible history so the user's
            // earlier context isn't wiped — only the backend session
            // override changed, not the conversation semantics.
            if (!wasProviderChange) {
              setMessages([])
              greetedRef.current = true // prevent auto-greet
            }
            const evt = skillEventRef.current
            skillEventRef.current = null
            // Build context message about the skill change
            let contextMsg = 'My skills were just updated. What skills do you have available now?'
            if (evt?.action === 'install' && evt.name) {
              contextMsg = `[System: A new skill "${evt.name}" was just installed and your session was refreshed.] Hi! I just installed the "${evt.name}" skill. Can you confirm you have it and briefly tell me what it does?`
            } else if (evt?.action === 'uninstall' && evt.id) {
              contextMsg = `[System: The skill "${evt.id}" was just uninstalled and your session was refreshed.] I just removed the "${evt.id}" skill. Can you confirm it's gone?`
            } else if (evt?.action === 'enable' && evt.id) {
              contextMsg = `[System: The skill "${evt.id}" was just re-enabled and your session was refreshed.] I just enabled the "${evt.id}" skill. Can you confirm you have it?`
            } else if (evt?.action === 'disable' && evt.id) {
              contextMsg = `[System: The skill "${evt.id}" was just disabled and your session was refreshed.] I just disabled the "${evt.id}" skill. Can you confirm it's no longer active?`
            }
            // Complete the progress bar
            if (reloadTimerRef.current) clearInterval(reloadTimerRef.current)
            setReloadProgress(100)
            // Small delay to show 100%, then either auto-send the skill
            // context message (skill install/uninstall) or, for a
            // provider change, just drop the overlay and surface a
            // green "Switched chat to X" banner so the user has an
            // explicit confirmation the new provider is active.
            setTimeout(async () => {
              setReloadingSkill(false)
              if (wasProviderChange) {
                // Refresh chat/model state so we can label the banner with
                // the new active provider. Fire-and-forget — if the fetch
                // fails the worst case is we don't show the banner, not
                // that the chat is broken.
                try {
                  const res = await fetch('/setup-api/chat/model', { cache: 'no-store' })
                  const state = await res.json() as ChatModelState
                  setChatModelState(state)
                  const label = state.activeLabel ?? state.primary?.label ?? 'the new AI provider'
                  setMessages(prev => [...prev, {
                    role: 'system',
                    text: `Switched chat to ${label}.`,
                    timestamp: Date.now(),
                    variant: 'success',
                  }])
                } catch {
                  // Ignore — banner is best-effort confirmation only.
                }
                return
              }
              setSending(true)
              setMessages([{ role: 'user', text: contextMsg.replace(/\[System:.*?\]\s*/g, ''), timestamp: Date.now() }])
              wsRequest('chat.send', {
                sessionKey: mainSessionKey,
                message: contextMsg,
                idempotencyKey: uuid(),
              }).catch((err) => { console.warn('[chat] skill reload send failed:', err); setSending(false) })
            }, 500)
          } else {
            loadHistory()
          }
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
          sendConnect()
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
            if (text) { setStreaming(text); setReloadingSkill(false) }
          } else if (state === 'final') {
            const text = extractText(msg)
            if (text && !/^\s*NO_REPLY\s*$/.test(text)) {
              setMessages(prev => [...prev, { role: 'assistant', text, timestamp: Date.now() }])
              saveMascotSnippet(text)
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
      // While a skill install is in-flight the gateway is restarting to
      // load the new skill — use the extended retry budget so the chat
      // reconnects automatically once it comes back, instead of bailing
      // out with 'Could not connect to gateway' and making the user click
      // Try again manually. The normal cap still applies outside of
      // skill-install windows.
      const maxRetries = skillInstalledRef.current ? SKILL_INSTALL_MAX_RETRIES : MAX_RETRIES
      if (retryCountRef.current < maxRetries) {
        retryCountRef.current++
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
        retryTimerRef.current = setTimeout(() => connect(), RETRY_DELAY)
        return
      }
      setStatus('error')
      setErrorMsg('Could not connect to gateway')
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

  useEffect(() => {
    if (!isOpen) return
    refreshChatModelState()
  }, [isOpen, refreshChatModelState])

  useEffect(() => {
    if (!isOpen) return
    const handleModelStateChanged = () => {
      refreshChatModelState()
    }
    window.addEventListener('clawbox:chat-model-state-changed', handleModelStateChanged)
    return () => window.removeEventListener('clawbox:chat-model-state-changed', handleModelStateChanged)
  }, [isOpen, refreshChatModelState])

  // Load chat history, auto-greet if empty
  const greetedRef = useRef(false)
  const loadHistory = useCallback(async () => {
    // Optimistically show the typing bubble if an auto-greet might still run,
    // so the user sees feedback during the history round-trip (and is locked
    // out of typing via the greetingPending gate on the input). Bootstrap is
    // tracked separately from `sending` so the stop button, sendMessage's
    // re-entry guard, and onThinkingChange aren't tripped before any
    // generation actually starts.
    const mightAutoGreet = !greetedRef.current
    if (mightAutoGreet) {
      setIsBootstrappingHistory(true)
      setStreaming('')
    }
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
        setIsBootstrappingHistory(false)
        setSending(true)
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
      } else if (mightAutoGreet) {
        setIsBootstrappingHistory(false)
      }
    } catch (err) {
      console.error('Failed to load history:', err)
      if (mightAutoGreet) setIsBootstrappingHistory(false)
    }
  }, [wsRequest])

  // Handle file selection for attachments — upload all files to server
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('path', 'uploads')
      try {
        const res = await fetch('/setup-api/files', { method: 'POST', body: formData })
        if (res.ok) {
          setAttachments(prev => [...prev, { name: file.name, path: `/home/clawbox/uploads/${file.name}`, type: file.type }])
        }
      } catch { /* upload failed */ }
    }
    e.target.value = ''
  }, [])

  const removeAttachment = useCallback((idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx))
  }, [])

  // Send a message
  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    if (sending) return

    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])

    // Build display text for user message
    const fileNames = currentAttachments.map(a => `📎 ${a.name}`).join('\n')
    const displayText = [fileNames, text].filter(Boolean).join('\n')
    setMessages(prev => [...prev, { role: 'user', text: displayText, timestamp: Date.now() }])
    setSending(true)
    setStreaming('')

    const idempotencyKey = uuid()
    runIdRef.current = idempotencyKey

    // Build message with file paths — gateway only supports 'message' string
    let messageText = text
    if (currentAttachments.length > 0) {
      const filePaths = currentAttachments.map(a => `[Attached file: ${a.path}]`).join('\n')
      messageText = [filePaths, text].filter(Boolean).join('\n')
    }

    try {
      await wsRequest('chat.send', {
        sessionKey: sessionKeyRef.current,
        message: messageText || '(file attached)',
        deliver: false,
        idempotencyKey,
      })
    } catch (err) {
      setSending(false)
      runIdRef.current = null
      setMessages(prev => [...prev, { role: 'system', text: `Error: ${(err as Error).message}`, timestamp: Date.now() }])
    }
  }, [input, sending, attachments, wsRequest])

  // Abort generation
  const abort = useCallback(async () => {
    try {
      await wsRequest('chat.abort', { sessionKey: sessionKeyRef.current })
    } catch {}
  }, [wsRequest])

  const switchChatModel = useCallback(async (target: { model: string; label: string }) => {
    if (switchingModel || chatModelState?.activeModel === target.model) return
    setSwitchingModel(true)
    setErrorMsg('')
    try {
      const res = await fetch('/setup-api/chat/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: target.model }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to switch chat model')

      setChatModelState(data as ChatModelState)
      setMessages(prev => [...prev, {
        role: 'system',
        text: `Switched chat to ${target.model}.`,
        timestamp: Date.now(),
        variant: 'success',
      }])
      retryCountRef.current = 0
      connect()
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'system',
        text: `Error: ${err instanceof Error ? err.message : 'Failed to switch chat model'}`,
        timestamp: Date.now(),
      }])
    } finally {
      setSwitchingModel(false)
    }
  }, [chatModelState, connect, switchingModel])

  const handleChatSourceChange = useCallback(async (optionId: string) => {
    const target = chatModelState?.options.find(option => option.id === optionId)
    if (!target) return

    if (!target.available || !target.model) {
      onOpenSettingsSection?.(target.settingsSection)
      setMessages(prev => [...prev, {
        role: 'system',
        text: `${target.label} is not configured. Opened Settings so you can set it up.`,
        timestamp: Date.now(),
      }])
      return
    }

    await switchChatModel({ model: target.model, label: target.label })
  }, [chatModelState, onOpenSettingsSection, switchChatModel])

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
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
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

  // Listen for skill installs — flag for /new after reconnect
  const skillInstalledRef = useRef(false)
  const skillEventRef = useRef<{ action: string; name?: string; id?: string } | null>(null)
  const [reloadingSkill, setReloadingSkill] = useState(false)
  const [reloadProgress, setReloadProgress] = useState(0)
  const [reloadReason, setReloadReason] = useState<'skill' | 'provider'>('skill')
  // Duplicate of reloadReason behind a ref because the WebSocket `hello`
  // resolve callback is created once (inside a useCallback with [] deps)
  // and captures whatever reloadReason state was at mount time —
  // without this ref, the `wasProviderChange` branch would never fire
  // because the state update from the event handler doesn't propagate
  // into that frozen closure.
  const reloadReasonRef = useRef<'skill' | 'provider'>('skill')
  const reloadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    const makeHandler = (reason: 'skill' | 'provider') => (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      skillInstalledRef.current = true
      skillEventRef.current = detail
      reloadReasonRef.current = reason
      setReloadReason(reason)
      setReloadingSkill(true)
      setReloadProgress(0)
      retryCountRef.current = 0
      if (reloadTimerRef.current) clearInterval(reloadTimerRef.current)
      let progress = 0
      reloadTimerRef.current = setInterval(() => {
        progress += (90 - progress) * 0.08
        const rounded = Math.min(Math.round(progress), 90)
        setReloadProgress(rounded)
        if (rounded >= 90 && reloadTimerRef.current) {
          clearInterval(reloadTimerRef.current)
          reloadTimerRef.current = null
        }
      }, 200)
    }
    const skillHandler = makeHandler('skill')
    // Treat a primary-AI-provider change the same as a skill install:
    // the gateway is restarting, the chat WS is about to drop, and
    // without the progress overlay the user sees the chat freeze until
    // the bare retry loop reconnects. Reusing the skillInstalledRef flag
    // also gets us the quadrupled retry budget for the reconnect, so
    // slower restarts don't trigger the 'Could not connect to gateway'
    // fallback UI.
    const providerReloadHandler = makeHandler('provider')
    const providerHandler = (e: Event) => {
      providerReloadHandler(e)
      // The configure route restarts the gateway before returning its
      // response, and the Settings event fires *after* the response —
      // so by the time we get here the WS may already have reconnected
      // on its own. If so, no future `hello` is coming to trip the
      // reload branch in the resolve callback, and the overlay would
      // stay up forever. Force a fresh connect() so the resolve-branch
      // fires exactly once, right now, with reloadReasonRef=='provider'.
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try { wsRef.current.close() } catch { /* ignore */ }
      }
      retryCountRef.current = 0
      connect()
    }
    window.addEventListener('clawbox-skill-installed', skillHandler)
    window.addEventListener('clawbox:primary-ai-configured', providerHandler)
    return () => {
      window.removeEventListener('clawbox-skill-installed', skillHandler)
      window.removeEventListener('clawbox:primary-ai-configured', providerHandler)
      if (reloadTimerRef.current) clearInterval(reloadTimerRef.current)
    }
  }, [])

  // Safety net: if the chat ever lands in the error state while a skill
  // install is still in flight, auto-retry the connection instead of
  // making the user click the manual Try-again button. The main defense
  // is the quadrupled retry budget in onClose / gateway-config fetch;
  // this effect covers any path that bypasses them.
  useEffect(() => {
    if (status !== 'error' || !reloadingSkill) return
    const timer = setTimeout(() => {
      retryCountRef.current = 0
      connect()
    }, RETRY_DELAY)
    return () => clearTimeout(timer)
  }, [status, reloadingSkill, connect])

  // Notify parent of thinking state
  useEffect(() => { onThinkingChange?.(sending) }, [sending, onThinkingChange])

  // Handle Enter to send
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  const stopHeaderDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation()
  }, [])

  if (!isOpen) return null

  // Default position: above mascot (desktop only)
  const defaultLeft = Math.max(8, Math.min((mascotX ?? 15) / 100 * (typeof window !== 'undefined' ? window.innerWidth : 1000) - 200, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 416))
  const posStyle: React.CSSProperties = panelMode
    ? { right: 0, top: 0, bottom: 56 }
    : mobile
      ? { left: 0, top: 0, right: 0, bottom: 0 }
      : pos
        ? { left: pos.x, top: pos.y, bottom: 'auto' }
        : trayMode
          ? { right: 8, bottom: 65 }
          : { left: defaultLeft, bottom: 170 }

  const greetingPending = isBootstrappingHistory || (sending && messages.length === 0)

  return (
    <div
      data-testid="chat-popup"
      ref={popupRef}
      style={{
        position: 'fixed',
        ...posStyle,
        ...(panelMode
          ? { width: panelWidth, height: 'auto', maxHeight: 'none', borderRadius: 0 }
          : mobile
            ? { width: 'auto', height: 'auto', maxHeight: 'none', borderRadius: 0 }
            : { width: size.w, height: size.h, maxHeight: 'calc(100vh - 60px)', borderRadius: 16 }),
        zIndex: 10010,
        overflow: 'hidden',
        boxShadow: panelMode ? '-4px 0 20px rgba(0,0,0,0.4), -1px 0 0 rgba(255,255,255,0.08)' : mobile ? 'none' : '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
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
        onPointerDown={mobile || panelMode ? undefined : onDragStart}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          background: 'linear-gradient(135deg, rgba(249,115,22,0.15) 0%, rgba(17,24,39,0.95) 100%)',
          borderBottom: '1px solid rgba(249,115,22,0.2)',
          flexShrink: 0,
          userSelect: 'none',
          cursor: mobile || panelMode ? 'default' : 'grab',
          touchAction: 'none',
        }}>
        <div style={{ display: 'flex', minWidth: 0 }}>
          {chatModelState && (
            <div
              onPointerDown={stopHeaderDrag}
              style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', maxWidth: 240 }}
            >
              <select
                aria-label="Chat model"
                value={chatModelState.activeOptionId ?? chatModelState.options[0]?.id ?? ''}
                onChange={(e) => handleChatSourceChange(e.target.value)}
                onPointerDown={stopHeaderDrag}
                disabled={switchingModel}
                style={{
                  appearance: 'none',
                  WebkitAppearance: 'none',
                  MozAppearance: 'none',
                  width: '100%',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#fff',
                  borderRadius: 10,
                  padding: '6px 28px 6px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  outline: 'none',
                  cursor: switchingModel ? 'default' : 'pointer',
                }}
              >
                {chatModelState.options.map((option) => (
                  <option key={option.id} value={option.id} style={{ background: '#111827', color: '#fff' }}>
                    {getChatModelOptionText(option)}
                  </option>
                ))}
              </select>
              <span
                className="material-symbols-rounded"
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  right: 8,
                  fontSize: 16,
                  color: 'rgba(255,255,255,0.35)',
                  pointerEvents: 'none',
                }}
              >
                unfold_more
              </span>
            </div>
          )}
          {(() => {
            // Inline model switcher: renders next to the provider dropdown
            // whenever the active provider has multiple curated models.
            // Lets users hot-swap between Claude Haiku/Sonnet/Opus, GPT
            // variants, Gemini variants, or OpenRouter's 340+ models
            // mid-chat without opening Settings. If the current model
            // isn't in our curated list (custom ID typed in Settings),
            // we prepend it as a "Custom" entry so the select reflects
            // reality.
            if (!chatModelState) return null
            const activeOption = chatModelState.options.find(
              (option) => option.id === chatModelState.activeOptionId,
            )
            if (!activeOption?.provider) return null
            const catalog = getProviderCatalog(activeOption.provider)
            if (!catalog || catalog.models.length < 2) return null
            const activeModelId = extractProviderModelId(
              chatModelState.activeModel,
              activeOption.provider,
            )
            if (!activeModelId) return null
            const curatedHasActive = catalog.models.some(
              (option) => option.id === activeModelId,
            )
            const modelOptions = curatedHasActive
              ? catalog.models
              : [
                  { id: activeModelId, label: activeModelId, hint: 'Custom model' },
                  ...catalog.models,
                ]
            return (
              <div
                onPointerDown={stopHeaderDrag}
                style={{
                  position: 'relative',
                  display: 'inline-flex',
                  alignItems: 'center',
                  maxWidth: 200,
                  marginLeft: 6,
                }}
              >
                <select
                  aria-label={`${activeOption.label} model`}
                  value={activeModelId}
                  onChange={(e) => {
                    const nextId = e.target.value
                    if (nextId === activeModelId) return
                    void switchChatModel({
                      model: `${activeOption.provider}/${nextId}`,
                      label: nextId,
                    })
                  }}
                  onPointerDown={stopHeaderDrag}
                  disabled={switchingModel}
                  style={{
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    MozAppearance: 'none',
                    width: '100%',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: '#fff',
                    borderRadius: 10,
                    padding: '6px 28px 6px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    outline: 'none',
                    cursor: switchingModel ? 'default' : 'pointer',
                  }}
                >
                  {modelOptions.map((option) => (
                    <option
                      key={option.id}
                      value={option.id}
                      style={{ background: '#111827', color: '#fff' }}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
                <span
                  className="material-symbols-rounded"
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    right: 8,
                    fontSize: 16,
                    color: 'rgba(255,255,255,0.35)',
                    pointerEvents: 'none',
                  }}
                >
                  unfold_more
                </span>
              </div>
            )
          })()}
          <div
            onPointerDown={stopHeaderDrag}
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              maxWidth: 120,
              marginLeft: 6,
            }}
          >
            <select
              aria-label="Reasoning effort"
              value={thinkingLevel}
              onChange={(e) => handleThinkingLevelChange(e.target.value)}
              onPointerDown={stopHeaderDrag}
              style={{
                appearance: 'none',
                WebkitAppearance: 'none',
                MozAppearance: 'none',
                width: '100%',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#fff',
                borderRadius: 10,
                padding: '6px 28px 6px 10px',
                fontSize: 11,
                fontWeight: 600,
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="low" style={{ background: '#111827', color: '#fff' }}>Effort: low</option>
              <option value="medium" style={{ background: '#111827', color: '#fff' }}>Effort: medium</option>
              <option value="high" style={{ background: '#111827', color: '#fff' }}>Effort: high</option>
            </select>
            <span
              className="material-symbols-rounded"
              aria-hidden="true"
              style={{
                position: 'absolute',
                right: 8,
                fontSize: 16,
                color: 'rgba(255,255,255,0.35)',
                pointerEvents: 'none',
              }}
            >
              unfold_more
            </span>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {(status === 'connecting' || switchingModel) && (
          <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <div style={{
              width: 12, height: 12,
              border: '2px solid rgba(249,115,22,0.3)',
              borderTopColor: '#f97316',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }} />
          </div>
        )}
        {status === 'connected' && !switchingModel && (
          <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.5)' }} />
          </div>
        )}
        {onOpenFull && (
          <button
            onPointerDown={stopHeaderDrag}
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
        {!mobile && (
          <button
            onPointerDown={stopHeaderDrag}
            onClick={togglePanelMode}
            title={panelMode ? "Undock panel" : "Dock to right"}
            style={{
              background: panelMode ? 'rgba(249,115,22,0.2)' : 'none',
              border: 'none',
              color: panelMode ? '#f97316' : 'rgba(255,255,255,0.4)',
              cursor: 'pointer', padding: 4, borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = panelMode ? '#f97316' : '#fff'; e.currentTarget.style.background = panelMode ? 'rgba(249,115,22,0.3)' : 'rgba(255,255,255,0.1)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = panelMode ? '#f97316' : 'rgba(255,255,255,0.4)'; e.currentTarget.style.background = panelMode ? 'rgba(249,115,22,0.2)' : 'none' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        )}
        <button
          onPointerDown={stopHeaderDrag}
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
        userSelect: 'text',
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(255,255,255,0.1) transparent',
      }}>
        {(status === 'connecting' || reloadingSkill) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 14, color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } } @keyframes dots { 0%,20% { content: '' } 40% { content: '.' } 60% { content: '..' } 80%,100% { content: '...' } }`}</style>
            {reloadingSkill ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, width: '85%' }}>
                <div style={SPINNER_STYLE} />
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, width: '100%' }}>
                  <span>{reloadReason === 'provider' ? 'Switching AI provider...' : 'Reloading skills...'}</span>
                  <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={reloadProgress} aria-label="Reload progress" style={{ width: '100%', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 2, background: '#f97316',
                      transition: 'width 0.3s ease-out',
                      width: `${reloadProgress}%`,
                    }} />
                  </div>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>This may take up to 30 seconds</span>
                </div>
              </div>
            ) : (
              <>
                <div style={SPINNER_STYLE} />
                {t("chat.connectingGateway")}
              </>
            )}
          </div>
        )}

        {status === 'error' && !reloadingSkill && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12, color: 'rgba(255,255,255,0.5)', fontSize: 13, textAlign: 'center', padding: 20 }}>
            <span style={{ fontSize: 28 }}>⚠️</span>
            <span>{errorMsg || t("chat.connectionFailed")}</span>
            <button
              onClick={() => { retryCountRef.current = 0; connect() }}
              style={{
                background: 'rgba(249,115,22,0.2)', border: '1px solid rgba(249,115,22,0.3)',
                color: '#f97316', borderRadius: 8, padding: '6px 16px', cursor: 'pointer',
                fontSize: 13, fontWeight: 500,
              }}
            >{t("chat.retry")}</button>
          </div>
        )}

        {status === 'connected' && !reloadingSkill && messages.length === 0 && !streaming && !sending && !isBootstrappingHistory && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>
            <img src="/clawbox-crab.png" alt="" style={{ width: 48, height: 48, objectFit: 'contain', opacity: 0.4 }} />
            <span>{t("chat.saySomething")}</span>
          </div>
        )}

        {!reloadingSkill && messages.map((msg, i) => {
          const isSuccess = msg.variant === 'success';
          const systemBg = isSuccess ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';
          const systemColor = isSuccess ? '#22c55e' : '#ef4444';
          return (
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
                    ? systemBg
                    : 'rgba(255,255,255,0.06)',
                color: msg.role === 'user'
                  ? '#fff'
                  : msg.role === 'system'
                    ? systemColor
                    : 'rgba(255,255,255,0.85)',
                fontSize: 13.5,
                lineHeight: 1.45,
                wordBreak: 'break-word',
              }}>
                {msg.role === 'user' ? msg.text : renderText(msg.text)}
              </div>
            </div>
          );
        })}

        {/* Streaming message */}
        {!reloadingSkill && streaming && (
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

        {/* Typing indicator while bootstrapping or generating but no stream yet */}
        {(sending || isBootstrappingHistory) && !streaming && (
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

      {/* Attachment preview */}
      {attachments.length > 0 && (
        <div style={{ padding: '6px 14px 0', display: 'flex', gap: 6, flexWrap: 'wrap', background: 'rgba(0,0,0,0.2)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {attachments.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 8, background: 'rgba(249,115,22,0.15)', fontSize: 11, color: '#f97316' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{a.type.startsWith('image/') ? 'image' : 'attach_file'}</span>
              <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              <button onClick={() => removeAttachment(i)} style={{ background: 'none', border: 'none', color: '#f97316', cursor: 'pointer', padding: 0, display: 'flex' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.txt,.csv,.json,.md,.py,.js,.ts,.html,.css" style={{ display: 'none' }} onChange={handleFileSelect} />

      {/* Input area */}
      <div style={{
        padding: '10px 14px 12px',
        borderTop: attachments.length > 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.2)',
        display: 'flex', gap: 8, alignItems: 'flex-end',
      }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={status !== 'connected'}
          title="Attach file"
          style={{
            width: 36, height: 36, borderRadius: 10, border: 'none',
            background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)',
            cursor: status === 'connected' ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => { if (status === 'connected') { e.currentTarget.style.background = 'rgba(249,115,22,0.15)'; e.currentTarget.style.color = '#f97316' } }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 20 }}>attach_file</span>
        </button>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            status !== 'connected'
              ? t("chat.connectingPlaceholder")
              : greetingPending
                ? t("chat.greetingPlaceholder")
                : t("chat.messagePlaceholder")
          }
          disabled={status !== 'connected' || greetingPending}
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
            disabled={(!input.trim() && attachments.length === 0) || status !== 'connected'}
            title={t("chat.send")}
            style={{
              width: 36, height: 36, borderRadius: 10, border: 'none',
              background: (input.trim() || attachments.length > 0) ? 'linear-gradient(135deg, #f97316, #ea580c)' : 'rgba(255,255,255,0.06)',
              color: (input.trim() || attachments.length > 0) ? '#fff' : 'rgba(255,255,255,0.2)',
              cursor: (input.trim() || attachments.length > 0) ? 'pointer' : 'default',
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

      {/* Left-edge resize for panel mode */}
      {!mobile && panelMode && (
        <div className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-orange-500/30 transition-colors" onMouseDown={handlePanelResizeStart} onTouchStart={handlePanelResizeStart} />
      )}

      {/* Resize edges — desktop only, not in panel mode */}
      {!mobile && !panelMode && <>
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
