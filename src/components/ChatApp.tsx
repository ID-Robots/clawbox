'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { buildDeviceConnectParams } from '@/lib/gateway-device-identity'
import * as kv from '@/lib/client-kv'
import { describeChatFailure } from '@/lib/chat-error-text'
import { useClawboxLogin } from '@/lib/use-clawbox-login'
import { PORTAL_LOGIN_URL } from '@/lib/max-subscription'
import {
  type ChatMessage,
  uuid,
} from '@/lib/chat-history-cache'
import { scrollToBottomAfterLayout } from '@/lib/scroll'

import { renderText, audioLabel } from '@/lib/chat-markdown'
import SpokenReplyPlayer from '@/components/SpokenReplyPlayer'
import { extractImageFilesFromClipboard } from '@/lib/clipboard'
import { useT } from '@/lib/i18n'
import { useChatToolCalls, ToolCallPills } from '@/lib/chat-tool-events'
import { prettifyAssistantText, isSentinel, isInterSessionEnvelope } from '@/lib/chat-sentinels'
// The card and the viewer come from the mascot chat's own modules: this surface
// rendered `EMAIL:<uid>` as text because only one of the two chats had learned
// to lift the directive out, and sharing the pieces is what stops them drifting
// apart again.
import { splitEmailRefs, streamingEmailRefsText, dropUnfinishedDirective, parseEmailUid, CONTROL_UI_EMAIL_PARAM } from '@/lib/chat-email-refs'
import { EmailCard, EmailFullView } from '@/lib/chat-email'
// Same reason, one convention over: a generated picture and a spoken reply are
// named by a `MEDIA:` line inside the reply text rather than delivered as
// attachments (see lib/chat-media.ts), and only the mascot chat had learned to
// lift them — so this surface printed an absolute path under ~/.openclaw/media
// into the customer's transcript. TASK-698.
import {
  splitMediaDirectives,
  splitAssistantMedia,
  extractAudioAttachments,
  boundedAudio,
  mediaFileName,
  isImageMedia,
  mediaUrl,
} from '@/lib/chat-media'
// WHICH HARNESS ANSWERS, resolved the one way this product resolves it.
//
// This surface is `/app/clawbox` — the page behind "Open in new tab", and the
// one a phone lands on (src/lib/ui-events.ts). It used to fetch the gateway's
// ws-config and open an OpenClaw websocket whatever the box ran, so on the
// Hermes edition the composer sat disabled behind "Could not connect to
// gateway" for ever, while the mascot chat — which asks — worked on the same
// device seconds earlier. The fix is not a second Hermes path in here: it is the
// adapter ChatPopup already resolves, because a chat feature is written ONCE and
// both editions get it (see harness/transport.ts).
import { useHarnessAdapter } from '@/lib/harness/use-harness-adapter'
// `extractText` too, and from here rather than a private copy: this one strips
// the gateway's own `<final>`/`<thinking>` wrapper tags. The local copy did not,
// so a wrapped reply showed its tags live and lost them after a reload — the
// replayed path goes through this module's projection.
import { extractText, type GatewayLink } from '@/lib/harness/openclaw-gateway-adapter'
import {
  HarnessError,
  type HarnessAdapter,
  type HarnessStatus,
  type TurnEvent,
  type TurnResult,
} from '@/lib/harness/transport'
import { DESKTOP_TRANSCRIPT_KEY } from '@/lib/harness/transcript-key'
// Staging, its refusals and its thumbnails, from the module both chats share.
// The adapter names an attachment by its absolute path on the box, so this
// surface stages through the same edition-neutral route the mascot chat uses
// instead of holding the bytes as base64 — which is also the shape the shared
// history projection reads back (`[Attached file: …]`), so a picture sent here
// survives a reload rather than vanishing from the replayed transcript.
import {
  attachmentAcceptAttribute,
  classifyStagingFailure,
  createPreviewUrl,
  partitionAttachments,
  revokePreviews,
  type ChatAttachment,
  type StagingFailure,
} from '@/lib/chat-attachments'


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
  // Gateway is canonical for chat history; we render an empty list until
  // chat.history arrives over the WS (matches the OpenClaw Control UI).
  const [messages, setMessages] = useState<ChatMessage[]>([])
  // The uid of the message a card is showing in full, or none. Only the uid:
  // the mail is fetched from the mailbox when the owner opens a card, so none
  // of it lands in the transcript or in this state.
  //
  // Seeded from `?email=<uid>` in the INITIALISER rather than from an effect, so
  // the panel is open on the first paint instead of on a second render the
  // compiler rightly calls a cascade. Pure — it only reads the address — which
  // is what lets it run here; taking the parameter back OUT of the address is a
  // side effect and stays in the effect below. Same shape as `welcomeDismissed`
  // above.
  const [openEmailUid, setOpenEmailUid] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null
    const named = new URL(window.location.href).searchParams.get(CONTROL_UI_EMAIL_PARAM)
    // The id is read by the directive's own rule rather than a second one, so a
    // link that names nothing usable opens nothing rather than asking the
    // mailbox about it.
    return named === null ? null : parseEmailUid(named)
  })
  const closeEmail = useCallback(() => setOpenEmailUid(null), [])
  const [input, setInput] = useState('')
  const [streaming, setStreamingState] = useState('')
  // The streaming buffer, mirrored in a ref, and the ONLY way it is written.
  //
  // A state updater is a pure function of the previous state and React is
  // entitled to call it twice — Strict Mode does, and so does any render it has
  // to redo. The interrupted-turn append used to happen INSIDE
  // `setStreaming(prev => …)`, so the owner's half-finished answer could land in
  // the transcript twice. The ref lets the abort path READ the buffer without an
  // updater at all, and the string-only signature makes putting an updater back
  // impossible rather than merely discouraged — and the raw setter is renamed
  // out of the way so a bare `setStreaming('')` added elsewhere in the file
  // cannot bypass the ref and leave it holding a dead run's text. TASK-703.
  const streamingRef = useRef('')
  const applyStreaming = useCallback((next: string) => {
    streamingRef.current = next
    setStreamingState(next)
  }, [])
  const [sending, setSending] = useState(false)
  const { toolCalls, applyToolEvent, clearToolCalls } = useChatToolCalls()
  const [errorMsg, setErrorMsg] = useState('')
  // Staged ON THE BOX, never held as base64 in the page — see the import note.
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<(StagingFailure & { file: string }) | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef<Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(new Map())
  const sessionKeyRef = useRef<string>('')
  const runIdRef = useRef<string | null>(null)
  // Timer for the ack-only `chat.history` refetch — see ChatPopup.tsx for
  // the deferred-reply rationale. Single-flight + cleared on unmount so
  // a burst of acked turns doesn't pile up overlapping fetches.
  const ackOnlyHistoryTimerRef = useRef<number | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const connectedOnceRef = useRef(false)
  // Sends queued while status is 'connecting'. Drained by a useEffect when
  // we transition to 'connected'. The optimistic user message is added to
  // `messages` immediately so the UI feels responsive even though the
  // gateway hasn't accepted the request yet.
  const pendingSendsRef = useRef<Array<{
    text: string
    attachments: ChatAttachment[]
    idempotencyKey: string
  }>>([])

  // Auto-scroll to bottom — see scrollToBottomAfterLayout for the rationale
  // behind the double-rAF wait.
  const scrollToBottom = useCallback(() => {
    scrollToBottomAfterLayout(messagesEndRef.current)
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, streaming, scrollToBottom])

  // `?email=<uid>` opens that message on arrival — the other end of a card on
  // the gateway's own Control UI chat (TASK-700). That page is a third `webchat`
  // surface ClawBox serves but does not build, so its card can only be a link,
  // and this is where the link lands: in the panel a card in this chat opens,
  // through the same fetch. WHICH uid is read in the state initialiser above;
  // this effect only takes the parameter back out of the address.
  //
  // Once, on mount. Left in, a reload, a Back, or any remount reopens the panel
  // the owner just closed — and the id sits in history and in anything they
  // bookmark or paste.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (url.searchParams.get(CONTROL_UI_EMAIL_PARAM) === null) return
    url.searchParams.delete(CONTROL_UI_EMAIL_PARAM)
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

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
      // 120s, not 30s: the gateway's main loop blocks for tens of seconds
      // during agent startup (core-plugin-tools / system-prompt / stream-setup
      // run synchronously). chat.send is documented as non-blocking but the
      // ack still has to traverse that loop, so the client must be patient
      // enough to outlast the worst observed stall (~81s on this device).
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id)
          reject(new Error('Request timeout'))
        }
      }, 120000)
    })
  }, [])

  // Reject everything still waiting on the socket. `connect` clears the map
  // outright; the transport's `close` has to TELL its callers, or a history read
  // or a send in flight when the link goes away never settles at all.
  const failPending = useCallback((reason: string) => {
    const waiting = [...pendingRef.current.values()]
    pendingRef.current.clear()
    for (const entry of waiting) entry.reject(new Error(reason))
  }, [])

  // ── The one transport ───────────────────────────────────────────────────
  //
  // The same seam the mascot chat uses: the socket lifecycle — handshake, retry,
  // event stream — stays in this component and reaches the adapter through
  // `GatewayLink`, so the RPC vocabulary is shared while the event handling below
  // is untouched. `connect` is defined further down and re-created when its own
  // inputs change, so the link reaches it through a ref.
  const connectRef = useRef<() => Promise<void> | void>(() => {})
  const statusListenersRef = useRef(new Set<(s: HarnessStatus, detail?: string) => void>())
  const gatewayLink = useMemo<GatewayLink>(() => ({
    request: (method, params) => wsRequest(method, params),
    sessionKey: () => sessionKeyRef.current,
    open: async () => { await connectRef.current() },
    close: () => { wsRef.current?.close(); wsRef.current = null; failPending('Not connected') },
    onStatus: (cb) => {
      statusListenersRef.current.add(cb)
      return () => { statusListenersRef.current.delete(cb) }
    },
  }), [wsRequest, failPending])
  // This surface carries no provider, model or reasoning picker, so a turn goes
  // out on the box's own configured pairing and the adapter's mid-switch guard —
  // the only reader of the first two fields — is unreachable from here. The
  // session key is the one that matters: it names the transcript on the box.
  const hermesContext = useCallback(() => ({
    devicePairing: { provider: '', model: '' },
    modelsReady: true,
    sessionKey: sessionKeyRef.current,
  }), [])
  // Stable by construction — see `HarnessWiring`. Everything that moves is read
  // through a ref inside these callbacks, so the object itself never changes and
  // the adapter keeps one identity for the life of the resolved harness.
  const harnessWiring = useMemo(
    () => ({ gateway: gatewayLink, hermesContext }),
    [gatewayLink, hermesContext],
  )
  const { adapter, capabilities: caps, resolved: harnessLoaded } = useHarnessAdapter(harnessWiring)
  // Read by the callbacks that must stay stable: `connect` and `loadHistory` are
  // closed over by long-lived socket handlers, so neither may capture whichever
  // adapter was current on the first render — before the box had answered.
  const adapterRef = useRef<HarnessAdapter>(adapter)
  useEffect(() => { adapterRef.current = adapter }, [adapter])
  // The gateway's status is produced by the socket handlers below; publish it so
  // the adapter's subscribers see one stream whichever harness is running.
  useEffect(() => {
    for (const cb of statusListenersRef.current) cb(status, errorMsg || undefined)
  }, [status, errorMsg])
  // …and take it back, which is how a harness with no socket reports itself
  // connected without this component claiming a wire that does not exist. For
  // the gateway this is the value it has just published, so React bails out of
  // the set and nothing re-renders.
  useEffect(() => adapter.onStatus((next) => {
    setStatus(next === 'idle' ? 'connecting' : next)
  }), [adapter])
  // Whether this box has a socket to open at all, through a ref because
  // `connect` is memoised with no dependencies and is reached from the Retry
  // button too: a value captured in its closure would let a Hermes box open a
  // gateway socket from a later render.
  const hasLiveConnectionRef = useRef(true)
  useEffect(() => { hasLiveConnectionRef.current = caps.hasLiveConnection }, [caps])

  /**
   * One place where a finished reply becomes a bubble, whatever produced it.
   *
   * Two things now do: the gateway's `final` event, and an adapter turn that
   * resolves with the whole answer because its harness has no event stream. The
   * spoken half of a reply arrives as a SECOND message repeating the text it
   * belongs to, so the fold lives here rather than on one of the two paths —
   * written twice it would show the answer once silently and once playable on
   * whichever path was missed, which is the divergence this whole change is
   * about.
   */
  const appendAssistantReply = useCallback((
    text: string,
    images: string[],
    audio: string[],
    // What the harness reported BESIDE the answer. Kept on the message rather
    // than dropped: the transcript this surface replays carries all four, so
    // discarding them here would make the live bubble and the reloaded one
    // disagree the moment anything renders them.
    extra?: Pick<ChatMessage, 'reasoning' | 'toolCalls' | 'model' | 'provider'>,
  ) => {
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (text.length > 0 && audio.length > 0 && images.length === 0
          && last && last.role === 'assistant' && last.text === text) {
        const merged = boundedAudio(last.audio ?? [], audio)
        if (last.audio?.length === merged.length
            && last.audio.every((src, i) => src === merged[i])) return prev
        return [...prev.slice(0, -1), { ...last, audio: merged }]
      }
      return [...prev, {
        role: 'assistant' as const,
        text: prettifyAssistantText(text),
        timestamp: Date.now(),
        images,
        audio,
        ...extra,
      }]
    })
  }, [])

  const loadHistory = useCallback(async () => {
    const transport = adapterRef.current
    // A harness with no replay has nothing to read, and asking would be a call
    // the adapter's own contract answers `unsupported`.
    if (!transport.capabilities.canListHistory) return
    try {
      // Through the ADAPTER, which is what makes one call serve both editions:
      // the gateway's `chat.history` plus the durable spoken-reply backstop, or
      // Hermes' own transcript store. It runs the SHARED projection this surface
      // used to call directly — dropping sentinels and inter-session envelopes,
      // lifting `MEDIA:` into images and audio, splitting the composer's
      // `[Attached file: …]` lines back into pictures and names, folding the
      // spoken reply into the bubble it belongs to — and it also folds
      // `/setup-api/chat/spoken-history`, which this page passed `null` for and
      // therefore lost on any gateway that omits the supplement.
      const { messages: chatMsgs } = await transport.loadHistory()
      // Server is canonical for everything it knows about, but a user turn
      // typed between connect-ack and history-arrival ("optimistic local")
      // hasn't reached the server yet — preserve it by appending any prev
      // user messages whose timestamp is newer than the last server message.
      setMessages(prev => {
        if (prev.length === 0) return chatMsgs
        const lastServerTs = chatMsgs.length > 0 ? chatMsgs[chatMsgs.length - 1].timestamp : 0
        const inFlight = prev.filter(m => m.role === 'user' && m.timestamp > lastServerTs)
        return inFlight.length === 0 ? chatMsgs : [...chatMsgs, ...inFlight]
      })
    } catch (err) {
      console.error('Failed to load history:', err)
    }
    // No dependencies on purpose: the socket's hello handler closes over this
    // callback for the life of the connection, so it has to keep one identity
    // and read the adapter through the ref above.
  }, [])

  const connect = useCallback(async () => {
    // A box with no socket has nothing to open. The adapter reports such a
    // harness connected by itself; this guard is for the Retry button and the
    // mount effect, which reach `connect` directly and must never open a gateway
    // socket on an edition that runs none.
    if (!hasLiveConnectionRef.current) return
    // ALREADY OPEN IS ALREADY CONNECTED. `transport.ts` calls `connect()` "safe
    // to call repeatedly", and this link maps `open()` straight onto this
    // function — which tears the socket down and re-handshakes. The mount effect
    // used to carry this test itself (`readyState !== OPEN`); now that the
    // adapter effect re-runs whenever the capabilities object changes — a
    // provider linked in Settings, a pending fact the box answers a minute later
    // — without it a healthy socket carrying a streaming reply would be closed
    // under the run. Safe for the Retry button, which only renders in the error
    // state, where there is no open socket. Same guard, same place, as ChatPopup.
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    // REJECTED, not dropped. A bare `clear()` leaves every in-flight RPC pending
    // for ever — the 120 s timeout above only fires for an id still IN the map —
    // so a `chat.send` ack in flight when a reconnect starts never settles, and
    // `dispatchSend` never reaches `setSending(false)`: the composer keeps the
    // Stop button for the life of the page with nothing said. ChatPopup rejects
    // here for exactly that reason.
    failPending('Connection restarted')
    setStatus('connecting')
    setErrorMsg('')
    connectedOnceRef.current = false

    let token: string
    let wsUrl: string
    try {
      // `no-store`: the gateway token is regenerated on a per-device reseed, a
      // settings change and an update, and a cached answer replays a stale one
      // on every reconnect — which the gateway refuses for ever. Newly reachable
      // now that the adapter effect can ask for a connect as well as mount.
      const res = await fetch('/setup-api/gateway/ws-config', { cache: 'no-store' })
      const config = await res.json()
      token = config.token
      wsUrl = config.wsUrl
    } catch {
      setStatus('error')
      setErrorMsg('Failed to get gateway config')
      return
    }

    let connectSent = false
    let ws: WebSocket

    const sendConnect = (challenge?: Record<string, unknown>) => {
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
      // OpenClaw 2 device identity — see gateway-device-identity.ts. Null
      // against an older gateway (no challenge ts) and simply omitted then.
      const clientPlatform = navigator.platform || 'web'
      const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing']
      const device = buildDeviceConnectParams({
        nonce: challenge?.nonce,
        ts: challenge?.ts,
        token,
        role: 'operator',
        scopes,
        clientId: 'openclaw-control-ui',
        clientMode: 'webchat',
        platform: clientPlatform,
      })
      ws.send(JSON.stringify({
        type: 'req', id, method: 'connect',
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: 'openclaw-control-ui',
            version: 'clawbox-chat',
            platform: clientPlatform,
            mode: 'webchat',
            instanceId: uuid(),
          },
          role: 'operator',
          scopes,
          caps: ['tool-events'],
          auth: { token },
          userAgent: navigator.userAgent,
          locale: navigator.language,
          ...(device ? { device } : {}),
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
          sendConnect(data.payload as Record<string, unknown> | undefined)
          return
        }

        // Tool-call lifecycle: surface a small inline pill above the
        // streaming bubble so the user can see when the agent is invoking
        // tools (bash, file ops, etc.). Mirrors ChatPopup.
        if (eventName === 'agent') {
          const payload = data.payload as Record<string, unknown> | undefined
          if (!payload) return
          const sk = payload.sessionKey as string | undefined
          if (sk && sk !== sessionKeyRef.current) return
          if (payload.stream === 'tool') {
            applyToolEvent(payload.data as Record<string, unknown> | undefined)
          }
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
            if (text && !isInterSessionEnvelope(text, msg)) applyStreaming(text)
          } else if (state === 'final') {
            const raw = extractText(msg)
            // Split on the way INTO state, as the mascot chat does: a generated
            // picture arrives as a `MEDIA:` line inside the reply text and a
            // spoken reply as a structured attachment part (lib/chat-media.ts),
            // and storing the caption alone is what put an absolute media path
            // in the transcript. Both shapes are read; neither is guaranteed.
            const { text, images, audio: directiveAudio } = splitAssistantMedia(raw)
            const audio = boundedAudio(extractAudioAttachments(msg), directiveAudio)
            // Suppress protocol sentinels and "Sent." (delivery-mirror ack)
            // from the rendered transcript — the former are markers users
            // shouldn't see, the latter is just a server-side ack that the
            // real reply will follow via the chat.history refetch scheduled
            // below. `isSentinel` covers NO_REPLY plus any other protocol
            // sentinel `chat-sentinels.ts` catalogues — same shared check
            // ChatPopup uses, so the two components can't drift on which
            // finals count as ack-only.
            //
            // A picture or a clip with no caption is a real reply, not an ack:
            // asking `!text` alone would have thrown it away and refetched
            // history instead.
            const isAckOnly = (!text && images.length === 0 && audio.length === 0)
              || /^\s*Sent\.\s*$/.test(text) || isSentinel(text)
            // Same suppression as the history path, so the bubble cannot
            // appear in real time either — only the append is skipped, the
            // ack-only refetch below still runs. Asked of the ORIGINAL text: a
            // routing envelope carrying a MEDIA: line must be dropped whole,
            // not split into a picture plus its own machinery.
            //
            // Appended through the SHARED renderer, so this bubble and the one
            // an adapter turn resolves with cannot drift.
            if (!isAckOnly && !isInterSessionEnvelope(raw, msg)) {
              appendAssistantReply(text, images, audio)
            }
            applyStreaming('')
            clearToolCalls()
            runIdRef.current = null
            setSending(false)
            // Mirror the ChatPopup fallback: OpenClaw can ack a turn with
            // "Sent." while the real reply is generated server-side a
            // moment later (delivery-mirror persona pipeline). That reply
            // is persisted but never streamed via WS — re-pull chat.history
            // a few seconds later so the deferred message surfaces without
            // a page refresh. Only fires on the ack-only case so normal
            // streamed replies don't pay an extra round-trip.
            if (isAckOnly) {
              if (ackOnlyHistoryTimerRef.current !== null) {
                window.clearTimeout(ackOnlyHistoryTimerRef.current)
              }
              ackOnlyHistoryTimerRef.current = window.setTimeout(() => {
                ackOnlyHistoryTimerRef.current = null
                void loadHistory()
              }, 3_000)
            }
          } else if (state === 'aborted' || state === 'error') {
            // Read, clear, THEN append — all three outside any updater. This
            // append used to sit inside `setStreaming(prev => …)`, where React
            // may run it twice and the owner's interrupted answer lands in the
            // transcript twice with it.
            //
            // Stop landing between `EMAIL` and its digits used to store the
            // half-written line, and the render keeps an unusable directive
            // as text — so a bare `EMAIL:` stayed in the transcript for good.
            // The bubble was already hiding it and it can never become a
            // card, so what is stored is what the owner was looking at.
            const kept = dropUnfinishedDirective(streamingRef.current)
            applyStreaming('')
            // The same lift the final path does, because the directives are
            // taken out on the way into state now: an interrupted turn that
            // already received a complete `MEDIA:` line keeps its picture, and
            // one interrupted mid-path stores no path — which is what the
            // bubble was showing, since the streaming render strips the line
            // whatever its payload.
            const keptMedia = splitAssistantMedia(kept)
            // `streamingEmailRefsText` first: `SENTINEL_RE` anchors the whole
            // string, so a Stop landing between `NO_REPLY` and an `EMAIL:` line
            // the reply had begun leaves a value that no longer looks like a
            // sentinel and would be appended verbatim. The same question the
            // bubble asks, and the same one the popup's two branches now ask.
            if ((keptMedia.text.trim() || keptMedia.images.length > 0 || keptMedia.audio.length > 0)
                && !isSentinel(streamingEmailRefsText(keptMedia.text))) {
              setMessages(msgs => [...msgs, {
                role: 'assistant',
                text: prettifyAssistantText(keptMedia.text),
                timestamp: Date.now(),
                images: keptMedia.images,
                audio: boundedAudio(keptMedia.audio),
              }])
            }
            clearToolCalls()
            runIdRef.current = null
            setSending(false)
            if (state === 'error') {
              // Never render the gateway's own error text. It is written for
              // an operator reading a log and has carried an absolute device
              // path, a session UUID and a `openclaw logs --follow` line into
              // the customer's transcript (TASK-440).
              setMessages(prev => [...prev, { role: 'system', text: describeChatFailure(payload.errorMessage), timestamp: Date.now() }])
            }
          }
        }
      }
    }

    const onClose = () => {
      wsRef.current = null
      // Same reason as the reconnect path: a request still waiting on a socket
      // that has gone away has to be told, or it never settles.
      failPending('Not connected')
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

  // Handed to the transport so `GatewayLink.open()` reaches the CURRENT connect.
  useEffect(() => { connectRef.current = connect }, [connect])

  /**
   * Stage the picked or pasted files ON THE BOX and keep only what a turn can
   * name.
   *
   * Deliberately not the Files API: the turn puts the returned absolute path in
   * the message, and each harness only reads media from its own allowlist of
   * roots — `/setup-api/chat/attachments` writes under the one both of them
   * read (harness/media-root.ts). The refusals, the classification and the
   * thumbnails are the mascot chat's own module, so the two surfaces cannot
   * disagree about what this box will accept.
   */
  const uploadGenerationRef = useRef(0)
  const stageFiles = useCallback((files: File[]) => {
    if (files.length === 0) return
    // A new attempt clears the previous complaint: a stale error above a strip
    // that now holds a good attachment reads as "this one failed too".
    setAttachmentError(null)
    // What this box can actually pass to the model, decided BEFORE the upload.
    // A document staged on a harness with no way to show it to the model would
    // sit on the customer's disk and be named in a turn nobody could read it
    // from.
    const { accepted, refused } = partitionAttachments(files, caps)
    if (refused.length > 0) {
      setAttachmentError({ reason: 'imagesOnly', detail: null, file: refused[0].name || '' })
    }
    if (accepted.length === 0) return
    const stampBase = Date.now()
    // Which composer these uploads belong to. Unmounting bumps it, so a request
    // that resolves afterwards releases its thumbnail and drops instead of
    // pushing state into a tree that is gone.
    const generation = uploadGenerationRef.current
    const isCurrent = () => uploadGenerationRef.current === generation
    void Promise.all(accepted.map(async (file, idx) => {
      // Clipboard images arrive as the generic "image.png"; stamp them so a
      // burst of pastes in the same millisecond cannot collide on disk.
      const isGeneric = !file.name || file.name === 'image.png' || file.name === 'image.jpeg'
      const filename = isGeneric
        ? `paste-${stampBase}-${idx}.${file.type.split('/')[1] || 'png'}`
        : file.name
      const formData = new FormData()
      formData.append('file', file, filename)
      // Minted before the request so the thumbnail is ready the moment the box
      // answers, and released on every path that does not hand it to the strip —
      // an object URL created and dropped pins the whole Blob for the life of
      // the document.
      const previewUrl = createPreviewUrl(file)
      const fail = (status: number | undefined, payload: unknown) => {
        revokePreviews([{ previewUrl }])
        if (!isCurrent()) return
        setAttachmentError({ ...classifyStagingFailure(status, payload), file: filename })
      }
      try {
        const res = await fetch('/setup-api/chat/attachments', { method: 'POST', body: formData })
        const json = await res.json().catch(() => ({} as { name?: string; path?: string }))
        if (!res.ok) {
          fail(res.status, json)
          return
        }
        // Only a non-empty string is a path. The route is ours, but a 200
        // carrying `{ path: {} }` would otherwise reach the strip and send
        // `[object Object]` as the file the agent should open.
        const absPath = typeof json.path === 'string' ? json.path.trim() : ''
        if (!absPath) {
          // A 200 with no path is the box misbehaving, not the file: staging
          // "succeeded" and produced nothing for the agent to open.
          fail(500, json)
          return
        }
        if (!isCurrent()) {
          // Landed after this composer went away: the staged copy stays on the
          // box, but nothing is resurrected and no Blob is left pinned.
          revokePreviews([{ previewUrl }])
          return
        }
        const name = typeof json.name === 'string' && json.name.trim() ? json.name : filename
        setPendingAttachments(prev => [...prev, { name, path: absPath, type: file.type, previewUrl }])
      } catch (err) {
        console.error('[chat] upload failed:', err)
        // No status: the request never completed, which is the box's problem
        // rather than the file's. The thrown error itself is never shown — it
        // can carry the request URL.
        fail(undefined, null)
      }
    }))
  }, [caps])

  // <input type=file> change handler.
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    stageFiles(Array.from(files))
    e.target.value = ''
  }, [stageFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // The SAME gate the attach button carries, and it has to be here too: with
    // only the button hidden, Ctrl+V was still a way in — and a box that cannot
    // pass the picture to the model would draw the screenshot into the
    // customer's own bubble and then answer without ever having looked at it.
    //
    // Only the IMAGE is refused; nothing is preventDefault-ed on that path, so a
    // paste that also carries text still pastes its text as usual.
    if (!caps.canAttachImages) return
    const imageFiles = extractImageFilesFromClipboard(e)
    if (imageFiles.length === 0) return
    e.preventDefault()
    stageFiles(imageFiles)
  }, [caps.canAttachImages, stageFiles])

  const removePendingAttachment = useCallback((index: number) => {
    setPendingAttachments(prev => {
      const gone = prev[index]
      if (gone) revokePreviews([gone])
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  // Release every thumbnail when the surface goes away: an object URL pins the
  // whole Blob until it is revoked, and on an 8 GB box that is the budget. The
  // ref mirrors the state because an unmount effect with `[]` deps closes over
  // the first render's empty array.
  const pendingAttachmentsRef = useRef<ChatAttachment[]>([])
  useEffect(() => { pendingAttachmentsRef.current = pendingAttachments }, [pendingAttachments])
  useEffect(() => () => {
    // Bumped as well as revoked: an upload still in flight is not in the ref
    // yet, so revoking the list alone would let the late completion keep its
    // object URL and hand it to a setState on a component that is gone.
    uploadGenerationRef.current += 1
    revokePreviews(pendingAttachmentsRef.current)
  }, [])

  /**
   * Send one turn, and put whatever comes back on screen.
   *
   * Through the ADAPTER rather than `wsRequest('chat.send', …)`, which is the
   * whole point of this change: the gateway ACKNOWLEDGES a turn and answers it
   * on its event stream, while a harness with no socket resolves here with the
   * finished reply. `acknowledgedOnly` says which, so neither edition has to be
   * named.
   */
  const dispatchSend = useCallback(async (
    text: string,
    attachments: readonly ChatAttachment[],
    idempotencyKey: string,
  ) => {
    const transport = adapterRef.current
    let result: TurnResult
    try {
      result = await transport.sendTurn({
        // The owner's words, verbatim. The adapter owns the empty-text case —
        // the gateway's is "(file attached)" — and an English sentence invented
        // here would be stored as the owner's own message on both editions, read
        // back into their bubble after a refresh, and asked about a PDF as
        // though it were a picture.
        text,
        attachments,
        idempotencyKey,
      }, (event: TurnEvent) => {
        // A run that has already ended — Stop, or a late frame after the final —
        // must not reopen the caret, so a delta only paints while this run is
        // still the live one.
        if (event.kind === 'delta' && runIdRef.current === idempotencyKey) {
          applyStreaming(event.text)
        } else if (event.kind === 'tool' && runIdRef.current === idempotencyKey) {
          // The same pills the gateway's own `agent` events already feed.
          // `applyToolEvent` reads `toolCallId`, so the transport's stable `id`
          // is handed over under that name.
          applyToolEvent({ toolCallId: event.id, name: event.name, phase: event.phase })
        }
      })
    } catch (err) {
      // A Stop is not a failure and must never become a red bubble. Never render
      // a harness's own error text either: it is written for an operator reading
      // a log and has carried an absolute device path and a session UUID into
      // the customer's transcript (TASK-440).
      const failure = err instanceof HarnessError && err.code === 'aborted'
        ? undefined
        : describeChatFailure(err instanceof Error ? err.message : undefined)
      // What the box managed to write is the OWNER'S. Read, clear, THEN append,
      // all outside any updater, and before the failure line so the answer stays
      // above it. Only a harness that streams on this promise ever arrives here
      // with a non-empty buffer — on the gateway the socket's own terminal event
      // owns it — which is how the same Stop used to keep the partial reply on
      // one edition and lose it on the other (TASK-721).
      const kept = dropUnfinishedDirective(streamingRef.current)
      applyStreaming('')
      if (kept.trim() && !isSentinel(streamingEmailRefsText(kept))) {
        setMessages(prev => [...prev, { role: 'assistant', text: kept, timestamp: Date.now() }])
      }
      clearToolCalls()
      setSending(false)
      runIdRef.current = null
      if (!failure) return
      setMessages(prev => [...prev, { role: 'system', text: failure, timestamp: Date.now() }])
      return
    }
    // The gateway answers on its event stream; that handler paints the reply and
    // ends the run, exactly as it always did.
    if (result.acknowledgedOnly) return
    const images = [...(result.media ?? [])]
    const audio = boundedAudio([...(result.audio ?? [])])
    // A protocol sentinel is machinery, never an answer — the same check the
    // gateway's `final` branch makes on the way into state. Its OTHER
    // suppression, a bare "Sent.", is deliberately NOT made here: that is the
    // gateway's delivery-mirror ack, and on a harness that answers on this
    // promise the same word is just as likely to be the agent telling the owner
    // their mail went out.
    if (!isSentinel(result.text)) {
      // A reply that is nothing BUT a picture or a clip is still a real answer;
      // one that is nothing at all says so, in the mascot chat's own words.
      const hasMedia = images.length > 0 || audio.length > 0
      appendAssistantReply(result.text || (hasMedia ? '' : '(no response)'), images, audio, {
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.toolCalls?.length ? { toolCalls: [...result.toolCalls] } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.provider ? { provider: result.provider } : {}),
      })
    }
    applyStreaming('')
    clearToolCalls()
    setSending(false)
    runIdRef.current = null
  }, [applyStreaming, applyToolEvent, clearToolCalls, appendAssistantReply])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    const staged = [...pendingAttachments]
    if ((!text && staged.length === 0) || sending) return

    // Pictures render in the bubble; everything else keeps a 📎 line, because a
    // document has nothing to show and a caption alone would refer to nothing.
    //
    // Tested on the STAGED PATH rather than on the browser's MIME type, so the
    // bubble drawn now and the one rebuilt from history after a refresh make the
    // same decision — and through `mediaUrl`, the same session-gated ref the
    // shared projection produces, so the picture survives the reload that an
    // object URL would not.
    const images = staged.filter(a => isImageMedia(a.path)).map(a => mediaUrl(a.path))
    const fileNames = staged
      .filter(a => !isImageMedia(a.path))
      .map(a => `📎 ${a.name}`)
      .join('\n')
    // No caption invented for a picture-only turn: the bubble draws the picture,
    // which is the message, and the mascot chat says nothing there either.
    const displayText = [fileNames, text].filter(Boolean).join('\n')
    setInput('')
    setPendingAttachments([])
    setAttachmentError(null)
    // Safe here and not later: a thumbnail is only ever rendered by the composer
    // strip, which this send has just emptied — the bubble above draws the box's
    // own media ref.
    revokePreviews(staged)
    setMessages(prev => [...prev, {
      role: 'user',
      text: displayText,
      timestamp: Date.now(),
      images,
    }])
    setSending(true)
    applyStreaming('')

    const idempotencyKey = uuid()
    runIdRef.current = idempotencyKey

    // Queue ONLY where there is a connection that can be down. The user's
    // message is already in `messages`, so the chat looks responsive while the
    // handshake finishes. A harness with no socket is never "not connected yet",
    // so parking its turns here would hold them for ever waiting on a status
    // change that has already happened.
    if (caps.hasLiveConnection && status !== 'connected') {
      pendingSendsRef.current.push({ text, attachments: staged, idempotencyKey })
      return
    }

    await dispatchSend(text, staged, idempotencyKey)
  }, [input, sending, pendingAttachments, caps.hasLiveConnection, status, dispatchSend, applyStreaming])

  // Drain queued sends on connect; flush them as system errors on error.
  // Sequential dispatch preserves user-typed order — chat.send acks fast
  // (per OpenClaw docs the response streams asynchronously), but firing
  // in parallel risks the gateway processing them out of order or
  // collapsing distinct turns.
  useEffect(() => {
    if (pendingSendsRef.current.length === 0) return
    if (status === 'connected') {
      const queue = pendingSendsRef.current
      pendingSendsRef.current = []
      void (async () => {
        for (const q of queue) {
          await dispatchSend(q.text, q.attachments, q.idempotencyKey)
        }
      })()
    } else if (status === 'error') {
      const dropped = pendingSendsRef.current.length
      pendingSendsRef.current = []
      setMessages(msgs => [...msgs, {
        role: 'system',
        text: `Could not deliver ${dropped} queued message${dropped === 1 ? '' : 's'} — gateway is unreachable.`,
        timestamp: Date.now(),
      }])
    }
  }, [status, dispatchSend])

  const abort = useCallback(async () => {
    // Best effort, as it has always been: a Stop that cannot be delivered leaves
    // the run to finish on its own. Through the adapter so Stop reaches the turn
    // whichever harness is running it — on the gateway a `chat.abort`, on a
    // harness that answers on a promise the fetch that carries it.
    if (!adapterRef.current.capabilities.canAbortTurn) return
    await adapterRef.current.abortTurn()
  }, [])

  // Bring the transport up, GATED ON THE HARNESS RESOLVING. Connecting before
  // that is exactly what opened a gateway socket on a box that runs no gateway.
  useEffect(() => {
    if (!harnessLoaded) return
    // No hello will name a main session on a harness with no live connection:
    // the box's own transcript store is the thread. Bound before the replay
    // below reads it, and to the SAME key the mascot chat binds, so the two
    // surfaces show one conversation the way they already do on the gateway's
    // `mainSessionKey`.
    if (!caps.hasLiveConnection) sessionKeyRef.current = DESKTOP_TRANSCRIPT_KEY
    void adapter.connect()
  }, [adapter, harnessLoaded, caps.hasLiveConnection])

  // Replay the stored conversation on a harness that has no handshake to hang it
  // on. The gateway path bootstraps its history the moment auth resolves — there
  // IS a moment there, and the socket handler owns it; a harness whose
  // `connect()` resolves immediately has none, so the only thing left that means
  // "the customer is looking at this" is this page being mounted with a harness
  // resolved. Once per resolved harness.
  const replayedRef = useRef(false)
  useEffect(() => {
    if (!harnessLoaded) return
    if (caps.hasLiveConnection || !caps.canListHistory) return
    if (replayedRef.current) return
    replayedRef.current = true
    void loadHistory()
  }, [harnessLoaded, caps.hasLiveConnection, caps.canListHistory, loadHistory])

  // Tear down on unmount, and only on unmount: `connect` is memoised with no
  // dependencies, so this is where the socket and the deferred refetch were
  // always released.
  useEffect(() => () => {
    // The adapter's own teardown — the gateway's closes the socket and rejects
    // what was waiting on it; a harness that answers on a promise aborts the turn
    // it was running. The direct close stays beside it because the socket is this
    // component's to own whatever the adapter turns out to be.
    adapterRef.current.disconnect()
    wsRef.current?.close()
    wsRef.current = null
    if (ackOnlyHistoryTimerRef.current !== null) {
      window.clearTimeout(ackOnlyHistoryTimerRef.current)
      ackOnlyHistoryTimerRef.current = null
    }
  }, [])

  // Focus input when connected
  useEffect(() => {
    if (status === 'connected') {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [status])



  // Notify parent of thinking state
  useEffect(() => { onThinkingChange?.(sending) }, [sending, onThinkingChange])

  // A picture IS a message: the bubble draws it and no caption is invented for
  // it, so the Send button has to agree or the camera button leads nowhere on the
  // one client this page documents as its own — a phone, whose soft keyboard
  // Enter often inserts a newline instead of sending. ChatPopup's predicate.
  const sendable = input.trim().length > 0 || pendingAttachments.length > 0

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
          <img src="/clawbox-crab.png" alt="" style={{ width: 14, height: 14, objectFit: 'contain', opacity: 0.7 }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.7)', flex: 1 }}>{t("chat.title")}</span>
          {/* A connection indicator is honest only where there IS a connection
              that can be down. On a harness with no socket the adapter reports
              itself connected so the composer works, and a green dot beside that
              would be describing a wire that does not exist. */}
          {caps.hasLiveConnection && status === 'connecting' && (
            <div style={{
              width: 10, height: 10,
              border: '2px solid rgba(249,115,22,0.3)',
              borderTopColor: '#f97316',
              borderRadius: '50%',
              animation: 'chatapp-spin 0.8s linear infinite',
            }} />
          )}
          {caps.hasLiveConnection && status === 'connected' && (
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.5)' }} />
          )}
          {caps.hasLiveConnection && status === 'error' && (
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

        {status === 'connecting' && messages.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12, color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
            <div style={{ width: 24, height: 24, border: '2px solid rgba(249,115,22,0.2)', borderTopColor: '#f97316', borderRadius: '50%', animation: 'chatapp-spin 0.8s linear infinite' }} />
            {/* The label names the gateway, so only a box that runs one gets it.
                Elsewhere the wait is the harness resolving and the spinner says
                that much without claiming a component this SKU does not have. */}
            {caps.hasLiveConnection && t("chat.connectingGateway")}
          </div>
        )}

        {caps.hasLiveConnection && status === 'error' && (
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
            <img src="/clawbox-crab.png" alt="" style={{ width: 25, height: 25, objectFit: 'contain', opacity: 0.4 }} />
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

        {messages.map((msg, i) => {
          // `MEDIA:` is lifted on the way INTO state — by the shared history
          // projection and by the live `final` handler — so what is stored
          // already carries its pictures and clips and the bubble just draws
          // them. Only the mail directives are derived here, because a card is
          // fetched when the owner opens it and must not be built from a turn
          // that is still streaming.
          const emailRefs = msg.role === 'assistant' ? splitEmailRefs(msg.text) : null
          const bodyText = emailRefs ? emailRefs.text : msg.text
          const images = msg.images ?? []
          const audio = msg.audio ?? []
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
                  ? 'rgba(239,68,68,0.15)'
                  : 'rgba(255,255,255,0.06)',
              color: msg.role === 'user' ? '#fff' : msg.role === 'system' ? '#ef4444' : 'rgba(255,255,255,0.85)',
              fontSize: 13.5,
              lineHeight: 1.45,
              wordBreak: 'break-word',
            }}>
              {images.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: bodyText ? 6 : 0 }}>
                  {images.map((src, j) => (
                    // A picture the agent drew IS the message, so it gets a
                    // real alt and is contained rather than cropped; one the
                    // customer sent is announced as theirs, because an
                    // accessible name is read out verbatim. `contain` applies
                    // to both — a sent photo is letterboxed rather than cropped
                    // here, matching the mascot chat.
                    <img
                      key={j}
                      src={src}
                      alt={msg.role === 'user' ? t("chat.sentImage") : t("chat.generatedImage")}
                      style={{ maxWidth: 180, maxHeight: 140, borderRadius: 8, objectFit: 'contain' }}
                    />
                  ))}
                </div>
              )}
              {msg.role === 'user' ? msg.text : renderText(bodyText, t("chat.table"))}
              {audio.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: bodyText ? 8 : 0 }}>
                  {/* The same player the mascot chat draws, from the same
                      component: two surfaces showing the same spoken reply must
                      not offer two different controls for it. Keyed by the URL
                      — the harness names every file with a uuid, so
                      re-rendering a transcript cannot hand one player
                      another's audio. */}
                  {audio.map(src => (
                    <SpokenReplyPlayer
                      key={src}
                      src={src}
                      // `bodyText`, never `msg.text`: the stored text still
                      // carries the directives, and a screen reader would read
                      // the absolute media path and the mail ids out loud.
                      label={audioLabel(bodyText, t("chat.audioReply"))}
                      downloadName={mediaFileName(src)}
                    />
                  ))}
                </div>
              )}
              {emailRefs && emailRefs.uids.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: bodyText ? 8 : 0 }}>
                  {emailRefs.uids.map(uid => (
                    <EmailCard key={uid} uid={uid} onOpen={setOpenEmailUid} t={t} />
                  ))}
                </div>
              )}
            </div>
          </div>
          )
        })}

        <ToolCallPills toolCalls={toolCalls} runningLabel={t("chat.running")} />

        {streaming && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              maxWidth: '85%', padding: '8px 14px',
              borderRadius: '14px 14px 14px 4px',
              background: 'rgba(255,255,255,0.06)',
              color: 'rgba(255,255,255,0.85)',
              fontSize: 13.5, lineHeight: 1.45, wordBreak: 'break-word',
            }}>
              {/* Stripped at RENDER, not on the way into state: the directive
                  lands in the last chunk before the turn finalises, so without
                  this the bare id sits in the bubble for that moment, and an
                  abort keeps the raw buffer it was holding — so the turn it
                  leaves behind can still become cards and pictures. No cards
                  and no pictures while streaming: half a directive is not an id
                  or a path yet.

                  A payload-less `MEDIA:` is deliberately kept as text by
                  `splitMediaDirectives` — a line that names nothing is not
                  swallowed — so a Stop landing exactly on the colon leaves that
                  token in the bubble and in the stored turn. Shown and stored
                  still agree, which is the property that matters; there is no
                  `dropUnfinishedDirective` equivalent for media, and the
                  mascot chat accepts the same token. */}
              {renderText(streamingEmailRefsText(splitMediaDirectives(streaming).text), t("chat.table"))}
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

      {/* Hidden file inputs. The filter follows the capability, so a box that can
          look at pictures but not documents never offers one. */}
      <input ref={fileInputRef} type="file" accept={attachmentAcceptAttribute(caps)} multiple style={{ display: 'none' }} onChange={handleFileSelect} />
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFileSelect} />

      {/* What could not be staged, and why — the route's own reason, in the
          desktop's language. Above the strip, because it is about the file the
          customer just picked. */}
      {attachmentError && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: '8px 14px 0',
            background: 'rgba(0,0,0,0.2)',
            color: '#f59e0b', fontSize: 12, lineHeight: 1.4, flexShrink: 0,
          }}
        >
          {t(`chat.attachment.error.${attachmentError.reason}`, { name: attachmentError.file })}
          {attachmentError.detail ? ` ${attachmentError.detail}` : ''}
        </div>
      )}

      {/* Staged attachments */}
      {pendingAttachments.length > 0 && (
        <div style={{
          padding: '8px 14px 0',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(0,0,0,0.2)',
          display: 'flex', gap: 6, overflowX: 'auto', flexShrink: 0,
        }}>
          {pendingAttachments.map((item, i) => (
            <div key={item.path} style={{ position: 'relative', flexShrink: 0 }}>
              {/* A picture shows itself; anything else shows its name, because a
                  document has no thumbnail and an empty tile says nothing about
                  what is attached. */}
              {item.previewUrl ? (
                // Named, not `alt=""`: a thumbnail is the only thing on screen
                // that says WHICH file is attached, and a decorative image tells
                // a screen-reader user nothing at all.
                <img src={item.previewUrl} alt={t('chat.attachment.previewAlt', { name: item.name })} style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.1)' }} />
              ) : (
                <div style={{
                  width: 56, height: 56, borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(255,255,255,0.04)',
                  color: 'rgba(255,255,255,0.55)', fontSize: 9, lineHeight: 1.2,
                  padding: 4, overflow: 'hidden', wordBreak: 'break-all',
                }}>{item.name}</div>
              )}
              <button
                onClick={() => removePendingAttachment(i)}
                aria-label={t('chat.attachment.remove', { name: item.name })}
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
        borderTop: pendingAttachments.length > 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.2)',
        display: 'flex', gap: 8, alignItems: 'flex-end',
      }}>
        {/* Attachment buttons — offered only where a staged file can actually
            reach the model. A chip on screen says "this went with your message",
            and on a box that cannot carry it that chip is a lie the customer
            only discovers from an answer that never looked at the picture. */}
        {caps.canAttachImages && (
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
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
            disabled={!sendable || status !== 'connected'}
            title={t("chat.send")}
            style={{
              width: 36, height: 36, borderRadius: 10, border: 'none',
              background: sendable ? 'linear-gradient(135deg, #f97316, #ea580c)' : 'rgba(255,255,255,0.06)',
              color: sendable ? '#fff' : 'rgba(255,255,255,0.2)',
              cursor: sendable ? 'pointer' : 'default',
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

      {/* Keyed by uid so opening a second card starts a fresh load rather than
          showing the first message under the second one's header. */}
      {openEmailUid !== null && (
        <EmailFullView key={openEmailUid} uid={openEmailUid} onClose={closeEmail} t={t} />
      )}
    </div>
  )
}

export default memo(ChatApp)
