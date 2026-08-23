'use client'

import React, { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'
import { createPortal } from 'react-dom'

// ── Gateway WebSocket chat widget ──
// Connects directly to the OpenClaw gateway, no iframe.

import {
  uuid,
  type ChatMessage as BaseChatMessage,
} from '@/lib/chat-history-cache'
import { useChatToolCalls, ToolCallPills, ToolCallSummaryChips, isImageGenerationTool } from '@/lib/chat-tool-events'
import { ReasoningDisclosure } from '@/lib/chat-reasoning-disclosure'
import { FIX_ERROR_EVENT, buildFixErrorPrompt, type FixErrorContext } from '@/lib/ui-events'
import { isSentinel, isInterSessionEnvelope } from '@/lib/chat-sentinels'
import { useModalDialog } from '@/hooks/useModalDialog'
// ── The harness transport ──
// One adapter, both editions. This surface asks `caps` what the box can do and
// `adapter` to do it; the only thing left that knows WHICH harness is running
// is the provider/model header, which renders a different vendor's catalogue
// and is product identity rather than a capability.
import { useHarnessAdapter } from '@/lib/harness/use-harness-adapter'
import { shouldPatchSessionDefaults } from '@/lib/harness/capabilities'
import { extractText, boundedAudio, type GatewayLink } from '@/lib/harness/openclaw-gateway-adapter'
import { HarnessError, type HarnessStatus, type TurnResult } from '@/lib/harness/transport'
import { splitMediaDirectives, splitAssistantMedia, mediaFileName, mediaUrl, isImageMedia, extractAudioAttachments } from '@/lib/chat-media'
import {
  IDLE_STATUS,
  MAX_RECORDING_MS,
  classifyCaptureError,
  describeTranscribeFailure,
  formatRecordingClock,
  pickRecordingMimeType,
  recordingFileName,
  type VoiceStatus,
} from '@/lib/chat-voice-input'
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

const MAX_RETRIES = 8
const MAX_QUEUED_SENDS = 20
// The server gives its upstream two minutes. Leave enough room for the upload
// and response body, while still guaranteeing that a browser-side stall ends
// in the existing retry UI instead of spinning forever.
const VOICE_TRANSCRIBE_TIMEOUT_MS = 180_000
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

// The chat used to clip up to two sentences out of every assistant reply into
// `clawbox-mascot-convo-lines` so the crab could quote them back. It has been
// removed: the snippets were whatever language the assistant happened to
// answer in (and whatever the user happened to be discussing), so they leaked
// into a mascot bag that must be in the UI locale. The server deletes the
// legacy KV key on first read.

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

/**
 * Accessible name for a spoken reply's player.
 *
 * The message body is already on screen and already read by the message
 * itself, so this is a short identifying fragment, not a second copy — but it
 * has to be there: a transcript can hold several players, and "audio" three
 * times over tells a screen-reader user nothing about which is which.
 */
function audioLabel(text: string | undefined, prefix: string): string {
  const spoken = text ? plainTextForLabel(text, 100) : "";
  return spoken ? `${prefix}: ${spoken}` : prefix;
}

function getProviderPillText(option: ChatModelState['options'][number]): string {
  const full = getChatModelOptionText(option)
  if (!option.available) return full
  return PROVIDER_PILL_LABEL[option.label ?? ''] ?? full
}

import { renderText, plainTextForLabel } from '@/lib/chat-markdown'
import { extractImageFilesFromClipboard } from '@/lib/clipboard'
import {
  attachmentAcceptAttribute,
  type ChatAttachment,
  classifyStagingFailure,
  createPreviewUrl,
  isPreviewableImage,
  partitionAttachments,
  revokePreviews,
  type StagingFailure,
} from '@/lib/chat-attachments'
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
import { CloudTtsWarning } from '@/components/CloudTtsWarning'
import { shortModelPillLabel, REASONING_PILL_ICON } from '@/lib/chat-header-pills'

// ── Waiting for a generated picture ─────────────────────────────────────────
//
// `image_generate` returns as soon as the job is QUEUED, so its tool pill goes
// green long before there is anything to show. The picture lands 20-40s later
// in a SEPARATE background run, and that run's reply reaches this socket with
// its MEDIA: directive already stripped — which is why the image only appeared
// after a manual refresh: `chat.history` returns the stored text, directive
// intact, and the reload was the only thing ever asking for it.
//
// So the banner stays up from the tool call until the picture actually appears.
// Finding it is push-driven: the gateway's `session.message` event fires on
// every transcript append and carries the stored text, directive intact.
// Only a backstop: `session.message` pushes the append the moment it lands, so
// this exists for a gateway too old to have the subscription (or one that
// dropped the event as slow) — not as the normal path.
const IMAGE_GEN_BACKSTOP_MS = 20_000
const IMAGE_GEN_MAX_WAIT_MS = 4 * 60_000

// A reconcile usually returns a transcript identical to the one on screen.
// Handing React a fresh array anyway re-renders the whole list and re-fires the
// auto-scroll, which would yank a user who had scrolled up back to the bottom.
function sameTranscript(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x.role !== y.role || x.text !== y.text || x.timestamp !== y.timestamp) return false
    if ((x.images?.length ?? 0) !== (y.images?.length ?? 0)) return false
    // Without this a reply that gained its spoken half between two history
    // reads compares equal, React skips the render, and the player never
    // appears until something else forces one. Compared by URL and not only by
    // count: a reply whose recording was replaced keeps the count and changes
    // the file, and a player left pointing at the old one plays the wrong
    // words convincingly.
    const xa = x.audio ?? [], ya = y.audio ?? []
    if (xa.length !== ya.length) return false
    for (let j = 0; j < xa.length; j++) if (xa[j] !== ya[j]) return false
  }
  return true
}

/** The gateway suffixes its stored copy by role; the client holds the bare run id. */
function runIdOf(key: string | undefined): string | undefined {
  if (!key) return undefined
  return key.endsWith(':user') ? key.slice(0, -':user'.length) : key
}

/**
 * Which locally-appended user turns the server has NOT echoed back yet.
 *
 * A turn is added to the transcript the moment it is sent, so a history read
 * that lands before the write completes must not erase it. Deciding that by
 * timestamp alone is not possible: the local copy is stamped with the browser's
 * clock and the server's with the device's, and a browser running ahead makes
 * every local copy look newer than everything the server returned.
 *
 * Identity settles it — both sides carry the run's idempotency key. Text is
 * kept only as the fallback for turns without one (other harnesses, older
 * gateways), and cannot be the primary test: an attachment turn displays
 * "📎 pic.png\nwhat is this" locally while the gateway stores the prompt alone.
 */
export function unechoedUserTurns(
  previous: ChatMessage[],
  restored: ChatMessage[],
  lastServerTs: number,
): ChatMessage[] {
  const serverRunIds = new Set<string>()
  // Per-text stock of server copies. Counting rather than a boolean so the
  // same words sent twice keep the second bubble.
  const unclaimed = new Map<string, number>()
  for (const message of restored) {
    if (message.role !== 'user') continue
    const runId = runIdOf(message.idempotencyKey)
    if (runId) serverRunIds.add(runId)
    unclaimed.set(message.text, (unclaimed.get(message.text) ?? 0) + 1)
  }
  const claimText = (text: string): boolean => {
    const left = unclaimed.get(text) ?? 0
    if (left <= 0) return false
    unclaimed.set(text, left - 1)
    return true
  }
  const pending: ChatMessage[] = []
  for (const message of previous) {
    if (message.role !== 'user') continue
    const runId = runIdOf(message.idempotencyKey)
    if (runId && serverRunIds.has(runId)) {
      // Also spend this text's stock, so a later identical turn is not matched
      // against the copy this one already accounted for.
      claimText(message.text)
      continue
    }
    if (claimText(message.text)) continue
    // Nothing on the server matches. Keep it only if it is newer than the whole
    // replay — an older unmatched turn has aged out of the history window and
    // re-appending it would put it back in the wrong place.
    if (message.timestamp > lastServerTs) pending.push(message)
  }
  return pending
}

// A live TTS supplement can arrive before an older gateway's history
// projection learns about it. Carry players across that short reconcile by
// message occurrence, never by a text->audio map: common replies such as
// "Sure." may appear many times, and one map entry would put the newest
// recording on every identical bubble.
function preserveSpokenByOccurrence(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  const restored = next.map(message => ({ ...message }))
  const used = new Set<number>()
  for (let i = previous.length - 1; i >= 0; i--) {
    const prior = previous[i]
    if (prior.role !== 'assistant' || !prior.audio?.length) continue
    let target = -1
    if (prior.timestamp > 0) {
      target = restored.findIndex((candidate, index) =>
        !used.has(index) && candidate.role === 'assistant'
        && candidate.timestamp === prior.timestamp && candidate.text === prior.text)
      if (target !== -1) {
        // Durable transcript recovery may already have filled this exact
        // occurrence. Treat that as the match even though there is nothing to
        // copy; falling through would clone the same recording onto a later
        // identical reply.
        if (!restored[target].audio?.length) {
          restored[target] = { ...restored[target], audio: boundedAudio(prior.audio) }
        }
        used.add(target)
        continue
      }
    }
    for (let j = restored.length - 1; j >= 0; j--) {
      const candidate = restored[j]
      if (prior.text.length > 0 && !used.has(j) && candidate.role === 'assistant' && !candidate.audio?.length
          && candidate.text === prior.text) {
        target = j
        break
      }
    }
    if (target !== -1) {
      restored[target] = { ...restored[target], audio: boundedAudio(prior.audio) }
      used.add(target)
    }
  }
  return restored
}

function finiteMessageTimestamp(message: unknown): number | null {
  if (!message || typeof message !== 'object') return null
  const timestamp = (message as { timestamp?: unknown }).timestamp
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : null
}

// The newest server timestamp currently on screen — the line a later message
// has to be after to belong to the wait that starts now.
function newestTimestamp(msgs: ChatMessage[]): number {
  let newest = 0
  for (const m of msgs) if (m.timestamp > newest) newest = m.timestamp
  return newest
}

function countImages(msgs: ChatMessage[]): number {
  let total = 0
  for (const m of msgs) total += m.images?.length ?? 0
  return total
}

// The two controls floating over the full-size preview (download, close).
const PREVIEW_BUTTON_STYLE: React.CSSProperties = {
  width: 38, height: 38, borderRadius: 10, border: 'none',
  background: 'rgba(255,255,255,0.12)', color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  textDecoration: 'none', backdropFilter: 'blur(6px)',
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
  // Read when a wait begins, to know what "a new picture" means.
  const messagesRef = useRef<ChatMessage[]>([])
  // Debounce for the pushed-append reconcile, and a stable handle on it — the
  // socket handler is built once and must not close over a stale callback.
  const transcriptReconcileTimerRef = useRef<number | null>(null)
  const reconcileTranscriptRef = useRef<() => Promise<void>>(async () => {})
  // Mirrors `generatingImage` for the socket handler and the reconcile, neither
  // of which re-subscribes when it changes.
  const generatingImageRef = useRef(false)
  // Set when a history read passes an envelope saying the image job failed.
  // A failed job produces no picture, so the count check that normally ends the
  // wait would never fire and the banner would sit there until it timed out.
  const imageFailedRef = useRef(false)
  // Timestamp the current wait started from; anything at or before it is a
  // previous generation's outcome, not this one's.
  const imageWaitFromRef = useRef(0)
  // Which agent harness backs this chat is resolved by `useHarnessAdapter`
  // below, together with what this box can actually do. Nothing here keeps its
  // own copy: a second source of truth for the harness is what let the
  // capability answer and the transport answer drift apart in the first place.
  // Hermes chat header — the same three controls the OpenClaw header has:
  // PROVIDER → MODEL (scoped to that provider) → THINKING EFFORT.
  //
  // All three are PER-INVOCATION overrides: `hermes -z --provider/--reasoning`
  // are documented as "for this invocation", so changing a pill never rewrites
  // config.yaml. The Hermes settings panel stays the only thing that persists a
  // device default; these choices persist in localStorage instead.
  //
  // Refs mirror the state so the send path can stay a stable useCallback([])
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
  // The threaded session id and the provider/model the last turn ran on used to
  // live here. They describe what the TRANSPORT did, not what the header shows,
  // and holding them in the component is what forced "new chat" to reach into
  // transport state to clear them. They belong to the adapter now; resetting a
  // conversation is one call.
  const [hermesReasoning, setHermesReasoning] = useState<HermesReasoningLevel>(HERMES_REASONING_DEFAULT)
  const hermesReasoningRef = useRef<HermesReasoningLevel>(HERMES_REASONING_DEFAULT)
  // False until the level is real (from localStorage, from the device's
  // agent.reasoning_effort, or picked by the user) rather than the placeholder.
  const hermesReasoningKnownRef = useRef(false)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [sending, setSending] = useState(false)
  // Queued while a run is in flight; drained one at a time on `final`.
  const [queuedSends, setQueuedSends] = useState<{ id: string; text: string; attachments: ChatAttachment[] }[]>([])
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
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  // Bumped whenever the composer's attachments are abandoned (currently: on
  // close). An upload captures it at start and checks it before touching
  // state, so a slow request cannot repopulate a strip the user has left.
  const uploadGenerationRef = useRef(0)
  // Why a staged upload failed, or null. Rendered next to the attachment
  // strip: the previous behaviour was to return early on a non-OK response,
  // which is indistinguishable to the user from a paste that never fired.
  const [attachmentError, setAttachmentError] = useState<(StagingFailure & { file: string }) | null>(null)
  // The image the full-size preview is showing, or null when it is closed.
  // It carries the picture's accessible name as well as its URL: a screen
  // reader must not be told "generated image" after opening one the customer
  // sent, and the src alone cannot tell the two apart.
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null)
  const closePreview = useCallback(() => setPreview(null), [])
  // The desktop's one modal-dialog behaviour: focus in, Tab trapped, focus
  // restored, the page behind inerted, and Escape closing THIS and stopping
  // there — which is why the chat's own Escape handler needs no special case.
  const previewPanelRef = useModalDialog<HTMLDivElement>({
    open: preview !== null,
    onClose: closePreview,
  })
  // True from the image_generate tool call until the picture arrives (or the
  // wait times out). Drives the banner AND the history polling.
  const [generatingImage, setGeneratingImage] = useState(false)
  // How many images the transcript held when the wait began — the picture has
  // landed once that count goes up. A count beats a timestamp here: the browser
  // may be a phone whose clock disagrees with the device's.
  const imageBaselineRef = useRef(0)

  // ── Drag + resize state ──
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>(DEFAULT_SIZE)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Reset position and size when reopened
  useEffect(() => {
    if (isOpen) { setPos(null); setSize(DEFAULT_SIZE); setPreview(null) }
    else setGeneratingImage(false)
  }, [isOpen])

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
  //
  // A non-empty `hermesProvider` is itself the Hermes signal: the only two
  // things that ever set it are the Hermes header's own picker and the Hermes
  // seeding fetch. Asking it rather than asking which harness is running keeps
  // this above the transport, which is resolved further down.
  const { scope: hermesScope, loading: hermesModelsLoading } = useHermesModelOptions(
    hermesProvider || null,
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
    // still contains its earlier "I am X" claims. The adapter therefore
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
  /**
   * `dispatchTurn`, reachable from `loadHistory` above it.
   *
   * The auto-greet used to call `adapter.sendTurn` directly, which is only
   * correct for a harness that answers on an event stream: the gateway ACKs,
   * its socket handler paints the reply and clears `sending`. A harness that
   * RESOLVES with the reply has no such handler, so the greeting arrived, was
   * dropped on the floor, and the composer stayed disabled forever with a Stop
   * button and nothing running. Going through `dispatchTurn` means both
   * editions end the run the same way — it already reads `acknowledgedOnly` to
   * tell the two apart.
   */
  const dispatchTurnRef = useRef<(text: string, attachments: ChatAttachment[], key: string) => Promise<void>>(
    async () => {},
  )
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
    attachments: ChatAttachment[]
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

  // ── The one transport ───────────────────────────────────────────────────
  //
  // The socket lifecycle (handshake, retry ladder, event stream) still lives in
  // this component and is handed to the adapter through `GatewayLink`. That is
  // the deliberate seam: the RPC vocabulary moves first, on its own, so this
  // change reads as "same frames, new home" rather than as a rewrite of 500
  // lines of event handling that every OpenClaw customer depends on.
  //
  // `connect` is defined further down and re-created when its own inputs
  // change, so the link reaches it through a ref — which is also what keeps the
  // long-lived listeners that deliberately close over the first `connect` from
  // ever holding a stale one.
  const connectRef = useRef<() => Promise<void> | void>(() => {})
  const statusListenersRef = useRef(new Set<(s: HarnessStatus, detail?: string) => void>())
  const gatewayLink = useMemo<GatewayLink>(() => ({
    request: (method, params) => wsRequest(method, params),
    sessionKey: () => sessionKeyRef.current,
    open: async () => { await connectRef.current() },
    close: () => { wsRef.current?.close(); wsRef.current = null },
    onStatus: (cb) => {
      statusListenersRef.current.add(cb)
      return () => { statusListenersRef.current.delete(cb) }
    },
  }), [wsRequest])
  // Read at send time, exactly as the refs behind it always were: a header pill
  // changed mid-run therefore applies to the NEXT turn, never retroactively to
  // the one in flight.
  const hermesContext = useCallback(() => ({
    devicePairing: hermesDeviceRef.current,
    modelsReady: hermesScopeReadyRef.current,
  }), [])
  // Stable by construction — see HarnessWiring. Everything that moves is read
  // through a ref inside these callbacks, so the object itself never changes
  // and the adapter keeps one identity for the life of the resolved harness.
  const harnessWiring = useMemo(
    () => ({ gateway: gatewayLink, hermesContext }),
    [gatewayLink, hermesContext],
  )
  const { adapter, capabilities: caps, harnessId, resolved: harnessLoaded } =
    useHarnessAdapter(harnessWiring)
  // The gateway's status is produced by the socket handlers below; publish it
  // so the adapter's subscribers see one stream whichever harness is running.
  useEffect(() => {
    for (const cb of statusListenersRef.current) cb(status, errorMsg || undefined)
  }, [status, errorMsg])
  // ...and take it back, which is how a harness with no socket reports itself
  // connected. For the gateway this is the value it just published, so React
  // bails out of the set and nothing re-renders.
  useEffect(() => adapter.onStatus((next) => {
    setStatus(next === 'idle' ? 'connecting' : next)
  }), [adapter])
  // `connect` is a stable `useCallback([])` that several window listeners close
  // over, so anything it reaches for must be read at call time rather than
  // captured. Same reason the harness itself used to be a ref.
  const adapterRef = useRef(adapter)
  useEffect(() => { adapterRef.current = adapter }, [adapter])
  // Whether this box has a socket to open at all. Read through a ref for the
  // same reason `harnessRef` was: several long-lived window listeners close
  // over the first `connect`, and a value captured in its dependency array
  // would let a Hermes box open a gateway socket after a Settings event.
  const hasLiveConnectionRef = useRef(true)
  useEffect(() => { hasLiveConnectionRef.current = caps.hasLiveConnection }, [caps])

  // Push thinkingLevel to the gateway as a sticky session override
  // (per OpenClaw control-ui docs: model + thinking pickers patch via
  // sessions.patch and persist for every subsequent turn). 'default'
  // maps to null on the wire so the gateway falls back to its config.
  // The lastSent ref dedupes — without it, every reconnect re-pushes
  // an identical value and a user click triggers two patches (state
  // change + this effect).
  const lastSentThinkingRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    // A sticky patch is an OpenClaw gateway call. A harness whose reasoning
    // dial is per-turn carries the level on the turn instead, so pushing here
    // could only ever reject with 'Not connected' — see the predicate for why
    // the capability is checked outright rather than left to the key guard.
    if (!shouldPatchSessionDefaults({ capabilities: caps, status, sessionKey: sessionKeyRef.current })) return
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
    void adapter.patchSessionDefaults({ thinkingLevel: wireValue }).catch((err: unknown) => {
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
  }, [status, headerProvider, thinkingLevel, adapter, caps])

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
    // A box with no socket has nothing to open. The adapter reports such a
    // harness connected on its own; this guard is for the window listeners and
    // recovery paths below, which call `connect` directly and must never open a
    // gateway socket on an edition that does not run one.
    if (!hasLiveConnectionRef.current) return
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
          // Ask the gateway to push every append to this session's transcript.
          // A generated picture is produced by a SEPARATE background run whose
          // reply reaches the `chat` stream with its MEDIA: directive stripped,
          // so that stream alone can never show it — this event is how we learn
          // the transcript gained something the live turn could not render.
          // Same projection `chat.history` uses, so the directive is intact.
          void wsRequest('sessions.messages.subscribe', { key: mainSessionKey })
            .catch(() => {
              // A gateway without the RPC just means we fall back to the
              // backstop reconcile below; the chat still works.
            })
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
              // Clearing the transcript starts a NEW conversation, so make the
              // agent forget it too — otherwise it would still carry the old
              // context the user just cleared away.
              void adapterRef.current.resetSession().catch(() => {
                // Best effort on a reload path: the visible transcript is
                // already gone and there is no button here to report to.
              })
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
                    await resetSessionRef.current()
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
            const toolData = payload.data as Record<string, unknown> | undefined
            applyToolEvent(toolData)
            // ONLY `start` opens a wait. `image_generate` reports `result`
            // ~200ms later (the job is merely queued), and that event can be
            // delivered after the picture has already landed and closed the
            // wait — which opened a second one whose baseline already counted
            // the new picture, so nothing could ever end it and the banner sat
            // there until it timed out.
            const toolName = typeof toolData?.name === 'string' ? toolData.name : ''
            const toolPhase = typeof toolData?.phase === 'string' ? toolData.phase : ''
            if (toolPhase === 'start' && isImageGenerationTool(toolName) && !generatingImageRef.current) {
              generatingImageRef.current = true
              imageFailedRef.current = false
              imageBaselineRef.current = countImages(messagesRef.current)
              imageWaitFromRef.current = newestTimestamp(messagesRef.current)
              setGeneratingImage(true)
            }
          }
          return
        }

        // The transcript gained a message. Rather than merge a pushed message
        // into the local list (and have to dedupe it against the one the `chat`
        // stream may also deliver), treat it as a signal and re-read history —
        // the same reconcile a manual page refresh used to be doing by hand.
        if (eventName === 'session.message') {
          const payload = data.payload as Record<string, unknown> | undefined
          if (!payload) return
          const sk = payload.sessionKey as string | undefined
          if (sk && sk !== sessionKeyRef.current) return
          // Older gateways push the TTS supplement intact here but omit it
          // from chat.history. Render it immediately; the on-box transcript
          // supplement route below restores the same identity after refresh.
          const pushedMessage = payload.message
          const pushedRole = pushedMessage && typeof pushedMessage === 'object'
            ? String((pushedMessage as Record<string, unknown>).role ?? '').toLowerCase()
            : ''
          const pushedRaw = extractText(pushedMessage)
          const pushedAudio = boundedAudio(extractAudioAttachments(pushedMessage))
          if (pushedRole === 'assistant' && pushedAudio.length > 0
              && !isSentinel(pushedRaw) && !isInterSessionEnvelope(pushedRaw, pushedMessage)) {
            const pushedText = splitMediaDirectives(pushedRaw).text
            setMessages(prev => {
              // Only a bubble after the latest user turn can own this event.
              // Otherwise a late supplement from the previous turn could be
              // put on a new identical "Sure.". If the target is ambiguous,
              // the timestamp-aware transcript reconcile scheduled below is
              // the sole authority; text-only pending queues cross turns.
              let latestUser = -1
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].role === 'user') { latestUser = i; break }
              }
              for (let i = prev.length - 1; pushedText && i > latestUser; i--) {
                const candidate = prev[i]
                if (candidate.role !== 'assistant' || candidate.text !== pushedText) continue
                if (candidate.audio?.length) return prev // duplicate push
                const next = [...prev]
                next[i] = { ...candidate, audio: pushedAudio }
                return next
              }
              // A genuinely audio-only reply has no caption to wait for.
              if (!pushedText) {
                return [...prev, {
                  role: 'assistant' as const,
                  text: '',
                  timestamp: finiteMessageTimestamp(pushedMessage) ?? Date.now(),
                  audio: pushedAudio,
                }]
              }
              return prev
            })
          }
          if (transcriptReconcileTimerRef.current !== null) {
            window.clearTimeout(transcriptReconcileTimerRef.current)
          }
          // Coalesce the burst an agent turn produces into one read.
          transcriptReconcileTimerRef.current = window.setTimeout(() => {
            transcriptReconcileTimerRef.current = null
            void reconcileTranscriptRef.current()
          }, 400)
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
            // Strip MEDIA: directives while streaming too, or the raw path
            // flashes in the bubble for the moment before `final` lands.
            const text = splitMediaDirectives(extractText(msg)).text
            // Sentinels would flash before the final-state filter drops them.
            if (text && !isSentinel(text) && !isInterSessionEnvelope(text, msg)) {
              setStreaming(text); setReloadingSkill(false)
            }
          } else if (state === 'final') {
            // A generated picture arrives as a MEDIA: line inside the reply
            // text, not as a structured attachment — see lib/chat-media.ts.
            const { text, images, audio: directiveAudio } = splitAssistantMedia(extractText(msg))
            // A spoken reply is a structured attachment part, not a MEDIA:
            // line — see lib/chat-media.ts. Both are read; the harness uses
            // the first and image generation the second.
            const audio = boundedAudio(extractAudioAttachments(msg), directiveAudio)
            // Suppress sentinel and "Sent." (delivery-mirror ack) from the
            // rendered transcript — the latter is just a server-side
            // acknowledgement that the real reply will follow via the
            // chat.history refetch scheduled below. Skipping the append
            // avoids a brief "Sent." bubble flashing on the screen before
            // the real reply replaces it.
            // An image with no caption is a real reply, not an ack — it must
            // not be mistaken for the empty "Sent." case and refetched away.
            // Audio counts as content for the same reason a picture does: the
            // harness delivers a spoken reply as its own message whose text is
            // a repeat of the one already on screen, and treating that as an
            // empty ack threw the recording away and refetched history instead.
            const isAckOnly = (!text && images.length === 0 && audio.length === 0) || /^\s*Sent\.\s*$/.test(text) || isSentinel(text)
            // The reconcile often wins the race now: `session.message` lands
            // the stored reply, media intact, before this event arrives with
            // the same text and the media stripped. Appending it again showed
            // the reply twice — once with the picture, once without.
            const latestShown = messagesRef.current[messagesRef.current.length - 1]
            const alreadyShownWithMedia = images.length === 0 && audio.length === 0 && text.length > 0 &&
              latestShown?.role === 'assistant' && latestShown.text === text &&
              ((latestShown.images?.length ?? 0) > 0 || (latestShown.audio?.length ?? 0) > 0)
            // Envelope suppression (TASK-416) still applies on the live path, so
            // the bubble cannot appear in real time and an envelope can never be
            // cached as a mascot snippet. Checked on the ORIGINAL text: a routing
            // envelope carrying a MEDIA: line must be dropped whole, not split
            // into a picture plus its own machinery.
            if (!isAckOnly && !alreadyShownWithMedia && !isInterSessionEnvelope(extractText(msg), msg)) {
              setMessages(prev => {
                // The spoken half arrives as a SECOND message repeating the
                // text of the one already rendered. Appending it verbatim
                // showed the answer twice, once silent and once playable, so
                // the audio is folded into the bubble it belongs to when the
                // text matches and that bubble has none yet.
                const last = prev[prev.length - 1]
                if (text.length > 0 && audio.length > 0 && !images.length && last && last.role === 'assistant'
                    && last.text === text) {
                  const mergedAudio = boundedAudio(last.audio ?? [], audio)
                  if (last.audio?.length === mergedAudio.length
                      && last.audio.every((src, index) => src === mergedAudio[index])) return prev
                  return [...prev.slice(0, -1), { ...last, audio: mergedAudio }]
                }
                return [...prev, {
                  role: 'assistant' as const,
                  text,
                  timestamp: finiteMessageTimestamp(msg) ?? Date.now(),
                  images,
                  audio,
                }]
              })
              // The picture reached us over the socket after all — nothing
              // left to wait for, so take the banner down.
              if (images.length > 0) endImageWait()
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
  // The adapter opens the socket through this, not by importing it: `connect`
  // is declared after the adapter is built, and this ref is what lets the two
  // reference each other without either being re-created for the other's sake.
  useEffect(() => { connectRef.current = connect }, [connect])

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
  const [startingSession, setStartingSession] = useState(false)
  const loadHistory = useCallback(async () => {
    // A harness with no durable transcript has nothing to replay. Returning
    // before the bootstrap bookkeeping rather than calling and catching keeps
    // the auto-greet honest: there is no history read here that can be "empty".
    if (!caps.canListHistory) return
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
      // The whole projection — sentinels, routing messages, inter-session
      // envelopes, the image-failure window, the spoken-reply merge — moved
      // into the adapter unchanged. It encodes about six independent shipped
      // fixes with no unifying rule between them; the one thing this call must
      // never do is re-derive them.
      const { messages: chatMsgs, imageGenerationFailed } = await adapter.loadHistory({
        limit: 50,
        imageWaitFrom: generatingImageRef.current ? imageWaitFromRef.current : null,
      })
      if (imageGenerationFailed) imageFailedRef.current = true
      // Preserve any optimistic user turns appended after this load was
      // dispatched but before chat.history responded — they haven't reached
      // the server yet so chatMsgs doesn't include them.
      setMessages(prev => {
        if (prev.length === 0) return chatMsgs
        // Carry an event that beat the disk/history read across this one
        // reconcile. One-to-one occurrence matching is essential here: a map
        // keyed by text put the newest recording on every historical "Sure.".
        const restored = preserveSpokenByOccurrence(prev, chatMsgs)
        const lastServerTs = restored.length > 0 ? restored[restored.length - 1].timestamp : 0
        const inFlight = unechoedUserTurns(prev, restored, lastServerTs)
        const next = inFlight.length === 0 ? restored : [...restored, ...inFlight]
        // Returning `prev` when nothing changed makes React skip the render.
        return sameTranscript(prev, next) ? prev : next
      })

      // Auto-send a greeting if no history exists (first conversation)
      if (chatMsgs.length === 0 && !greetedRef.current) {
        greetedRef.current = true
        setIsBootstrappingHistory(false)
        setSending(true)
        const idempotencyKey = uuid()
        runIdRef.current = idempotencyKey
        await dispatchTurnRef.current('hi', [], idempotencyKey)
      } else if (mightAutoGreet) {
        setIsBootstrappingHistory(false)
      }
      // Handed back so a caller can act on what was just loaded without waiting
      // for the state commit — the image poll below decides on this, not on a
      // ref React has not refreshed yet.
      return chatMsgs
    } catch (err) {
      console.error('Failed to load history:', err)
      if (mightAutoGreet) setIsBootstrappingHistory(false)
    }
  }, [adapter, caps])

  useEffect(() => { messagesRef.current = messages }, [messages])

  const endImageWait = useCallback(() => {
    generatingImageRef.current = false
    imageFailedRef.current = false
    setGeneratingImage(false)
  }, [])

  // Re-read the transcript and, if it gained a picture since the wait began,
  // end the wait. Used by the pushed-append handler and by the backstop below.
  const reconcileTranscript = useCallback(async () => {
    const loaded = await loadHistory()
    if (!loaded) return
    if (!generatingImageRef.current) return
    // Either the picture landed, or the job reported that it never will.
    if (imageFailedRef.current || countImages(loaded) > imageBaselineRef.current) {
      endImageWait()
    }
  }, [loadHistory, endImageWait])

  useEffect(() => { reconcileTranscriptRef.current = reconcileTranscript }, [reconcileTranscript])

  // Make the agent forget the thread, rather than the UI merely hiding it.
  // Shared with the provider switch, which needs the same reset: when the two
  // were written out separately they drifted, and the switch stopped clearing
  // the previous model's half-streamed reply off the screen. Throws on
  // failure so each caller can word its own banner.
  // Blank the visible conversation. Shared by both harnesses so the two cannot
  // drift on what "cleared" means — only the way the AGENT is made to forget
  // differs, and that difference is the adapter's business, not this one's.
  const clearTranscript = useCallback(() => {
    setMessages([])
    setStreaming('')
    // The auto-greet opens a FIRST conversation; re-arming it here would drop
    // an unasked-for "hi" into the chat the moment it was cleared.
    greetedRef.current = true
  }, [])

  const resetSession = useCallback(async () => {
    await adapter.resetSession()
    clearTranscript()
  }, [adapter, clearTranscript])
  const resetSessionRef = useRef(resetSession)
  useEffect(() => { resetSessionRef.current = resetSession }, [resetSession])

  const startNewSession = useCallback(async () => {
    setStartingSession(true)
    try {
      await resetSession()
    } catch (err) {
      // Blanking the view on a failed reset is the worst outcome: the agent
      // still holds the thread, but the user believes it is gone.
      setMessages(prev => [...prev, {
        role: 'system',
        text: `Could not start a new chat: ${err instanceof Error ? err.message : 'unknown error'}`,
        timestamp: Date.now(),
        variant: 'error',
      }])
    } finally {
      setStartingSession(false)
    }
  }, [resetSession])

  // While a picture is being generated, go and look for it. The background run
  // that produces it does not deliver renderable media over this socket, so a
  // history read — which returns the stored reply, directive intact — is what
  // actually finds it. Normally the pushed append triggers this within ~400ms;
  // this timer only covers a gateway that never sent the event.
  useEffect(() => {
    if (!generatingImage || status !== 'connected') return
    const startedAt = Date.now()
    let inFlight = false
    const timer = window.setInterval(() => {
      // Never stack reads on a gateway that is busy generating the picture.
      if (inFlight) return
      if (Date.now() - startedAt > IMAGE_GEN_MAX_WAIT_MS) {
        // Give up rather than wait forever on a job that failed silently.
        endImageWait()
        return
      }
      inFlight = true
      void reconcileTranscript().finally(() => { inFlight = false })
    }, IMAGE_GEN_BACKSTOP_MS)
    return () => window.clearInterval(timer)
  }, [generatingImage, status, reconcileTranscript, endImageWait])

  // Stage one or more files for the agent and add them to the chat attachment
  // list. Shared by the file-input change handler and by the textarea paste
  // handler (Ctrl+V on a clipboard image).
  //
  // Deliberately NOT the Files API. The turn puts the returned absolute
  // path in the message, and OpenClaw only reads media from a fixed allowlist
  // of roots; $HOME/uploads, where `/setup-api/files?dir=uploads` writes, is
  // not one of them, so the agent got "Local media path is not under an
  // allowed directory" and told the user it could not see the picture
  // (TASK-417). /setup-api/chat/attachments writes under <stateDir>/media,
  // which is on that allowlist. Same { name, path } response shape.
  const uploadFiles = useCallback((files: File[]) => {
    if (files.length === 0) return
    const stampBase = Date.now()
    // A new attempt clears the previous complaint. Leaving a stale error above
    // a strip that now holds a good attachment reads as "this one failed too".
    setAttachmentError(null)
    // What this box can actually pass to the model. Refused BEFORE the upload,
    // not after: a document staged on a harness that has no way to show it to
    // the model would sit on the customer's disk and be named in a turn nobody
    // could read it from. The refusal names the real limit — pictures, not
    // documents — rather than failing silently.
    const { accepted, refused } = partitionAttachments(files, caps)
    if (refused.length > 0) {
      setAttachmentError({ reason: 'imagesOnly', detail: null, file: refused[0].name || '' })
    }
    if (accepted.length === 0) return
    // Which composer these uploads belong to. Closing the chat bumps it, so a
    // request that resolves afterwards releases its thumbnail and drops
    // instead of pushing an attachment nobody can see back into a strip the
    // user has already dismissed.
    const generation = uploadGenerationRef.current
    const isCurrent = () => uploadGenerationRef.current === generation
    const tasks = accepted.map(async (rawFile, idx) => {
      // Clipboard images come in as the generic "image.png"; stamp them so
      // a burst of pastes in the same millisecond doesn't collide on disk.
      // FormData's third arg sets the filename without copying the Blob.
      const isGeneric = !rawFile.name || rawFile.name === 'image.png' || rawFile.name === 'image.jpeg'
      const filename = isGeneric
        ? `paste-${stampBase}-${idx}.${rawFile.type.split('/')[1] || 'png'}`
        : rawFile.name
      const formData = new FormData()
      formData.append('file', rawFile, filename)
      // Minted before the request so the thumbnail is ready the moment the box
      // answers, and released on every path that does not hand it to the strip
      // — an object URL that is created and then dropped pins the whole Blob
      // for the life of the document.
      const previewUrl = createPreviewUrl(rawFile)
      const releasePreview = () => revokePreviews([{ previewUrl }])
      // Report a failure only while this composer is still the current one.
      // After a close there is nothing on screen to attach the complaint to.
      const fail = (status: number | undefined, payload: unknown) => {
        releasePreview()
        if (!isCurrent()) return
        setAttachmentError({ ...classifyStagingFailure(status, payload), file: filename })
      }
      try {
        const res = await fetch('/setup-api/chat/attachments', { method: 'POST', body: formData })
        const json = await res.json().catch(() => ({} as { name?: string; path?: string; error?: string }))
        if (!res.ok) {
          fail(res.status, json)
          return
        }
        // Only a non-empty string is a path. The route is ours, but a 200
        // carrying `{ path: {} }` would otherwise reach the strip, render a
        // name that can throw, and send `[object Object]` as the file the
        // agent should open.
        const absPath = typeof json.path === 'string' ? json.path.trim() : ''
        const name = typeof json.name === 'string' && json.name.trim() ? json.name : filename
        if (!absPath) {
          // A 200 with no path is the box misbehaving, not the file: staging
          // "succeeded" and produced nothing for the agent to open. Reporting
          // it is the difference between a visible fault and a paste that
          // silently does nothing.
          fail(500, json)
          return
        }
        if (!isCurrent()) {
          // Landed after the chat closed: keep the staged copy on the box (a
          // later turn may still name it) but do not resurrect the strip, and
          // never leak the Blob this thumbnail pins.
          releasePreview()
          return
        }
        setAttachments(prev => [...prev, { name, path: absPath, type: rawFile.type, previewUrl }])
      } catch (err) {
        console.error('[chat] upload failed:', err)
        // No status: the request never completed. classifyStagingFailure maps
        // that to the box's problem rather than the file's, and the thrown
        // error itself is never shown — it can carry the request URL.
        fail(undefined, null)
      }
    })
    void Promise.all(tasks)
  }, [caps])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    uploadFiles(Array.from(files))
    e.target.value = ''
  }, [uploadFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // The SAME gate the attach button carries, and it has to be here too: with
    // only the button hidden, Ctrl+V was still a way in — and a box that cannot
    // pass the picture to the model drew the screenshot into the user's own
    // bubble and then answered without ever having looked at it.
    //
    // Only the IMAGE is refused. Nothing is preventDefault-ed on this path, so
    // a paste that also carries text still pastes its text as usual.
    if (!caps.canAttachImages) return
    if (status !== 'connected') return
    const imageFiles = extractImageFilesFromClipboard(e)
    if (imageFiles.length === 0) return
    e.preventDefault()
    uploadFiles(imageFiles)
  }, [caps, status, uploadFiles])

  const removeAttachment = useCallback((idx: number) => {
    setAttachments(prev => {
      const gone = prev[idx]
      if (gone) revokePreviews([gone])
      return prev.filter((_, i) => i !== idx)
    })
  }, [])

  // Release every thumbnail when the surface goes away. Without this, closing
  // the chat with attachments staged keeps their Blobs alive until the tab is
  // closed — on an 8 GB box, with screenshots, that is the whole budget.
  //
  // Unmount is NOT enough. page.tsx keeps this component mounted for the life
  // of the session and only toggles `isOpen`, so the render returns null while
  // React holds on to `attachments` — the previews would outlive every close.
  // Closing therefore clears the strip the same way the microphone is
  // abandoned a few lines below: the composer starts empty next time either
  // way, since the staged files are named in the turn, not in this state.
  //
  // The ref mirrors the state so the unmount cleanup can read the final list:
  // an effect with `[]` deps closes over the first render's empty array.
  const attachmentsRef = useRef<ChatAttachment[]>([])
  useEffect(() => { attachmentsRef.current = attachments }, [attachments])
  useEffect(() => () => {
    // Same bump as the close path, for the same reason: an upload still in
    // flight is not in `attachmentsRef` yet, so revoking that list alone would
    // let the late completion keep its object URL — and hand it to a
    // `setAttachments` on a component that no longer exists.
    uploadGenerationRef.current += 1
    revokePreviews(attachmentsRef.current)
  }, [])
  useEffect(() => {
    if (isOpen) return
    // Bump first: an upload still in flight must see a stale generation the
    // moment it resolves, not race the state reset below.
    uploadGenerationRef.current += 1
    setAttachments(prev => {
      if (prev.length === 0) return prev
      revokePreviews(prev)
      return []
    })
    setAttachmentError(null)
  }, [isOpen])

  // ── Voice input ───────────────────────────────────────────────────────
  //
  // Record in the composer, transcribe on the box, then send the usable text
  // through the same turn path as the Send button. This is intentionally the
  // Telegram-like record -> stop -> send flow Yanko requested; Cancel remains
  // available for anything the user does not want uploaded.
  const [voice, setVoice] = useState<VoiceStatus>(IDLE_STATUS)
  const [recordingMs, setRecordingMs] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  // Set when the user cancels, so the recorder's stop handler knows to throw
  // the audio away instead of transcribing it. `MediaRecorder.stop()` is the
  // only way to end a capture, so cancel and finish arrive at the same place
  // and something has to tell them apart.
  const cancelledRef = useRef(false)
  // The last recording, kept so a failed transcription can be retried without
  // making the user say it all again.
  const lastAudioRef = useRef<{ blob: Blob; name: string } | null>(null)
  // Bumped every time the microphone is released, which is every way out of a
  // capture including the panel closing and the component unmounting.
  //
  // `getUserMedia` resolves in a later task than the click that called it, and
  // the stream it hands back does not exist until it does — so nothing the
  // cleanup can reach is holding a microphone while the permission prompt is
  // still open. Close the panel in that window and the stream arrives after
  // there is any interface left to stop it: a live recorder with no indicator,
  // which is the one outcome this feature must never produce. The resolver
  // compares this counter against the value it captured and, if it moved,
  // stops the tracks it was just handed instead of recording with them.
  const captureGenerationRef = useRef(0)
  const sendVoiceTranscriptRef = useRef<(text: string) => void>(() => {})
  const transcribeAbortRef = useRef<AbortController | null>(null)

  /**
   * Release the microphone.
   *
   * Every path out of recording goes through here — finish, cancel, error,
   * unmount. A live capture with no visible indicator is the one thing this
   * feature must never leave behind, so this is deliberately idempotent and
   * called more often than strictly necessary.
   */
  const releaseMicrophone = useCallback(() => {
    captureGenerationRef.current += 1
    const stream = streamRef.current
    streamRef.current = null
    recorderRef.current = null
    if (stream) for (const track of stream.getTracks()) track.stop()
  }, [])

  const abandonRecording = useCallback(() => {
    cancelledRef.current = true
    const recorder = recorderRef.current
    if (recorder) {
      // Track shutdown can queue the normal dataavailable/stop sequence. With
      // these handlers still attached an unmounted panel uploads audio the user
      // can no longer see or cancel.
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
      if (recorder.state !== 'inactive') {
        try { recorder.stop() } catch { /* already stopping */ }
      }
    }
    chunksRef.current = []
    lastAudioRef.current = null
    transcribeAbortRef.current?.abort()
    transcribeAbortRef.current = null
    releaseMicrophone()
  }, [releaseMicrophone])

  const transcribe = useCallback(async (blob: Blob, name: string) => {
    const generation = captureGenerationRef.current
    const controller = new AbortController()
    const requestController = new AbortController()
    const abortRequest = () => requestController.abort()
    controller.signal.addEventListener('abort', abortRequest, { once: true })
    const timeoutId = window.setTimeout(abortRequest, VOICE_TRANSCRIBE_TIMEOUT_MS)
    transcribeAbortRef.current?.abort()
    transcribeAbortRef.current = controller
    setVoice({ state: 'transcribing', error: null, message: null, canRetry: false })
    try {
      const form = new FormData()
      form.append('file', blob, name)
      const res = await fetch('/setup-api/chat/transcribe', {
        method: 'POST',
        body: form,
        signal: requestController.signal,
      })
      const payload = await res.json().catch(() => null)
      if (captureGenerationRef.current !== generation || controller.signal.aborted) return
      if (!res.ok) {
        setVoice({
          state: 'error',
          error: 'transcribe',
          message: describeTranscribeFailure(payload),
          // The audio is still in hand, so this is worth offering again —
          // most failures here are a flaky uplink, not a bad recording.
          canRetry: true,
        })
        return
      }
      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (!text.trim()) {
        // A successful call that heard nothing. Not an error, but silently
        // returning to idle would look like the button did nothing at all.
        //
        // No retry offered: the call succeeded, so re-sending the same bytes
        // buys the same empty transcript and one more paid transcription.
        // Everything a retry could actually change — a flaky uplink, a
        // timeout, an upstream 5xx — arrives on the !res.ok branch above.
        lastAudioRef.current = null
        setVoice({ state: 'error', error: 'empty', message: null, canRetry: false })
        return
      }
      setVoice(IDLE_STATUS)
      lastAudioRef.current = null
      // A voice turn owns only the words captured by that recording. The
      // composer remains editable while transcription is in flight, so
      // merging its current value here would silently send and erase a draft
      // the user typed after pressing Stop.
      sendVoiceTranscriptRef.current(text)
    } catch {
      if (captureGenerationRef.current !== generation || controller.signal.aborted) return
      setVoice({ state: 'error', error: 'transcribe', message: null, canRetry: true })
    } finally {
      window.clearTimeout(timeoutId)
      controller.signal.removeEventListener('abort', abortRequest)
      if (transcribeAbortRef.current === controller) transcribeAbortRef.current = null
    }
  }, [])

  const startRecording = useCallback(async () => {
    if (voice.state === 'recording' || voice.state === 'requesting') return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoice({ state: 'error', error: 'unsupported', message: null, canRetry: false })
      return
    }
    setVoice({ state: 'requesting', error: null, message: null, canRetry: false })
    const generation = captureGenerationRef.current
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      // Same staleness test as the success path below. A prompt that is still
      // open when the panel closes can be denied afterwards, and an error
      // pinned to a panel nobody is looking at is waiting on screen the next
      // time it opens, describing a request that is no longer anyone's.
      if (captureGenerationRef.current !== generation) { setVoice(IDLE_STATUS); return }
      setVoice({ state: 'error', error: classifyCaptureError(err), message: null, canRetry: false })
      return
    }
    if (captureGenerationRef.current !== generation) {
      // The panel closed, or the component unmounted, while the prompt was up.
      // Whoever released the microphone could not reach this stream because it
      // did not exist yet, so it is stopped here instead of being recorded
      // with. No error is shown: nothing went wrong and, more to the point,
      // there may no longer be anywhere to show it.
      for (const track of stream.getTracks()) track.stop()
      setVoice(IDLE_STATUS)
      return
    }
    const mimeType = pickRecordingMimeType()
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    } catch {
      // The stream is already open at this point; letting it stay open would
      // leave the microphone live with nothing on screen saying so.
      for (const track of stream.getTracks()) track.stop()
      setVoice({ state: 'error', error: 'unsupported', message: null, canRetry: false })
      return
    }
    streamRef.current = stream
    recorderRef.current = recorder
    chunksRef.current = []
    cancelledRef.current = false
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data) }
    recorder.onstop = () => {
      releaseMicrophone()
      const chunks = chunksRef.current
      chunksRef.current = []
      if (cancelledRef.current) { setVoice(IDLE_STATUS); return }
      const type = recorder.mimeType || mimeType || 'audio/webm'
      const blob = new Blob(chunks, { type })
      if (blob.size === 0) {
        setVoice({ state: 'error', error: 'empty', message: null, canRetry: false })
        return
      }
      const name = recordingFileName(type)
      lastAudioRef.current = { blob, name }
      void transcribe(blob, name)
    }
    recorder.onerror = () => {
      // `error` is not the end of the event sequence: the recorder still
      // delivers `dataavailable` and then `stop`. Left attached, that stop
      // handler uploads whatever partial audio the failure produced and
      // replaces this error with a transcribing spinner — so a capture the
      // browser said had failed is paid for and answered anyway. Detach both
      // and drop the chunks before the error state is set.
      recorder.ondataavailable = null
      recorder.onstop = null
      chunksRef.current = []
      lastAudioRef.current = null
      releaseMicrophone()
      setVoice({ state: 'error', error: 'transcribe', message: null, canRetry: false })
    }
    try {
      recorder.start()
    } catch {
      // Some browsers expose MediaRecorder and accept its constructor but
      // reject start synchronously for the selected device/container. The
      // stream is already live here, so this path must tear it down too.
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
      chunksRef.current = []
      lastAudioRef.current = null
      releaseMicrophone()
      setVoice({ state: 'error', error: 'unsupported', message: null, canRetry: false })
      return
    }
    setRecordingMs(0)
    setVoice({ state: 'recording', error: null, message: null, canRetry: false })
  }, [voice.state, releaseMicrophone, transcribe])

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    cancelledRef.current = false
    if (!recorder || recorder.state === 'inactive') { releaseMicrophone(); setVoice(IDLE_STATUS); return }
    recorder.stop()
  }, [releaseMicrophone])

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true
    const recorder = recorderRef.current
    lastAudioRef.current = null
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    else { releaseMicrophone(); setVoice(IDLE_STATUS) }
  }, [releaseMicrophone])

  const retryTranscribe = useCallback(() => {
    const last = lastAudioRef.current
    if (!last) { setVoice(IDLE_STATUS); return }
    void transcribe(last.blob, last.name)
  }, [transcribe])

  const dismissVoiceError = useCallback(() => { lastAudioRef.current = null; setVoice(IDLE_STATUS) }, [])

  // Elapsed time, so a recording always shows that it is running — and a hard
  // ceiling on how long it can run. Finishing through `stopRecording` is the
  // same finish the button performs, so a capture that hits the cap is still
  // transcribed instead of thrown away; the alternative is a blob the route
  // answers 413 to after the whole upload, which loses the dictation at the
  // point it cost the most. Armed once per recording: `stopRecording` and the
  // `releaseMicrophone` it closes over are stable callbacks, so the clock's
  // re-renders cannot push the deadline back.
  useEffect(() => {
    if (voice.state !== 'recording') return
    const started = Date.now()
    const id = setInterval(() => setRecordingMs(Date.now() - started), 200)
    const deadline = setTimeout(() => {
      // Not through `stopRecording` blind: that clears the cancelled flag, and
      // cancelling leaves a window where clearing it is wrong. `stop()` goes
      // inactive at once but delivers `dataavailable`/`stop` in a later task,
      // so between the user's Cancel and those events the state here is still
      // `recording` and this deadline is still armed. Firing in that window
      // would hand the recorder's stop handler a capture that no longer looks
      // cancelled — uploading, and paying to transcribe, audio the user threw
      // away. The button is unaffected: it only ever runs outside that window.
      if (cancelledRef.current) return
      stopRecording()
    }, MAX_RECORDING_MS)
    return () => { clearInterval(id); clearTimeout(deadline) }
  }, [voice.state, stopRecording])

  // Closing the panel, navigating away or unmounting must not leave the
  // microphone running or let its queued stop event upload abandoned audio.
  useEffect(() => () => abandonRecording(), [abandonRecording])
  useEffect(() => {
    if (isOpen) return
    abandonRecording()
    setVoice(IDLE_STATUS)
  }, [isOpen, abandonRecording])

  // ONE send path.
  //
  // Which harness answers, whether the reply streams or lands whole, and
  // whether the reasoning level rides on the turn or was patched onto the
  // session are all the adapter's business. What is left here is the part that
  // was always this component's: putting the answer on screen and ending the
  // run.
  const dispatchTurn = useCallback(async (
    text: string,
    sendAttachments: ChatAttachment[],
    idempotencyKey: string,
  ) => {
    let result: TurnResult
    try {
      result = await adapter.sendTurn({
        text,
        attachments: sendAttachments,
        idempotencyKey,
        // Ignored by a harness with no such dial. Read here, at send time, so a
        // pill changed mid-run applies to the NEXT turn rather than
        // retroactively to this one.
        provider: hermesProviderRef.current,
        model: hermesModelRef.current,
        // The default level is only a placeholder for the picker. Until the
        // level is KNOWN (read from the device, or chosen by the user) send
        // none at all, so a failed seeding fetch cannot silently override the
        // device's own reasoning effort with "medium".
        reasoning: hermesReasoningKnownRef.current ? hermesReasoningRef.current : '',
      }, (event) => {
        // The answer so far, for the streaming bubble — the same state the
        // gateway's own delta handler sets, so both harnesses paint through
        // one renderer. Passed unconditionally: an adapter that cannot stream
        // simply never calls this, which is a quieter contract than asking the
        // capability here and getting the answer wrong on one of them.
        //
        // A run that has already ended (Stop, or a late frame after the final)
        // must not reopen the caret, so a delta is only painted while this run
        // is still the live one.
        if (event.kind === 'delta' && runIdRef.current !== null) setStreaming(event.text)
      })
    } catch (err) {
      // Nothing is coming on either path, so the run ends here.
      setSending(false)
      setStreaming('')
      runIdRef.current = null
      // A user-initiated Stop shows nothing, not an error line.
      if (err instanceof HarnessError && err.code === 'aborted') return
      setMessages(prev => [...prev, {
        role: 'system',
        text: `Error: ${err instanceof Error ? err.message : 'unknown error'}`,
        timestamp: Date.now(),
      }])
      return
    }
    // A harness that merely ACKNOWLEDGED the turn answers on its own event
    // stream; those handlers paint the reply and end the run.
    if (result.acknowledgedOnly) return
    const hasMedia = (result.media?.length ?? 0) > 0 || (result.audio?.length ?? 0) > 0
    setMessages(prev => [...prev, {
      role: 'assistant',
      // A reply that is nothing BUT a picture is still a real answer — don't
      // call it '(no response)'.
      text: result.text || (hasMedia ? '' : '(no response)'),
      timestamp: Date.now(),
      images: [...(result.media ?? [])],
      audio: boundedAudio([...(result.audio ?? [])]),
      // Beside the answer, never folded into it — the live bubble and the one
      // replayed from the transcript have to be the same bubble.
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      ...(result.toolCalls?.length ? { toolCalls: [...result.toolCalls] } : {}),
    }])
    setSending(false)
    setStreaming('')
    runIdRef.current = null
  }, [adapter])
  useEffect(() => { dispatchTurnRef.current = dispatchTurn }, [dispatchTurn])

  const startRun = useCallback((text: string, sendAttachments: ChatAttachment[]) => {
    // Pictures render in the bubble; everything else keeps its 📎 line, because
    // a document has nothing to show and a caption alone would refer to nothing.
    //
    // Tested on the STAGED PATH, not on the browser's MIME type, so that the
    // bubble drawn now and the one rebuilt from history after a refresh make
    // the same decision. Two different tests here would mean an image that is a
    // thumbnail until you reload and a filename afterwards.
    const images = sendAttachments.filter(a => isImageMedia(a.path)).map(a => mediaUrl(a.path))
    const fileNames = sendAttachments
      .filter(a => !isImageMedia(a.path))
      .map(a => `📎 ${a.name}`)
      .join('\n')
    const displayText = [fileNames, text].filter(Boolean).join('\n')
    const idempotencyKey = uuid()
    // Stamped onto the bubble, not just sent with the request: it is how the
    // reconcile recognises the server's copy of this exact turn. Text cannot
    // do that job here — `displayText` carries the 📎 filenames while the
    // gateway stores and returns the prompt alone.
    setMessages(prev => [...prev, { role: 'user', text: displayText, timestamp: Date.now(), idempotencyKey, images }])
    setSending(true)
    setStreaming('')
    runIdRef.current = idempotencyKey
    // Queue only where there is a connection that can be down. A harness with
    // no socket is never "not connected yet", so parking its turns would hold
    // them forever waiting for a status change that has already happened.
    if (caps.hasLiveConnection && status !== 'connected') {
      pendingSendsRef.current.push({ text, attachments: sendAttachments, idempotencyKey })
      return
    }
    void dispatchTurn(text, sendAttachments, idempotencyKey)
  }, [caps, status, dispatchTurn])

  const sendVoiceTranscript = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (sending) {
      setQueuedSends(prev => {
        const next = [...prev, { id: uuid(), text: trimmed, attachments: [] }]
        return next.length > MAX_QUEUED_SENDS ? next.slice(next.length - MAX_QUEUED_SENDS) : next
      })
      return
    }
    startRun(trimmed, [])
  }, [sending, startRun])
  useEffect(() => {
    sendVoiceTranscriptRef.current = sendVoiceTranscript
  }, [sendVoiceTranscript])

  const sendMessage = useCallback(() => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    setAttachmentError(null)
    // Safe here and not later: the thumbnail is only ever rendered by the
    // composer strip, which this send has just emptied. The queued/pending
    // copies of these objects are read for `name` and `path` alone.
    revokePreviews(currentAttachments)
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
          await dispatchTurn(q.text, q.attachments, q.idempotencyKey)
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
  }, [status, dispatchTurn])

  // Abort generation
  const abort = useCallback(async () => {
    await adapter.abortTurn()
  }, [adapter])

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

  // Seed the Hermes header once the harness is known. This is the one place
  // left that asks WHICH harness is running rather than what it can do, and
  // deliberately so: the header renders a different vendor's model catalogue,
  // which is a product fact about Hermes and not a capability of the box.
  useEffect(() => {
    if (harnessId !== 'hermes') return
    const controller = new AbortController()
    void seedHermesHeader(controller.signal)
    return () => { controller.abort() }
  }, [harnessId, seedHermesHeader])

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
    if (harnessId !== 'hermes') return
    const controller = new AbortController()
    const onChanged = () => { void seedHermesHeader(controller.signal) }
    window.addEventListener(HERMES_MODEL_STATE_EVENT, onChanged)
    return () => {
      controller.abort()
      window.removeEventListener(HERMES_MODEL_STATE_EVENT, onChanged)
    }
  }, [harnessId, seedHermesHeader])

  // Pre-warm the transport on mount so opening chat is instant. Gated on the
  // harness resolving: connecting before that is what would open a gateway
  // socket on a box that runs no gateway.
  useEffect(() => {
    if (!harnessLoaded) return
    void adapter.connect()
  }, [adapter, harnessLoaded])

  // Replay the stored conversation on a harness that has no handshake to hang
  // it on.
  //
  // The gateway path bootstraps its history from the moment auth resolves —
  // there IS a moment there, and the socket handler owns it. A harness with no
  // live connection has no such event: `connect()` resolves immediately, so the
  // only thing left that means "the user is looking at this now" is the surface
  // being mounted with a harness resolved. Without this the store is written on
  // every turn and read by nobody, and the refresh bug it exists to fix stays
  // exactly as it was.
  //
  // Once per resolved harness, not once per open: `greetedRef` makes the
  // auto-greet fire at most once anyway, and re-reading on every open would
  // fight the optimistic bubbles `loadHistory` reconciles against.
  const replayedRef = useRef(false)
  useEffect(() => {
    if (!harnessLoaded) return
    if (caps.hasLiveConnection || !caps.canListHistory) return
    if (replayedRef.current) return
    replayedRef.current = true
    void loadHistory()
  }, [harnessLoaded, caps, loadHistory])

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
      if (transcriptReconcileTimerRef.current !== null) {
        window.clearTimeout(transcriptReconcileTimerRef.current)
        transcriptReconcileTimerRef.current = null
      }
    }
  }, [])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && visible && status === 'connected') {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen, visible, status])

  // Close on Escape. An open image preview swallows the key before it reaches
  // here (useModalDialog stops it at the document capture phase), so dismissing
  // the picture cannot also close the conversation behind it.
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
      }
      @keyframes clawImageGenPulse {
        0%, 100% { opacity: 0.45; transform: scale(0.92); }
        50%      { opacity: 1;    transform: scale(1.08); }
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
          {harnessId === 'hermes' ? (
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
        <button
          onPointerDown={stopHeaderDrag}
          onClick={() => { void startNewSession() }}
          disabled={startingSession}
          title="New chat"
          aria-label="New chat"
          style={{
            background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)',
            cursor: 'pointer', padding: 4, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.background = 'none' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
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
        <CloudTtsWarning connected={status === 'connected'} request={wsRequest} />

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
                {msg.images && msg.images.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: msg.text ? 6 : 0 }}>
                    {msg.images.map((src, j) => {
                    // The same block draws both the pictures the assistant made
                    // and, since TASK-436, the ones the customer sent. They are
                    // not the same thing to announce: "Generated image" on a
                    // photo the customer just attached is simply wrong, and an
                    // accessible name is read out verbatim.
                    const imageAlt = msg.role === 'user' ? t("chat.sentImage") : t("chat.generatedImage")
                    return (
                      <div key={j} style={{ position: 'relative', display: 'inline-flex', maxWidth: '100%' }}>
                        {/* A button, not a bare onClick on the image: the
                            preview has to be reachable from the keyboard too,
                            and the alt text gives the control its name. */}
                        <button
                          type="button"
                          onClick={() => setPreview({ src, alt: imageAlt })}
                          style={{
                            padding: 0, border: 'none', background: 'none',
                            cursor: 'zoom-in', lineHeight: 0, borderRadius: 8, maxWidth: '100%',
                          }}
                        >
                          {/* A generated picture IS the message, not decoration:
                              it gets a real alt so a screen reader announces it,
                              and it is contained rather than cropped so the image
                              the user asked for does not lose its edges. */}
                          <img src={src} alt={imageAlt} style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, objectFit: 'contain' }} />
                        </button>
                        {/* Same-origin, so the `download` attribute is enough to
                            save it under the name the harness gave it. */}
                        <a
                          href={src}
                          download={mediaFileName(src)}
                          title={t("chat.downloadImage")}
                          aria-label={t("chat.downloadImage")}
                          style={{
                            position: 'absolute', top: 6, right: 6,
                            width: 26, height: 26, borderRadius: 8,
                            background: 'rgba(0,0,0,0.55)', color: '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            textDecoration: 'none', backdropFilter: 'blur(4px)',
                          }}
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
                        </a>
                      </div>
                    );
                    })}
                  </div>
                )}
                {msg.text ? (msg.role === 'user' ? msg.text : renderText(msg.text)) : null}
                {msg.audio && msg.audio.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: msg.text ? 8 : 0 }}>
                    {msg.audio.map((src) => (
                      // The browser's own player, not a bespoke one: play,
                      // pause, scrub and duration are what "a normal playable
                      // message" means, and every one of them already works
                      // here and is reachable from the keyboard.
                      //
                      // `preload="metadata"` so the duration is on screen
                      // before anything is played, without pulling the whole
                      // file down for a reply nobody listens to. The src is
                      // this box's own media route, which answers Range
                      // requests — without that the scrubber does not move.
                      //
                      // Keyed by the URL: the harness names every file with a
                      // uuid, so re-rendering a transcript cannot hand one
                      // player another player's audio.
                      <audio
                        key={src}
                        data-testid="chat-audio"
                        // Markdown source must not reach an accessible name —
                        // it is read out character for character. See
                        // plainTextForLabel.
                        aria-label={audioLabel(msg.text, t("chat.audioReply"))}
                        controls
                        preload="metadata"
                        src={src}
                        style={{ width: '100%', maxWidth: 280, height: 34 }}
                      >
                        <a href={src} download={mediaFileName(src)}>{t("chat.downloadAudio")}</a>
                      </audio>
                    ))}
                  </div>
                )}
                {/* What the agent DID and what it was thinking, under the
                    answer and never inside it. Both come off the stored
                    message, so a replayed turn shows exactly what the live one
                    did — the chips sit where the live pills sat, and the
                    monologue stays collapsed until it is asked for. */}
                {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                  <ToolCallSummaryChips toolCalls={msg.toolCalls} label={t("chat.toolsUsed")} />
                )}
                {msg.role === 'assistant' && msg.reasoning && (
                  <ReasoningDisclosure reasoning={msg.reasoning} label={t("chat.reasoning")} />
                )}
              </div>
            </div>
          );
        })}

        {!reloadingSkill && <ToolCallPills toolCalls={toolCalls} runningLabel={t("chat.running")} />}

        {/* The picture outlives the turn that asked for it, so this banner is
            the only thing on screen during the 20-40s wait — the tool pill has
            already gone green and `sending` is back to false. */}
        {!reloadingSkill && generatingImage && (
          <div
            role="status"
            aria-live="polite"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              alignSelf: 'flex-start',
              padding: '5px 11px', borderRadius: 999,
              background: 'rgba(249,115,22,0.12)',
              border: '1px solid rgba(249,115,22,0.25)',
              color: '#fdba74', fontSize: 12, fontWeight: 500,
            }}
          >
            <span
              className="material-symbols-rounded"
              aria-hidden="true"
              style={{ fontSize: 15, animation: 'clawImageGenPulse 1.4s ease-in-out infinite' }}
            >
              imagesmode
            </span>
            <span>{t("chat.generatingImage")}</span>
          </div>
        )}

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

      {/* Attachment strip.

          A pasted screenshot has no name the user recognises — the composer
          stamps it `paste-<ts>-<idx>.png` so a burst of pastes cannot collide
          on disk — so the thumbnail IS the confirmation that the right image
          is about to be sent. The file name stays beside it for the
          file-picker case and for non-images, which have no thumbnail. */}
      {attachments.length > 0 && (
        <div data-testid="chat-attachments" style={{ padding: '6px 14px 0', display: 'flex', gap: 6, flexWrap: 'wrap', background: 'rgba(0,0,0,0.2)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {attachments.map((a, i) => (
            <div key={`${a.path}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: a.previewUrl ? '3px 6px 3px 3px' : '3px 8px', borderRadius: 8, background: 'rgba(249,115,22,0.15)', fontSize: 11, color: '#f97316' }}>
              {a.previewUrl ? (
                // Raw <img>, like the other three in this file: the source is
                // a `blob:` object URL for bytes the browser already holds, so
                // next/image has nothing to optimise and its loader cannot
                // fetch it at all.
                <img
                  src={a.previewUrl}
                  alt={t('chat.attachment.previewAlt', { name: a.name })}
                  style={{ width: 34, height: 34, borderRadius: 6, objectFit: 'cover', display: 'block', background: 'rgba(0,0,0,0.35)' }}
                />
              ) : (
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{isPreviewableImage(a.type) ? 'image' : 'attach_file'}</span>
              )}
              <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              <button
                onClick={() => removeAttachment(i)}
                aria-label={t('chat.attachment.remove', { name: a.name })}
                style={{ background: 'none', border: 'none', color: '#f97316', cursor: 'pointer', padding: 0, display: 'flex' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Why an attachment did not appear.

          The uploader used to return early on a non-OK response, so a rejected
          file, a full disk or an expired session all looked exactly like a
          paste that had not happened. The generic line is chosen by what the
          customer can do about it; `detail` is only ever a message the box
          produced AND that survived the leak filter in safe-error-text. */}
      {attachmentError && (
        <div
          data-testid="chat-attachment-error"
          role="status"
          aria-live="polite"
          style={{ padding: '6px 14px 0', display: 'flex', alignItems: 'flex-start', gap: 6, background: 'rgba(0,0,0,0.2)', fontSize: 11.5, color: '#f87171' }}
        >
          <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 15, flexShrink: 0 }}>error</span>
          <span style={{ flex: 1 }}>
            {t(`chat.attachment.error.${attachmentError.reason}`, { name: attachmentError.file })}
            {attachmentError.detail ? ` ${attachmentError.detail}` : ''}
          </span>
          <button
            onClick={() => setAttachmentError(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontSize: 11.5 }}
          >
            {t('chat.voice.dismiss')}
          </button>
        </div>
      )}

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" multiple accept={attachmentAcceptAttribute(caps)} style={{ display: 'none' }} onChange={handleFileSelect} />

      {/* Voice status. Always rendered while anything is happening: a capture
          that is running, uploading or failed must be visible, because the
          alternative is a microphone the user cannot tell is live. It is a live
          region for the same reason: the pulsing dot and the running clock are
          the only signal that the microphone opened, and a screen reader sees
          neither. Polite rather than an alert — the row also hosts the cancel,
          retry and dismiss buttons, which an assertive interrupt talks over. */}
      {caps.canTranscribe && voice.state !== 'idle' && (
        <div
          data-testid="voice-status"
          role="status"
          aria-live="polite"
          style={{
            padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(0,0,0,0.2)', fontSize: 11.5,
            color: voice.state === 'error' ? '#f87171' : '#f97316',
          }}
        >
          {voice.state === 'recording' && (
            <span
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', flexShrink: 0, animation: 'claw-pulse 1s ease-in-out infinite' }}
            />
          )}
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {voice.state === 'requesting' && t("chat.voice.requesting")}
            {voice.state === 'recording' && <>{t("chat.voice.recording")}{' '}
              {/* The clock is kept out of the accessibility tree, not out of
                  the page. `role="status"` is implicitly atomic, so a live
                  region re-announces ALL of its text on any change inside it:
                  with the elapsed time in here the row would be read out in
                  full every second, for as long as the capture runs — ten
                  minutes of a screen reader talking over everything else the
                  user is doing. Hidden, its ticking is not a change the tree
                  can see, so the announcement fires on what a listener
                  actually needs: the state going recording → transcribing →
                  error. Sighted users lose nothing; this renders as before. */}
              <span aria-hidden data-testid="voice-clock">{formatRecordingClock(recordingMs)}</span>
            </>}
            {voice.state === 'transcribing' && t("chat.voice.transcribing")}
            {voice.state === 'error' && (
              voice.message
              || (voice.error === 'permission' ? t("chat.voice.permissionDenied")
                : voice.error === 'unsupported' ? t("chat.voice.unsupported")
                : voice.error === 'empty' ? t("chat.voice.nothingHeard")
                : t("chat.voice.failed"))
            )}
          </span>
          {voice.state === 'recording' && (
            <button
              onClick={cancelRecording}
              data-testid="voice-cancel"
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontSize: 11.5 }}
            >{t("chat.voice.cancel")}</button>
          )}
          {voice.state === 'error' && voice.canRetry && (
            <button
              onClick={retryTranscribe}
              data-testid="voice-retry"
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontSize: 11.5 }}
            >{t("chat.retry")}</button>
          )}
          {voice.state === 'error' && (
            <button
              onClick={dismissVoiceError}
              data-testid="voice-dismiss"
              aria-label={t("chat.voice.dismiss")}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'flex' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
            </button>
          )}
        </div>
      )}

      {/* The cloud-privacy line. Voice leaves the box: the recording goes to
          ClawBox AI to be turned into text. That has to be said on the surface
          where it happens, not only in a settings page nobody opens. */}
      {caps.canTranscribe && (voice.state === 'recording' || voice.state === 'transcribing') && (
        <div data-testid="voice-privacy" style={{ padding: '0 14px 6px', background: 'rgba(0,0,0,0.2)', fontSize: 10.5, color: 'rgba(255,255,255,0.45)' }}>
          {t("chat.voice.privacy")}
        </div>
      )}

      {/* Input area */}
      <div style={{
        padding: '10px 14px 12px',
        borderTop: attachments.length > 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.2)',
        display: 'flex', gap: 8, alignItems: 'flex-end',
      }}>
        {/* Shown only where a file staged here can actually reach the model.
            The alternative is worse than a missing button: the picture is drawn
            into the user's own bubble and then dropped, so the customer sees
            their screenshot in the transcript and an answer that never looked
            at it. */}
        {(caps.canAttachImages || caps.canAttachDocuments) && (
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
        {/* Voice input. Shown wherever the box has something to transcribe WITH
            — the route itself is edition-neutral, so what actually decides is
            whether this device holds a ClawBox AI credential. Offering the
            button without one would promise something that cannot work. */}
        {caps.canTranscribe && (
          voice.state === 'recording' ? (
            <button
              onClick={stopRecording}
              title={t("chat.voice.stop")}
              aria-label={t("chat.voice.stop")}
              data-testid="voice-stop"
              style={{
                width: 36, height: 36, borderRadius: 10, border: 'none',
                background: 'rgba(239,68,68,0.25)', color: '#ef4444',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>stop_circle</span>
            </button>
          ) : (
            <button
              onClick={startRecording}
              disabled={status !== 'connected' || voice.state === 'requesting' || voice.state === 'transcribing'}
              title={t("chat.voice.record")}
              aria-label={t("chat.voice.record")}
              data-testid="voice-record"
              style={{
                width: 36, height: 36, borderRadius: 10, border: 'none',
                background: 'rgba(255,255,255,0.06)',
                color: voice.state === 'transcribing' ? '#f97316' : 'rgba(255,255,255,0.4)',
                cursor: status === 'connected' && voice.state === 'idle' ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => { if (status === 'connected' && voice.state === 'idle') { e.currentTarget.style.background = 'rgba(249,115,22,0.15)'; e.currentTarget.style.color = '#f97316' } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; if (voice.state !== 'transcribing') e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
                {voice.state === 'transcribing' ? 'hourglass_top' : 'mic'}
              </span>
            </button>
          )
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

      {/* Full-size image preview.
          Portalled to <body> rather than nested here: the popup root carries a
          `transform`, which makes it the containing block for fixed-position
          descendants — an overlay rendered inside it would be clipped to the
          popup instead of covering the screen. */}
      {preview && createPortal(
        // Backdrop: dismissal only. The dialog role belongs on the panel — on
        // the backdrop the accessible dialog would be the whole viewport and
        // its name would swallow every bit of text behind the scrim.
        <div
          onClick={closePreview}
          style={{
            position: 'fixed', inset: 0, zIndex: 10020,
            background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}
        >
          {/* Clicking the picture or its controls must not dismiss, or the
              image is impossible to inspect without losing it. */}
          <div
            ref={previewPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("chat.imagePreview")}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative', display: 'flex',
              maxWidth: '100%', maxHeight: '100%',
            }}
          >
            <img
              src={preview.src}
              alt={preview.alt}
              style={{
                maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
                borderRadius: 12, boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
              }}
            />
            <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 8 }}>
              <a
                href={preview.src}
                download={mediaFileName(preview.src)}
                title={t("chat.downloadImage")}
                aria-label={t("chat.downloadImage")}
                style={PREVIEW_BUTTON_STYLE}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>download</span>
              </a>
              <button
                type="button"
                onClick={closePreview}
                title={t("chat.closePreview")}
                aria-label={t("chat.closePreview")}
                style={{ ...PREVIEW_BUTTON_STYLE, cursor: 'pointer' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

export default memo(ChatPopup)
