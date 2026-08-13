'use client'

import React, { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'

// ── Gateway WebSocket chat widget ──
// Connects directly to the OpenClaw gateway, no iframe.

// Save short assistant snippets for mascot speech lines via client-kv
import * as kv from '@/lib/client-kv'
import {
  uuid,
  type ChatMessage as BaseChatMessage,
} from '@/lib/chat-history-cache'
import { useChatToolCalls, ToolCallPills } from '@/lib/chat-tool-events'
import { FIX_ERROR_EVENT, buildFixErrorPrompt, type FixErrorContext } from '@/lib/ui-events'
import { isSentinel } from '@/lib/chat-sentinels'
import {
  type ThinkingLevel,
  type ProviderReasoningConfig,
  THINKING_LEVEL_LABELS,
  SAFE_THINKING_LEVEL,
  getProviderReasoningConfig,
  readPersistedThinkingLevel,
  resolveWireThinkingLevel,
  parseUnsupportedThinkingLevelError,
  PERSIST_KEY_PREFIX,
} from '@/lib/chat-reasoning'

const MASCOT_LINES_KEY = 'clawbox-mascot-convo-lines'
const MAX_RETRIES = 8
const MAX_QUEUED_SENDS = 20
// During a skill install the gateway restarts to load the new skill, so
// extend the retry budget to quadruple so the chat reconnects automatically
// once it comes back instead of forcing the user to click Try again.
const SKILL_INSTALL_MAX_RETRIES = MAX_RETRIES * 4
const RETRY_DELAY = 3000
// When the gateway closes the socket with an auth rejection (it rate-limits a
// client after too many failed auth attempts), retrying on the fast RETRY_DELAY
// cadence just re-trips the limiter and the lockout never clears. Back off hard
// so the cooldown can expire, then the next attempt succeeds without the user
// having to reload.
const AUTH_BACKOFF_DELAY = 30000
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

// `system`-role messages render as colored pill banners; `variant` picks
// the colour (red error, green confirmation). Ignored for user/assistant.
type ChatMessage = BaseChatMessage & { variant?: 'success' | 'error' }

// One selectable entry in the Hermes provider pill, as reported by
// /setup-api/hermes/models (which reads Hermes' live dashboard). Only rows the
// device has credentials for get this far — see the seeding effect.
interface HermesChatProvider {
  id: string
  name: string
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

// Compact provider labels for the chat header pill. The chat panel
// can be docked at ~370px wide where "OpenAI Codex" + "GPT-5.4 Mini"
// + "Medium" combined exceeds the available width and pills truncate
// to "OpenAI Co...". Drop the brand prefix on the provider pill so
// users see the distinctive part ("Codex" vs "GPT" — both still
// clearly OpenAI) without overflow. Settings page and notification
// messages still use the full PROVIDER_LABELS values from the chat
// model route.
const PROVIDER_PILL_LABEL: Record<string, string> = {
  'ClawBox AI': 'ClawBox',
  'Anthropic Claude': 'Claude',
  'OpenAI GPT': 'GPT',
  'OpenAI Codex': 'Codex',
  'Google Gemini': 'Gemini',
  'OpenRouter': 'OpenRouter',
  'Ollama Local': 'Ollama',
  'Gemma 4 Local': 'Gemma 4',
}
function getProviderPillText(option: ChatModelState['options'][number]): string {
  const full = getChatModelOptionText(option)
  if (!option.available) return full
  return PROVIDER_PILL_LABEL[option.label ?? ''] ?? full
}

import { renderText } from '@/lib/chat-markdown'
import { extractImageFilesFromClipboard } from '@/lib/clipboard'
import { scrollToBottomAfterLayout } from '@/lib/scroll'
import { useT } from '@/lib/i18n'
import {
  extractProviderModelId,
} from '@/lib/provider-models'
import { useProviderCatalog } from '@/hooks/useProviderCatalog'
// Hermes chat header. Deliberately a separate namespace from the OpenClaw
// pieces above: Hermes has its own provider slugs, its own model ids and its
// own reasoning vocabulary, and the whole point of REQ 1 is that the two never
// get mixed. The MODEL list is scoped by the same server contract the Hermes
// settings panel uses (GET /setup-api/hermes/models?provider=…) — no parallel
// client-side filtering exists.
import { HERMES_MODEL_STATE_EVENT, useHermesModelOptions } from '@/hooks/useHermesModelOptions'
import {
  HERMES_AUTO_PROVIDER,
  hermesProviderLabel,
  hermesProviderPillLabel,
} from '@/lib/hermes-providers'
import {
  HERMES_REASONING_DEFAULT,
  HERMES_REASONING_LABELS,
  binaryReasoningLabel,
  binaryReasoningTriggerLabel,
  clampReasoningForProvider,
  hermesReasoningLevelsFor,
  isHermesReasoningLevel,
  isThinkingOnLevel,
  providerHasBinaryReasoning,
  type HermesReasoningLevel,
} from '@/lib/hermes-reasoning'
import { readHermesChatPrefs, writeHermesChatPrefs } from '@/lib/hermes-chat-prefs'
import { useClawboxLogin } from '@/lib/use-clawbox-login'
import { isClawboxAiProModel, CLAWBOX_AI_MODEL_BY_TIER } from '@/lib/clawbox-ai-models'
import { PORTAL_DASHBOARD_URL } from '@/lib/max-subscription'
import { HeaderDropdown } from '@/components/HeaderDropdown'
import { fetchHarness } from '@/lib/client-harness'
import { shortModelPillLabel, REASONING_PILL_ICON } from '@/lib/chat-header-pills'

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

// 420, not the old 400, because of the header. The three selector pills spend
// ~120px on their own padding, chevrons and gaps, so a 400px panel left ~154px
// for the three LABELS — and the widest shipped default pairing, "Claude" +
// "Sonnet 4.6" + "Medium", needs 158 even after every redundant word has been
// squeezed out of it (see src/lib/chat-header-pills.ts). 20px is the whole
// remaining gap; measured in the device's own Chromium, every provider/model
// default in the catalog renders un-truncated at 420 and several did not at 400.
const DEFAULT_SIZE = { w: 420, h: 500 }
const DEFAULT_PANEL_WIDTH = DEFAULT_SIZE.w
// Floor for the chat window width. Below this the header selector pills would
// squeeze past a readable size, so the resize handles (floating + docked panel)
// and the rendered width all clamp here — the chat simply stops getting
// narrower instead of smashing the pills.
const MIN_CHAT_WIDTH = 340

function ChatPopup({ isOpen, onClose, onOpenFull, onOpenSettingsSection, onThinkingChange, onPanelModeChange, initialPanelWidth, mascotX, mobile = false, trayMode = false }: ChatPopupProps) {
  const { t } = useT()
  const [panelWidth, setPanelWidth] = useState<number | null>(initialPanelWidth && initialPanelWidth > 0 ? initialPanelWidth : null)
  const panelMode = panelWidth !== null
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  // Gateway is canonical; render an empty list until chat.history arrives.
  const [messages, setMessages] = useState<ChatMessage[]>([])
  // Which agent harness backs this chat. OpenClaw uses the gateway WebSocket;
  // Hermes uses the /setup-api/hermes/chat HTTP route (hermes -z, persistent
  // session). Loaded once on mount; connect() is gated on `harnessLoaded` so we
  // never open the OpenClaw WS in Hermes mode.
  const harnessRef = useRef<'openclaw' | 'hermes'>('openclaw')
  const [harnessLoaded, setHarnessLoaded] = useState(false)
  // Reactive copy of the harness for rendering (the ref drives connect/send at
  // call-time; this drives which header controls show).
  const [harnessMode, setHarnessMode] = useState<'openclaw' | 'hermes'>('openclaw')
  // Hermes chat header — the same three controls the OpenClaw header has:
  // PROVIDER → MODEL (scoped to that provider) → THINKING EFFORT.
  //
  // All three are PER-INVOCATION overrides: `hermes -z --provider/--reasoning`
  // are documented as "for this invocation", so changing a pill never rewrites
  // config.yaml. The Hermes settings panel stays the only thing that persists a
  // device default; these choices persist in localStorage instead.
  //
  // Refs mirror the state so dispatchHermes can stay a stable useCallback([])
  // and read the values at send-time (a pill changed mid-run therefore applies
  // to the NEXT turn, never retroactively).
  const [hermesProviders, setHermesProviders] = useState<HermesChatProvider[]>([])
  const [hermesProvider, setHermesProvider] = useState('')
  const hermesProviderRef = useRef('')
  // The device's own configured pairing (config.yaml model.provider/default).
  // It is the floor: the only pairing we may assume without a live model list.
  const [hermesDevice, setHermesDevice] = useState<{ provider: string; model: string }>({ provider: '', model: '' })
  const hermesDeviceRef = useRef<{ provider: string; model: string }>({ provider: '', model: '' })
  // The user's explicit model pick, keyed BY PROVIDER — so a remembered
  // anthropic id can never leak into a ClawBox AI turn. Honoured only while the
  // pick is still in that provider's live list (see the `hermesModel` memo).
  const [hermesPicks, setHermesPicks] = useState<Record<string, string>>({})
  const hermesModelRef = useRef('')
  // The Hermes session this chat is threaded through. Empty until the first
  // reply reports one; every later turn resumes it, which is what gives the
  // conversation memory. Cleared when the user starts a new chat.
  const hermesSessionRef = useRef('')
  // What the LAST turn actually ran on. A resumed session keeps the system
  // prompt it was created with, so after a switch the agent would still answer
  // "What model are you?" with the old one (and echo its earlier claims from
  // the transcript) even though the turn is genuinely routed to the new
  // provider. Comparing against these lets the next turn state the change
  // rather than discarding the conversation to get a fresh system prompt.
  const hermesSentProviderRef = useRef('')
  const hermesSentModelRef = useRef('')
  const [hermesReasoning, setHermesReasoning] = useState<HermesReasoningLevel>(HERMES_REASONING_DEFAULT)
  const hermesReasoningRef = useRef<HermesReasoningLevel>(HERMES_REASONING_DEFAULT)
  // False until the level is real (from localStorage, from the device's
  // agent.reasoning_effort, or picked by the user) rather than the placeholder.
  const hermesReasoningKnownRef = useRef(false)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [sending, setSending] = useState(false)
  // Queued while a run is in flight; drained one at a time on `final`.
  const [queuedSends, setQueuedSends] = useState<{ id: string; text: string; attachments: { name: string; path: string; type: string }[] }[]>([])
  const { toolCalls, applyToolEvent, clearToolCalls } = useChatToolCalls()
  const [isBootstrappingHistory, setIsBootstrappingHistory] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [chatModelState, setChatModelState] = useState<ChatModelState | null>(null)
  const [switchingModel, setSwitchingModel] = useState(false)
  // Initialised to the always-safe level, not a speculative `high`: the real
  // value is snapped to the active provider's persisted choice (or that
  // provider's default) by the [headerProvider] effect below as soon as
  // chatModelState resolves. Starting at `off` means that if the socket
  // connects before the catalog does, the first wire push can't offer a
  // reasoning level a local (off-only) model would reject.
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(SAFE_THINKING_LEVEL)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<{ name: string; path: string; type: string }[]>([])

  // ── Drag + resize state ──
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>(DEFAULT_SIZE)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Reset position and size when reopened
  useEffect(() => { if (isOpen) { setPos(null); setSize(DEFAULT_SIZE) } }, [isOpen])

  // Provider id for the header model dropdown. Memoised on the active
  // option so the catalog hook below only re-fetches when the provider
  // actually changes — `chatModelState` is replaced on every status
  // poll, so depending on the whole object would refetch the catalog
  // on every poll tick.
  const headerProvider = useMemo<string | null>(() => {
    if (!chatModelState) return null
    const activeOption = chatModelState.options.find(
      (option) => option.id === chatModelState.activeOptionId,
    )
    return activeOption?.provider ?? null
  }, [chatModelState])
  const reasoningConfig = useMemo<ProviderReasoningConfig>(
    () => getProviderReasoningConfig(headerProvider),
    [headerProvider],
  )
  const visibleThinkingLevels = reasoningConfig.levels
  // Snap the displayed value to a level the active provider actually
  // supports. Without this the <select> would render a value with no
  // matching <option> and show empty when the user switches from a
  // provider that has e.g. `xhigh` to one that doesnt. The setter below
  // syncs `thinkingLevel` to this value once the provider settles, so
  // the wire payload also stays in sync.
  const effectiveThinkingLevel: ThinkingLevel = visibleThinkingLevels.includes(thinkingLevel)
    ? thinkingLevel
    : reasoningConfig.default
  const chatProviderCatalog = useProviderCatalog(headerProvider)
  // Pull live tier so the chat-model picker can filter ClawBox AI options
  // by entitlement. Without this, a Free user could pick deepseek-v4-pro,
  // see a "Switched chat to deepseek/deepseek-v4-pro" success message,
  // then watch every reply silently downgrade to flash because Mike's
  // gateway gates by user.tier — UI says one thing, gateway does another.
  const clawboxLogin = useClawboxLogin()

  // ── Hermes header: provider-scoped model list ──
  //
  // The scoping is SERVER-side (src/lib/hermes-model-options.ts): the hook asks
  // for `?provider=<slug>` and gets back that provider's models only, with a
  // `current` that is "" whenever the device's saved model belongs to a
  // different provider. There is nothing else in the payload to render, so the
  // reported bug — select Anthropic, still see a deepseek id — is structurally
  // impossible here, exactly as in the Hermes settings panel. No second,
  // client-side filter exists to drift from it.
  const { scope: hermesScope, loading: hermesModelsLoading } = useHermesModelOptions(
    harnessMode === 'hermes' && hermesProvider ? hermesProvider : null,
  )
  // Whether the model pill should hold its place while the new provider's list
  // arrives. Switching provider drops `scope` to null by design — showing the
  // OLD provider's models would be the foreign-vendor bug this whole module
  // exists to prevent — but unmounting the pill made the header visibly
  // collapse to "Provider + Thinking" for a second and then reflow when the
  // models landed. Two layout shifts where none is needed.
  //
  // `hadModelPill` remembers that the pill was showing a moment ago, so a
  // provider that genuinely has one model (ClawBox AI) still never grows a
  // pointless picker.
  const hadModelPill = useRef(false)
  const hermesModelCount = hermesScope?.models.length ?? 0
  useEffect(() => {
    if (!hermesModelsLoading) hadModelPill.current = hermesModelCount > 1
  }, [hermesModelsLoading, hermesModelCount])
  const showModelPill = hermesModelsLoading ? hadModelPill.current : hermesModelCount > 1

  // DERIVED, never effect-synced: a remembered pick the newly selected provider
  // doesn't serve is dropped on the spot, so the pill can never sit on a
  // foreign vendor's id — not even for a single frame.
  const hermesModel = useMemo(() => {
    const models = hermesScope?.models ?? []
    const picked = hermesPicks[hermesProvider]
    if (picked && models.some(m => m.id === picked)) return picked
    if (models.length) return hermesScope?.current || hermesScope?.defaultModel || models[0].id
    // No live list for this provider (dashboard unreachable, or a provider that
    // exposes no enumerable /v1/models). The ONLY pairing safe to assume is the
    // device's own, because that is what it is running right now; for anything
    // else we send no -m at all and let hermes fall back to its configured
    // default rather than guess an id that provider may not serve.
    return hermesProvider && hermesProvider === hermesDevice.provider ? hermesDevice.model : ''
  }, [hermesScope, hermesPicks, hermesProvider, hermesDevice])

  // Whether the scoped list for the CURRENT provider has landed. Lets the send
  // path tell "this provider genuinely has no models" apart from "the list is
  // still in flight" — the hook nulls `scope` while a newly selected provider's
  // request is running, and those two need very different messages.
  const hermesScopeReadyRef = useRef(false)

  // Keep the send-time refs in step with what is rendered.
  useEffect(() => { hermesScopeReadyRef.current = Boolean(hermesScope) }, [hermesScope])
  useEffect(() => { hermesProviderRef.current = hermesProvider }, [hermesProvider])
  useEffect(() => { hermesModelRef.current = hermesModel }, [hermesModel])
  // Only the levels the SELECTED provider actually accepts. ClawBox AI rejects
  // `ultra` outright (HTTP 400 reasoning_effort: unknown), so offering it would
  // be offering a guaranteed failed turn.
  const hermesReasoningOptions = useMemo(
    () => hermesReasoningLevelsFor(hermesProvider),
    [hermesProvider],
  )
  // What the pill DISPLAYS and what we send: a user sitting on Ultra who
  // switches to ClawBox AI lands on the nearest supported level rather than
  // showing a value with no matching option.
  const hermesEffectiveReasoning = useMemo(
    () => clampReasoningForProvider(hermesProvider, hermesReasoning),
    [hermesProvider, hermesReasoning],
  )
  useEffect(() => { hermesReasoningRef.current = hermesEffectiveReasoning }, [hermesEffectiveReasoning])
  useEffect(() => { hermesDeviceRef.current = hermesDevice }, [hermesDevice])

  // The on-device model's dial is a thinking SWITCH, not an effort scale — its
  // backend has two states and no graded middle (see hermes-reasoning.ts). It
  // therefore borrows two levels from the shared vocabulary to stand for the
  // ends, and must not label them "Minimal"/"Max" as though the scale applied.
  //
  // Plain functions, not useMemo/useCallback: all three are called inline while
  // rendering and none is passed to a memoised child, so a hook would allocate
  // a dependency array and a closure per render and save nothing.
  const hermesBinaryReasoning = providerHasBinaryReasoning(hermesProvider)
  /** Full label for the open menu. */
  const hermesReasoningLabel = (level: HermesReasoningLevel) =>
    binaryReasoningLabel(hermesProvider, level) ?? HERMES_REASONING_LABELS[level]
  /** Compact label for the closed pill, which shares a tight width budget. */
  const hermesReasoningTriggerLabel = (level: HermesReasoningLevel) =>
    binaryReasoningTriggerLabel(hermesProvider, level) ?? HERMES_REASONING_LABELS[level]

  const hermesProviderName = useCallback(
    (id: string) => hermesProviderLabel(id, hermesProviders.find(p => p.id === id)?.name),
    [hermesProviders],
  )

  // Text of the header's provider pill. Also feeds the model pill, which drops
  // whatever this already says (see shortModelPillLabel).
  const hermesProviderPill = useMemo(
    () => hermesProviderPillLabel(
      hermesProvider,
      hermesProviders.find(p => p.id === hermesProvider)?.name,
    ),
    [hermesProvider, hermesProviders],
  )

  const changeHermesProvider = useCallback((id: string) => {
    if (id === hermesProviderRef.current) return
    setHermesProvider(id)
    writeHermesChatPrefs({ provider: id })
    // The session is deliberately KEPT: switching provider mid-conversation
    // must not throw the conversation away. The turn is routed correctly on a
    // resumed session (verified — the billing record shows the new provider);
    // the only casualty was the agent's SELF-knowledge, because a resumed
    // session keeps the system prompt it was created with and the transcript
    // still contains its earlier "I am X" claims. dispatchHermes therefore
    // tells it about the switch on the next turn instead.
    setMessages(msgs => [...msgs, {
      role: 'system',
      text: `Switched to ${hermesProviderName(id)}.`,
      timestamp: Date.now(),
      variant: 'success',
    }])
  }, [hermesProviderName])

  const changeHermesModel = useCallback((id: string) => {
    const provider = hermesProviderRef.current
    if (!provider) return
    setHermesPicks(prev => (prev[provider] === id ? prev : { ...prev, [provider]: id }))
    // Read-modify-write: `models` is a nested map, so a shallow merge of the
    // patch alone would drop every other provider's remembered pick.
    writeHermesChatPrefs({ models: { ...readHermesChatPrefs().models, [provider]: id } })
    // Session kept — see changeHermesProvider. The next turn announces the
    // change to the agent rather than starting the conversation over.
  }, [])

  const changeHermesReasoning = useCallback((next: string) => {
    const level: HermesReasoningLevel = isHermesReasoningLevel(next) ? next : HERMES_REASONING_DEFAULT
    if (level === hermesReasoningRef.current) return
    hermesReasoningKnownRef.current = true
    setHermesReasoning(level)
    writeHermesChatPrefs({ reasoning: level })
    // A two-state provider has no "effort" to switch — the pill and the menu
    // both say Thinking on/off, and the confirmation has to agree with them.
    // Reads the ref, not the memoised label, so this stays dependency-free
    // like the rest of the header's change handlers.
    const thinking = binaryReasoningTriggerLabel(hermesProviderRef.current, level)
    setMessages(msgs => [...msgs, {
      role: 'system',
      text: thinking
        ? `Switched thinking to ${thinking}.`
        : `Switched effort to ${HERMES_REASONING_LABELS[level]}.`,
      timestamp: Date.now(),
      variant: 'success',
    }])
  }, [])

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
      const newW = Math.max(MIN_CHAT_WIDTH, Math.min(startW - (cx - startX), window.innerWidth * 0.6))
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
      const finalW = Math.max(MIN_CHAT_WIDTH, Math.min(startW - (cx - startX), window.innerWidth * 0.6))
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
      if (edge.includes('r')) newW = Math.max(MIN_CHAT_WIDTH, start.w + dx)
      if (edge.includes('b')) newH = Math.max(250, start.h + dy)
      if (edge.includes('l')) { newW = Math.max(MIN_CHAT_WIDTH, start.w - dx); newX = start.left + (start.w - newW) }
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
  // Timer for the ack-only `chat.history` refetch — single-flight so a
  // burst of "Sent."-acked turns doesn't pile up overlapping fetches, and
  // cancellable on unmount.
  const ackOnlyHistoryTimerRef = useRef<number | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const connectedOnceRef = useRef(false)
  const pendingModelSwitchResetRef = useRef<{ model: string; label: string } | null>(null)
  // Sends queued while the WS handshake hasn't completed yet. Drained by
  // a useEffect when status flips to 'connected' so the user can type and
  // hit Enter before the gateway is ready without seeing a hard error.
  const pendingSendsRef = useRef<Array<{
    text: string
    attachments: { name: string; path: string; type: string }[]
    idempotencyKey: string
  }>>([])
  // Auto-scroll to bottom — see scrollToBottomAfterLayout for the rationale
  // behind the double-rAF wait.
  const scrollToBottom = useCallback(() => {
    scrollToBottomAfterLayout(messagesEndRef.current)
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, streaming, queuedSends, scrollToBottom])
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
      // Timeout after 120s. Gateway main-loop blocks for tens of seconds
      // during agent startup; we need to outlast the worst observed stall
      // (~81s) so chat.send acks aren't dropped client-side.
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id)
          reject(new Error('Request timeout'))
        }
      }, 120000)
    })
  }, [])

  // Push thinkingLevel to the gateway as a sticky session override
  // (per OpenClaw control-ui docs: model + thinking pickers patch via
  // sessions.patch and persist for every subsequent turn). 'default'
  // maps to null on the wire so the gateway falls back to its config.
  // The lastSent ref dedupes — without it, every reconnect re-pushes
  // an identical value and a user click triggers two patches (state
  // change + this effect).
  const lastSentThinkingRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (status !== 'connected') return
    const key = sessionKeyRef.current
    if (!key) return
    // Never push a level the ACTIVE model doesn't support. `resolveWireThinkingLevel`
    // clamps to the provider's config (so a stale `high` carried over from a
    // reasoning-capable model is folded to the local model's `off`) and returns
    // null while the provider is still unknown (catalog loading) so we hold the
    // push rather than sending a speculative value the gateway would reject.
    const wireLevel = resolveWireThinkingLevel(headerProvider, thinkingLevel)
    if (wireLevel === null) return
    const wireValue: string = wireLevel
    if (wireValue === lastSentThinkingRef.current) return
    lastSentThinkingRef.current = wireValue
    void wsRequest('sessions.patch', { key, thinkingLevel: wireValue }).catch((err: unknown) => {
      // Reset so a reconnect or next user change retries.
      lastSentThinkingRef.current = undefined
      // The gateway itself tells us the level to fall back to when a model
      // exposes no (or a narrower) reasoning control — e.g. local Gemma:
      //   thinkingLevel "high" is not supported for llamacpp/... (use off)
      // Honour that silently: snap to the suggested level and re-push it,
      // surfacing a plain note rather than a red failure banner (a residual
      // race, an external model change, or an API client can still reach here).
      const message = err instanceof Error ? err.message : 'unknown error'
      const suggested = parseUnsupportedThinkingLevelError(message)
      if (suggested !== null) {
        if (headerProvider) {
          try { window.localStorage?.setItem(`${PERSIST_KEY_PREFIX}:${headerProvider}`, suggested) } catch { /* localStorage unavailable */ }
        }
        setThinkingLevel(prev => (prev === suggested ? prev : suggested))
        setMessages(msgs => [...msgs, {
          role: 'system',
          text: `Reasoning effort isn't available for this model — using ${THINKING_LEVEL_LABELS[suggested] ?? suggested}.`,
          timestamp: Date.now(),
          variant: 'success',
        }])
        return
      }
      setMessages(msgs => [...msgs, {
        role: 'system',
        text: `Failed to change effort: ${message}`,
        timestamp: Date.now(),
        variant: 'error',
      }])
    })
  }, [status, headerProvider, thinkingLevel, wsRequest])

  // Snap thinkingLevel to the active provider's persisted choice (or its
  // default) whenever the active provider changes. Without this the
  // global state would carry e.g. an OpenAI `xhigh` choice over to a
  // DeepSeek session that doesnt support xhigh, and `effectiveThinkingLevel`
  // would silently fall back to the provider default while the actual
  // state still said xhigh — confusing and racey when the user then
  // tries to change levels.
  useEffect(() => {
    if (!headerProvider) return
    const cfg = getProviderReasoningConfig(headerProvider)
    const persisted = readPersistedThinkingLevel(headerProvider, cfg)
    setThinkingLevel(prev => (prev === persisted ? prev : persisted))
  }, [headerProvider])

  const handleThinkingLevelChange = useCallback((next: string) => {
    const cfg = getProviderReasoningConfig(headerProvider)
    const normalized: ThinkingLevel = cfg.levels.includes(next as ThinkingLevel)
      ? (next as ThinkingLevel)
      : cfg.default
    setThinkingLevel(prev => {
      if (prev === normalized) return prev
      const label = THINKING_LEVEL_LABELS[normalized] ?? normalized
      setMessages(msgs => [...msgs, {
        role: 'system',
        text: `Switched effort to ${label}.`,
        timestamp: Date.now(),
        variant: 'success',
      }])
      return normalized
    })
    if (headerProvider) {
      try { window.localStorage?.setItem(`${PERSIST_KEY_PREFIX}:${headerProvider}`, normalized) } catch { /* localStorage unavailable */ }
    }
  }, [headerProvider])

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
    // Hermes mode: no gateway WebSocket. Mark connected so the composer is
    // enabled; startRun routes sends to /setup-api/hermes/chat instead.
    if (harnessRef.current === 'hermes') {
      setStatus('connected')
      return
    }
    // Cancel any pending retry / auth-backoff timer so an explicit reconnect
    // (e.g. the "Try again" button) can't race with a previously scheduled one
    // and fire a duplicate connect later.
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return
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
      // no-store: the gateway token can be regenerated (per-device reseed, a
      // settings change, post-update). A cached ws-config response would replay
      // a stale token on every reconnect and the gateway would reject it with
      // "token mismatch" forever. Always fetch the current token.
      const res = await fetch('/setup-api/gateway/ws-config', { cache: 'no-store' })
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
      // Same terminal-failure teardown as the onClose exhaustion path: a reboot
      // where ws-config keeps failing exhausts here, not in onClose, so without
      // this the overlay would stay up and the safety-net effect would loop.
      tearDownReloadOverlay()
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
            // A plain gateway restart (e.g. a channel-config toggle) keeps
            // the conversation intact too — nothing about the session
            // semantics changed, the gateway just bounced.
            const keepHistoryReload = wasProviderChange || reloadReasonRef.current === 'restart'
            skillInstalledRef.current = false
            reloadReasonRef.current = 'skill' // reset for next reload
            // Only reset the transcript for skill install/uninstall/etc.
            // Provider changes and plain restarts keep the visible history so
            // the user's earlier context isn't wiped — only the backend
            // session override changed (provider) or nothing did (restart).
            if (!keepHistoryReload) {
              setMessages([])
              greetedRef.current = true // prevent auto-greet
              // Clearing the transcript starts a NEW conversation, so drop the
              // threaded Hermes session too — otherwise the agent would still
              // carry the old context the user just cleared away.
              hermesSessionRef.current = ''
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
              // A provider change surfaces a "Switched chat to X" banner so the
              // user knows the new provider is live. Refresh chat/model state to
              // label it. Fire-and-forget — if the fetch fails the worst case is
              // we don't show the banner, not that the chat is broken.
              if (wasProviderChange) {
                const pendingModelSwitch = pendingModelSwitchResetRef.current
                pendingModelSwitchResetRef.current = null
                if (pendingModelSwitch) {
                  try {
                    await wsRequest('sessions.reset', { key: mainSessionKey, reason: 'new' })
                    setMessages([])
                    greetedRef.current = true
                  } catch (err) {
                    setMessages(prev => [...prev, {
                      role: 'system',
                      text: `Switched chat to ${pendingModelSwitch.model}, but could not start a fresh chat: ${err instanceof Error ? err.message : 'unknown error'}`,
                      timestamp: Date.now(),
                      variant: 'error',
                    }])
                  }
                }
                try {
                  const res = await fetch('/setup-api/chat/model', { cache: 'no-store' })
                  const state = await res.json() as ChatModelState
                  setChatModelState(state)
                  const label = state.activeLabel ?? state.primary?.label ?? 'the new AI provider'
                  setMessages(prev => [...prev, {
                    role: 'system',
                    text: pendingModelSwitch
                      ? `Switched chat to ${label}. Started a fresh chat so the previous model's transcript does not leak into this model.`
                      : `Switched chat to ${label}.`,
                    timestamp: Date.now(),
                    variant: 'success',
                  }])
                } catch {
                  // Ignore — banner is best-effort confirmation only.
                }
              }
              // Provider changes and plain restarts keep the visible history and
              // have nothing to auto-send — drop the overlay and hand back to the
              // user. Only a skill install/uninstall sends a context message.
              if (keepHistoryReload) return
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
          minProtocol: 4,
          maxProtocol: 4,
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

        // Tool-call lifecycle: surface a small inline pill in the chat so
        // the user can see "🔧 bash · running…" while the agent is acting.
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
            // Sentinels would flash before the final-state filter drops them.
            if (text && !isSentinel(text)) {
              setStreaming(text); setReloadingSkill(false)
            }
          } else if (state === 'final') {
            const text = extractText(msg)
            // Suppress sentinel and "Sent." (delivery-mirror ack) from the
            // rendered transcript — the latter is just a server-side
            // acknowledgement that the real reply will follow via the
            // chat.history refetch scheduled below. Skipping the append
            // avoids a brief "Sent." bubble flashing on the screen before
            // the real reply replaces it.
            const isAckOnly = !text || /^\s*Sent\.\s*$/.test(text) || isSentinel(text)
            if (text && !isAckOnly) {
              setMessages(prev => [...prev, { role: 'assistant', text, timestamp: Date.now() }])
              saveMascotSnippet(text)
            }
            setStreaming('')
            clearToolCalls()
            runIdRef.current = null
            setSending(false)
            // OpenClaw can ack a turn with "Sent." (delivery-mirror persona
            // pipeline / internal-source-reply) while the real reply is
            // generated server-side a moment later — persisted but never
            // streamed via WS. Only refetch history in that ack-only case,
            // detected by an empty / "Sent."-only `final`. Normal streamed
            // replies arrive via delta+final and don't need the extra
            // round-trip every turn.
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
            setStreaming(prev => {
              if (prev.trim() && !isSentinel(prev)) {
                setMessages(msgs => [...msgs, { role: 'assistant', text: prev, timestamp: Date.now() }])
              }
              return ''
            })
            clearToolCalls()
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

    const onClose = (event?: CloseEvent) => {
      wsRef.current = null

      // Auth rejection (gateway closes with 1008 / "unauthorized" / "rate
      // limited" — it rate-limits a client after too many failed auth
      // attempts). Do NOT fall through to the fast RETRY_DELAY loop: hammering
      // every 3s just re-trips the limiter so the lockout never clears. Tear
      // down any reconnect overlay, surface the gateway's reason, and schedule
      // a single long backoff retry so it self-heals once the cooldown expires.
      const closeReason = event?.reason || ""
      if (event?.code === 1008 || /unauthor|rate.?limit|too many/i.test(closeReason)) {
        tearDownReloadOverlay()
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
        setStatus('error')
        setErrorMsg(closeReason || 'Unauthorized — retrying shortly')
        retryTimerRef.current = setTimeout(() => { retryCountRef.current = 0; connect() }, AUTH_BACKOFF_DELAY)
        return
      }

      // If the WS drops after we'd successfully connected, the gateway
      // bounced under us (a restart from a skill install, AI-provider
      // change, the Telegram progress-streaming toggle, a settings change,
      // or a crash). Show the same reconnect overlay the skill/provider
      // flows use so the chat doesn't just freeze — instead of the bare
      // spinner. `connectedOnceRef` gates this to genuine restarts (an
      // initial connection that never succeeded keeps the plain "connecting"
      // UI). The `!skillInstalledRef` guard avoids re-tripping while an
      // overlay reconnect is already in flight. Reason 'restart' keeps the
      // visible history; the resolve callback clears the overlay + extends
      // the retry budget once the gateway answers again.
      if (connectedOnceRef.current && !skillInstalledRef.current) {
        skillInstalledRef.current = true
        reloadReasonRef.current = 'restart'
        setReloadReason('restart')
        setReloadingSkill(true)
        setReloadProgress(0)
        startReloadProgressTimer()
      }

      // While a reload is in-flight the gateway is restarting — use the
      // extended retry budget so the chat reconnects automatically once it
      // comes back, instead of bailing out with 'Could not connect to
      // gateway' and making the user click Try again manually. The normal
      // cap still applies outside of restart windows.
      const maxRetries = skillInstalledRef.current ? SKILL_INSTALL_MAX_RETRIES : MAX_RETRIES
      if (retryCountRef.current < maxRetries) {
        retryCountRef.current++
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
        retryTimerRef.current = setTimeout(() => connect(), RETRY_DELAY)
        return
      }
      // Retries exhausted — the gateway isn't coming back on its own. Tear the
      // reconnect overlay down so the error panel can render (it's hidden while
      // reloadingSkill is true) and a manual "Try again" starts from a clean
      // state with the normal retry budget.
      tearDownReloadOverlay()
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
        if (!text || isSentinel(text)) continue
        const cleaned = role === 'user' ? text.replace(/^\[[^\]]+\]\s*/, '') : text
        chatMsgs.push({ role: role as 'user' | 'assistant', text: cleaned, timestamp: (m.timestamp as number) || 0 })
      }
      // Preserve any optimistic user turns appended after this load was
      // dispatched but before chat.history responded — they haven't reached
      // the server yet so chatMsgs doesn't include them.
      setMessages(prev => {
        if (prev.length === 0) return chatMsgs
        const lastServerTs = chatMsgs.length > 0 ? chatMsgs[chatMsgs.length - 1].timestamp : 0
        const inFlight = prev.filter(m => m.role === 'user' && m.timestamp > lastServerTs)
        return inFlight.length === 0 ? chatMsgs : [...chatMsgs, ...inFlight]
      })

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

  // Upload one or more files to the server's /uploads dir and add them to
  // the chat attachment list. Shared by the file-input change handler and
  // by the textarea paste handler (Ctrl+V on a clipboard image).
  const uploadFiles = useCallback((files: File[]) => {
    if (files.length === 0) return
    const stampBase = Date.now()
    const tasks = files.map(async (rawFile, idx) => {
      // Clipboard images come in as the generic "image.png"; stamp them so
      // a burst of pastes in the same millisecond doesn't collide on disk.
      // FormData's third arg sets the filename without copying the Blob.
      const isGeneric = !rawFile.name || rawFile.name === 'image.png' || rawFile.name === 'image.jpeg'
      const filename = isGeneric
        ? `paste-${stampBase}-${idx}.${rawFile.type.split('/')[1] || 'png'}`
        : rawFile.name
      const formData = new FormData()
      formData.append('file', rawFile, filename)
      try {
        const res = await fetch('/setup-api/files?dir=uploads', { method: 'POST', body: formData })
        if (!res.ok) return
        const json = await res.json().catch(() => ({} as { name?: string; path?: string }))
        const name = json.name || filename
        const absPath = json.path
        if (!absPath) return
        setAttachments(prev => [...prev, { name, path: absPath, type: rawFile.type }])
      } catch (err) {
        console.error('[chat] upload failed:', err)
      }
    })
    void Promise.all(tasks)
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    uploadFiles(Array.from(files))
    e.target.value = ''
  }, [uploadFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (status !== 'connected') return
    const imageFiles = extractImageFilesFromClipboard(e)
    if (imageFiles.length === 0) return
    e.preventDefault()
    uploadFiles(imageFiles)
  }, [status, uploadFiles])

  const removeAttachment = useCallback((idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx))
  }, [])

  const dispatchSend = useCallback(async (
    text: string,
    sendAttachments: { name: string; path: string; type: string }[],
    idempotencyKey: string,
  ) => {
    let messageText = text
    if (sendAttachments.length > 0) {
      const filePaths = sendAttachments.map(a => `[Attached file: ${a.path}]`).join('\n')
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
  }, [wsRequest])

  // Hermes send: POST the turn to the HTTP route (hermes -z keeps a persistent
  // session, so multi-turn memory works without threading context). No
  // streaming yet — the reply lands whole. Attachments are OpenClaw-only for now.
  // Holds the in-flight Hermes request so Stop can abort it (which aborts the
  // fetch → the route sees request.signal abort → kills the `hermes` process).
  const hermesAbortRef = useRef<AbortController | null>(null)
  const dispatchHermes = useCallback(async (text: string) => {
    const controller = new AbortController()
    hermesAbortRef.current = controller
    // Read the header selections at send-time (see the refs' comment): the
    // callback stays stable, and a pill changed mid-run applies to the next
    // turn rather than retroactively to this one.
    const provider = hermesProviderRef.current
    const model = hermesModelRef.current
    // HERMES_REASONING_DEFAULT is only a placeholder for the picker. Until the
    // level is KNOWN (read from the device, or chosen by the user) we send no
    // --reasoning at all, so a failed seeding fetch can't silently override the
    // device's own agent.reasoning_effort with "medium".
    const reasoning = hermesReasoningKnownRef.current ? hermesReasoningRef.current : ''
    try {
      if (provider && provider !== HERMES_AUTO_PROVIDER && !model && provider !== hermesDeviceRef.current.provider) {
        // Sending --provider without -m makes hermes fall back to config.yaml's
        // model.default, which belongs to the CONFIGURED provider — i.e. it
        // would run this provider against another one's model id. The route
        // rejects that too (409); catching it here turns a raw error into an
        // actionable one instead of burning a turn.
        throw new Error(hermesScopeReadyRef.current
          ? `No models are available for ${hermesProviderLabel(provider)} on this device. `
            + 'Add credentials for it in Settings, or pick another provider.'
          : `Still loading ${hermesProviderLabel(provider)}'s models — try again in a moment.`)
      }
      // Announce a mid-conversation switch. Only when we are RESUMING (a fresh
      // session already gets a correct system prompt) and only when something
      // actually changed, so a normal turn carries no extra text.
      const switched = Boolean(hermesSessionRef.current)
        && (hermesSentProviderRef.current !== provider || hermesSentModelRef.current !== model)
        && Boolean(hermesSentProviderRef.current || hermesSentModelRef.current)
      const outbound = switched
        ? `[System note: this conversation has just been switched to model "${model || 'the provider default'}" `
          + `via provider "${hermesProviderLabel(provider)}". You are now that model — disregard any earlier `
          + `statement in this conversation about which model you are. Keep the conversation and its context.]\n\n`
          + text
        : text
      const res = await fetch('/setup-api/hermes/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: outbound,
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
          ...(reasoning ? { reasoning } : {}),
          // Continue this conversation instead of starting a fresh agent every
          // turn — otherwise a follow-up like "is it removed now?" reaches an
          // agent with no idea what "it" is.
          ...(hermesSessionRef.current ? { sessionId: hermesSessionRef.current } : {}),
        }),
        signal: controller.signal,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Hermes chat failed')
      if (typeof data.sessionId === 'string' && data.sessionId) {
        hermesSessionRef.current = data.sessionId
      }
      // Record what this turn ran on, so the NEXT one only announces a switch
      // if something really changed. Set after success: a failed turn didn't
      // establish anything, and the announcement should survive to be made.
      hermesSentProviderRef.current = provider
      hermesSentModelRef.current = model
      setMessages(prev => [...prev, { role: 'assistant', text: data.text || '(no response)', timestamp: Date.now() }])
    } catch (err) {
      // A user-initiated Stop shows nothing, not an error line.
      if ((err as Error)?.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'system', text: `Error: ${(err as Error).message}`, timestamp: Date.now() }])
      }
    } finally {
      hermesAbortRef.current = null
      setSending(false)
      setStreaming('')
      runIdRef.current = null
    }
  }, [])

  const startRun = useCallback((text: string, sendAttachments: { name: string; path: string; type: string }[]) => {
    const fileNames = sendAttachments.map(a => `📎 ${a.name}`).join('\n')
    const displayText = [fileNames, text].filter(Boolean).join('\n')
    setMessages(prev => [...prev, { role: 'user', text: displayText, timestamp: Date.now() }])
    setSending(true)
    setStreaming('')
    const idempotencyKey = uuid()
    runIdRef.current = idempotencyKey
    if (harnessRef.current === 'hermes') {
      void dispatchHermes(text)
      return
    }
    if (status !== 'connected') {
      pendingSendsRef.current.push({ text, attachments: sendAttachments, idempotencyKey })
      return
    }
    void dispatchSend(text, sendAttachments, idempotencyKey)
  }, [status, dispatchSend, dispatchHermes])

  const sendMessage = useCallback(() => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    if (sending) {
      // Cap to bound memory; dropping the oldest matches "newest is freshest".
      setQueuedSends(prev => {
        const next = [...prev, { id: uuid(), text, attachments: currentAttachments }]
        return next.length > MAX_QUEUED_SENDS ? next.slice(next.length - MAX_QUEUED_SENDS) : next
      })
      return
    }
    startRun(text, currentAttachments)
  }, [input, sending, attachments, startRun])

  useEffect(() => {
    if (sending || queuedSends.length === 0) return
    const [next, ...rest] = queuedSends
    setQueuedSends(rest)
    startRun(next.text, next.attachments)
  }, [sending, queuedSends, startRun])

  const cancelQueuedSend = useCallback((id: string) => {
    setQueuedSends(prev => prev.filter(q => q.id !== id))
  }, [])

  // Fix-My-Error: queue an investigation prompt for the agent. Mark the
  // auto-greet as already done so loadHistory doesn't race the user's
  // fix-error prompt with a stray "hi".
  useEffect(() => {
    const handler = (e: Event) => {
      const ctx = (e as CustomEvent<FixErrorContext>).detail
      if (!ctx?.message) return
      greetedRef.current = true
      setQueuedSends(prev => [...prev, { id: uuid(), text: buildFixErrorPrompt(ctx), attachments: [] }])
    }
    window.addEventListener(FIX_ERROR_EVENT, handler)
    return () => window.removeEventListener(FIX_ERROR_EVENT, handler)
  }, [])

  // Drain queued sends on connect; flush them as system errors on error
  // so messages don't sit forever in a ref the user has no way to see.
  // Sequential dispatch preserves user-typed order on the gateway.
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

  // Abort generation
  const abort = useCallback(async () => {
    if (harnessRef.current === 'hermes') {
      hermesAbortRef.current?.abort()
      return
    }
    try {
      await wsRequest('chat.abort', { sessionKey: sessionKeyRef.current })
    } catch {}
  }, [wsRequest])

  const switchChatModel = useCallback(async (target: { model: string; label: string }) => {
    if (switchingModel || chatModelState?.activeModel === target.model) return
    // Intercept clawai Pro picks from non-Max users. The portal's
    // /api/ai gateway silently downgrades these requests to flash via
    // its live-tier reconcile, which previously left the user staring
    // at a "Switched chat to deepseek-v4-pro" success toast while every
    // reply came from flash. Surface the gate here with an actionable
    // upgrade prompt and skip the network call entirely. The portal URL
    // is wrapped as `[text](url)` so chat-markdown renders it as a
    // clickable link instead of a bare string.
    if (isClawboxAiProModel(target.model) && clawboxLogin.tier !== 'pro') {
      setMessages(prev => [...prev, {
        role: 'system',
        text: `${target.label} requires a Max subscription. [Upgrade in the ClawBox portal](${PORTAL_DASHBOARD_URL}) to unlock it. Staying on the current model.`,
        timestamp: Date.now(),
        variant: 'error',
      }])
      return
    }
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
      pendingModelSwitchResetRef.current = target
      skillInstalledRef.current = true
      reloadReasonRef.current = 'provider'
      setReloadReason('provider')
      setReloadingSkill(true)
      setReloadProgress(0)
      retryCountRef.current = 0
      startReloadProgressTimer()
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try { wsRef.current.close() } catch { /* ignore */ }
      }
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
  }, [chatModelState, connect, switchingModel, clawboxLogin.tier])

  // The dropdown gate above only catches Max-tier picks the user *clicks*. A
  // non-Max account can also boot with the Max tier already saved as the
  // default (picked during setup, or left over after a plan downgrade). The
  // portal gateway then silently rejects every turn — the user only sees the
  // opaque "[assistant turn failed]". Catch that on load: explain it with an
  // upgrade link and drop to the Pro tier the plan supports so chat works.
  const tierGuardRef = useRef(false)
  useEffect(() => {
    if (tierGuardRef.current || clawboxLogin.loading) return
    const active = chatModelState?.activeModel
    if (!active || !isClawboxAiProModel(active) || clawboxLogin.tier === 'pro') return
    tierGuardRef.current = true
    setMessages(prev => [...prev, {
      role: 'system',
      text: `Max Tier needs a Max subscription. [Upgrade in the ClawBox portal](${PORTAL_DASHBOARD_URL}) to unlock it — switching you to Pro Tier so chat keeps working.`,
      timestamp: Date.now(),
      variant: 'error',
    }])
    void switchChatModel({ model: CLAWBOX_AI_MODEL_BY_TIER.flash, label: 'Pro Tier' })
  }, [chatModelState?.activeModel, clawboxLogin.tier, clawboxLogin.loading, switchChatModel])

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

  // Seed (or RE-seed) the Hermes header: which providers this device can
  // actually talk to, what it is configured to use, and its effort level. The
  // per-provider MODEL list is not fetched here — it comes from the scoped hook
  // above, which re-asks the server whenever the provider changes. Device
  // config is the floor; localStorage is the preference.
  //
  // Safe to re-run: every in-session choice is mirrored into localStorage by the
  // change* callbacks, and those prefs win here, so a re-sync preserves the
  // user's picks while picking up new credentials / a new device pairing.
  //
  // LATEST SEED WINS. Seeds overlap now that three call sites emit the
  // invalidation (a device login, an OAuth return and a Save can land within a
  // second of each other, and the mount seed can still be in flight when the
  // first event arrives). They all hit the same route, so a slower EARLIER
  // response can resolve last and reinstate the provider list, device model and
  // selection the newer one just replaced — the same "a stale provider wins"
  // failure the model pill guards against, reached through a different door.
  // Each seed therefore takes a generation, cancels the one it supersedes, and
  // writes only if it is still the newest when its answer lands.
  const seedGenerationRef = useRef(0)
  const seedControllerRef = useRef<AbortController | null>(null)

  const seedHermesHeader = useCallback(async (signal?: AbortSignal) => {
    const generation = ++seedGenerationRef.current
    seedControllerRef.current?.abort()
    const controller = new AbortController()
    seedControllerRef.current = controller
    // The caller's signal still cancels this seed (unmount, harness switch).
    const abortThis = () => controller.abort()
    if (signal?.aborted) abortThis()
    else signal?.addEventListener('abort', abortThis)
    try {
      const mRes = await fetch('/setup-api/hermes/models', { cache: 'no-store', signal: controller.signal })
      const mData = await mRes.json() as {
        providers?: { id?: unknown; name?: unknown; authenticated?: unknown }[]
        provider?: unknown
        current?: unknown
        reasoning?: unknown
      }
      // `aborted` alone is not enough: a response can resolve before the abort
      // lands, and `json()` adds a second await for a newer seed to start in.
      if (controller.signal.aborted || generation !== seedGenerationRef.current) return
      // Offer only providers Hermes has credentials for (`authenticated:
      // false` rows would give an empty model list and a failing turn).
      // `null` means the source couldn't tell — keep those.
      const rows: HermesChatProvider[] = (Array.isArray(mData?.providers) ? mData.providers : [])
        .filter(p => typeof p?.id === 'string' && p.id && p.authenticated !== false)
        .map(p => ({
          id: p.id as string,
          name: typeof p.name === 'string' ? p.name : (p.id as string),
        }))
      const deviceProvider = typeof mData?.provider === 'string' ? mData.provider : ''
      const deviceModel = typeof mData?.current === 'string' ? mData.current : ''
      // The configured provider always belongs in the list even if Hermes
      // reports it unauthenticated — it is what this chat is running on,
      // so the header must be able to show it.
      if (deviceProvider && !rows.some(r => r.id === deviceProvider)) {
        rows.unshift({ id: deviceProvider, name: deviceProvider })
      }
      setHermesProviders(rows)
      setHermesDevice({ provider: deviceProvider, model: deviceModel })

      const prefs = readHermesChatPrefs()
      // A remembered provider only wins while it is still on offer.
      setHermesProvider(
        (prefs.provider && rows.some(r => r.id === prefs.provider) ? prefs.provider : '')
        || deviceProvider
        || rows[0]?.id
        || '',
      )
      if (prefs.models) setHermesPicks(prefs.models)
      const knownReasoning = prefs.reasoning
        ?? (isHermesReasoningLevel(mData?.reasoning) ? mData.reasoning : null)
      hermesReasoningKnownRef.current = knownReasoning !== null
      setHermesReasoning(knownReasoning ?? HERMES_REASONING_DEFAULT)
    } catch { /* header falls back to a plain label */ }
    finally {
      signal?.removeEventListener('abort', abortThis)
      if (seedControllerRef.current === controller) seedControllerRef.current = null
    }
  }, [])

  // Resolve the active harness once, before connecting, so we never open the
  // OpenClaw WS in Hermes mode.
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const data = await fetchHarness({ signal: controller.signal })
        if (!controller.signal.aborted && data?.active === 'hermes') {
          harnessRef.current = 'hermes'
          setHarnessMode('hermes')
          await seedHermesHeader(controller.signal)
        }
      } catch {
        // default to openclaw
      }
      if (!controller.signal.aborted) setHarnessLoaded(true)
    })()
    return () => { controller.abort() }
  }, [seedHermesHeader])

  // Re-seed when the settings panel changes the device's provider/model/tier or
  // adds a credential. Without this the header keeps naming the OLD provider
  // for the rest of the session — and a provider the user just connected never
  // reaches the picker at all. `hermesDevice` is also the sole basis for the
  // "safe to send --provider without -m" decision, so a stale copy either
  // blocks a legal turn or lets the route answer 409.
  //
  // This is the plain unscoped GET, which is what makes the invalidation cheap:
  // the per-provider model lists are NOT re-enumerated here, they stay with the
  // scoped hook above.
  //
  // The controller here only stops seeds once this effect is torn down; ORDER
  // between overlapping seeds is not its job (one controller shared by every
  // event could not do that anyway) and is handled by the generation guard in
  // `seedHermesHeader`.
  useEffect(() => {
    if (harnessMode !== 'hermes') return
    const controller = new AbortController()
    const onChanged = () => { void seedHermesHeader(controller.signal) }
    window.addEventListener(HERMES_MODEL_STATE_EVENT, onChanged)
    return () => {
      controller.abort()
      window.removeEventListener(HERMES_MODEL_STATE_EVENT, onChanged)
    }
  }, [harnessMode, seedHermesHeader])

  // Pre-warm the connection on mount so opening chat is instant. In OpenClaw
  // mode this silently completes the gateway WS handshake; in Hermes mode
  // connect() just marks connected (no WS). Gated on the harness resolving.
  useEffect(() => {
    if (!harnessLoaded) return
    connect()
  }, [connect, harnessLoaded])

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
    } else {
      setVisible(false)
    }
  }, [isOpen])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close()
      wsRef.current = null
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      if (ackOnlyHistoryTimerRef.current !== null) {
        window.clearTimeout(ackOnlyHistoryTimerRef.current)
        ackOnlyHistoryTimerRef.current = null
      }
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
  const [reloadReason, setReloadReason] = useState<'skill' | 'provider' | 'restart'>('skill')
  // Duplicate of reloadReason behind a ref because the WebSocket `hello`
  // resolve callback is created once (inside a useCallback with [] deps)
  // and captures whatever reloadReason state was at mount time —
  // without this ref, the `wasProviderChange` branch would never fire
  // because the state update from the event handler doesn't propagate
  // into that frozen closure.
  const reloadReasonRef = useRef<'skill' | 'provider' | 'restart'>('skill')
  const reloadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Drives the reload overlay's progress bar from 0 toward 90% (it parks at
  // 90 until the gateway answers, then the resolve callback completes it to
  // 100). Shared by the skill/provider event handlers and the onClose restart
  // path so the easing curve stays in one place.
  const startReloadProgressTimer = useCallback(() => {
    // The reload bar is now driven by a compositor-only CSS transform animation
    // (`clawReloadFill`, see the overlay below) instead of a JS setInterval.
    // The old timer fired setReloadProgress every 200ms, and on the Jetson —
    // where switching provider restarts the gateway and pins the CPU — those
    // React re-renders plus the `width` transition (which forces layout every
    // frame) made the bar visibly stutter. A transform:scaleX keyframe runs on
    // the compositor thread and stays smooth even while the main thread is busy.
    // We keep `reloadProgress` purely as the 0→100 completion signal. Just clear
    // any stale timer from an older reload path.
    if (reloadTimerRef.current) {
      clearInterval(reloadTimerRef.current)
      reloadTimerRef.current = null
    }
  }, [])
  // Tear the reconnect overlay down and reset the reload flags. Called from
  // every terminal-failure path (both retry-exhaustion branches) so the error
  // panel — gated on `!reloadingSkill` — can render and the safety-net retry
  // effect (which fires on `error && reloadingSkill`) stops looping.
  const tearDownReloadOverlay = useCallback(() => {
    if (reloadTimerRef.current) {
      clearInterval(reloadTimerRef.current)
      reloadTimerRef.current = null
    }
    skillInstalledRef.current = false
    reloadReasonRef.current = 'skill'
    setReloadingSkill(false)
    setReloadProgress(0)
  }, [])
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
      startReloadProgressTimer()
    }
    // A skill install signals the gateway to restart (SIGUSR1), which drops the
    // WS shortly after this event fires. We deliberately do NOT force a
    // reconnect here (unlike the provider path below): the install route does
    // not await the restart, so the WS is still up when this runs and the
    // natural onClose → reconnect → resolve path delivers the post-restart
    // `hello` that clears the overlay and auto-sends the skill-confirm message.
    // Forcing a reconnect here instead races the restart and the auto-send
    // lands on a dead socket.
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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- connect is stable (useCallback [])

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

  // macOS-style open: grow the popup OUT of the mascot. The transform-origin
  // is pinned to the popup's bottom edge, horizontally aligned with the
  // mascot, so the scale animation emanates from where the user tapped
  // instead of from the popup's centre.
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1000
  const mascotCenterPx = ((mascotX ?? 85) / 100) * winW
  const anchorLeft = pos ? pos.x : (trayMode ? winW - size.w - 8 : defaultLeft)
  const originX = Math.max(20, Math.min(mascotCenterPx - anchorLeft, size.w - 20))
  const transformOrigin = panelMode ? 'right center' : mobile ? 'center bottom' : `${originX}px bottom`

  const greetingPending = isBootstrappingHistory || (sending && messages.length === 0)

  return (
    <div
      data-testid="chat-popup"
      ref={popupRef}
      style={{
        position: 'fixed',
        ...posStyle,
        ...(panelMode
          ? { width: panelWidth, minWidth: MIN_CHAT_WIDTH, height: 'auto', maxHeight: 'none', borderRadius: 0 }
          : mobile
            ? { width: 'auto', height: 'auto', maxHeight: 'none', borderRadius: 0 }
            : {
                width: size.w,
                minWidth: MIN_CHAT_WIDTH,
                height: size.h,
                // The un-dragged popup is anchored from the BOTTOM (bottom:170
                // above the mascot / bottom:65 in tray mode), so the height
                // budget must subtract that anchor too — the old flat
                // `100vh - 60px` let a 500px-tall popup shove its header (pills,
                // close button) off the TOP of short/zoomed viewports, which
                // looked completely broken. Reserve anchor + 12px top margin.
                maxHeight: pos
                  ? 'calc(100vh - 60px)'
                  : trayMode
                    ? 'calc(100vh - 77px)'
                    : 'calc(100vh - 182px)',
                borderRadius: 16,
              }),
        zIndex: 10010,
        overflow: 'hidden',
        boxShadow: panelMode ? '-4px 0 20px rgba(0,0,0,0.4), -1px 0 0 rgba(255,255,255,0.08)' : mobile ? 'none' : '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
        background: '#0d1117',
        display: 'flex',
        flexDirection: 'column',
        transformOrigin,
        opacity: visible ? 1 : 0,
        // Resting transform. On desktop the entrance is driven by the
        // `clawChatBurstIn` keyframes below (a spring burst OUT of the mascot
        // with an overshoot, a tilt-wobble and an orange energy-glow flash),
        // which override this while playing and settle back onto scale(1).
        // Mobile keeps its clean slide-up; a drag pins it to the resting state.
        transform: visible ? 'scale(1) translateY(0)' : (mobile ? 'translateY(100%)' : 'scale(0.72) translateY(14px)'),
        animation: (visible && !mobile && !dragRef.current)
          ? 'clawChatBurstIn 0.62s cubic-bezier(0.34, 1.56, 0.64, 1) both'
          : undefined,
        // Mobile / drag still use a transition; the desktop entrance is the
        // keyframe animation, so we only transition opacity there to avoid
        // fighting it. No transition mid-drag so the window tracks 1:1.
        transition: dragRef.current
          ? 'none'
          : mobile
            ? 'opacity 0.2s ease, transform 0.42s cubic-bezier(0.22, 1.28, 0.36, 1)'
            : 'opacity 0.18s ease',
        pointerEvents: visible ? 'auto' : 'none',
        willChange: 'transform, opacity',
      }}
    >
      {/* Spring burst out of the mascot: overshoot + tilt-wobble, transform +
          opacity only. transform-origin (set on the container) pins it to where
          the crab is. The previous version also tweened filter:blur/brightness/
          drop-shadow every frame — a full-layer repaint per frame that dropped
          frames on the Jetson iGPU (esp. while chat is connecting). The
          transform spring already carries the "erupt and settle" feel. */}
      <style>{`@keyframes clawChatBurstIn {
        0%   { opacity: 0; transform: scale(0.12) translateY(38px) rotate(-8deg); }
        45%  { opacity: 1; transform: scale(1.08) translateY(-6px) rotate(2.4deg); }
        65%  { transform: scale(0.965) translateY(3px) rotate(-1.4deg); }
        82%  { transform: scale(1.015) translateY(-1px) rotate(0.5deg); }
        100% { opacity: 1; transform: scale(1) translateY(0) rotate(0deg); }
      }`}</style>
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
        <div className="chat-header-pills">
          {harnessMode === 'hermes' ? (
            // Same three pills, same order and widths as the OpenClaw branch
            // below — provider → model (scoped to it) → thinking effort. The
            // row is 262px at the 400px docked default, of which ~142px is
            // label text, so every pill label is de-duplicated against its
            // neighbour (see src/lib/chat-header-pills.ts) to fit un-truncated.
            // Below ~386px they still truncate with "…" rather than wrap (see
            // .chat-header-pills in globals.css); the popovers keep full text.
            // Falls back to a plain label until the catalogue loads.
            hermesProviders.length > 0 ? (
              <>
                <HeaderDropdown
                  ariaLabel="Chat provider"
                  value={hermesProvider}
                  triggerLabel={hermesProviderPill}
                  options={hermesProviders.map(p => ({ id: p.id, label: hermesProviderName(p.id) }))}
                  onChange={changeHermesProvider}
                  onPointerDown={stopHeaderDrag}
                  triggerMaxWidth={130}
                  popoverWidth={220}
                />
                {/* Hidden at a single option, matching the OpenClaw rule — a
                    one-entry picker is noise. That is today's ClawBox AI case:
                    its proxy serves exactly the one model of the active tier. */}
                {showModelPill && (
                  <HeaderDropdown
                    ariaLabel="Hermes model"
                    /* While the new provider's list loads there is no model to
                       name yet — an ellipsis holds the pill's place rather than
                       showing the previous provider's id, which would be wrong
                       for a beat and is the mistake worth avoiding. */
                    disabled={hermesModelsLoading}
                    value={hermesModelsLoading ? '' : hermesModel}
                    /* Trigger shows the model WITHOUT whatever the provider pill
                       immediately to its left already says — "claude-fable-5"
                       next to "Claude" is "fable-5". At the docked width the
                       repeated vendor was eating the part that distinguishes one
                       model from another ("claude-fable-5" → "claude-fab…").
                       The popover keeps the full id. */
                    triggerLabel={hermesModelsLoading ? '…' : shortModelPillLabel(hermesModel, hermesProviderPill)}
                    options={(hermesScope?.models ?? []).map(m => ({ id: m.id, label: m.id }))}
                    onChange={changeHermesModel}
                    onPointerDown={stopHeaderDrag}
                    triggerMaxWidth={140}
                    /* Wider than OpenClaw's 240: Hermes ids are long
                       `vendor/model` slugs. */
                    popoverWidth={280}
                  />
                )}
                {/* `hermes --reasoning` takes the same eight levels for every
                    provider, but the CLI accepting a level is not the same as
                    the backend doing anything with it — so the level list is
                    per-provider and a provider with nothing to offer gets no
                    pill at all.

                    The on-device model is the two-state case: its backend
                    ignores `reasoning_effort` (which is why this pill used to
                    be hidden for it) but does honour a thinking switch per
                    request, with no graded middle to expose. So it shows two
                    options, not eight, and the labels say what they do rather
                    than borrowing the effort scale's vocabulary. */}
                {hermesReasoningOptions.length > 0 && (
                  <HeaderDropdown
                    ariaLabel={hermesBinaryReasoning ? 'Thinking' : 'Reasoning effort'}
                    value={hermesEffectiveReasoning}
                    /* Brain glyph instead of a "Thinking: " word prefix — see
                       REASONING_PILL_ICON. The word cost 55px of a 142px row
                       and truncated the level away; the glyph costs ~11px. */
                    triggerLabel={hermesReasoningTriggerLabel(hermesEffectiveReasoning)}
                    triggerIcon={REASONING_PILL_ICON}
                    options={hermesReasoningOptions.map(level => ({
                      id: level,
                      label: hermesReasoningLabel(level),
                      /* Thinking on this model is ~25x slower on a short
                         question (measured: 0.2s vs 8.4s). A dial that hides
                         that is a dial that surprises people.
                         `isThinkingOnLevel` is the SAME predicate the proxy
                         uses to set enable_thinking — deriving "is on" here
                         instead (e.g. "the last option") would let this hint
                         and the wire behaviour drift apart silently. */
                      hint: hermesBinaryReasoning
                        ? (isThinkingOnLevel(hermesProvider, level)
                          ? 'Better at reasoning. Much slower.'
                          : 'Fastest. Answers immediately.')
                        : undefined,
                    }))}
                    onChange={changeHermesReasoning}
                    onPointerDown={stopHeaderDrag}
                    triggerMaxWidth={120}
                    popoverWidth={hermesBinaryReasoning ? 230 : 180}
                  />
                )}
              </>
            ) : (
              <span className="header-dropdown-trigger" style={{ cursor: 'default', maxWidth: 130 }}>Hermes</span>
            )
          ) : (<>
          {chatModelState && (() => {
            const activeId = chatModelState.activeOptionId ?? chatModelState.options[0]?.id ?? ''
            const activeOption = chatModelState.options.find(o => o.id === activeId)
            const triggerLabel = activeOption ? getProviderPillText(activeOption) : activeId
            return (
              <HeaderDropdown
                ariaLabel="Chat provider"
                value={activeId}
                triggerLabel={triggerLabel}
                options={chatModelState.options.map((option) => ({
                  id: option.id,
                  label: getChatModelOptionText(option),
                }))}
                onChange={handleChatSourceChange}
                onPointerDown={stopHeaderDrag}
                disabled={switchingModel}
                triggerMaxWidth={130}
                popoverWidth={220}
              />
            )
          })()}
          {(() => {
            // Inline model switcher: renders next to the provider dropdown
            // whenever the active provider has multiple available models.
            // Lets users hot-swap between Claude Haiku/Sonnet/Opus, GPT
            // variants, Gemini variants, or OpenRouter's 340+ models
            // mid-chat without opening Settings. If the current model
            // isn't in the live catalog (custom ID typed in Settings),
            // we prepend it as a "Custom" entry so the select reflects
            // reality.
            //
            // The catalog is the live one from /setup-api/ai-models/catalog
            // (kept in sync via the useEffect above), with the static
            // fallback as cold-start render. Used to be a hand-curated
            // array that rotted on every upstream rename — see the comment
            // at the top of provider-models.ts for the migration history.
            if (!chatModelState) return null
            const activeOption = chatModelState.options.find(
              (option) => option.id === chatModelState.activeOptionId,
            )
            if (!activeOption?.provider) return null
            const catalog = chatProviderCatalog
            if (!catalog) return null
            // Show the dropdown when there are multiple models to pick OR
            // the catalog permits a custom model id (then the picker
            // surfaces a "type your own" affordance, which is the only way
            // to switch to a different Claude variant when Anthropic's
            // OAuth scope returned a single canonical model).
            if (catalog.models.length < 2 && !catalog.allowCustom) return null
            // ClawBox AI's wire-format provider is `deepseek` (Mike's
            // gateway forwards to DeepSeek's API), while the UI normalizes
            // to `clawai`. Try the canonical provider first, then fall
            // back to the deepseek alias so the picker can resolve the
            // active model id either way.
            let activeModelId = extractProviderModelId(
              chatModelState.activeModel,
              activeOption.provider,
            )
            if (!activeModelId && activeOption.provider === 'clawai') {
              activeModelId = extractProviderModelId(chatModelState.activeModel, 'deepseek')
            }
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
            // Same de-duplication as the Hermes branch: the provider pill to
            // the left already says "Claude", so this pill shows "Sonnet 4.6",
            // not "Claude Sonnet 4.6". The popover keeps the full label.
            const activeModelLabel = modelOptions.find(o => o.id === activeModelId)?.label
              ?? activeModelId
            return (
              <HeaderDropdown
                ariaLabel={`${activeOption.label} model`}
                value={activeModelId}
                triggerLabel={shortModelPillLabel(
                  activeModelLabel,
                  getProviderPillText(activeOption),
                )}
                options={modelOptions.map(option => ({
                  id: option.id,
                  label: option.label,
                  hint: option.hint,
                }))}
                onChange={(nextId) => {
                  if (nextId === activeModelId) return
                  // Wire-format provider for ClawBox AI is `deepseek`
                  // (Mike's gateway routes via DeepSeek). Sending
                  // `clawai/...` would be rejected by the gateway as
                  // an unknown provider.
                  const wireProvider = activeOption.provider === 'clawai'
                    ? 'deepseek'
                    : activeOption.provider
                  void switchChatModel({
                    model: `${wireProvider}/${nextId}`,
                    label: nextId,
                  })
                }}
                onPointerDown={stopHeaderDrag}
                disabled={switchingModel}
                triggerMaxWidth={140}
                popoverWidth={240}
              />
            )
          })()}
          {/* Per-provider effort levels — see REASONING_BY_PROVIDER for
              the upstream-API-accurate set per provider. The wire vocabulary
              is the OpenClaw gateway's full union; the gateway translates
              per-provider (DeepSeek `xhigh`→`max`, Google `adaptive`→
              `thinking_budget=-1`, etc.). Hidden entirely for providers with
              no real reasoning choice (off-only, e.g. local Gemma) — a
              single-option dropdown is pointless and picking a level errors at
              the gateway ("thinkingLevel … not supported for llamacpp/gemma…"). */}
          {visibleThinkingLevels.length > 1 && (
            <HeaderDropdown
              ariaLabel="Reasoning effort"
              value={effectiveThinkingLevel}
              options={visibleThinkingLevels.map(level => ({
                id: level,
                label: THINKING_LEVEL_LABELS[level] ?? level,
              }))}
              onChange={handleThinkingLevelChange}
              onPointerDown={stopHeaderDrag}
              /* Brain glyph instead of a "Thinking: " word prefix — see
                 REASONING_PILL_ICON. */
              triggerLabel={THINKING_LEVEL_LABELS[effectiveThinkingLevel] ?? effectiveThinkingLevel}
              triggerIcon={REASONING_PILL_ICON}
              triggerMaxWidth={120}
              popoverWidth={180}
            />
          )}
          </>)}
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
        {(status === 'connecting' || reloadingSkill) && (reloadingSkill || messages.length === 0) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 14, color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } } @keyframes dots { 0%,20% { content: '' } 40% { content: '.' } 60% { content: '..' } 80%,100% { content: '...' } } @keyframes clawReloadFill { from { transform: scaleX(0.04) } to { transform: scaleX(0.9) } }`}</style>
            {reloadingSkill ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, width: '85%' }}>
                <div style={SPINNER_STYLE} />
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, width: '100%' }}>
                  <span>{reloadReason === 'provider' ? 'Switching AI provider...' : reloadReason === 'restart' ? 'Restarting chat...' : 'Reloading skills...'}</span>
                  <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={reloadProgress >= 100 ? 100 : undefined} aria-busy={reloadProgress < 100} aria-label="Reload progress" style={{ width: '100%', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    {/* Compositor-only fill: a transform:scaleX keyframe eases
                        0→90% and holds; when the gateway answers (reloadProgress
                        hits 100) we drop the animation and transition to full.
                        No JS ticks, no width/layout thrash — stays smooth even
                        while the box is pinned restarting the gateway. */}
                    <div style={{
                      height: '100%', width: '100%', borderRadius: 2, background: '#f97316',
                      transformOrigin: 'left',
                      transform: reloadProgress >= 100 ? 'scaleX(1)' : 'scaleX(0.04)',
                      transition: reloadProgress >= 100 ? 'transform 0.3s ease-out' : undefined,
                      animation: reloadProgress >= 100 ? undefined : 'clawReloadFill 14s cubic-bezier(0.16, 1, 0.3, 1) forwards',
                      willChange: 'transform',
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

        {!reloadingSkill && <ToolCallPills toolCalls={toolCalls} runningLabel={t("chat.running")} />}

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

        {queuedSends.map((q) => (
          <div key={q.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{
              maxWidth: '85%', padding: '7px 12px',
              borderRadius: '14px 14px 4px 14px',
              background: 'rgba(249,115,22,0.25)',
              color: 'rgba(255,255,255,0.7)',
              fontSize: 13, lineHeight: 1.4, wordBreak: 'break-word',
              display: 'flex', alignItems: 'center', gap: 8,
              border: '1px dashed rgba(249,115,22,0.4)',
            }}>
              <span style={{ flex: 1 }}>{q.text}</span>
              <button
                onClick={() => cancelQueuedSend(q.id)}
                title={t("cancel")}
                aria-label={t("cancel")}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'rgba(255,255,255,0.5)', padding: 0, lineHeight: 1,
                  fontSize: 14, fontWeight: 700,
                }}
              >×</button>
            </div>
          </div>
        ))}

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
        {/* Hermes chat is text-only (the `hermes -z` CLI takes no attachments),
            so hide the attach control there — otherwise a user could attach a
            file that startRun silently drops on the Hermes path. */}
        {harnessMode !== 'hermes' && (
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
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            status !== 'connected'
              ? t("chat.connectingPlaceholder")
              : greetingPending
                ? t("chat.greetingPlaceholder")
                : t("chat.messagePlaceholder")
          }
          // Block input while the WS handshake is still in flight. Allowing
          // sends during 'connecting' caused them to queue behind a busy
          // gateway loop and feel broken to users — better to clearly gate
          // the input until the connection is ready.
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
            disabled={(!input.trim() && attachments.length === 0) || status === 'error'}
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
