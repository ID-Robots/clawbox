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
import { useCodingAgentActivity, isCodingAgentTool, type CodingAgentActivity } from '@/lib/use-coding-agent-activity'
import { pickSpinnerVerb } from '@/lib/spinner-verbs'
import CodingAgentActivityPill from '@/components/CodingAgentActivityPill'
import { ReasoningDisclosure } from '@/lib/chat-reasoning-disclosure'
import { ClarifyPrompt, expireClarifyCard, upsertClarifyCard, type ClarifyCardState } from '@/lib/chat-clarify'
import {
  EmailBatchCard,
  OWN_ENDING,
  batchFromPending,
  emailEnding,
  endingAsAsked,
  reconcileBatchCards,
  settleCard,
  shownDraftIds,
  updateBatchCard,
  type EmailBatchApproval,
  type EmailBatchCardState,
  type EmailBatchDraft,
  type EmailBatchOutcome,
  type EmailGesture,
} from '@/lib/chat-email-batch'
import { installPendingRefresh } from '@/lib/email-pending-refresh'
import { describeChatFailure, describeImageFailure } from '@/lib/chat-error-text'
import { NEW_APP_EVENT, CHAT_MESSAGE_EVENT, FIX_ERROR_EVENT, VOICE_SETTINGS_CHANGED_EVENT, buildFixErrorPrompt, dispatchOpenApp, onProvidersChanged, type ChatMessageDetail, type FixErrorContext, dispatchOpenCodingRun } from '@/lib/ui-events'
import { speechTextFor } from '@/lib/speech-text'
import { SKILL_CHANGE_EVENT, buildSkillChangeMessage, type SkillChangeEvent } from '@/lib/skill-change-message'
import { isSentinel, isInterSessionEnvelope } from '@/lib/chat-sentinels'
import { useModalDialog } from '@/hooks/useModalDialog'
// ── The harness transport ──
// One adapter, both editions. This surface asks `caps` what the box can do and
// `adapter` to do it; the only thing left that knows WHICH harness is running
// is the provider/model header, which renders a different vendor's catalogue
// and is product identity rather than a capability.
import { useHarnessAdapter } from '@/lib/harness/use-harness-adapter'
import { shouldPatchSessionDefaults } from '@/lib/harness/capabilities'
// `extractText` stays with the gateway adapter: it strips that gateway's own
// wrapper tags, which is genuinely OpenClaw-specific. `boundedAudio` is not,
// and now lives with the rest of the media helpers.
import { extractText, type GatewayLink } from '@/lib/harness/openclaw-gateway-adapter'
import { DESKTOP_TRANSCRIPT_KEY } from '@/lib/harness/transcript-key'
import { HarnessError, type HarnessStatus, type TurnResult, type HarnessAdapter } from '@/lib/harness/transport'
import { splitMediaDirectives, splitAssistantMedia, mediaFileName, mediaUrl, isImageMedia, extractAudioAttachments, boundedAudio } from '@/lib/chat-media'
import { splitEmailRefs, streamingEmailRefsText, dropUnfinishedDirective } from '@/lib/chat-email-refs'
import { EmailCard, EmailFullView } from '@/lib/chat-email'
import {
  IDLE_STATUS,
  MAX_RECORDING_MS,
  classifyCaptureError,
  describeTranscribeFailure,
  formatRecordingClock,
  pickRecordingMimeType,
  readCaptureAvailability,
  recordingFileName,
  type CaptureAvailability,
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

/** How many spoken replies' audio the chat keeps alive at once; older ones lose their player. */
const SPOKEN_REPLIES_KEPT = 12
/** The most one ask for a spoken reply may take, queue and cold start included. */
const SPEAK_REPLY_TIMEOUT_MS = 150_000
/** The longest one spoken reply holds the queue while playing (a capped reply is ~100 s of speech). */
const PLAYBACK_MAX_MS = 150_000

/** A turn waiting its go: what to send, and whether it was SPOKEN (then the reply is spoken back). */
type QueuedSend = { id: string; text: string; attachments: ChatAttachment[]; voice?: boolean }
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
// The status line's small sibling of SPINNER_STYLE.
const TURN_SPINNER_STYLE: React.CSSProperties = { width: 12, height: 12, border: '2px solid rgba(249,115,22,0.25)', borderTopColor: '#f97316', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }
// Past this, a pasted user message folds behind "Show more".
const USER_CLAMP_CHARS = 700

// The chat used to clip up to two sentences out of every assistant reply into
// `clawbox-mascot-convo-lines` so the crab could quote them back. It has been
// removed: the snippets were whatever language the assistant happened to
// answer in (and whatever the user happened to be discussing), so they leaked
// into a mascot bag that must be in the UI locale. The server deletes the
// legacy KV key on first read.

/** The floating popup's live rect, in viewport coordinates. */
export interface ChatFloatingRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface ChatPopupProps {
  isOpen: boolean
  onClose: () => void
  onOpenFull?: () => void
  onOpenSettingsSection?: (section: 'ai' | 'localAi') => void
  onThinkingChange?: (thinking: boolean) => void
  onPanelModeChange?: (panelWidth: number) => void
  initialPanelWidth?: number
  /**
   * Where the FLOATING popup stands in the desktop's stacking order.
   *
   * It used to be a constant 10010 — above every window, whose band starts at
   * 100 — so a window opened while the chat was up had its minimize, maximize
   * and close buttons underneath the popup, and the owner had to close the chat
   * to reach them. The desktop now hands the floating chat a value out of the
   * same focus counter the windows draw from (`raiseChat` in page.tsx), which
   * makes it their peer: whichever surface was focused last is on top. The
   * DOCKED panel is not part of that — windows reserve its strip rather than
   * overlapping it — and stays at `DESKTOP_LAYERS.chat`.
   */
  floatingZIndex?: number
  /** Any pointer press inside the chat, so the desktop can put it back on top. */
  onFocus?: () => void
  /**
   * The floating popup's rect whenever it moves, and `null` while the chat is
   * closed, docked or full-screen — for the surfaces that have to keep clear of
   * it (the top-right notice column).
   */
  onFloatingRectChange?: (rect: ChatFloatingRect | null) => void
  mascotX?: number
  mobile?: boolean
  trayMode?: boolean
}

/**
 * How far LEFT the desktop's top-right notice column has to move to clear the
 * FLOATING chat, on top of its own `margin`.
 *
 * The docked half of this answer is a number the desktop already has — the
 * panel's width plus the gap it floats in — and the notices use it so a card
 * lands beside the panel instead of over its tab row and its +, dock and close
 * buttons. The floating popup had no such answer: the cards are fixed to the
 * top-right corner and the chat is often standing in it, so for the 30s before
 * a card hides itself the chat's header controls were unreachable.
 *
 * Returns 0 when the chat is nowhere near the column, and never shifts the
 * column off the screen: on a desktop too narrow for both, the cards move as
 * far as they can and no further.
 */
export function noticeColumnInset(
  rect: { left: number; right: number } | null,
  viewportWidth: number,
  columnWidth: number,
  margin: number,
): number {
  if (!rect) return 0
  const columnLeft = viewportWidth - margin - columnWidth
  if (rect.right <= columnLeft) return 0
  // The column's right edge lands `margin` clear of the chat's left edge; the
  // caller adds its own margin back, so what it needs is the difference.
  const clear = viewportWidth - rect.left
  const maxInset = viewportWidth - columnWidth - margin * 2
  return Math.max(0, Math.min(clear, maxInset))
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
    /** The ChatGPT sign-in on this box predates the installed OpenClaw: the
     * credential is intact, the core just cannot route it. Signing in again is
     * the only fix, so the row must not say "set up in Settings" — that sends
     * the owner to re-enter something they already have. */
    reauthRequired?: boolean
  }>
  primary: { available: boolean; label: string | null; model: string | null }
  local: { available: boolean; label: string | null; model: string | null }
  /** Providers this box authenticates to by SUBSCRIPTION only. The catalogue's
   * `availableOnSubscription` stamp says what a provider's subscription
   * surface carries; this says whether that applies to this device. Optional
   * so an older/partial payload reads as "no provider is subscription-only" —
   * unknown must not invent a restriction. */
  subscriptionProviders?: string[]
}

// Left dropdown is the provider selector — always show the friendly
// provider label (e.g. "Anthropic Claude", "OpenAI GPT") so users don't
// see a raw fully-qualified model id. When the provider has multiple
// curated models a secondary dropdown appears next to this one for
// model selection (see renderProviderModelPicker).
function getChatModelOptionText(option: ChatModelState['options'][number]) {
  if (option.reauthRequired) return `${option.label} - Sign in again in Settings`
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

import { renderText, audioLabel } from '@/lib/chat-markdown'
import SnapPreviewOverlay from '@/components/SnapPreviewOverlay'
import { DESKTOP_GAP, DESKTOP_LAYERS, getSnapRect, getSnapZone, type SnapZone } from '@/lib/window-snap'
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
import { useTr } from '@/lib/i18n-floor'
import {
  extractProviderModelId,
  isModelUsableOnSubscription,
} from '@/lib/provider-models'
import { chatgptReferenceProvider } from '@/lib/chatgpt-subscription'
import { useProviderCatalog } from '@/hooks/useProviderCatalog'
// Hermes chat header. Deliberately a separate namespace from the OpenClaw
// pieces above: Hermes has its own provider slugs, its own model ids and its
// own reasoning vocabulary, and the whole point of REQ 1 is that the two never
// get mixed. The MODEL list is scoped by the same server contract the Hermes
// settings panel uses (GET /setup-api/hermes/models?provider=…) — no parallel
// client-side filtering exists.
import {
  useHermesModelOptions,
  DEGRADED_RETRY_ATTEMPTS,
  degradedRetryDelayMs,
} from '@/hooks/useHermesModelOptions'
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
import { isClawboxAiProModel, portalDeniesClawboxAiModel, CLAWBOX_AI_MODEL_BY_TIER } from '@/lib/clawbox-ai-models'
import { PORTAL_DASHBOARD_URL } from '@/lib/max-subscription'
import { HeaderDropdown } from '@/components/HeaderDropdown'
import { buildDeviceConnectParams } from '@/lib/gateway-device-identity'
import NewAppWizardCard, { DEFAULT_MAX_TASK_CHARS } from '@/components/NewAppWizardCard' 
import VoiceTunnelDialog from '@/components/VoiceTunnelDialog'
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
    // Same rule as the audio above, for the same reason: a reply that gained
    // the model that served it between two reads must repaint, or the label
    // never appears. Declared here because this comparator is where a
    // late-arriving per-message field has to be named to survive a reconcile.
    if (x.model !== y.model || x.provider !== y.provider) return false
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
// 520×680, up from 420×500: with the model pills under the composer and a
// real header bar the popup reads as a small window, and the owner asked for
// one they can actually work in. The viewport still caps it (maxHeight below,
// and readStoredSize clamps a remembered size to the screen it is opened on).
const DEFAULT_SIZE = { w: 520, h: 680 }
const MIN_CHAT_HEIGHT = 250
// The docked panel keeps the old default width: it sits beside the desktop,
// where every extra pixel comes out of the windows next to it.
const DEFAULT_PANEL_WIDTH = 420

/**
 * The breathing room the DOCKED (expanded) chat keeps from the screen edges.
 *
 * Docked used to mean flush: `right/top: 0`, `bottom: 56`, square corners and a
 * one-pixel seam for a left border — a full-height slab that read as a
 * different component from the chat the owner had just been using. It is the
 * same chat, only wider, so it keeps the popup's radius and shadow and floats
 * clear of the edges instead.
 *
 * It is the DESKTOP's gap, not the chat's own — the same margin a maximized
 * window keeps — which is why the number comes from `window-snap`. Still
 * exported under this name because the desktop reserves this strip: `page.tsx`
 * passes the reserved width to windows and to the mascot as `rightInset`, and
 * that reservation has to include the gap or a maximized window slides under
 * it and shows through.
 */
export const CHAT_PANEL_GAP = DESKTOP_GAP

/** ChromeShelf's height — what the docked chat sits above. */
const SHELF_HEIGHT_PX = 56
// The floating popup's size survives a refresh and a close. Position does
// not: it is re-anchored to the mascot on every open, which is where the
// owner looks for it. The docked panel's width is the desktop's preference
// (initialPanelWidth), persisted by page.tsx, so it is not repeated here.
const SIZE_STORAGE_KEY = 'clawbox-chat-size'

// ── Chat tabs ──
// Every tab is its own session under the same agent — a separate conversation
// with the SAME assistant, not another agent. The main tab is the harness's
// main session: on OpenClaw the gateway's (the one Telegram, the desktop and
// every other surface share), on Hermes the desktop transcript. The others are
// sessions this popup minted through the adapter, which is what makes the
// strip one thing on both editions. The list and which one is open survive a
// refresh; the transcripts live with the transport.
interface ChatTab {
  /** The session key as the transport minted it — see `HarnessAdapter.newSessionKey`. */
  key: string
  label: string
  createdAt: number
  /** Still carrying its "Chat N" placeholder: the first thing the owner
   *  types becomes the label, once. */
  autoLabel?: boolean
  /** The N its placeholder was minted with; the next tab takes max+1, so
   *  closing "Chat 2" while "Chat 3" lives can never mint a second "Chat 3". */
  seq?: number
}
const TABS_STORAGE_KEY = 'clawbox-chat-tabs'
const TAB_LABEL_MAX = 24

/** The transcript, as the tab strip's one panel. */
const TRANSCRIPT_PANEL_ID = 'chat-transcript-panel'
/**
 * A tab's DOM id, derived from its session key so the panel can name the
 * selected tab as its label without either side holding an index. `null` is the
 * main conversation, which has no tab key of its own.
 *
 * The key's punctuation is folded to `_` — an OpenClaw session key is
 * `agent:main:clawbox-…`, and while a colon is legal in an HTML id it has to be
 * escaped in every CSS selector that looks one up. `aria-controls` and
 * `aria-labelledby` are IDREFs and would not care; a later `querySelector`
 * would, and this is the cheaper end to fix it at. The fold is lossy, which is
 * harmless here: one id per open tab, and two live keys that differ only in
 * punctuation do not exist.
 */
const tabDomId = (key: string | null) =>
  `chat-tab-${key === null ? 'main' : key.replace(/[^A-Za-z0-9_-]/g, '_')}`

/**
 * The ✕ on a tab plate — it closes a side tab, and restarts main. One control
 * in two places, so its box, its hover ladder and its glyph are written once.
 *
 * 24x24 is the WCAG 2.5.8 floor, and the spacing exception does not apply: the
 * tab beside it is itself an activation target. So the BOX is the target and
 * the 10px glyph inside it is only the ink.
 */
const TAB_CONTROL_STYLE: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0,
  marginLeft: 2, marginRight: -2, width: 24, height: 24, borderRadius: 5,
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  color: 'rgba(255,255,255,0.45)', cursor: 'pointer',
  transition: 'background 0.15s, color 0.15s',
}
const onTabControlEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
  e.currentTarget.style.color = 'rgba(255,255,255,0.9)'
  e.currentTarget.style.background = 'rgba(255,255,255,0.12)'
}
const onTabControlLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
  e.currentTarget.style.color = 'rgba(255,255,255,0.45)'
  e.currentTarget.style.background = 'transparent'
}
const TabControlGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)

function readStoredTabs(): { tabs: ChatTab[]; active: string | null } {
  if (typeof window === 'undefined') return { tabs: [], active: null }
  try {
    const raw = window.localStorage?.getItem(TABS_STORAGE_KEY)
    if (!raw) return { tabs: [], active: null }
    const parsed = JSON.parse(raw) as { tabs?: unknown; active?: unknown }
    const tabs = (Array.isArray(parsed.tabs) ? parsed.tabs : [])
      .filter((t): t is ChatTab =>
        !!t && typeof t === 'object'
        // Any non-empty key: which transport it belongs to is judged when the
        // main session binds (`bindMainSession`), not here.
        && typeof (t as ChatTab).key === 'string' && (t as ChatTab).key.length > 0
        && typeof (t as ChatTab).label === 'string')
      .map(t => ({ key: t.key, label: t.label, createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0, autoLabel: t.autoLabel === true, seq: typeof t.seq === 'number' ? t.seq : undefined }))
    const active = typeof parsed.active === 'string' && tabs.some(t => t.key === parsed.active) ? parsed.active : null
    return { tabs, active }
  } catch {
    return { tabs: [], active: null }
  }
}

function readStoredSize(): { w: number; h: number } {
  if (typeof window === 'undefined') return DEFAULT_SIZE
  try {
    const raw = window.localStorage?.getItem(SIZE_STORAGE_KEY)
    if (!raw) return DEFAULT_SIZE
    const parsed = JSON.parse(raw) as { w?: unknown; h?: unknown }
    const w = typeof parsed.w === 'number' && Number.isFinite(parsed.w) ? parsed.w : DEFAULT_SIZE.w
    const h = typeof parsed.h === 'number' && Number.isFinite(parsed.h) ? parsed.h : DEFAULT_SIZE.h
    // A size saved on a big screen must not land the popup off a small one.
    return {
      w: Math.round(Math.max(MIN_CHAT_WIDTH, Math.min(w, window.innerWidth - 16))),
      h: Math.round(Math.max(MIN_CHAT_HEIGHT, Math.min(h, window.innerHeight - 16))),
    }
  } catch {
    return DEFAULT_SIZE
  }
}
// Floor for the chat window width. Below this the header selector pills would
// squeeze past a readable size, so the resize handles (floating + docked panel)
// and the rendered width all clamp here — the chat simply stops getting
// narrower instead of smashing the pills.
const MIN_CHAT_WIDTH = 340

// The gutter the floating popup keeps from every screen edge — the same 8px
// per side `readStoredSize` already reserves when it restores a remembered
// size. Drag and resize honour it too: without it the popup could be grown or
// dragged past the right/bottom edge, taking the header's dock and close
// buttons and the composer's send button off-screen with it, and nothing on the
// desktop brings a chat in that state back.
const VIEWPORT_MARGIN = 8

/**
 * Is this tool call the one that queues outgoing mail?
 *
 * Matched on the SUFFIX rather than on equality because the name that reaches
 * this surface is the host's, not ours: the MCP tool is registered as
 * `email_send`, and a gateway is free to hand it over namespaced
 * (`clawbox_email_send`, `mcp__clawbox__email_send`). Anchored at the end and
 * fenced by a separator so a future `email_send_bulk` does not silently inherit
 * this behaviour — and getting it wrong is cheap in one direction only: a miss
 * means the owner approves in Settings → Email exactly as before.
 */
export function isEmailSendTool(name: string): boolean {
  return /(?:^|[^A-Za-z0-9])email_send$/.test(name)
}

/**
 * One row of an approve or a delete answer, as the card should render it.
 *
 * `gesture` is what the owner pressed, because the route says `ok: true` for
 * its own success and a send and a deletion are not the same news. The same
 * word `settleCard` and `reconcileBatchCards` take, so all three producers of
 * an outcome weigh an ending against one vocabulary.
 *
 * A row the route could not act on carries the receipt's `ending` when there is
 * one: the draft was sent, deleted or refused somewhere else while the card sat
 * on screen, and the card settles on this answer, so "no longer waiting" over
 * all of them would be a permanent shrug where the box knows the truth.
 *
 * `kind` is the receipt's word and `ok` is the GESTURE'S verdict on it, which
 * is why both travel. The card writes the words from one and the colour from
 * the other; keying the colour off the ending alone painted a draft the owner
 * was deleting a triumphant green because Telegram had sent it a minute
 * earlier. Only `changed` returns nothing at all — that draft is still waiting,
 * and giving it an outcome would take its checkbox away for good.
 */
function emailRowOutcome(row: unknown, gesture: EmailGesture): EmailBatchOutcome[] {
  if (typeof row !== 'object' || row === null) return []
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string') return []
  const at = typeof r.at === 'number' ? { at: r.at } : {}
  const error = typeof r.error === 'string' ? { error: r.error } : {}
  // This card's own request landed, so what it asked for is what happened.
  if (r.ok === true) return [{ id: r.id, ok: true, kind: OWN_ENDING[gesture], ...at }]
  const ending = emailEnding(r.ending)
  if (ending) return [{ id: r.id, ok: endingAsAsked(ending, gesture), kind: ending, ...at, ...error }]
  // A duplicate with no receipt behind it: approveBatch's own word for a twin
  // this very batch covered. Good news under either gesture, for the reason
  // `endingAsAsked` gives.
  if (r.reason === 'duplicate') return [{ id: r.id, ok: endingAsAsked('duplicate', gesture), kind: 'duplicate', ...error }]
  // Nobody knows which ending it had, so there is nothing to compare the
  // gesture against.
  if (r.reason === 'gone') return [{ id: r.id, ok: false, kind: 'gone', ...error }]
  if (r.reason === 'changed') return []
  return [{ id: r.id, ok: false, ...error }]
}

/**
 * Why a draft this gesture named is still waiting, when one is.
 *
 * `emailRowOutcome` gives a refused row NO outcome on purpose — that draft is
 * still in the queue, and an outcome would take its checkbox away for good — and
 * `settleCard` then clears `requestError` and hands the card back live. On a
 * mixed answer, one draft deleted and one refused, the card therefore said
 * nothing at all about the refused one: the silent click this whole path was
 * rewritten to remove, in a smaller place.
 *
 * BOTH handlers need it, and not symmetrically. `cancelEmailBatch` throws on an
 * empty `outcomes`, so an ALL-refused delete was already loud; `approveEmailBatch`
 * has no such throw, so an all-refused approve settled in complete silence until
 * this sentence. Each side has its own regression test, because a revert of
 * either one leaves the other's green.
 *
 * The ROUTE'S OWN sentence, never a generic one invented here: it says which
 * way the draft moved, and a line written on this side would have to claim
 * something about the drafts that did go.
 */
function emailRefusalSentence(rows: unknown[]): string {
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (r.reason === 'changed' && typeof r.error === 'string' && r.error) return r.error
  }
  return ''
}

function ChatPopup({ isOpen, onClose, onOpenFull, onOpenSettingsSection, onThinkingChange, onPanelModeChange, initialPanelWidth, floatingZIndex, onFocus, onFloatingRectChange, mascotX, mobile = false, trayMode = false }: ChatPopupProps) {
  const { t } = useT()
  const tr = useTr()
  const [panelWidth, setPanelWidth] = useState<number | null>(initialPanelWidth && initialPanelWidth > 0 ? initialPanelWidth : null)
  // A PHONE never draws the docked panel. Its geometry is a desktop one — a
  // column anchored to the right edge at a width chosen on a big screen — which
  // a 390px viewport drew at x=-381: the header, the title, the new-chat and
  // dock buttons and every other way back out were off the left edge, with the
  // panel covering the whole home screen. The width itself is kept (the desktop
  // hands it back as `initialPanelWidth`), so widening the window docks the
  // chat again instead of losing the owner's layout.
  const panelMode = panelWidth !== null && !mobile
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  // Gateway is canonical; render an empty list until chat.history arrives.
  const [messages, setMessages] = useState<ChatMessage[]>([])
  // Read when a wait begins, to know what "a new picture" means.
  const messagesRef = useRef<ChatMessage[]>([])
  // The spoken reply currently playing, and the object URLs handed to bubbles
  // — declared up here because clearTranscript (below) releases them.
  const replyPlayerRef = useRef<HTMLAudioElement | null>(null)
  const spokenUrlsRef = useRef<string[]>([])
  // Speak a reply that is already on screen (the guarded path is
  // maybeSpeakReply, below): the ack-only refetch and a tab switch reach it.
  const speakReplyRef = useRef<(text: string, audio: string[]) => Promise<void>>(async () => {})
  // Bumped whenever the spoken replies are released (the transcript cleared,
  // the panel gone): a synthesis still in flight then belongs to a
  // conversation that no longer exists, and must create nothing.
  const speechGenerationRef = useRef(0)
  const releaseSpokenReplies = useCallback(() => {
    speechGenerationRef.current += 1
    replyPlayerRef.current?.pause()
    replyPlayerRef.current = null
    for (const url of spokenUrlsRef.current) { try { URL.revokeObjectURL(url) } catch { /* jsdom */ } }
    spokenUrlsRef.current = []
    // The notes those URLs carried go with them: a released clip has no player
    // left to say "cloud voice" or "press play" about.
    setCloudSpoken([])
    setAutoplayBlocked([])
  }, [])
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
  // Queued while a run is in flight; drained one at a time on `final`.
  const [queuedSends, setQueuedSends] = useState<QueuedSend[]>([])
  // Synchronous mirrors of `sending` and the queue. A send handler can run in
  // the window between the commit that rendered `sending === false` and the
  // commit after the drain effect started the next queued run; deciding from
  // the render-time closures in that window started a SECOND run while one was
  // already in flight — which is how three accepted messages went unanswered
  // (TASK-517). The refs are written at the moment the fact changes, so a
  // stale closure cannot start a run it has no right to start.
  const sendingRef = useRef(false)
  const queuedSendsRef = useRef<QueuedSend[]>([])
  useEffect(() => { queuedSendsRef.current = queuedSends }, [queuedSends])
  // The status line under the thread while a turn runs: a ticking clock, and
  // whatever the harness last said it was doing ({kind:'status'} events — a
  // contract the popup used to ignore). Both are per-turn: armed when
  // `sending` flips true, cleared when it flips back.
  const turnStartedAtRef = useRef(0)
  const [turnNow, setTurnNow] = useState(0)
  const [turnStatus, setTurnStatus] = useState<string | null>(null)
  // The turn's spinner verb — "Percolating…", "Scuttling…" — picked once per
  // turn so the line does not flicker through the dictionary, and replaced by
  // the harness's own status text the moment one arrives.
  const turnVerbRef = useRef<string | null>(null)
  useEffect(() => {
    if (!sending) { setTurnStatus(null); return }
    turnVerbRef.current = pickSpinnerVerb(turnVerbRef.current)
    turnStartedAtRef.current = Date.now()
    setTurnNow(Date.now())
    const id = setInterval(() => setTurnNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [sending])
  // Long pasted user messages the owner chose to unfold, keyed by position and
  // timestamp so a history reconcile cannot re-collapse a different message.
  const [expandedLong, setExpandedLong] = useState<Set<string>>(() => new Set())
  const { toolCalls, applyToolEvent, clearToolCalls } = useChatToolCalls()
  // A delegated coding run outlives the tool call that started it, so this is
  // driven by the device's run record rather than the tool pills. Only probed
  // while the chat is open, and only polled while a run is actually in flight.
  const { runs: codingRuns, nudge: nudgeCodingAgent } = useCodingAgentActivity(isOpen)
  // Every run — live or settled — renders as a card IN the transcript, where
  // the conversation that started it lives. A pinned bar above the messages
  // was tried and rejected by the owner: it covered the chat rather than
  // being part of it.
  const codingAgentCard = (run: CodingAgentActivity) => (
    <CodingAgentActivityPill
      key={run.id}
      run={run}
      labels={{
        running: t("codingAgent.chatWorking"),
        runningOwner: t("codingAgent.chatWorkingOwner"),
        completed: t("codingAgent.chatFinished"),
        failed: t("codingAgent.chatFailed"),
        stopped: t("codingAgent.chatStopped"),
        paused: t("codingAgent.chatPaused"),
        draft: t("codingAgent.chatDraft"),
        timeLeft: t("codingAgent.timeLeft"),
        // A template, not a sentence: the card fills in the count.
        agents: t("codingAgent.chatAgents"),
        tokensWord: t("codingAgent.tokensWord"),
        // The expanded "live work" panel and the tooltip on its header.
        liveWork: t("codingAgent.chatLiveWork"),
        showDetails: t("codingAgent.showDetails"),
        hideDetails: t("codingAgent.hideDetails"),
        thinking: t("codingAgent.thinking"),
        filesTouched: t("codingAgent.chatFilesTouched"),
        turns: t("codingAgent.chatTurns"),
        // The run's own plan on the card, and the word beside the three dots
        // that say a live run is still working.
        plan: t("codingAgent.chatPlan"),
        done: t("codingAgent.chatDone"),
        now: t("codingAgent.chatNow"),
        more: t("codingAgent.chatMore"),
        busy: t("codingAgent.chatBusy"),
        // One word per kind of step the card can draw as a chip — the
        // owner's language for what the harness names by tool.
        steps: {
          screenshot: t("codingAgent.chatScreenshot"),
          lookingAtPage: t("codingAgent.chatLookingAtPage"),
          openingPage: t("codingAgent.chatOpeningPage"),
          drivingPage: t("codingAgent.chatDrivingPage"),
          closingPage: t("codingAgent.chatClosingPage"),
          write: t("codingAgent.chatWrite"),
          edit: t("codingAgent.chatEdit"),
          read: t("codingAgent.chatRead"),
          plan: t("codingAgent.chatPlan"),
        },
      }}
      // View: the run's own page in the Coding Agent app, with the whole
      // desktop for it — the live terminal is embedded there while it runs.
      openLabel={t("codingAgent.liveView")}
      onOpen={() => dispatchOpenCodingRun(run.id, { maximize: true })}
      // A run's screenshot opens in the SAME full-size preview the generated
      // and attached images use (the portal at the end of this component),
      // not a second lightbox of the card's own.
      onPreview={(src, alt) => setPreview({ src, alt })}
    />
  )
  // The questions the agent is currently parked on, newest last.
  //
  // DELIBERATELY NOT PERSISTED. Every other thing a turn produces — the reply,
  // its pictures, its tool steps, its reasoning — is written into `ChatMessage`
  // and comes back from `chat-history-cache` after a refresh, because it is a
  // RECORD. A clarify is not: it is a control that only works while the agent
  // is still parked on that `requestId`, and the moment the page reloads that
  // wait is over. A card replayed from the cache would be an interactive-
  // looking widget inviting an answer that no route could deliver, which is
  // worse than no card at all. So it lives here, in transient state, and
  // `chat-history-cache.ts` gains no field for it.
  const [clarifies, setClarifies] = useState<ClarifyCardState[]>([])
  const clearClarifies = useCallback(() => {
    setClarifies(prev => (prev.length === 0 ? prev : []))
  }, [])
  // Outgoing mail the agent has queued and the owner has not agreed to yet.
  //
  // ONE CARD, however many drafts — see chat-email-batch.tsx for why the
  // reading is the safety mechanism and the click is only the gesture.
  //
  // NOT cleared when the turn ends, and that is the difference from
  // `clarifies` above: a clarify is a question the agent is PARKED on, so it
  // dies with the turn, while this card appears precisely BECAUSE the turn
  // finished and left mail waiting. Nothing here is lost if it goes anyway —
  // a draft still waiting is on disk and Settings → Email lists it, and one
  // that has been decided has a receipt there saying how.
  const [emailBatches, setEmailBatches] = useState<EmailBatchCardState[]>([])
  /**
   * Which read of the approval queue is the current one.
   *
   * The reads overlap: the turn-end collect and a focus or timer tick can be in
   * flight together, and nothing makes two fetches of the same URL come back in
   * the order they were sent. That was harmless while an old answer could only
   * fail to ADD a card. It is not harmless now that an answer also decides what
   * has LEFT the queue: an older read, arriving second, would find the draft a
   * newer one had just reported as waiting missing from its own list and settle
   * the card as "decided somewhere else" — over a draft that is still waiting,
   * on a card the reconcile then skips for ever. So a superseded answer is
   * dropped; the read that superseded it is already on its way.
   */
  const emailQueueReadSeq = useRef(0)
  // Did this turn ask to send mail? Set from the tool stream and read once the
  // turn is over, so the approval queue is only consulted when there is a
  // reason to think something landed in it — rather than on every turn the box
  // ever answers.
  const emailSendSeenRef = useRef(false)
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
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>(SAFE_THINKING_LEVEL)
  // Mirrored and written through one helper, for the reason `applyStreaming`
  // is: the "Switched effort to …" confirmation was appended from INSIDE the
  // `setThinkingLevel` updater, so one click could add two lines to the
  // transcript. The ref is what lets the "did it actually change?" question be
  // answered without one. TASK-703.
  const thinkingLevelRef = useRef<ThinkingLevel>(SAFE_THINKING_LEVEL)
  const applyThinkingLevel = useCallback((next: ThinkingLevel) => {
    thinkingLevelRef.current = next
    setThinkingLevelState(next)
  }, [])
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
  // The message the full-message panel is showing, or null when it is closed.
  // Only the id lives here: the panel fetches the mail itself when it opens, so
  // no message content is held in this component's state or in the transcript.
  const [openEmailUid, setOpenEmailUid] = useState<number | null>(null)
  const closeEmail = useCallback(() => setOpenEmailUid(null), [])
  // True from the image_generate tool call until the picture arrives (or the
  // wait times out). Drives the banner AND the history polling.
  const [generatingImage, setGeneratingImage] = useState(false)
  // How many images the transcript held when the wait began — the picture has
  // landed once that count goes up. A count beats a timestamp here: the browser
  // may be a phone whose clock disagrees with the device's.
  const imageBaselineRef = useRef(0)
  // The COMPOSER's own picture wait, kept apart from `generatingImage` above.
  //
  // Two waits because they end in two different ways. `generatingImage` covers
  // a picture the AGENT is drawing: nothing hands the media back, so it polls
  // the transcript until the image count goes up. This one covers a picture the
  // BOX is fetching, where the call itself resolves with the media — so it ends
  // when the promise does, and sharing the other flag would start that poll and
  // let a history read paint the same picture the promise is about to.
  //
  // Tracked PER CONVERSATION, keyed by tab (null is the main one). It was one
  // component-wide flag, so a picture asked for in one tab put "Generating
  // image…" over another tab's transcript and greyed ITS picture button until
  // the request settled — while the picture itself already followed the rule
  // `dispatchTurn` and `loadHistory` follow and landed in the tab that asked.
  const [drawingTabs, setDrawingTabs] = useState<ReadonlySet<string | null>>(() => new Set())
  // The controllers behind them. Re-entry is decided from the ref, which does
  // not lag a rapid second click on one tab — two generations would be two
  // charges against the customer's daily allowance for one intent — and it
  // carries the aborts, so closing the popup can end every wait nobody is
  // watching any more.
  const drawingRef = useRef(new Map<string | null, AbortController>())
  const syncDrawingTabs = useCallback(() => {
    setDrawingTabs(new Set(drawingRef.current.keys()))
  }, [])

  // ── The Create button's wizard ──
  // The same card the Coding Agent app opens: name, what it should do, which
  // starter. Create hands ONE message to this very chat (through the window
  // event the popup already listens for), so the request lands as the owner's
  // turn and the assistant takes it from there. `maxTaskChars` is read from
  // the run route once, when the card opens; until it answers the card uses
  // the route's own default, and the route still refuses anything longer.
  const [showNewApp, setShowNewApp] = useState(false)
  // What the last opener asked the card to open on: the Coding Agent's
  // project page hands over its project and the team switch.
  const [newAppOptions, setNewAppOptions] = useState<{ project?: string; team?: boolean }>({})
  const [newAppMaxChars, setNewAppMaxChars] = useState<number | null>(null)
  const toggleNewApp = useCallback(() => {
    // The fetch sits BESIDE the setter, not inside the updater: React may run
    // an updater more than once per call, and one click must cost one request.
    if (!showNewApp && newAppMaxChars === null) {
      void fetch('/setup-api/coding-agent/status', { cache: 'no-store' })
        .then(res => res.ok ? res.json() as Promise<{ maxTaskChars?: unknown }> : null)
        .then(data => {
          const n = data?.maxTaskChars
          if (typeof n === 'number' && Number.isFinite(n) && n > 0) setNewAppMaxChars(n)
        })
        .catch(() => { /* the card keeps the default ceiling */ })
    }
    // Closing forgets what the last opener asked for (a project, the team
    // switch): the next "+" must open a fresh card, not the previous
    // project's team form.
    if (showNewApp) setNewAppOptions({})
    setShowNewApp(open => !open)
  }, [showNewApp, newAppMaxChars])
  const closeNewApp = useCallback(() => { setShowNewApp(false); setNewAppOptions({}) }, [])

  // The Coding Agent hands "Create app" over to here: the card composes one
  // message for the assistant, so it belongs in the conversation that will
  // carry the reply, not in a second window that cannot show it.
  useEffect(() => {
    const onNewApp = (e: Event) => {
      const detail = (e as CustomEvent<{ project?: unknown; team?: unknown } | undefined>).detail
      setNewAppOptions({
        project: typeof detail?.project === 'string' ? detail.project : undefined,
        team: detail?.team === true,
      })
      if (!showNewApp) toggleNewApp()
    }
    window.addEventListener(NEW_APP_EVENT, onNewApp)
    return () => window.removeEventListener(NEW_APP_EVENT, onNewApp)
  }, [showNewApp, toggleNewApp])

  // ── Drag + resize state ──
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>(DEFAULT_SIZE)
  // Drag-to-edge snapping, the same zones the app windows use — the chat is a
  // draggable surface on the same desktop, and landing it against an edge had
  // no effect at all before.
  const [snapPreview, setSnapPreview] = useState<SnapZone>(null)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // Remembered size: read once on mount; written by the resize handler when
  // the pointer goes up (see handleResizeStart). Not by an effect on `size` —
  // that ran in the same commit as this restore, saw the default the state
  // still held, and wrote it over the remembered value; with StrictMode's
  // double-run of effects the second restore then read the default back.
  useEffect(() => {
    setSize(readStoredSize())
  }, [])

  // Re-anchor to the mascot when reopened. The size is deliberately kept: the
  // owner resized it once and expects it to stay that way.
  useEffect(() => {
    if (isOpen) { setPos(null); setPreview(null) }
    else { setGeneratingImage(false); closeNewApp() }
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
  // Fully-qualified model behind the active option. The reasoning default is
  // tier-aware for ClawBox AI (the Max tier reasons by default, Flash does
  // not), and the tier is a property of the MODEL, not the provider.
  const headerModel = useMemo<string | null>(() => {
    if (!chatModelState) return null
    const activeOption = chatModelState.options.find(
      (option) => option.id === chatModelState.activeOptionId,
    )
    return activeOption?.model ?? chatModelState.activeModel ?? null
  }, [chatModelState])
  const reasoningConfig = useMemo<ProviderReasoningConfig>(
    () => getProviderReasoningConfig(headerProvider, headerModel),
    [headerProvider, headerModel],
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
  // Does the greying-out rule apply to THIS box? `chatModelState` is refetched
  // whenever the provider changes or a configure lands, so this follows the
  // device rather than being sampled once at mount — a box that swaps a Claude
  // sign-in for an API key gets its full model list back without a reload.
  const headerOnSubscription = useMemo(
    () => !!headerProvider
      && !!chatModelState?.subscriptionProviders?.includes(headerProvider),
    [headerProvider, chatModelState],
  )
  // Pull the account state so the chat-model picker can refuse a ClawBox AI
  // model the PORTAL says this account may not run. Without it a Free user
  // could pick deepseek-v4-pro, see a "Switched chat to
  // deepseek/deepseek-v4-pro" success message, and then get nothing but
  // "[assistant turn failed]" — the proxy answers such a turn
  // `400 "Model not allowed: …"` (measured 2026-09-04), which no chat surface
  // can render as anything the owner could act on. `tier` is the device
  // DEFAULT and never the gate; `allowedModels` is the gate.
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
  /* hermes-reasoning.ts is the vocabulary the CLI speaks and stays English —
     a route imports it. The words on the CONTROL are worded here, with that
     English as the floor, exactly as the effort pill below does: this dial is
     the last one on the composer that still read "Thinking off" on a German
     desktop. Two-state providers get their own pair of keys rather than the
     effort scale's, because "Thinking on" and "High" are different sentences. */
  /** Full label for the open menu. */
  const hermesReasoningLabel = (level: HermesReasoningLevel) => {
    const binary = binaryReasoningLabel(hermesProvider, level)
    if (binary !== null) {
      const on = isThinkingOnLevel(hermesProvider, level)
      return tr(on ? 'chat.thinkingOn' : 'chat.thinkingOff', binary)
    }
    return tr(`chat.effort.${level}`, HERMES_REASONING_LABELS[level])
  }
  /** Compact label for the closed pill, which shares a tight width budget. */
  const hermesReasoningTriggerLabel = (level: HermesReasoningLevel) => {
    const binary = binaryReasoningTriggerLabel(hermesProvider, level)
    if (binary !== null) {
      const on = isThinkingOnLevel(hermesProvider, level)
      return tr(on ? 'chat.thinkingPillOn' : 'chat.thinkingPillOff', binary)
    }
    return tr(`chat.effort.${level}`, HERMES_REASONING_LABELS[level])
  }

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

  // The width a CLOSED chat was docked at, or null when it was floating.
  // Closing has to hand the desktop its strip back (a window must not be
  // squeezed for a panel nobody can see), and the only way to say that is
  // `onPanelModeChange(0)` — which also drops the dock. So the layout the owner
  // chose is remembered here and put back on the next open: the X used to turn
  // a docked panel into a 520x680 floating popup.
  const dockedBeforeCloseRef = useRef<number | null>(null)

  // Give the desktop its strip back while the chat is closed, and take the
  // dock back when it opens again.
  useEffect(() => {
    if (!isOpen && panelMode) {
      dockedBeforeCloseRef.current = panelWidth
      setPanelWidth(null)
      onPanelModeChange?.(0)
      return
    }
    // Not on a phone: the dock is a desktop layout (see `panelMode`), and
    // taking it back here would hand the desktop a strip to reserve for a panel
    // this viewport does not draw. The width is held until the window is wide
    // enough again, which re-runs this effect.
    if (isOpen && !panelMode && !mobile && dockedBeforeCloseRef.current !== null) {
      const restored = dockedBeforeCloseRef.current
      dockedBeforeCloseRef.current = null
      setPanelWidth(restored)
      onPanelModeChange?.(restored)
    }
  }, [isOpen, panelMode, panelWidth, mobile, onPanelModeChange])

  // What the floating popup covers, for the desktop surfaces that must keep
  // clear of it. Reported only while the desktop is listening (it passes no
  // callback unless a notice is actually on screen), because `pos`/`size` move
  // on every pointer event of a drag and each report is a desktop re-render.
  const reportedRectRef = useRef<string | null>(null)
  useEffect(() => {
    if (!onFloatingRectChange) return
    if (!isOpen || panelMode || mobile) {
      if (reportedRectRef.current !== null) {
        reportedRectRef.current = null
        onFloatingRectChange(null)
      }
      return
    }
    const report = () => {
      const el = popupRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const key = `${r.left}|${r.top}|${r.right}|${r.bottom}`
      if (key === reportedRectRef.current) return
      reportedRectRef.current = key
      onFloatingRectChange({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }
    report()
    window.addEventListener('resize', report)
    return () => window.removeEventListener('resize', report)
  }, [isOpen, panelMode, mobile, pos, size, visible, onFloatingRectChange])

  const togglePanelMode = useCallback(() => {
    if (panelMode) {
      setPanelWidth(null)
      onPanelModeChange?.(0)
    } else {
      setPanelWidth(DEFAULT_PANEL_WIDTH)
      onPanelModeChange?.(DEFAULT_PANEL_WIDTH)
    }
    setPos(null)
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
      // Clamped to the screen the popup is being dragged on: dropped below the
      // bottom edge its composer is unreachable, and dropped past the right one
      // its close button is. A popup taller or wider than the viewport lands at
      // the top-left gutter, where its header is at least on screen.
      const x = d.origX + (ev.clientX - d.startX)
      const y = d.origY + (ev.clientY - d.startY)
      setPos({
        x: Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - rect.width - VIEWPORT_MARGIN)),
        y: Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - rect.height - VIEWPORT_MARGIN)),
      })
      setSnapPreview(getSnapZone(ev.clientX, ev.clientY))
    }
    const onUp = (ev: PointerEvent) => {
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // Read the zone from the RELEASE point, not from the preview state: a
      // pointerup can arrive without a preceding pointermove (a click that
      // barely moved), and reusing a stale preview would snap on a drag that
      // never reached an edge.
      const zone = getSnapZone(ev.clientX, ev.clientY)
      setSnapPreview(null)
      const rect = getSnapRect(zone)
      if (!rect) return
      // Honour the chat's own floor. `getSnapRect` divides the screen, and half
      // of a narrow window is narrower than the chat can render.
      setPos({ x: rect.x, y: rect.y })
      setSize({ w: Math.max(MIN_CHAT_WIDTH, rect.width), h: Math.max(MIN_CHAT_HEIGHT, rect.height) })
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
      // Each edge stops at the viewport gutter as well as at the size floor:
      // dragging the bottom-right corner past the screen used to keep growing
      // the popup, pushing the send button and the header's controls off it.
      // The floor wins on a screen too small for it — a chat clipped at the
      // edge is still usable, one narrower than MIN_CHAT_WIDTH is not.
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (edge.includes('r')) newW = Math.max(MIN_CHAT_WIDTH, Math.min(start.w + dx, vw - start.left - VIEWPORT_MARGIN))
      if (edge.includes('b')) newH = Math.max(MIN_CHAT_HEIGHT, Math.min(start.h + dy, vh - start.top - VIEWPORT_MARGIN))
      // Growing leftward/upward moves the far edge, which is what has to stay
      // inside: the right edge is fixed at `start.left + start.w`.
      if (edge.includes('l')) { newW = Math.max(MIN_CHAT_WIDTH, Math.min(start.w - dx, start.left + start.w - VIEWPORT_MARGIN)); newX = start.left + (start.w - newW) }
      if (edge.includes('t')) { newH = Math.max(MIN_CHAT_HEIGHT, Math.min(start.h - dy, start.top + start.h - VIEWPORT_MARGIN)); newY = start.top + (start.h - newH) }
      setSize({ w: newW, h: newH })
      setPos({ x: newX, y: newY })
      last = { w: newW, h: newH }
    }
    let last: { w: number; h: number } | null = null
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
      // The size the owner let go at is the one to remember — once per
      // resize, not once per pointer move.
      if (last) {
        try { window.localStorage?.setItem(SIZE_STORAGE_KEY, JSON.stringify(last)) } catch { /* localStorage unavailable */ }
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onMove)
    window.addEventListener('touchend', onUp)
  }, [])

  const wsRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef<Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(new Map())
  const sessionKeyRef = useRef<string>('')
  // ── Tabs ──
  // `activeTabKeyRef` is what the hello handler binds the socket to on every
  // (re)connect — a gateway bounce or a provider switch must bring the owner
  // back to the tab they were on, not to main. null = the main session.
  const storedTabs = useRef(readStoredTabs()).current
  const [tabs, setTabs] = useState<ChatTab[]>(storedTabs.tabs)
  const [activeTabKey, setActiveTabKey] = useState<string | null>(storedTabs.active)
  const activeTabKeyRef = useRef<string | null>(storedTabs.active)
  /** Is THIS conversation waiting on a composer picture? See `drawingTabs`. */
  const drawing = drawingTabs.has(activeTabKey)
  const [mainSessionKey, setMainSessionKey] = useState('')
  const mainSessionKeyRef = useRef('')
  // Sessions whose turn is still running while another tab is shown. The
  // popup keeps ONE set of in-flight state, so leaving a tab mid-turn puts
  // that state down and remembers the session here; the `chat` handler
  // clears the entry when the terminal event for that key arrives, and marks
  // the tab unread so the owner knows there is something to read.
  const busyKeysRef = useRef<Set<string>>(new Set())
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set())
  const [unreadKeys, setUnreadKeys] = useState<Set<string>>(() => new Set())
  // The composer a tab was left with: its draft and the turns queued behind
  // its running one. Restored when the tab is shown again, so text typed for
  // one conversation is never sent into another.
  const tabStashRef = useRef<Map<string, { input: string; queuedSends: QueuedSend[]; attachments: ChatAttachment[]; runId: string | null; voiceTurnKey: string | null }>>(new Map())
  // A run that died in a background tab leaves NOTHING in the transcript to
  // explain itself — the error line is client-side only. It is kept here when
  // the terminal event goes by and handed over when the tab is next shown.
  const tabErrorsRef = useRef<Map<string, string>>(new Map())
  // Bumped on every tab switch so the sticky reasoning level is pushed to the
  // session that is now bound (the effect below cannot see a ref change).
  const [sessionEpoch, setSessionEpoch] = useState(0)
  useEffect(() => {
    try { window.localStorage?.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs, active: activeTabKey })) } catch { /* localStorage unavailable */ }
  }, [tabs, activeTabKey])
  // The adapter, for the two stable callbacks below that run inside the socket
  // handshake and cannot re-create themselves when it changes.
  const adapterRef = useRef<HarnessAdapter | null>(null)
  /**
   * Bind the popup to its main session: the gateway's, named by the hello, or
   * the desktop transcript on a harness with no handshake to name one.
   *
   * Tabs are minted beside a main key and only mean something to their own
   * transport, and the stored list can hold the other one's — a dual box that
   * switched harness — so what the adapter does not own is dropped here. The
   * bound key is the open tab if it survived, else main. Idempotent: a re-bind
   * (a reconnect, a capability re-probe) keeps the owner where they were.
   */
  const bindMainSession = useCallback((main: string): string => {
    mainSessionKeyRef.current = main
    setMainSessionKey(main)
    const owns = (key: string) => adapterRef.current?.ownsSessionKey(key) ?? true
    setTabs(prev => prev.every(tb => owns(tb.key)) ? prev : prev.filter(tb => owns(tb.key)))
    if (activeTabKeyRef.current !== null && !owns(activeTabKeyRef.current)) {
      activeTabKeyRef.current = null
      setActiveTabKey(null)
    }
    const bound = activeTabKeyRef.current ?? main
    sessionKeyRef.current = bound
    return bound
  }, [])
  /**
   * A run on `key` has ended. Its busy mark goes — a tab the owner left
   * mid-run and came back to carries one too — and a tab they are NOT looking
   * at also turns unread and keeps the error for their return: nothing in a
   * transcript explains a run that died, so the line is client-side only.
   * A key with no mark ended in the tab they never left, or in one they have
   * since closed; nothing to mark either way.
   */
  const settleRun = useCallback((key: string, error?: string) => {
    if (!busyKeysRef.current.delete(key)) return
    setBusyKeys(new Set(busyKeysRef.current))
    if (key === sessionKeyRef.current) return
    setUnreadKeys(prev => new Set(prev).add(key))
    if (error) tabErrorsRef.current.set(key, error)
  }, [])
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
  /**
   * `settleEmailDrafts`, reachable from the gateway socket handler.
   *
   * A ref for the same reason `dispatchTurnRef` is one: `connect` is a
   * `useCallback([])` on purpose, and adding a dependency to it would tear the
   * socket down and rebuild it every time this callback's identity changed.
   */
  const settleEmailDraftsRef = useRef<() => Promise<void>>(async () => {})
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


  /**
   * Settle every in-flight RPC, then forget them.
   *
   * A teardown that merely dropped the map left each caller waiting forever:
   * the 120-second timeout below only fires while the entry is STILL THERE, so
   * `pendingRef.current.clear()` silently orphaned the promise instead of
   * ending it. A `chat.send` orphaned that way is the expensive case — the run
   * never completes, so the sending guard is never cleared, and the queue parks
   * behind a turn that can no longer arrive.
   */
  const failPending = useCallback((reason: string) => {
    const waiting = [...pendingRef.current.values()]
    pendingRef.current.clear()
    for (const entry of waiting) entry.reject(new Error(reason))
  }, [])

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
    close: () => { wsRef.current?.close(); wsRef.current = null; failPending('Not connected') },
    onStatus: (cb) => {
      statusListenersRef.current.add(cb)
      return () => { statusListenersRef.current.delete(cb) }
    },
  }), [wsRequest, failPending])
  // Read at send time, exactly as the refs behind it always were: a header pill
  // changed mid-run therefore applies to the NEXT turn, never retroactively to
  // the one in flight.
  const hermesContext = useCallback(() => ({
    devicePairing: hermesDeviceRef.current,
    modelsReady: hermesScopeReadyRef.current,
    sessionKey: sessionKeyRef.current,
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
  useEffect(() => { adapterRef.current = adapter }, [adapter])
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
    const wireLevel = resolveWireThinkingLevel(headerProvider, thinkingLevel, headerModel)
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
        if (thinkingLevelRef.current !== suggested) applyThinkingLevel(suggested)
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
  // `sessionEpoch` is bumped by switchSession so a new tab's session gets the level too.
  }, [status, headerProvider, headerModel, thinkingLevel, adapter, caps, sessionEpoch, applyThinkingLevel])

  // Snap thinkingLevel to the active provider's persisted choice (or its
  // default) whenever the active provider changes. Without this the
  // global state would carry e.g. an OpenAI `xhigh` choice over to a
  // DeepSeek session that doesnt support xhigh, and `effectiveThinkingLevel`
  // would silently fall back to the provider default while the actual
  // state still said xhigh — confusing and racey when the user then
  // tries to change levels.
  //
  // Keyed on the model as well: within ClawBox AI the default moves with the
  // tier (Max reasons by default, Flash does not), so a Flash↔Max switch has
  // to re-snap too. A persisted user choice is per provider and still wins.
  useEffect(() => {
    if (!headerProvider) return
    const cfg = getProviderReasoningConfig(headerProvider, headerModel)
    const persisted = readPersistedThinkingLevel(headerProvider, cfg)
    if (thinkingLevelRef.current !== persisted) applyThinkingLevel(persisted)
  }, [headerProvider, headerModel, applyThinkingLevel])

  const handleThinkingLevelChange = useCallback((next: string) => {
    const cfg = getProviderReasoningConfig(headerProvider, headerModel)
    const normalized: ThinkingLevel = cfg.levels.includes(next as ThinkingLevel)
      ? (next as ThinkingLevel)
      : cfg.default
    if (thinkingLevelRef.current !== normalized) {
      applyThinkingLevel(normalized)
      const label = THINKING_LEVEL_LABELS[normalized] ?? normalized
      setMessages(msgs => [...msgs, {
        role: 'system',
        text: `Switched effort to ${label}.`,
        timestamp: Date.now(),
        variant: 'success',
      }])
    }
    if (headerProvider) {
      try { window.localStorage?.setItem(`${PERSIST_KEY_PREFIX}:${headerProvider}`, normalized) } catch { /* localStorage unavailable */ }
    }
  }, [headerProvider, headerModel, applyThinkingLevel])

  // Connect to gateway
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
    failPending('Connection restarted')
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

    const sendConnect = (challenge?: Record<string, unknown>) => {
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
          // The tab the owner is on survives the reconnect. Before tabs this
          // line bound every hello to main, so a gateway bounce mid-conversation
          // in another tab would have reloaded main's transcript over it.
          const boundKey = bindMainSession(mainSessionKey)
          // A reconnect: whatever a background tab was waiting on either died
          // with the gateway or finished while the socket was down — its
          // terminal event is gone, so a busy mark kept here could never be
          // cleared again and the tab would pulse (and wedge its composer)
          // forever. Point the owner at the tab instead; its history has the
          // truth. The bound tab is about to be reloaded, so it needs no dot.
          if (busyKeysRef.current.size > 0) {
            setUnreadKeys(prev => {
              const next = new Set(prev)
              for (const k of busyKeysRef.current) { if (k !== boundKey) next.add(k) }
              return next
            })
            busyKeysRef.current.clear()
            setBusyKeys(new Set())
          }
          // Ask the gateway to push every append to this session's transcript.
          // A generated picture is produced by a SEPARATE background run whose
          // reply reaches the `chat` stream with its MEDIA: directive stripped,
          // so that stream alone can never show it — this event is how we learn
          // the transcript gained something the live turn could not render.
          // Same projection `chat.history` uses, so the directive is intact.
          void wsRequest('sessions.messages.subscribe', { key: boundKey })
            .catch(() => {
              // A gateway without the RPC just means we fall back to the
              // backstop reconcile below; the chat still works.
            })
          // Only a provider change or a plain gateway restart gets here: those
          // are the two things that still bounce the gateway and drop this
          // socket. A skill change no longer does either, so it never raises
          // the overlay and is handled entirely in its own event handler
          // (search for skillHandler) — it must not be re-handled here.
          //
          // Both survivors keep the visible history: a provider change only
          // swapped the backend session override, and a restart changed
          // nothing about the conversation at all.
          if (skillInstalledRef.current) {
            const wasProviderChange = reloadReasonRef.current === 'provider'
            skillInstalledRef.current = false
            reloadReasonRef.current = 'skill' // reset for next reload
            skillEventRef.current = null
            // Complete the progress bar
            if (reloadTimerRef.current) clearInterval(reloadTimerRef.current)
            setReloadProgress(100)
            // Small delay to show 100%, then drop the overlay. A provider
            // change additionally surfaces a green "Switched chat to X" banner
            // so the user has an explicit confirmation the new provider is
            // active.
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
                    // The fresh chat belongs to MAIN — the pre-tabs contract,
                    // and the session every other surface shares. With a side
                    // tab bound, resetting "the current session" would wipe
                    // the conversation under the owner's cursor and leave
                    // main carrying the old model's transcript — the exact
                    // leak the banner below claims was prevented.
                    if (sessionKeyRef.current === mainSessionKeyRef.current) {
                      await resetSessionRef.current()
                    } else {
                      await wsRequest('sessions.reset', { key: mainSessionKeyRef.current, reason: 'new' })
                    }
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
            }, 500)
          } else {
            loadHistory()
          }
        },
        reject: (err: Error) => {
          // The fifth terminal-failure path, and it used to be the one that
          // forgot both halves. A gateway that REFUSES the connect frame
          // (protocol skew, a rejected device identity, a denied scope) keeps
          // the socket open, so without the close below `connect()` returns at
          // its `readyState === OPEN` guard and even the manual Try again is a
          // no-op; and without the teardown the reconnect overlay hides the
          // error panel, which is the TASK-712 spinner-that-never-comes-down
          // from a far likelier trigger than an unparsable URL.
          tearDownReloadOverlay()
          if (wsRef.current === ws) wsRef.current = null
          try { ws.close() } catch { /* already closing */ }
          setStatus('error')
          setErrorMsg(err.message || 'Auth failed')
        },
      })
      // OpenClaw 2 requires a device identity from webchat clients; the
      // challenge's nonce+ts are what it signs. Built as null against an
      // older gateway (no ts in the challenge) and the field is simply
      // omitted — the exact pre-2026.8 frame. Every signed value must match
      // this frame byte for byte, so the shared literals live in consts.
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
          sendConnect(data.payload as Record<string, unknown> | undefined)
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
            // The moment a coding-agent tool goes by, ask the device what is
            // running. Cheaper and more certain than polling on a timer: the
            // one event that means "a run may have just started" is right here.
            if (typeof toolData?.name === 'string' && isCodingAgentTool(toolData.name)) nudgeCodingAgent()
            // The gateway's own tool stream is where an OpenClaw-edition turn
            // reports `email_send`; the adapter callback never sees it,
            // because that harness only ACKs the turn.
            if (typeof toolData?.name === 'string' && isEmailSendTool(toolData.name)) {
              emailSendSeenRef.current = true
            }
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
            const pushedText = splitEmailRefs(splitMediaDirectives(pushedRaw).text).text
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
                // The STORED text still carries its `EMAIL:` lines — they are
                // lifted at render, not at write — and a caption can carry a
                // `MEDIA:` line too, while `pushedText` has had
                // them taken out. Compare like with like, or a turn that named
                // messages never matches its own spoken supplement and the
                // audio is dropped.
                if (candidate.role !== 'assistant') continue
                if (splitEmailRefs(splitMediaDirectives(candidate.text).text).text !== pushedText) continue
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
          const state = payload.state as string
          // A run the owner left behind in another tab has ended: the tab is
          // no longer busy and has something new to read. Checked BEFORE the
          // session filter, which is what would otherwise drop the event. The
          // error branch below never runs for a background session, and a
          // history reload cannot recreate what was never stored.
          if (state === 'final' || state === 'aborted' || state === 'error') {
            settleRun(sk, state === 'error' ? describeChatFailure(payload.errorMessage) : undefined)
          }
          if (sk !== sessionKeyRef.current) return

          const msg = payload.message

          if (state === 'delta') {
            // Strip MEDIA: directives while streaming, or the raw path flashes
            // in the bubble for the moment before `final` lands.
            //
            // `EMAIL:` is deliberately NOT stripped here — only in the render
            // below. An interrupted turn is appended from this buffer
            // (`aborted`, further down), so stripping into state left that
            // turn holding text with its directives already gone and the
            // messages it named unopenable for good. The bubble looks the same
            // either way; only what survives an interrupt differs.
            const text = splitMediaDirectives(extractText(msg)).text
            // Sentinels would flash before the final-state filter drops them.
            // Asked of the text as the BUBBLE will show it, not of the buffer:
            // `SENTINEL_RE` anchors the whole string, so once the directives
            // stopped being stripped on the way in, `NO_REPLY\nEMAIL:4471`
            // stopped looking like a sentinel and the marker reached the
            // bubble. The buffer is still what gets STORED, so an interrupt
            // keeps the directives and their cards.
            if (text && !isSentinel(streamingEmailRefsText(text)) && !isInterSessionEnvelope(text, msg)) {
              applyStreaming(text); setReloadingSkill(false)
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
              // Spoken back when a spoken question started this run.
              void maybeSpeakReplyRef.current(runIdRef.current, text, audio)
            }
            // The run this final closes, for the ack-only branch below (the
            // ref is cleared two lines down).
            const finishedRun = runIdRef.current
            applyStreaming('')
            clearToolCalls()
            runIdRef.current = null
            sendingRef.current = false; setSending(false)
            // The turn is over on this harness too, so mail it queued is now
            // waiting and gets its one card.
            void settleEmailDraftsRef.current()
            // OpenClaw can ack a turn with "Sent." (delivery-mirror persona
            // pipeline / internal-source-reply) while the real reply is
            // generated server-side a moment later — persisted but never
            // streamed via WS. Only refetch history in that ack-only case,
            // detected by an empty / "Sent."-only `final`. Normal streamed
            // replies arrive via delta+final and don't need the extra
            // round-trip every turn.
            if (isAckOnly) {
              // The real reply arrives through the history refetch below, as
              // a stored message rather than a live final. A spoken question
              // is still owed a spoken answer: the mark is taken now and the
              // restored reply spoken once the refetch has painted it.
              const speakRestored = finishedRun !== null && voiceTurnKeyRef.current === finishedRun
              if (speakRestored) voiceTurnKeyRef.current = null
              if (ackOnlyHistoryTimerRef.current !== null) {
                window.clearTimeout(ackOnlyHistoryTimerRef.current)
              }
              ackOnlyHistoryTimerRef.current = window.setTimeout(() => {
                ackOnlyHistoryTimerRef.current = null
                // What loadHistory ANSWERS, not messagesRef: the ref follows
                // the state a render later, so right here it may still be
                // the transcript from before the read.
                void loadHistory().then((loaded) => {
                  if (!speakRestored || sessionKeyRef.current !== sk) return
                  const restored = [...(loaded ?? [])].reverse().find(m => m.role === 'assistant')
                  if (restored) void speakReplyRef.current(restored.text, restored.audio ?? [])
                })
              }, 3_000)
            }
          } else if (state === 'aborted' || state === 'error') {
            // Read, clear, THEN append — all three outside any updater, for the
            // same reason as the full-screen chat: React may run an updater
            // twice, and this one appended a message.
            //
            // A Stop between `EMAIL` and its digits would store the half-written
            // line, which the render keeps as text, leaving a bare `EMAIL:` in
            // the transcript for good. It can never become a card and the bubble
            // was already hiding it, so the stored turn is what the owner last
            // saw.
            const kept = dropUnfinishedDirective(streamingRef.current)
            applyStreaming('')
            if (kept.trim() && !isSentinel(streamingEmailRefsText(kept))) {
              setMessages(msgs => [...msgs, { role: 'assistant', text: kept, timestamp: Date.now() }])
            }
            clearToolCalls()
            runIdRef.current = null
            sendingRef.current = false; setSending(false)
            // Same as the failing adapter path: a turn that died may still
            // have left a draft on disk before it did.
            void settleEmailDraftsRef.current()
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

    const onClose = (event?: CloseEvent) => {
      // Only the socket that is CURRENTLY installed may tear anything down. A
      // close event from a socket this connect already replaced arrives late
      // and describes a connection nobody is using — acting on it would null
      // the live socket's reference, reject the requests waiting on IT, and
      // schedule a reconnect on top of a healthy connection.
      if (wsRef.current !== ws) return
      wsRef.current = null
      // The socket is gone; nothing that was waiting on it can still arrive.
      failPending('Not connected')

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
    } catch (err) {
      // The same terminal-failure teardown the other three error paths do, and
      // for the same reason. A wsUrl the browser's parser rejects throws here
      // on EVERY attempt, so leaving the overlay up left the safety-net retry
      // effect armed — and that effect resets `retryCountRef` to 0 before it
      // reconnects, which is the counter both exhaustion branches are gated
      // on. The ladder could never run out: one doomed attempt every
      // RETRY_DELAY for as long as the chat window stayed open, behind a
      // spinner that never came down (TASK-712).
      tearDownReloadOverlay()
      setStatus('error')
      // With the reason. The realistic triggers are browser-side refusals —
      // mixed content (a `ws://` url offered to an HTTPS page behind a proxy
      // that hid the scheme) and a CSP `connect-src` block — and the bare
      // message sent the owner looking at the gateway instead. Safe to show:
      // the token travels in the connect frame, not in `wsUrl`.
      const reason = err instanceof Error ? err.message : String(err)
      setErrorMsg(reason ? `WebSocket creation failed: ${reason}` : 'WebSocket creation failed')
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

  // Re-read the provider/model list the moment anything reports a provider
  // change, so a provider connected in Settings while this popup is open is
  // offered here without a reload. Through the shared subscriber, which spans
  // both harnesses' signal names and debounces the burst a single save emits.
  useEffect(() => {
    if (!isOpen) return
    return onProvidersChanged(() => { refreshChatModelState() })
  }, [isOpen, refreshChatModelState])

  // Load chat history, auto-greet if empty
  const greetedRef = useRef(false)
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
    const keyAtCall = sessionKeyRef.current
    const mightAutoGreet = !greetedRef.current
    if (mightAutoGreet) {
      setIsBootstrappingHistory(true)
      applyStreaming('')
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
      // The owner switched tabs while this read was in flight (the request
      // key was captured at call time): the answer belongs to the tab that
      // was left. Painting it would put one conversation inside another —
      // and the auto-label effect would then name the new tab after it.
      // The new tab runs a read of its own.
      if (sessionKeyRef.current !== keyAtCall) {
        if (mightAutoGreet) setIsBootstrappingHistory(false)
        return
      }
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

      // Auto-send a greeting if no history exists (first conversation).
      // Main only: a restored side tab the owner never typed in is ALSO an
      // empty transcript, and on a desktop reload the hello binds straight to
      // it — greeting there would spend a model turn nobody asked for and
      // resurrect a session the gateway may have deleted. (On Hermes both
      // keys are '' and the greet keeps working as before.)
      if (chatMsgs.length === 0 && !greetedRef.current && sessionKeyRef.current === mainSessionKeyRef.current) {
        greetedRef.current = true
        setIsBootstrappingHistory(false)
        sendingRef.current = true
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
  }, [adapter, caps, applyStreaming])

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
    applyStreaming('')
    // The bubbles holding spoken replies are gone for good (a returned-to tab
    // repaints from the box's history, which cannot carry a browser-local
    // blob URL), so the blobs go with them. This panel never unmounts while
    // the desktop is open, so this — not the unmount cleanup — is where a
    // day of voice use is kept from retaining every reply ever spoken.
    releaseSpokenReplies()
    // The pills render from their own state, outside the transcript map, and
    // the socket only clears them on `final`/`aborted`/`error`. New chat during
    // a live turn beats all three, which left the previous turn's pills sitting
    // under an empty conversation.
    clearToolCalls()
    // And the same for a question the previous turn was parked on: the thread
    // it belonged to is gone, so answering it now would push a reply into a
    // conversation the agent has been told to forget.
    clearClarifies()
    // And the approval card, for a narrower reason: nothing is lost by taking
    // it away — every draft is still on disk and Settings → Email lists them —
    // but a card left under a blanked conversation refers to a turn that is no
    // longer on screen, which is a consent form with its context deleted.
    setEmailBatches([])
    // The auto-greet opens a FIRST conversation; re-arming it here would drop
    // an unasked-for "hi" into the chat the moment it was cleared.
    greetedRef.current = true
  }, [clearToolCalls, clearClarifies, applyStreaming])

  const resetSession = useCallback(async () => {
    await adapter.resetSession()
    clearTranscript()
  }, [adapter, clearTranscript])
  const resetSessionRef = useRef(resetSession)
  useEffect(() => { resetSessionRef.current = resetSession }, [resetSession])

  // Restart the main conversation in place — the ✕ on the main tab, which
  // cannot be closed. The strip's + used to do this on the Hermes edition, on
  // the belief that one transcript was all that harness could hold; it opens
  // a tab there now, exactly as it does on OpenClaw (see newTab).
  const [startingSession, setStartingSession] = useState(false)
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

  /**
   * Show another tab's session in this popup.
   *
   * The popup has ONE set of conversation state, so a switch is: put down
   * what belongs to the tab being left, repoint the session key, pick up what
   * belongs to the tab being entered, read its transcript. A turn still
   * running in the tab being left is NOT aborted — that is the point of a
   * second tab — the session is marked busy instead, and the `chat` handler
   * clears the mark when the run's terminal event arrives. Everything keyed
   * to the old session that could otherwise fire against the new one is
   * cancelled here: the two history-refetch timers, the picture wait, the
   * queued turns (stashed with the tab, not dropped).
   */
  const switchSession = useCallback(async (key: string) => {
    if (!key || key === sessionKeyRef.current) return
    const oldKey = sessionKeyRef.current
    // `runId` rides with the rest: the live-frame gates in `dispatchTurn` ask
    // whether the frame belongs to the run this popup is showing, and a tab
    // returned to with the id dropped would take its own reply as a stranger's
    // and stop painting it.
    if (oldKey) tabStashRef.current.set(oldKey, { input, queuedSends, attachments, runId: runIdRef.current, voiceTurnKey: voiceTurnKeyRef.current })
    voiceTurnKeyRef.current = null
    if (sendingRef.current && oldKey) {
      busyKeysRef.current.add(oldKey)
      setBusyKeys(new Set(busyKeysRef.current))
    }
    sendingRef.current = false
    setSending(false)
    runIdRef.current = null
    if (transcriptReconcileTimerRef.current !== null) {
      window.clearTimeout(transcriptReconcileTimerRef.current)
      transcriptReconcileTimerRef.current = null
    }
    if (ackOnlyHistoryTimerRef.current !== null) {
      window.clearTimeout(ackOnlyHistoryTimerRef.current)
      ackOnlyHistoryTimerRef.current = null
    }
    // The AGENT's picture wait, which belongs to the turn being left behind.
    // The COMPOSER's (`drawingTabs`) deliberately survives: it is keyed by tab
    // now, so it stays with the conversation that asked and is on screen again
    // when the owner comes back to it.
    endImageWait()
    imageWaitFromRef.current = 0
    imageBaselineRef.current = 0
    emailSendSeenRef.current = false
    setExpandedLong(new Set())
    setPreview(null)
    setOpenEmailUid(null)
    setIsBootstrappingHistory(false)
    if (oldKey) void wsRequest('sessions.messages.unsubscribe', { key: oldKey }).catch(() => { /* best effort */ })
    // The switch itself. From here the adapter, the three event filters and
    // the sticky-reasoning guard all follow the new key.
    sessionKeyRef.current = key
    const nextActive = key === mainSessionKeyRef.current ? null : key
    activeTabKeyRef.current = nextActive
    setActiveTabKey(nextActive)
    messagesRef.current = []
    // Blanks the view and marks the greet done, so an empty new tab does not
    // greet itself with an unasked-for "hi".
    clearTranscript()
    void wsRequest('sessions.messages.subscribe', { key }).catch(() => { /* best effort */ })
    lastSentThinkingRef.current = undefined
    setSessionEpoch(e => e + 1)
    const stash = tabStashRef.current.get(key)
    setInput(stash?.input ?? '')
    setQueuedSends(stash?.queuedSends ?? [])
    // The staged files too — a screenshot attached in one conversation must
    // not ride into another and be sent with its next message.
    setAttachments(stash?.attachments ?? [])
    setAttachmentError(null)
    // Its run is still going: Stop stays available and the composer queues,
    // exactly as if the owner had never left.
    const stillRunning = busyKeysRef.current.has(key)
    if (stillRunning) {
      sendingRef.current = true
      setSending(true)
      runIdRef.current = stash?.runId ?? null
      voiceTurnKeyRef.current = stash?.voiceTurnKey ?? null
    }
    // A spoken question whose run finished while the owner was elsewhere:
    // the reply is in the history about to load, and it is still owed aloud.
    const speakOnReturn = !stillRunning && Boolean(stash?.voiceTurnKey)
    setUnreadKeys(prev => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    const loaded = await loadHistory()
    // The owner switched again while that read was in flight. `loadHistory`
    // protects its own paint the same way; without this the tab being left
    // would hand its error to whichever conversation is on screen now — and
    // lose it, because the entry is taken out of the map as it is read.
    if (sessionKeyRef.current !== key) return
    if (speakOnReturn) {
      const restored = [...(loaded ?? [])].reverse().find(m => m.role === 'assistant')
      if (restored) void speakReplyRef.current(restored.text, restored.audio ?? [])
    }
    const storedError = tabErrorsRef.current.get(key)
    if (storedError) {
      tabErrorsRef.current.delete(key)
      // …unless the replay above already carries it. This line exists for a
      // transport whose failures live only in the browser (the gateway's:
      // a run that died in a background tab leaves nothing behind). A box that
      // keeps its own transcript records the failure there itself, and the
      // history read has just painted it — appending here would report one
      // failed turn twice, in two different wordings.
      const replayed = loaded?.[loaded.length - 1]
      if (replayed?.variant !== 'error') {
        setMessages(prev => [...prev, { role: 'system', text: storedError, timestamp: Date.now() }])
      }
    }
  }, [input, queuedSends, attachments, clearTranscript, endImageWait, loadHistory, wsRequest])

  /** The + : a new tab, bound to a fresh session under the same agent. */
  const newTab = useCallback(() => {
    const main = mainSessionKeyRef.current
    if (!main) return
    const key = adapter.newSessionKey(main)
    setTabs(prev => {
      const nextSeq = prev.reduce((m, tb) => Math.max(m, tb.seq ?? 1), 1) + 1
      return [...prev, {
        key,
        label: t('chat.tabUntitled', { n: nextSeq }),
        createdAt: Date.now(),
        autoLabel: true,
        seq: nextSeq,
      }]
    })
    void switchSession(key)
  }, [adapter, switchSession, t])

  /**
   * Close a tab: the popup forgets it and the transport deletes the session
   * behind it — a closed tab cannot be reopened from here, so a session kept
   * would only clutter it. Main can never be closed.
   */
  const closeTab = useCallback((key: string) => {
    const idx = tabs.findIndex(tb => tb.key === key)
    if (idx < 0) return
    // Is a run still on the session? One left behind earlier sits in the busy
    // set — but the busy set is only written on the way OUT of a tab, so the
    // common case, closing the tab you are watching while its reply streams,
    // lives in sendingRef alone. Decide BEFORE switching away, which resets
    // both.
    const running = busyKeysRef.current.has(key) || (sessionKeyRef.current === key && sendingRef.current)
    const remaining = tabs.filter(tb => tb.key !== key)
    setTabs(remaining)
    tabStashRef.current.delete(key)
    tabErrorsRef.current.delete(key)
    setUnreadKeys(prev => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    // A composer picture still being fetched for THIS tab. `deleteSession`
    // cannot reach it — it aborts the adapter's own turn controller, and only
    // when `running`, which a drawing tab never sets — and the image route
    // appends the picture to the transcript when it lands, so a generation left
    // running would re-create the file this close is about to delete, with the
    // owner's conversation back on disk and the picture billed against a
    // conversation that no longer exists.
    drawingRef.current.get(key)?.abort()
    const dispose = async () => {
      // switchSession marks the key busy on the way out when its run is
      // live; the tab is gone now, so the mark must go too.
      if (busyKeysRef.current.delete(key)) setBusyKeys(new Set(busyKeysRef.current))
      await adapter.deleteSession(key, { running })
    }
    if (sessionKeyRef.current === key) {
      // The neighbour on the left, else the one that slid into its place, else main.
      const next = remaining[idx - 1]?.key ?? remaining[idx]?.key ?? mainSessionKeyRef.current
      void switchSession(next).then(dispose)
    } else {
      void dispose()
    }
  }, [tabs, switchSession, adapter])

  // A new tab is named after the first thing the owner says in it, once.
  useEffect(() => {
    const key = activeTabKey
    if (!key) return
    const tab = tabs.find(tb => tb.key === key)
    if (!tab?.autoLabel) return
    const first = messages.find(m => m.role === 'user' && m.text.trim())
    if (!first) return
    const text = first.text.replace(/^📎 .*$/gm, '').replace(/\s+/g, ' ').trim()
    if (!text) return
    const label = text.length > TAB_LABEL_MAX ? `${text.slice(0, TAB_LABEL_MAX).trimEnd()}…` : text
    setTabs(prev => prev.map(tb => tb.key === key ? { ...tb, label, autoLabel: false } : tb))
  }, [messages, activeTabKey, tabs])

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
  // Whether this ORIGIN can capture audio at all (TASK-470). Resolved after
  // mount because the server has no `window` to ask, and it starts at "ok" so
  // the first paint on a perfectly capable box never flashes a refusal.
  const [captureAvailability, setCaptureAvailability] = useState<CaptureAvailability>('ok')
  // The popup that answers "then where DOES the mic work?" on an insecure
  // origin: it offers a live route to this box's Remote Access tunnel
  // (TASK-470). Opened only from a mic click that classified as `insecure`.
  const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false)
  const [recordingMs, setRecordingMs] = useState(0)
  useEffect(() => {
    setCaptureAvailability(readCaptureAvailability())
  }, [])
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

  // ── Spoken replies ────────────────────────────────────────────────────
  //
  // A voice message gets a voice back (Settings → Voice, on by default). The
  // gateway cannot do this half itself: the recording is transcribed on the
  // box and sent as text, so its own `tts.auto: "inbound"` never sees a
  // voice message here. So the chat remembers which run a spoken question
  // started, and when that run's reply lands it either plays the audio the
  // harness already attached, or asks /setup-api/tts/speak for it and plays
  // that — through the same player every spoken reply already renders in.
  const [voiceAutoReply, setVoiceAutoReply] = useState(true)
  const voiceAutoReplyRef = useRef(true)
  useEffect(() => { voiceAutoReplyRef.current = voiceAutoReply }, [voiceAutoReply])
  // The run started by a spoken question, until its reply has been spoken.
  const voiceTurnKeyRef = useRef<string | null>(null)
  // Spoken replies are asked for one after another: the box speaks one at a
  // time, and two replies landing seconds apart must both be heard.
  const speakChainRef = useRef<Promise<void>>(Promise.resolve())
  // Whether the box is making the sound right now, and for how long. A cold
  // Kokoro is 13-19 s on an Orin and the reply is already on screen by then,
  // so with nothing said the chat looked finished and simply spoke half a
  // minute later; the seconds are what tells a wait from a hang.
  const [speakingReply, setSpeakingReply] = useState(false)
  const [speakingFor, setSpeakingFor] = useState(0)
  // The two things a player cannot say for itself, by the object URL they
  // belong to: which replies the CLOUD voice spoke (the owner picked the box's
  // own voice and is owed the fact when it could not answer), and which ones
  // the browser refused to start on its own — iOS Safari wants the gesture and
  // the sound in the same tick, which an await for the audio cannot give it.
  const [cloudSpoken, setCloudSpoken] = useState<string[]>([])
  const [autoplayBlocked, setAutoplayBlocked] = useState<string[]>([])
  useEffect(() => () => releaseSpokenReplies(), [releaseSpokenReplies])
  useEffect(() => {
    if (!speakingReply) return
    const startedAt = Date.now()
    const timer = window.setInterval(() => setSpeakingFor(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [speakingReply])
  useEffect(() => {
    if (!isOpen) return
    let active = true
    // The switch, read when the panel opens — and ONLY the switch. This also
    // read a top-level `supportedOnEdition`, which the route has never sent
    // (it nests that fact under `channels`), so the test was inert; worse, it
    // named the wrong fact: channels are the gateway's half, while a spoken
    // reply HERE is made by /setup-api/tts/speak, which a Hermes box answers
    // through its own harness. `autoReply` alone decides.
    fetch('/setup-api/tts', { cache: 'no-store' })
      .then(res => res.json())
      .then((data: { autoReply?: unknown } | null) => {
        if (!active) return
        setVoiceAutoReply(data?.autoReply !== false)
      })
      .catch(() => { /* keep the last reading */ })
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ autoReply?: unknown }>).detail
      if (typeof detail?.autoReply === 'boolean') setVoiceAutoReply(detail.autoReply)
    }
    window.addEventListener(VOICE_SETTINGS_CHANGED_EVENT, onChanged)
    return () => { active = false; window.removeEventListener(VOICE_SETTINGS_CHANGED_EVENT, onChanged) }
  }, [isOpen])
  /**
   * Play a reply, and settle once it has been heard — `ended`, an `error`,
   * a refusal to start, or a release — so the next spoken reply waits for
   * this one instead of talking over it. Bounded, so a player that never
   * reports either cannot hold the queue forever.
   */
  const playReply = useCallback((src: string): Promise<void> => new Promise<void>((resolve) => {
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve() } }
    try {
      replyPlayerRef.current?.pause()
      const player = new Audio(src)
      replyPlayerRef.current = player
      player.addEventListener('ended', done, { once: true })
      player.addEventListener('error', done, { once: true })
      // Paused from outside (a release, a newer reply): heard enough.
      player.addEventListener('pause', done, { once: true })
      const started = player.play()
      // A browser that wants the gesture and the sound in the same tick
      // refuses; the bubble's own player is there for exactly that case — and
      // it is now SAID so, because the refusal used to be swallowed whole and
      // the box simply appeared to answer a spoken question in silence (iOS
      // Safari, every time). The reply is on screen either way; the line under
      // the player is what tells the owner there is something to press.
      if (started && typeof started.catch === 'function') {
        started.catch(() => {
          setAutoplayBlocked(prev => (prev.includes(src) ? prev : [...prev, src]))
          done()
        })
      }
      window.setTimeout(done, PLAYBACK_MAX_MS)
    } catch { done() /* no Audio here (jsdom) — the bubble's player remains */ }
  }), [])
  /**
   * The reply that closes the run a spoken question started: speak it.
   * `audio` is what the harness attached itself (a channel-style spoken
   * reply); when there is none, the box is asked for it.
   */
  /**
   * Speak a reply: the audio the harness attached, or the box's own
   * synthesis of the words, in the chat's one queue (see playReply).
   */
  const speakReply = useCallback(async (text: string, audio: string[]) => {
    if (!voiceAutoReplyRef.current) return
    const words = audio.length > 0 ? '' : speechTextFor(text)
    if (audio.length === 0 && !words) return
    // One at a time, in order, PLAYBACK INCLUDED — chained on the previous
    // reply, whatever became of it, so a second answer never talks over the
    // first. The box queues syntheses too; a 429 here means that queue is
    // full, which a short wait usually clears.
    const generation = speechGenerationRef.current
    const previous = speakChainRef.current
    let release: () => void = () => {}
    speakChainRef.current = new Promise<void>((resolve) => { release = resolve })
    try {
      await previous
      if (speechGenerationRef.current !== generation) return
      if (audio.length > 0) { await playReply(audio[0]); return }
      let res: Response | null = null
      // From here until the bytes are in hand the box is working on the sound,
      // and the wait is on screen. Set after the queue has let this reply
      // through, so "Speaking…" never counts the seconds an EARLIER reply was
      // taking; cleared in the same breath as the response, so the line goes
      // the moment the player takes over.
      setSpeakingFor(0)
      setSpeakingReply(true)
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          res = await fetch('/setup-api/tts/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: words }),
            // A deadline, so a stalled synthesis cannot hold the chain of
            // spoken replies forever: the box's own budget is a cold Kokoro
            // (up to 40 s) behind up to three queued replies.
            signal: AbortSignal.timeout(SPEAK_REPLY_TIMEOUT_MS),
          })
          if (res.status !== 429) break
          await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)))
        }
      } finally {
        setSpeakingReply(false)
      }
      if (!res || !res.ok) return
      // WHICH voice spoke. The chain falls through to the cloud whenever the
      // box's own engine cannot answer (no headroom, no engine, a wedged
      // server), and an owner who chose "This box" has no other way to learn
      // that the words went off the box for this reply — the sound is the same
      // either way. Absent on an older server: then nothing is claimed.
      const engine = res.headers.get('X-ClawBox-Voice-Engine')
      const blob = await res.blob()
      // The transcript this reply belonged to may have gone while the box
      // was speaking: then nothing is created, stored or played.
      if (speechGenerationRef.current !== generation) return
      const url = URL.createObjectURL(blob)
      spokenUrlsRef.current.push(url)
      if (engine === 'cloud') setCloudSpoken(prev => (prev.includes(url) ? prev : [...prev, url]))
      // A bounded ring: the oldest spoken replies are released once a dozen
      // are held, even before the transcript is cleared.
      // …but never one a bubble still plays: a URL still on a message stays
      // until the transcript is cleared, whatever the count.
      const referenced = (candidate: string) => messagesRef.current.some(m => m.audio?.includes(candidate))
      while (spokenUrlsRef.current.length > SPOKEN_REPLIES_KEPT) {
        const idx = spokenUrlsRef.current.findIndex(candidate => !referenced(candidate))
        if (idx < 0) break
        const [stale] = spokenUrlsRef.current.splice(idx, 1)
        try { URL.revokeObjectURL(stale) } catch { /* jsdom */ }
      }
      // Onto the bubble it answers — the newest assistant bubble with this
      // text and no audio yet — so it can be played again from the transcript.
      setMessages(prev => {
        for (let i = prev.length - 1; i >= 0; i--) {
          const m = prev[i]
          if (m.role === 'assistant' && m.text === text && !(m.audio?.length)) {
            const next = [...prev]
            next[i] = { ...m, audio: [url] }
            return next
          }
        }
        return prev
      })
      await playReply(url)
    } catch { /* the reply is on screen; the voice was a bonus */ }
    finally { release() }
  }, [playReply])
  const maybeSpeakReply = useCallback(async (runKey: string | null, text: string, audio: string[]) => {
    if (!runKey || voiceTurnKeyRef.current !== runKey) return
    voiceTurnKeyRef.current = null
    await speakReply(text, audio)
  }, [speakReply])
  useEffect(() => { speakReplyRef.current = speakReply }, [speakReply])
  const maybeSpeakReplyRef = useRef(maybeSpeakReply)
  useEffect(() => { maybeSpeakReplyRef.current = maybeSpeakReply }, [maybeSpeakReply])

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
    // Read live rather than from `captureAvailability`: the state exists to
    // label the button before anyone clicks, and a stale render must never be
    // what decides whether the microphone is opened.
    const availability = readCaptureAvailability()
    if (availability !== 'ok') {
      setVoice({ state: 'error', error: availability, message: null, canRetry: false })
      // On an insecure origin the status line can only say where the mic does
      // not work. The popup carries the other half: a live, one-click route to
      // this box's Remote Access tunnel, where it does.
      if (availability === 'insecure') setTunnelDialogOpen(true)
      return
    }
    setVoice({ state: 'requesting', error: null, message: null, canRetry: false })
    // The earliest moment the box can know a spoken reply is coming. Kokoro's
    // server stops itself after five idle minutes, so without this the reply
    // to the first voice message of a conversation waits out a 13-19 s model
    // load — usually long enough for the chain to give up on the box and
    // answer in the cloud voice instead. The recording, the transcription and
    // the agent's own turn all happen while the model loads. Fire and forget:
    // a box with no engine of its own answers 409 and nothing here changes.
    if (voiceAutoReplyRef.current) {
      void fetch('/setup-api/tts/warm', { method: 'POST' }).catch(() => { /* the reply cold-starts */ })
    }
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

  // Losing the credential mid-capture is the other way a recording can be
  // orphaned: the entry point disappears, and without this the `MediaRecorder`
  // would keep running with nothing left on screen to stop it. Nothing is
  // uploaded — there is no longer anything that could transcribe it.
  useEffect(() => {
    if (caps.canTranscribe || voice.state === 'idle') return
    abandonRecording()
    setVoice(IDLE_STATUS)
  }, [caps.canTranscribe, voice.state, abandonRecording])

  // Deliver one clarify answer.
  //
  // The gateway unblocks the agent only once EVERY question in the request has
  // been answered, so a batch is one POST per question rather than one POST
  // carrying them all — and `questionId` is what tells the two apart.
  const answerClarify = useCallback(async (requestId: string, qid: string, answer: string) => {
    // Locked optimistically, so the question collapses at once and a second
    // answer cannot be sent while the first is still in flight. The catch below
    // puts it back: a control that looks answered but never reached the agent
    // is the one failure a customer cannot see and cannot recover from.
    setClarifies(prev => prev.map(card => (card.requestId === requestId
      ? { ...card, answered: { ...card.answered, [qid]: answer }, failed: false }
      : card)))
    try {
      const res = await fetch('/setup-api/hermes/chat/clarify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `questionId` rides along only for a BATCH. A single clarify arrives
        // with an empty qid and the route wants the field omitted, not empty.
        body: JSON.stringify({ requestId, answer, ...(qid ? { questionId: qid } : {}) }),
      })
      if (!res.ok) throw new Error(`clarify answer refused with ${res.status}`)
      const body = await res.json().catch(() => ({})) as { status?: unknown }
      // Expiry is not a failure: the agent simply stopped waiting. The card
      // says so and goes quiet, because a red "could not send" would invite a
      // retry that can never succeed.
      if (body.status === 'expired') setClarifies(prev => expireClarifyCard(prev, requestId))
    } catch {
      // Same polite `role="status"` treatment the attachment and voice rows
      // use — the message renders inside the card, next to the control that
      // came back.
      setClarifies(prev => prev.map(card => {
        if (card.requestId !== requestId) return card
        const answered = { ...card.answered }
        delete answered[qid]
        return { ...card, answered, failed: true }
      }))
    }
  }, [])

  // ── Outgoing mail, approved once for the whole batch ──────────────────────

  /**
   * If this turn asked to send mail, read the approval queue and put anything
   * new on screen as ONE card.
   *
   * Guarded by the turn's own flag rather than run on a timer: the drafts are
   * written by `email_send` and by nothing else this surface can see, so
   * polling would be asking a question whose answer only changes for a reason
   * we already know about. Check-and-clear, so a turn collects exactly once.
   *
   * Drafts already inside a live card are left alone (`shownDraftIds`). That is
   * what stops a second turn's mail from being folded into a card the owner is
   * part-way through reading — it gets its own card, with its own consent.
   *
   * THIS IS THE COLLECT ITSELF, and it is deliberately unconditional: every
   * caller has already decided that it wants to look. See `settleEmailDrafts`
   * for the turn-end caller and `recoverEmailDrafts` for the scheduled one.
   */
  const collectEmailDrafts = useCallback(async () => {
    const read = ++emailQueueReadSeq.current
    try {
      // `no-store`, and not because the route is slow to change: the route's
      // `dynamic = "force-dynamic"` governs Next's own render cache and does
      // NOT put `Cache-Control: no-store` on the wire, so the browser is free
      // to hand back a reply from an earlier turn. Stale drafts here are not a
      // cosmetic problem — the card would carry fingerprints the queue has
      // moved past, and every one of them would come back refused.
      const res = await fetch('/setup-api/email/pending', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      // 403 is the ordinary answer on a surface with no owner session, and 409
      // on a box with no mail account. Neither is worth a line in the
      // transcript: the customer did not ask for this, the agent did.
      if (!res.ok) return
      const body = await res.json().catch(() => ({})) as { pending?: unknown; outcomes?: unknown }
      if (!Array.isArray(body.pending)) return
      // What became of the drafts that have LEFT the queue, read in the same
      // breath as the queue itself. Two requests could catch a draft in
      // neither list and render the one state that is never true.
      const resolved = new Map<string, EmailBatchOutcome>()
      if (Array.isArray(body.outcomes)) {
        for (const row of body.outcomes) {
          if (typeof row !== 'object' || row === null) continue
          const o = row as Record<string, unknown>
          if (typeof o.id !== 'string') continue
          const kind = emailEnding(o.kind)
          if (!kind) continue
          resolved.set(o.id, {
            id: o.id,
            // A poll has no gesture to weigh this against, and what the card
            // was offering to do is send: a message that went out is the good
            // news, everything else is not.
            ok: kind === 'sent',
            kind,
            ...(typeof o.at === 'number' ? { at: o.at } : {}),
            ...(typeof o.error === 'string' ? { error: o.error } : {}),
          })
        }
      }
      const drafts: EmailBatchDraft[] = body.pending.flatMap((row): EmailBatchDraft[] => {
        if (typeof row !== 'object' || row === null) return []
        const d = row as Record<string, unknown>
        // A draft with no fingerprint could not be checked against what was on
        // screen, so it is not offered for one-click approval at all — it stays
        // in Settings → Email where each one is approved on its own.
        if (typeof d.id !== 'string' || typeof d.fingerprint !== 'string') return []
        if (typeof d.subject !== 'string' || typeof d.body !== 'string') return []
        if (!Array.isArray(d.to)) return []
        return [{
          id: d.id,
          to: d.to.filter((r): r is string => typeof r === 'string'),
          subject: d.subject,
          body: d.body,
          createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
          fingerprint: d.fingerprint,
        }]
      })
      // Deliberately NOT `if (drafts.length === 0) return`, which is what it
      // used to say. An empty queue is the most important answer this request
      // can bring back: it means every card on screen is offering to send mail
      // that has already been decided.
      const pendingIds = new Set(drafts.map(d => d.id))
      // A newer read has gone out since this one, so this answer is already
      // history — and history applied on top of the present says a draft that
      // is waiting is not. See `emailQueueReadSeq`.
      if (read !== emailQueueReadSeq.current) return
      setEmailBatches(prev => {
        const settled = reconcileBatchCards(prev, pendingIds, resolved)
        const card = batchFromPending(drafts, shownDraftIds(settled))
        return card ? [...settled, card] : settled
      })
    } catch {
      // The queue could not be read. Nothing is waiting as far as this surface
      // is concerned, and Settings → Email is unaffected.
    }
  }, [])

  /**
   * The turn-end caller: collect at once, but only for a turn that asked to
   * send mail.
   *
   * The flag is still checked and cleared here, and it still means what it
   * meant — except that it is now about IMMEDIACY rather than about whether
   * the drafts are ever seen. A turn that queued mail must show its card the
   * moment it finishes, not on the next tick; a turn that did not must not
   * make a request just because it ended. Everything the flag used to hide
   * for good is now picked up by `recoverEmailDrafts` instead.
   *
   * Check-and-clear is kept because there are FOUR turn-end call sites (the
   * adapter's done and error paths, and the gateway's) and more than one can
   * run for a single turn.
   */
  const settleEmailDrafts = useCallback(async () => {
    if (!emailSendSeenRef.current) return
    emailSendSeenRef.current = false
    await collectEmailDrafts()
  }, [collectEmailDrafts])
  useEffect(() => { settleEmailDraftsRef.current = settleEmailDrafts }, [settleEmailDrafts])

  /**
   * The scheduled caller: look regardless of what this browser saw.
   *
   * WHY THIS EXISTS. The card used to appear only for a turn that this surface
   * watched call `email_send`, on the reasoning that nothing else could put a
   * draft in the queue. Four things can, and each one stranded mail on disk
   * with no way to approve it from the conversation:
   *
   *   - a draft was left on a card the owner never answered, or unticked out
   *     of one he did (cancelling DELETES the ticked ones, so those do not
   *     come back — the unticked ones are still waiting and still his);
   *   - the page reloaded, and `emailBatches` is component state;
   *   - the turn was somebody else's — a cron run, an inbound-email
   *     auto-answer, Telegram, another session;
   *   - the tool event never streamed, so the flag was never set.
   *
   * Looking repeatedly is safe because `batchFromPending` filters against
   * `shownDraftIds` and returns null when everything waiting is already on
   * screen: a draft is offered once, and a second look adds nothing. That
   * dedup — not the flag — is what now carries "one card per draft", so it
   * must not be weakened.
   */
  const recoverEmailDrafts = useCallback(() => { void collectEmailDrafts() }, [collectEmailDrafts])

  /**
   * Ask on open, then on the shared schedule.
   *
   * `installPendingRefresh` is the same helper Settings → Email uses, so the
   * two surfaces cannot drift into disagreeing about how often they re-read
   * the queue — or about not polling behind a hidden tab. Installed only while
   * the panel is open, for the same reason Settings installs it only while its
   * email section is on screen.
   */
  useEffect(() => {
    if (!isOpen) return
    // The open itself is the first ask: this is the reload case, where the
    // queue may already hold mail nobody in this page has seen.
    recoverEmailDrafts()
    return installPendingRefresh(recoverEmailDrafts)
  }, [isOpen, recoverEmailDrafts])

  /**
   * Send the drafts the owner ticked — one request, whatever N is.
   *
   * `approval.entries` comes off the CARD's own frozen state, so what is posted
   * is the set that was read. The route re-checks each fingerprint before it
   * claims a draft, so the guarantee does not depend on this component being
   * the only caller.
   */
  const approveEmailBatch = useCallback(async (approval: EmailBatchApproval) => {
    const { batchId, entries } = approval
    if (entries.length === 0) return
    // The GESTURE IS RECORDED HERE, on the click, not on the answer.
    // `settleCard` rewrites the same value when the route replies, but the
    // reply is exactly what a dropped link, a restarting server or a non-JSON
    // 502 does not deliver — and the `catch` below puts the card back to
    // `waiting` with nothing to say which button made it. Every later reader
    // (the settle, the partial settle, the reconcile's `lastGesture ?? "approve"`)
    // then weighs a receipt against a default instead of against the click.
    // `reconcileBatchCards` skips a card in this status, so nothing acts on it
    // while the request is in flight.
    setEmailBatches(prev => updateBatchCard(prev, batchId, {
      status: 'sending',
      requestError: '',
      lastGesture: 'approve',
    }))
    try {
      const res = await fetch('/setup-api/email/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_batch', drafts: entries }),
      })
      const body = await res.json().catch(() => ({})) as { results?: unknown }
      // A 200 and a 207 both carry per-draft results and both are read the same
      // way. Anything with no results at all is a failure of the REQUEST, and
      // is reported as one rather than as an empty success.
      if (!Array.isArray(body.results)) throw new Error(`batch approval refused with ${res.status}`)
      const outcomes = body.results.flatMap(row => emailRowOutcome(row, 'approve'))
      const refused = emailRefusalSentence(body.results)
      setEmailBatches(prev => {
        const next = settleCard(prev, batchId, outcomes, 'approve')
        return refused ? updateBatchCard(next, batchId, { requestError: refused }) : next
      })
    } catch {
      // Back to `waiting`, with the reason next to the button: the drafts were
      // either never claimed or are reported in a response we could not read,
      // and either way telling the owner "sent" here would be the false success
      // this whole card exists to avoid.
      setEmailBatches(prev => updateBatchCard(prev, batchId, {
        status: 'waiting',
        requestError: t('chat.emailBatch.requestFailed'),
      }))
    }
  }, [t])

  /**
   * Send nothing — and mean it.
   *
   * This used to drop the card from THIS component's state and touch nothing
   * else, on the reasoning that the drafts were safe in Settings → Email. What
   * the owner actually got was a button that hid itself for fifteen seconds and
   * then handed the same card back, because `recoverEmailDrafts` finds anything
   * still queued: "when I click dismiss nothing happens; it returns after 20
   * secs." The card was deciding what the queue holds instead of asking it —
   * the same defect as a stale Approve button, seen from the other side.
   *
   * So the gesture goes to the store, naming the drafts the card is showing
   * with the fingerprints they were shown with, exactly as approving does.
   * Drafts that already carry an outcome are left out: they are decided, and
   * this click is not about them.
   *
   * The card then STAYS, settled, as the record of what was thrown away. It
   * cannot come back live, because `shownDraftIds` still covers its drafts and
   * they are no longer in the queue anyway.
   */
  const cancelEmailBatch = useCallback(async (approval: EmailBatchApproval) => {
    const { batchId, entries } = approval
    // The same guard `approveEmailBatch` opens with, and the sibling this one
    // was missing. It did not matter while the button carried a native
    // `disabled` the browser enforced; the button now announces itself with
    // `aria-disabled` and is guarded in its own handler, so this is the second
    // layer — and posting an empty set would only earn a 400 rendered as "the
    // deletion did not get through", a red line about nothing.
    if (entries.length === 0) return
    // `deleting`, not `sending`: the primary button's label keys off the
    // status, and a card that reads "Sending…" over the two messages the owner
    // has just said must not be sent is the surface asserting the opposite of
    // what it is doing.
    // The gesture, on the click — see `approveEmailBatch`. This is the side the
    // default hides: a *Delete without sending* whose own request never came
    // back readably left `lastGesture` unwritten, and the receipt of a send
    // that went out anyway was then read as `approve` and settled the card on a
    // green "1 sent." over the one thing that click was preventing.
    setEmailBatches(prev => updateBatchCard(prev, batchId, {
      status: 'deleting',
      requestError: '',
      lastGesture: 'delete',
    }))
    try {
      const res = await fetch('/setup-api/email/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject_batch', drafts: entries }),
      })
      const body = await res.json().catch(() => ({})) as { results?: unknown }
      if (!Array.isArray(body.results)) throw new Error(`deletion refused with ${res.status}`)
      // Every row that has an ending gets one, not only the ones that deleted:
      // a row left without a verdict on a card that then settled could never be
      // spoken about again — the reconcile skips settled cards and
      // `batchFromPending` will not rebuild one for a draft already on screen.
      // A draft the route refused because its text moved is the one exception,
      // and it gets none precisely because it is STILL WAITING; `settleCard`
      // then keeps the card open for it.
      const outcomes = body.results.flatMap(row => emailRowOutcome(row, 'delete'))
      // Nothing at all came back that this card can show. Saying "removed"
      // would be the false success this card exists to avoid, pointing at the
      // owner's own mail, so it says the deletion did not get through and puts
      // the button back.
      if (outcomes.length === 0) throw new Error('nothing was deleted')
      const refused = emailRefusalSentence(body.results)
      setEmailBatches(prev => {
        // The GESTURE goes with the answer: rows this card learned from an
        // earlier poll carry that poll's un-gestured reading of a send, and
        // settling a delete on top of them used to produce a green "1 sent."
        const next = settleCard(prev, batchId, outcomes, 'delete')
        return refused ? updateBatchCard(next, batchId, { requestError: refused }) : next
      })
    } catch {
      // Nothing was deleted, or we cannot say what was. Claiming "removed"
      // here would be the false success this card exists to avoid, pointing at
      // the owner's own mail.
      setEmailBatches(prev => updateBatchCard(prev, batchId, {
        status: 'waiting',
        requestError: t('chat.emailBatch.cancelFailed'),
      }))
    }
  }, [t])

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
    // The conversation this turn belongs to. A harness that answers on this
    // promise rather than on a keyed event stream needs it remembered: the
    // owner may be in another tab by the time the reply lands, and painting
    // it there would put one conversation inside another.
    const keyAtSend = sessionKeyRef.current
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
        if (event.kind === 'delta' && runIdRef.current === idempotencyKey) applyStreaming(event.text)
        // Live tool steps, through the SAME pills the gateway harness already
        // feeds. A hermes turn used to reach this callback with nothing but
        // text, so a turn that spent its time in `web_search` — measured at up
        // to four minutes on the box — showed an empty bubble and no reason to
        // believe anything was happening. `applyToolEvent` reads `toolCallId`,
        // so the transport's stable `id` is handed over under that name.
        else if (event.kind === 'tool' && runIdRef.current === idempotencyKey) {
          applyToolEvent({ toolCallId: event.id, name: event.name, phase: event.phase })
          if (isCodingAgentTool(event.name)) nudgeCodingAgent()
          // Remember that this turn asked to send mail. Noted on `start` as
          // well as on `result` because a tool that never reported a result —
          // a wedged turn, a dropped socket — may still have reached the route
          // and left a draft on disk, and a draft nobody is shown is exactly
          // the state this card exists to end.
          if (isEmailSendTool(event.name)) emailSendSeenRef.current = true
        }
        // A one-line "what I am doing" from the harness, painted on the status
        // line under the thread. Gated on the live run for the reason a delta
        // is: a status frame after the turn ended describes nothing.
        else if (event.kind === 'status' && runIdRef.current === idempotencyKey) {
          setTurnStatus(event.text?.trim() ? event.text.trim() : null)
        }
        // The agent has parked on a question. Held by `requestId`, so a
        // reconnect's REPLAY of a prompt still being waited on folds into the
        // card already on screen instead of drawing a second one beside it —
        // and gated on the live run for the reason a delta is: a prompt that
        // arrives after the turn ended belongs to nothing anyone can answer.
        else if (event.kind === 'clarify' && runIdRef.current === idempotencyKey) {
          setClarifies(prev => upsertClarifyCard(prev, event))
        }
        // NOT gated on the run: an expiry is precisely the frame that can
        // arrive once everything else has stopped, and a card left looking
        // answerable after it would take an answer nothing could deliver.
        else if (event.kind === 'clarifyExpire') {
          setClarifies(prev => expireClarifyCard(prev, event.requestId))
        }
      })
    } catch (err) {
      // A user-initiated Stop shows nothing, not an error line. Never render a
      // harness's own error text: it is written for an operator reading a log
      // and has carried an absolute device path and a session UUID into the
      // customer's transcript (TASK-440). Both harnesses funnel through here
      // now, so this is the only gate left.
      const failure = err instanceof HarnessError && err.code === 'aborted'
        ? undefined
        : describeChatFailure(err instanceof Error ? err.message : undefined)
      settleRun(keyAtSend, failure)
      // It failed in a tab the owner has left: the composer, the caret and
      // the pills on screen belong to the tab they are looking at now, and
      // the error waits in the left tab for their return (settleRun).
      if (sessionKeyRef.current !== keyAtSend) return
      // Nothing is coming on either path, so the run ends here.
      sendingRef.current = false
      setSending(false)
      // What the box managed to write is the OWNER'S, and it survives here for
      // the same reason it survives on the gateway path's `aborted`/`error`
      // branch: pressing Stop mid-answer keeps the fragment rather than wiping
      // it. This catch serves BOTH adapters — the gateway one rejects here too
      // when a `chat.send` ack fails — but only the Hermes one ever reaches it
      // with a non-empty buffer, because on the gateway edition the socket's
      // own terminal event owns that buffer and every entry to `dispatchTurn`
      // clears it first. It used to clear and append nothing, so the same Stop
      // lost the reply on one edition and kept it on the other (TASK-721).
      // Read, clear, THEN append, all outside any updater, and before the
      // failure line below so the answer stays above it.
      //
      // `streamingEmailRefsText` first, not the raw buffer: `SENTINEL_RE`
      // anchors the whole string, so a Stop landing between `NO_REPLY` and an
      // `EMAIL:` line the reply had begun leaves a value that is no longer
      // recognisable as a sentinel — and it would be appended verbatim and
      // minted into an email card off text the bubble never showed. The
      // gateway path asks the same question the same way.
      //
      // Stored RAW, without the `splitAssistantMedia` the full-screen chat's
      // abort branch applies: a `MEDIA:` line is something the Hermes route
      // ADDS when it settles a turn, so an interrupted stream has not got one.
      // What an interrupted Hermes answer can carry is prose naming a file it
      // just wrote, which the settle path's own clean-up handles and which no
      // split here would improve.
      const kept = dropUnfinishedDirective(streamingRef.current)
      applyStreaming('')
      if (kept.trim() && !isSentinel(streamingEmailRefsText(kept))) {
        setMessages(prev => [...prev, { role: 'assistant', text: kept, timestamp: Date.now() }])
      }
      clearToolCalls()
      // The agent is no longer parked on anything, so neither is the customer.
      // A card outliving its turn is a control with nowhere to post to.
      clearClarifies()
      // A turn that failed may still have queued mail before it did. The
      // drafts are on disk either way, so the card is offered on this path too
      // rather than only on the happy one.
      void settleEmailDrafts()
      runIdRef.current = null
      if (!failure) return
      setMessages(prev => [...prev, { role: 'system', text: failure, timestamp: Date.now() }])
      return
    }
    // A harness that merely ACKNOWLEDGED the turn answers on its own event
    // stream; those handlers paint the reply and end the run.
    if (result.acknowledgedOnly) return
    settleRun(keyAtSend)
    // The reply belongs to a tab the owner has left. The box recorded it
    // before answering, so that tab replays it on return; here it only went
    // from busy to unread (settleRun).
    if (sessionKeyRef.current !== keyAtSend) return
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
      // What answered, as the harness recorded it — kept on the message so the
      // live bubble and the one replayed from the transcript say the same.
      ...(result.model ? { model: result.model } : {}),
      ...(result.provider ? { provider: result.provider } : {}),
    }])
    // Spoken back when a spoken question started this run.
    void maybeSpeakReplyRef.current(idempotencyKey, result.text || '', boundedAudio([...(result.audio ?? [])]))
    // Pair the synchronous guard with the state on EVERY completion path, not
    // just the failing one: the drain effect and both send handlers decide from
    // `sendingRef`, so a reply that lands whole and forgets to clear it leaves
    // the queue permanently parked (TASK-517).
    sendingRef.current = false
    setSending(false)
    applyStreaming('')
    // The live pills have done their job. The finished message carries the
    // agent's OWN record of the steps (`result.toolCalls`) and renders it as
    // summary chips, so leaving the running ones up would show the same turn's
    // tools twice — once as a guess from the wire, once as the record.
    clearToolCalls()
    // Same reason as the failure path: the turn is over, so any question it was
    // parked on is over too.
    clearClarifies()
    // The turn is done and anything it wanted to post is now waiting. This is
    // where the batch card appears.
    void settleEmailDrafts()
    runIdRef.current = null
  }, [adapter, applyToolEvent, nudgeCodingAgent, clearToolCalls, clearClarifies, settleEmailDrafts, settleRun, applyStreaming])
  useEffect(() => { dispatchTurnRef.current = dispatchTurn }, [dispatchTurn])

  const startRun = useCallback((text: string, sendAttachments: ChatAttachment[], voice = false) => {
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
    sendingRef.current = true
    setSending(true)
    applyStreaming('')
    runIdRef.current = idempotencyKey
    // A spoken question is answered aloud: remember which run it is, so the
    // reply that closes THIS run is the one spoken (see maybeSpeakReply).
    voiceTurnKeyRef.current = voice ? idempotencyKey : null
    // Queue only where there is a connection that can be down. A harness with
    // no socket is never "not connected yet", so parking its turns would hold
    // them forever waiting for a status change that has already happened.
    if (caps.hasLiveConnection && status !== 'connected') {
      pendingSendsRef.current.push({ text, attachments: sendAttachments, idempotencyKey })
      return
    }
    void dispatchTurn(text, sendAttachments, idempotencyKey)
  }, [caps, status, dispatchTurn, applyStreaming])

  // Send a line the UI composed itself — a voice transcript, or the question
  // that follows a skill change. Both can arrive while the agent is already
  // answering, and starting a second turn on top of a live one makes the chat
  // report the first as finished while it is still running, so they take the
  // same queue a typed message would.
  const enqueueRun = useCallback((text: string, voice = false) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Decide from the refs, not the render-time `sending`: this can run in the
    // window between "previous turn finished" committing and the drain's next
    // run committing, where the closure still says idle while a run is already
    // in flight — starting here would double-start (TASK-517). A non-empty
    // queue also forces enqueueing, or this send would jump the line.
    if (sending || sendingRef.current || queuedSendsRef.current.length > 0) {
      setQueuedSends(prev => {
        const next = [...prev, { id: uuid(), text: trimmed, attachments: [], voice }]
        return next.length > MAX_QUEUED_SENDS ? next.slice(next.length - MAX_QUEUED_SENDS) : next
      })
      return
    }
    startRun(trimmed, [], voice)
  }, [sending, startRun])

  const sendVoiceTranscript = useCallback((text: string) => enqueueRun(text, true), [enqueueRun])
  useEffect(() => {
    sendVoiceTranscriptRef.current = sendVoiceTranscript
  }, [sendVoiceTranscript])

  // The skill-change handler lives in a mount-once effect and cannot close over
  // `enqueueRun`, which is rebuilt whenever a turn starts or ends. Same ref
  // trick `resetSessionRef` uses a few hundred lines up — and it has to be a
  // ref rather than a dependency, because the value it needs to see is the
  // CURRENT `sending`.
  const enqueueRunRef = useRef(enqueueRun)
  useEffect(() => { enqueueRunRef.current = enqueueRun }, [enqueueRun])

  /**
   * Draw the composer's text, on a harness whose agent cannot.
   *
   * The whole feature the customer sees, and it is short because the decisions
   * are elsewhere: whether to offer it at all is `imageGenerationTrigger`, and
   * where the picture comes from is the adapter's. What is left here is what
   * this component has always owned — putting the exchange on screen.
   *
   * The prompt is drawn as a user bubble before the call so the wait has
   * something to sit under, and the box records the same two lines in the
   * durable transcript, so closing the tab mid-generation still leaves the
   * picture waiting on the next visit.
   */
  const generatePicture = useCallback(async () => {
    const prompt = input.trim()
    // Re-entry is decided from the ref, not from `drawing`: a second click can
    // land in the window before the state commit, and two generations would be
    // two charges against the customer's daily allowance for one intent.
    //
    // PER CONVERSATION, not per popup: two tabs are two intents and may each
    // buy a picture, which is a real change to what a burst of clicking can
    // spend — nothing on the box refuses the second request, and the only
    // back-stop is the plan's daily allowance (a 429 the chat words). It is
    // the right UI model, and it is the owner's call to make: see the PR body.
    // The tab that asked, so the wait is shown where it belongs and a second
    // click on THIS tab is refused while another conversation may still ask.
    const tabAtSend = activeTabKeyRef.current
    if (!prompt || drawingRef.current.has(tabAtSend)) return
    // The conversation that asked. A generation takes 15-40 seconds and the
    // route records it under this key, so a tab switch mid-wait must not paint
    // the picture into whichever conversation is on screen when it lands —
    // the same rule `dispatchTurn` and `loadHistory` already follow.
    const keyAtSend = sessionKeyRef.current
    setInput('')
    const controller = new AbortController()
    drawingRef.current.set(tabAtSend, controller)
    syncDrawingTabs()
    setMessages(prev => [...prev, { role: 'user', text: prompt, timestamp: Date.now() }])
    try {
      const { media } = await adapter.generateImage(prompt, controller.signal)
      // It is in the transcript either way, so the tab it belongs to replays it.
      if (sessionKeyRef.current !== keyAtSend) return
      setMessages(prev => [...prev, {
        role: 'assistant',
        // A picture with no caption is the whole reply here — there is no model
        // writing one, so '(no response)' would be describing the absence of
        // something nobody asked for.
        text: '',
        timestamp: Date.now(),
        images: [...media],
      }])
    } catch (err) {
      // Stopping is not failing, and must not leave a red bubble behind.
      if (err instanceof HarnessError && err.code === 'aborted') return
      // Nor does a failure belong in a conversation that did not ask.
      if (sessionKeyRef.current !== keyAtSend) return
      setMessages(prev => [...prev, {
        role: 'system',
        // The same leak rules a failed turn goes through. Everything this path
        // can report was written by us for a customer, but the layers under it
        // are a proxy and a filesystem, and both quote what they were handed.
        text: describeImageFailure(err instanceof Error ? err.message : undefined),
        timestamp: Date.now(),
      }])
    } finally {
      // Only ever clear our OWN entry: a generation that settles must not take
      // down one this tab started after it.
      if (drawingRef.current.get(tabAtSend) === controller) {
        drawingRef.current.delete(tabAtSend)
        syncDrawingTabs()
      }
    }
  }, [input, adapter, syncDrawingTabs])

  // A wait nobody is watching is a paid generation still running. Closing the
  // popup ends it, the same way it drops the agent's image wait just above —
  // and so does UNMOUNTING while open, which the `isOpen` branch alone never
  // saw: an effect keyed on it only fires when the flag changes, so a popup
  // taken off the page mid-generation left the request running and billed.
  // The controllers take themselves out of the map in `generatePicture`'s
  // `finally`, which runs whether the request was aborted or not.
  useEffect(() => {
    const abortAll = () => {
      for (const controller of drawingRef.current.values()) controller.abort()
    }
    if (isOpen) return abortAll
    abortAll()
  }, [isOpen])

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
    // Same ref-based decision as enqueueRun, for the same reason: an Enter can
    // land while the drain is mid-handoff and the closure still says idle.
    if (sending || sendingRef.current || queuedSendsRef.current.length > 0) {
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
    // sendingRef guards the commit-lag case: a send that started between this
    // commit and now (stale-window Enter) is invisible to the `sending` state
    // this effect closed over, and draining on top of it would double-start.
    if (sending || sendingRef.current || queuedSends.length === 0) return
    const [next, ...rest] = queuedSends
    setQueuedSends(rest)
    startRun(next.text, next.attachments, next.voice === true)
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

  // A message handed over by another app — the Coding Agent's New wizard —
  // goes through the SAME queue as a fix-error prompt, and for the same
  // reasons: the drain effect is the one send path, so the text is sent as
  // the owner's turn in order with anything they typed, and the greet is
  // marked done so loadHistory cannot race it with a stray "hi".
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<ChatMessageDetail>).detail?.text
      if (typeof text !== 'string' || !text.trim()) return
      greetedRef.current = true
      setQueuedSends(prev => [...prev, { id: uuid(), text: text.trim(), attachments: [] }])
    }
    window.addEventListener(CHAT_MESSAGE_EVENT, handler)
    return () => window.removeEventListener(CHAT_MESSAGE_EVENT, handler)
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
    // Bound to onClick, which drops the returned promise — so a rejection here
    // surfaces as an unhandled rejection rather than as anything the user can
    // act on. Stop is best-effort by design: a turn that could not be called
    // back finishes on its own, and a red banner about the Stop button would
    // tell the customer nothing they can do.
    try {
      await adapter.abortTurn()
    } catch (err) {
      console.warn('[chat] abort failed:', err)
    }
  }, [adapter])

  // `provider` is the UI id of the ROW the pick came from, and it is the only
  // thing that can say a `openai/<id>` pick is the ChatGPT subscription rather
  // than the API key: on a box holding both credentials the two rows offer the
  // same reference, and the server cannot tell them apart from the model alone.
  const switchChatModel = useCallback(async (target: { model: string; label: string; provider?: string | null }): Promise<boolean> => {
    if (switchingModel || chatModelState?.activeModel === target.model) return false
    // Intercept a ClawBox AI pick the portal POSITIVELY refuses, and say so
    // here rather than letting every turn on it come back as the opaque
    // "[assistant turn failed]" — measured against the live proxy on
    // 2026-09-04, an id outside the account's list answers
    // `400 {"error":{"message":"Model not allowed: …"}}`. The portal URL is
    // wrapped as `[text](url)` so chat-markdown renders it as a clickable link
    // instead of a bare string.
    //
    // Gated on the portal's own entitlement list, never on the tier badge: the
    // badge follows the portal's `deviceTier`, which is a device DEFAULT — a
    // Max subscriber may deliberately run Flash on this box — and a default is
    // not something to veto an explicit pick with. An unanswered entitlement
    // (portal unreachable, poll failed) is not a refusal either: the pick goes
    // through and the proxy has the last word.
    if (portalDeniesClawboxAiModel(target.model, clawboxLogin.allowedModels)) {
      setMessages(prev => [...prev, {
        role: 'system',
        text: isClawboxAiProModel(target.model)
          ? `${target.label} requires a Max subscription. [Upgrade in the ClawBox portal](${PORTAL_DASHBOARD_URL}) to unlock it. Staying on the current model.`
          : `${target.label} is not included in your ClawBox AI plan. [Manage it in the ClawBox portal](${PORTAL_DASHBOARD_URL}). Staying on the current model.`,
        timestamp: Date.now(),
        variant: 'error',
      }])
      return false
    }
    setSwitchingModel(true)
    setErrorMsg('')
    try {
      const res = await fetch('/setup-api/chat/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: target.model,
          ...(target.provider ? { provider: target.provider } : {}),
        }),
      })
      const data = await res.json()
      // 502 WITH a warning = the model IS written and the route returned the new
      // state; only the gateway has not finished coming back. Throwing there
      // would revert the dropdown to a model the box is no longer configured
      // for, skip the reconnect, and print a generic failure over a switch that
      // succeeded — the exact false failure the route's 502 exists to avoid.
      // `warning` is required, not just the status, so a 502 from anywhere else
      // (a proxy, cloudflared) stays the error it is.
      const gatewayPending = res.status === 502 && typeof data.warning === 'string' && data.warning
      if (!res.ok && !gatewayPending) throw new Error(data.error || 'Failed to switch chat model')
      if (gatewayPending) {
        setMessages(prev => [...prev, {
          role: 'system',
          text: data.warning,
          timestamp: Date.now(),
        }])
      }

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
      return true
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'system',
        text: `Error: ${err instanceof Error ? err.message : 'Failed to switch chat model'}`,
        timestamp: Date.now(),
      }])
      return false
    } finally {
      setSwitchingModel(false)
    }
  }, [chatModelState, connect, switchingModel, clawboxLogin.allowedModels])

  // The dropdown gate above only catches picks the user *clicks*. An account
  // the portal refuses can also boot with the Max model already saved as the
  // default (picked during setup, chosen from the Telegram `/model` keyboard,
  // or left over after a plan downgrade). The portal gateway then silently
  // rejects every turn — the user only sees the opaque "[assistant turn
  // failed]". Catch that on load: explain it with an upgrade link and drop to
  // the Pro tier the plan supports so chat works.
  //
  // This one WRITES: it moves the box off the model the owner chose. So it
  // fires only on a positive refusal from the portal's entitlement list. On
  // the badge it fired for "tier unknown" too — a single failed status poll
  // was enough to rewrite a Max box's primary model to flash and tell its
  // owner to buy the subscription he already had (TASK-691).
  //
  // WHAT THE LATCH BELOW REMEMBERS, and why it is not a boolean. `switchChatModel`
  // writes `switchingModel`, which is one of its own useCallback deps, so calling
  // it changes its identity — and this effect depends on that identity. A boolean
  // latch released on failure therefore re-armed the guard with nothing about the
  // box changed, and any repeatable failure of `/setup-api/chat/model` (400
  // "provider is not configured", 409, 500, a proxy's non-JSON body) became a POST
  // loop against the box's own setup server with two system messages per turn of
  // it. A boolean latch never released is the other error: `page.tsx` keeps this
  // component mounted for the whole session and only toggles `isOpen`, so one
  // failed attempt would leave the box on a refused model until a page reload —
  // a capability probed once and treated as settled, which is the shape this
  // codebase keeps producing.
  //
  // So it remembers the INPUTS the last attempt was made for. Re-entry on the
  // same box state buys nothing; a changed active model or a changed entitlement
  // list buys exactly one more attempt, and so does closing and re-opening the
  // chat, which is the retry an owner reaches for. `allowedModels` keeps its
  // array identity across polls that bring the same ids back (`sameIds` in
  // use-clawbox-login.ts), so `===` here means "the answer has not changed".
  const tierGuardAttemptRef = useRef<{ model: string; allowed: readonly string[] | null } | null>(null)
  useEffect(() => {
    if (!isOpen) {
      tierGuardAttemptRef.current = null
      return
    }
    if (clawboxLogin.loading) return
    const active = chatModelState?.activeModel
    // The Max tier and nothing else: it is the only ClawBox AI model with a
    // tier below it to fall back to, and the message below says so by name.
    if (!active || !isClawboxAiProModel(active)) return
    if (!portalDeniesClawboxAiModel(active, clawboxLogin.allowedModels)) return
    // The recovery is "drop to the Flash tier", so only run it when the portal
    // allows that one. Switching to a second refused model would move the
    // error rather than fix it.
    if (portalDeniesClawboxAiModel(CLAWBOX_AI_MODEL_BY_TIER.flash, clawboxLogin.allowedModels)) return
    const attempted = tierGuardAttemptRef.current
    if (attempted && attempted.model === active && attempted.allowed === clawboxLogin.allowedModels) return
    // `switchChatModel` early-returns without attempting anything while another
    // switch is in flight, so wait rather than record an attempt that was never
    // made. `switchingModel` is a dep, so the effect comes back by itself when
    // that other switch finishes.
    if (switchingModel) return
    tierGuardAttemptRef.current = { model: active, allowed: clawboxLogin.allowedModels }
    void switchChatModel({ model: CLAWBOX_AI_MODEL_BY_TIER.flash, label: 'Pro Tier' })
      .then(switched => {
        // Posted from the SUCCESS path only. This sentence says the box was
        // moved, and until the POST comes back that is not known — announcing
        // it first left a failed switch under a message claiming it had
        // happened, above the `Error:` line saying it had not.
        if (!switched) return
        setMessages(prev => [...prev, {
          role: 'system',
          text: `Max Tier needs a Max subscription. [Upgrade in the ClawBox portal](${PORTAL_DASHBOARD_URL}) to unlock it — switched you to Pro Tier so chat keeps working.`,
          timestamp: Date.now(),
          variant: 'error',
        }])
      })
  }, [isOpen, chatModelState?.activeModel, clawboxLogin.allowedModels, clawboxLogin.loading, switchChatModel, switchingModel])

  const handleChatSourceChange = useCallback(async (optionId: string) => {
    const target = chatModelState?.options.find(option => option.id === optionId)
    if (!target) return

    if (!target.available || !target.model) {
      onOpenSettingsSection?.(target.settingsSection)
      setMessages(prev => [...prev, {
        role: 'system',
        // A stale sign-in is not an absent one. The credential is on the box;
        // the installed OpenClaw simply cannot route the way it was filed, and
        // only a fresh sign-in re-files it.
        text: target.reauthRequired
          ? `${target.label} needs you to sign in again — this box's sign-in predates the installed OpenClaw. Opened Settings so you can reconnect it.`
          : `${target.label} is not configured. Opened Settings so you can set it up.`,
        timestamp: Date.now(),
      }])
      return
    }

    await switchChatModel({ model: target.model, label: target.label, provider: target.provider })
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
  // The pending "ask again, the box was still booting" timer, and the seed it
  // calls. A ref rather than a direct recursive call because `seedHermesHeader`
  // is a stable useCallback and cannot name itself.
  const seedRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seedRef = useRef<(signal?: AbortSignal, attempt?: number) => Promise<void>>(async () => {})
  const clearSeedRetry = useCallback(() => {
    if (!seedRetryTimerRef.current) return
    clearTimeout(seedRetryTimerRef.current)
    seedRetryTimerRef.current = null
  }, [])
  // Whether anything is currently on offer in the header, read inside the seed
  // (a stable useCallback, so it cannot close over the state).
  const hermesProvidersRef = useRef<HermesChatProvider[]>([])
  useEffect(() => { hermesProvidersRef.current = hermesProviders }, [hermesProviders])

  const seedHermesHeader = useCallback(async (signal?: AbortSignal, attempt = 0) => {
    const generation = ++seedGenerationRef.current
    seedControllerRef.current?.abort()
    clearSeedRetry()
    const controller = new AbortController()
    seedControllerRef.current = controller
    // The caller's signal still cancels this seed (unmount, harness switch).
    const abortThis = () => controller.abort()
    if (signal?.aborted) abortThis()
    else signal?.addEventListener('abort', abortThis)
    // Ask again later, keeping what is on screen. True when one was booked.
    const retryLater = (): boolean => {
      if (attempt >= DEGRADED_RETRY_ATTEMPTS) return false
      if (controller.signal.aborted || generation !== seedGenerationRef.current) return false
      seedRetryTimerRef.current = setTimeout(
        () => { void seedRef.current(signal, attempt + 1) },
        degradedRetryDelayMs(attempt),
      )
      return true
    }
    try {
      const mRes = await fetch('/setup-api/hermes/models', { cache: 'no-store', signal: controller.signal })
      // A non-OK answer has no `providers` and no `stale` (the route's own 502
      // arm is `{ error }`), so without this it read as a LIVE empty catalogue
      // and unmounted the header outright.
      if (!mRes.ok) throw new Error(`HTTP ${mRes.status}`)
      const mData = await mRes.json() as {
        providers?: { id?: unknown; name?: unknown; authenticated?: unknown }[]
        provider?: unknown
        current?: unknown
        reasoning?: unknown
        stale?: unknown
      }
      // `aborted` alone is not enough: a response can resolve before the abort
      // lands, and `json()` adds a second await for a newer seed to start in.
      if (controller.signal.aborted || generation !== seedGenerationRef.current) return
      // `stale` means the box could not reach its Hermes dashboard and answered
      // from the on-disk manifest instead — a file from the docs site that only
      // ever carries `openrouter` and `nous` and knows nothing about THIS
      // device's credentials. Its rows arrive `authenticated: null` ("the
      // source couldn't tell"), which the filter below keeps, so the header
      // used to offer two providers the box has no key for: on the settled box
      // both report `authenticated: false`, and picking one gives an empty
      // model list and a failing turn. That is the "OpenAI Codex / OpenRouter /
      // Nous Portal" header the owner photographed.
      //
      // So a degraded seed contributes NO rows. The device's own configured
      // provider is still added below — the CLI read behind it is a fact about
      // this box either way — and the retry at the end of this function goes
      // back for the real list.
      const degraded = mData?.stale === true
      // A degraded answer must never REPLACE a good one. The header is seeded
      // again on every providers-changed signal, so a key saved during a
      // dashboard blip used to collapse a live four-provider list to the one
      // configured provider and silently move the active provider off the
      // owner's pick — every turn in that window then ran on the device default.
      // Keep what is rendered and go back for the real list; only a header with
      // nothing on offer yet falls back to the device's own provider.
      if (degraded && hermesProvidersRef.current.length > 0) {
        retryLater()
        return
      }
      const reported = !degraded && Array.isArray(mData?.providers) ? mData.providers : []
      // Offer only providers Hermes has credentials for (`authenticated:
      // false` rows would give an empty model list and a failing turn).
      // `null` means the source couldn't tell — keep those.
      const rows: HermesChatProvider[] = reported
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

      // Go back for the real list, with backoff — the same loop the scoped hook
      // runs, and the same one #587 gave the OpenClaw picker for `warming`.
      // Without it a chat opened during the ~11-12 s the Hermes dashboard needs
      // to come up after a reboot kept the placeholder for the whole session.
      if (degraded) retryLater()
    } catch {
      // A dropped connection is the same news as a degraded body, and it is the
      // shape the reported incident took: the box restarted three times inside
      // four minutes, so the seeds in that window were rejections and 502s.
      // Without this the header fell back to a plain label for the session.
      retryLater()
    }
    finally {
      signal?.removeEventListener('abort', abortThis)
      if (seedControllerRef.current === controller) seedControllerRef.current = null
    }
  }, [clearSeedRetry])
  useEffect(() => { seedRef.current = seedHermesHeader }, [seedHermesHeader])

  // Seed the Hermes header once the harness is known. This is the one place
  // left that asks WHICH harness is running rather than what it can do, and
  // deliberately so: the header renders a different vendor's model catalogue,
  // which is a product fact about Hermes and not a capability of the box.
  useEffect(() => {
    if (harnessId !== 'hermes') return
    const controller = new AbortController()
    void seedHermesHeader(controller.signal)
    return () => {
      controller.abort()
      // A seed's retry is scheduled OUTSIDE any fetch, so aborting the signal
      // does not by itself cancel one that is already pending.
      clearSeedRetry()
    }
  }, [harnessId, seedHermesHeader, clearSeedRetry])

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
    const unsubscribe = onProvidersChanged(() => { void seedHermesHeader(controller.signal) })
    return () => {
      controller.abort()
      unsubscribe()
      clearSeedRetry()
    }
  }, [harnessId, seedHermesHeader, clearSeedRetry])

  // Pre-warm the transport on mount so opening chat is instant. Gated on the
  // harness resolving: connecting before that is what would open a gateway
  // socket on a box that runs no gateway.
  useEffect(() => {
    if (!harnessLoaded) return
    // No hello will name a main session on a harness with no live connection:
    // the box's own transcript store is the thread, and its tabs are files
    // beside it. Bound BEFORE the replay below reads it.
    if (!caps.hasLiveConnection) bindMainSession(DESKTOP_TRANSCRIPT_KEY)
    void adapter.connect()
  }, [adapter, harnessLoaded, caps.hasLiveConnection, bindMainSession])

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
    // Not while the popup is closed. This surface stays MOUNTED behind the
    // desktop, so "the harness resolved" is not the same as "the user is
    // looking at this" — and on an empty transcript the replay ends in the
    // auto-greet, which persisted a turn the owner never asked for, before
    // they had opened chat at all.
    if (!isOpen) return
    if (caps.hasLiveConnection || !caps.canListHistory) return
    if (replayedRef.current) return
    replayedRef.current = true
    void loadHistory()
  }, [harnessLoaded, isOpen, caps, loadHistory])

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
      failPending('Chat closed')
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
  }, [failPending])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && visible && status === 'connected') {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen, visible, status])

  // Close on Escape — but only when nothing is open ON TOP of the chat, since
  // Escape closes the innermost thing first. An open image preview swallows the
  // key before it reaches here (useModalDialog stops it at the document capture
  // phase) and so does an open pill menu (HeaderDropdown, same phase). The New
  // app card cannot: it is a popover over the composer whose own handler is a
  // plain document listener, so the key reached both and one Escape dismissed
  // the card AND the whole conversation — un-docking a docked panel with it.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || showNewApp) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, showNewApp])

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
  // every terminal-failure path — the two retry-exhaustion branches, the 1008
  // auth close, the refused connect frame and the socket constructor that
  // threw — so the error panel, gated on `!reloadingSkill`, can render and the
  // safety-net retry effect (which fires on `error && reloadingSkill`) stops
  // looping.
  const tearDownReloadOverlay = useCallback(() => {
    if (reloadTimerRef.current) {
      clearInterval(reloadTimerRef.current)
      reloadTimerRef.current = null
    }
    skillInstalledRef.current = false
    reloadReasonRef.current = 'skill'
    // The pending switch goes with the overlay it was waiting behind. Its only
    // consumer is the `hello` resolve branch gated on `skillInstalledRef`,
    // which the line above clears — so a kept value can never be used for the
    // switch that stored it, and would instead fire on the NEXT provider
    // change, resetting the owner's transcript for a switch that ended
    // minutes ago.
    pendingModelSwitchResetRef.current = null
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
    // A SKILL CHANGE RESTARTS NOTHING — and this handler used to assume it did.
    //
    // `openclaw-config.ts` deliberately stopped bouncing the gateway on install:
    // SIGUSR1 means "restart" to OpenClaw, not "reload", and OpenClaw watches its
    // own skill roots anyway, so the running session picks a new skill up on its
    // next turn. Proven on hardware: right after an install the live session
    // answered "yes" and named the skill's SKILL.md, with the gateway's PID and
    // restart count unchanged.
    //
    // The reconnect overlay was left behind pointing at that removed restart. Its
    // ONLY exit was a post-restart `hello`, so it never cleared and the chat sat
    // frozen on "Reloading skills..." until the owner thought to reload the page
    // (TASK-508). There is nothing to wait for, so we do not wait: keep the
    // socket, keep the transcript, and ask the agent to confirm the change. Its
    // answer is the confirmation the overlay was standing in for, and it is a
    // truthful one — it comes from the session that now has the skill.
    const skillHandler = (e: Event) => {
      // The shared type, not a restatement of three of its fields: the local
      // cast used to omit `kind`, which survived only because the object was
      // handed on by reference — one destructure away from every webapp
      // removal saying "skill" again with the whole suite green.
      const detail = ((e as CustomEvent).detail || {}) as SkillChangeEvent
      // Goes out the same door a typed message does — queued behind a turn
      // that is still answering, sent through startRun otherwise, which owns
      // the disconnected queue, the Hermes branch and the run bookkeeping.
      // Growing a second, thinner send path here is what would drift next.
      enqueueRunRef.current(buildSkillChangeMessage(detail))
    }
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
    window.addEventListener(SKILL_CHANGE_EVENT, skillHandler)
    window.addEventListener('clawbox:primary-ai-configured', providerHandler)
    return () => {
      window.removeEventListener(SKILL_CHANGE_EVENT, skillHandler)
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

  // Default position: centred above the mascot when there is room, clamped to
  // an 8px viewport gutter when the mascot is near an edge. This must follow
  // the live/remembered width: the old fixed `- 200` was the half-width of the
  // original 400px popup and became a 60px offset when the default grew to
  // 520px (and was wrong for every user-resized width too).
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1000
  const mascotCenterPx = ((mascotX ?? 85) / 100) * winW
  const defaultLeft = Math.max(8, Math.min(mascotCenterPx - size.w / 2, winW - size.w - 8))
  const posStyle: React.CSSProperties = panelMode
    ? {
        right: DESKTOP_GAP,
        top: DESKTOP_GAP,
        // The safe-area inset rides along because a maximized window subtracts
        // it from its height too; a flat 62 left the panel hanging below the
        // window's bottom edge on a device that has an inset.
        bottom: `calc(${SHELF_HEIGHT_PX + DESKTOP_GAP}px + env(safe-area-inset-bottom, 0px))`,
      }
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
  const anchorLeft = pos ? pos.x : (trayMode ? winW - size.w - 8 : defaultLeft)
  const originX = Math.max(20, Math.min(mascotCenterPx - anchorLeft, size.w - 20))
  const transformOrigin = panelMode ? 'right center' : mobile ? 'center bottom' : `${originX}px bottom`

  const greetingPending = isBootstrappingHistory || (sending && messages.length === 0)

  return (
    <div
      data-testid="chat-popup"
      ref={popupRef}
      // On the CAPTURE phase: the header, the pills and the composer all stop
      // their own pointer events, and a click that raises no surface is a click
      // that leaves the chat buried under the window that covered it.
      onPointerDownCapture={onFocus}
      style={{
        position: 'fixed',
        ...posStyle,
        ...(panelMode
          ? { width: panelWidth, minWidth: MIN_CHAT_WIDTH, height: 'auto', maxHeight: 'none', borderRadius: 16 }
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
        // The docked panel owns its strip and stays above the windows beside
        // it; the floating popup takes the place in the focus order the desktop
        // gives it, so the window the owner just opened is not stuck underneath
        // it with its title-bar controls covered. See `floatingZIndex`.
        //
        // A PHONE is neither: the chat is full-screen there and so is the one
        // window the desktop draws (at z 200, above the whole window band), so
        // a chat in the focus order would be opened and never seen.
        zIndex: panelMode || mobile ? DESKTOP_LAYERS.chat : floatingZIndex ?? DESKTOP_LAYERS.chat,
        overflow: 'hidden',
        boxShadow: mobile ? 'none' : '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
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
      }
      @keyframes clawHeaderPulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.35; }
      }
      /* Hidden until hover — but ONLY where a pointer can hover, and never
         merely transparent. A touch surface has no hover state and most mobile
         browsers apply :hover on tap, so an unconditional rule left an INVISIBLE
         restart sitting on the main plate that one tap could reveal and fire —
         and it makes the agent forget the thread, with no confirmation. Inside
         the query, pointer-events:none says the same thing to the pointer
         that CAN hover: while it is invisible it is not clickable either. */
      @media (hover: hover) and (pointer: fine) {
        .claw-tab-hover-close { opacity: 0; pointer-events: none; transition: opacity 0.12s ease; }
        .claw-tab-plate:hover .claw-tab-hover-close,
        .claw-tab-plate:focus-within .claw-tab-hover-close { opacity: 1; pointer-events: auto; }
      }`}</style>
      {/* Header — drag handle (desktop) / simple bar (mobile).
          A real bar in the flow, not a strip floating over the transcript.
          The floating version faded from the shell colour to transparent
          over ~44px, and the first line of every reply scrolled up under it
          half-visible behind the buttons — which read as a rendering glitch,
          not as a design. At 40px this costs 4px more than the top padding
          the strip needed, and buys the popup the title and the connection
          state every other desktop window carries (ChromeWindow's title bar
          is the same recipe: solid ground, one hairline). Same ground and
          hairline as the composer below, so the two bars frame the
          transcript symmetrically. Still no backdrop blur — a per-frame
          filter on the Jetson iGPU is the frame drop the burst animation's
          note warns about, and a solid bar needs none. */}
      <div
        data-testid="chat-header"
        onPointerDown={mobile || panelMode ? undefined : onDragStart}
        style={{
          flexShrink: 0,
          minHeight: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px 0 14px',
          background: 'rgba(0,0,0,0.2)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          userSelect: 'none',
          cursor: mobile || panelMode ? 'default' : 'grab',
          touchAction: 'none',
        }}>
        {/* The tabs. No status dot beside them (the owner asked for it gone):
            the composer already gates itself and says "Connecting…" in words,
            and connected is the normal state. The per-tab dots remain — they
            carry per-conversation facts (busy / unread) the composer cannot. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          {/* The tabs: main first, then the popup's own sessions, in the
              order they were opened. Alone, main wears no plate — it reads as
              the title it used to be. The row scrolls sideways past ~4 tabs
              rather than wrapping into a second header row. */}
          <div
            role="tablist"
            aria-label={t('chat.tabList')}
            data-testid="chat-tabs"
            style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, flex: 1, overflowX: 'auto', scrollbarWidth: 'none' }}
          >
            {[{ key: mainSessionKey, label: 'ClawBox', main: true }, ...tabs.map(tb => ({ key: tb.key, label: tb.label, main: false }))].map(tab => {
              const active = tab.main ? activeTabKey === null : activeTabKey === tab.key
              const busy = !!tab.key && busyKeys.has(tab.key)
              const unread = !!tab.key && !active && unreadKeys.has(tab.key)
              const switchable = status === 'connected' && !active && !!tab.key
              const select = () => { if (switchable) void switchSession(tab.key) }
              return (
                /* The plate is the WRAPPER, and the tab and its control are
                   siblings inside it. role="tab" makes its descendants
                   presentational, so a close button nested in it was one opaque
                   element to assistive tech and, at tabIndex -1, unreachable
                   from the keyboard. Putting the background and hover on the
                   wrapper keeps what the owner asked for — one plate, the ✕ part
                   of it, not a separate control that happens to sit beside it —
                   while each action keeps its own semantics and focus stop. */
                <div
                  key={tab.main ? 'main' : tab.key}
                  className="claw-tab-plate"
                  data-active={active || undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                    // minWidth so a short auto-label ("Chat 2") makes the same
                    // plate as a long one: without it every tab was exactly as
                    // wide as its text, and the whole strip re-flowed the moment
                    // a tab was renamed from the owner's first message.
                    padding: '4px 8px', borderRadius: 8, minWidth: 92, maxWidth: 150, minHeight: 24,
                    background: active && tabs.length > 0 ? 'rgba(255,255,255,0.08)' : 'transparent',
                    color: active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
                    fontSize: 12, fontWeight: 600, letterSpacing: 0.2,
                    userSelect: 'none', transition: 'background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={(e) => { if (switchable) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'rgba(255,255,255,0.8)' } }}
                  onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.5)' } }}
                >
                  <div
                    role="tab"
                    // Roving, per the ARIA tabs pattern: the strip is ONE tab
                    // stop, not one per conversation — eight open chats used to
                    // mean eight presses to reach the composer.
                    tabIndex={active ? 0 : -1}
                    aria-selected={active}
                    // The other half of the ARIA tabs pattern: a `tab` that
                    // controls nothing leaves assistive tech with a strip of
                    // buttons and no way to say what selecting one changed.
                    // One panel for every tab, because the transcript IS the
                    // panel — it is re-read for the conversation that was
                    // selected rather than swapped for a second element.
                    id={tabDomId(tab.main ? null : tab.key)}
                    aria-controls={TRANSCRIPT_PANEL_ID}
                    data-testid="chat-tab"
                    data-session-key={tab.key}
                    // Both dots are aria-hidden decoration, so without this a
                    // conversation that is still answering, one holding a reply
                    // nobody has read, and an idle one all read alike: colour
                    // and shape were carrying the fact by themselves.
                    aria-label={busy ? t('chat.tabBusy', { label: tab.label })
                      : unread ? t('chat.tabUnread', { label: tab.label })
                      : tab.label}
                    title={tab.label}
                    onPointerDown={stopHeaderDrag}
                    onClick={select}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); return }
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                      // MANUAL activation: the arrows move focus, Enter opens.
                      // Automatic activation is the other half of the pattern
                      // and wrong here — every step would spend a history read
                      // on a conversation nobody asked to see.
                      e.preventDefault()
                      const strip = e.currentTarget.closest('[role="tablist"]')
                      const all = [...(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
                      const at = all.indexOf(e.currentTarget)
                      if (at < 0 || all.length < 2) return
                      all[(at + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.focus()
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1,
                      cursor: switchable ? 'pointer' : 'default',
                      // The plate's padding is on the wrapper, so push the focus
                      // ring out to the plate's edge rather than hugging the text.
                      outlineOffset: 4,
                    }}
                  >
                    {busy && (
                      <span data-testid="chat-tab-busy" aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: '#f97316', flexShrink: 0, animation: 'clawHeaderPulse 1.2s ease-in-out infinite' }} />
                    )}
                    {!busy && unread && (
                      <span data-testid="chat-tab-unread" aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
                    )}
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1 }}>{tab.label}</span>
                  </div>
                  {!tab.main && active && (
                    /* ONE click closes — the old first tap only armed a red
                       "Close tab?" in place, which is the confirmation the owner
                       was seeing and did not want. Neutral, on the plate's own
                       hover ladder rather than a raw red tint. A native button:
                       focusable in the tab order, Enter and Space for free. */
                    <button
                      type="button"
                      onPointerDown={stopHeaderDrag}
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.key) }}
                      aria-label={t('chat.tabClose')}
                      title={t('chat.tabClose')}
                      data-testid="chat-tab-close"
                      style={TAB_CONTROL_STYLE}
                      onMouseEnter={onTabControlEnter}
                      onMouseLeave={onTabControlLeave}
                    >
                      <TabControlGlyph />
                    </button>
                  )}
                  {tab.main && active && (
                    /* Revealed on hover of the PLATE (`.claw-tab-plate:hover`),
                       which is the fix for a dead style: the reveal rule used
                       to be `[role="tab"]:hover .claw-tab-hover-close` while the
                       button sat beside role="tab", so the descendant selector
                       never matched and the button stayed at opacity 0 —
                       invisible, still clickable, and invisible to jsdom too,
                       which is why the test passed. Scoping the rule to the
                       wrapper keeps the button a sibling of the tab with its
                       own focus stop; :focus-within shows it to the keyboard.
                       The hiding itself is gated on a hover-capable pointer —
                       see the rule — so a touch surface, which has no hover to
                       reveal anything with, simply always shows it. */
                    <button
                      type="button"
                      onPointerDown={stopHeaderDrag}
                      onClick={(e) => { e.stopPropagation(); if (!startingSession) void startNewSession() }}
                      aria-label={t('chat.tabRestart')}
                      title={t('chat.tabRestart')}
                      data-testid="chat-tab-restart"
                      className="claw-tab-hover-close"
                      style={TAB_CONTROL_STYLE}
                      onMouseEnter={onTabControlEnter}
                      onMouseLeave={onTabControlLeave}
                    >
                      <TabControlGlyph />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        {onOpenFull && (
          <button
            onPointerDown={stopHeaderDrag}
            onClick={() => { onOpenFull(); onClose() }}
            title={tr('chat.openFullUi', 'Open full UI')}
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
          onClick={newTab}
          // A new tab needs the main key: the hello brings the gateway's, and
          // a harness with no handshake binds its own on connect.
          disabled={status !== 'connected'}
          title={t('chat.tabNew')}
          aria-label={t('chat.tabNew')}
          data-testid="chat-new-tab"
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
            title={panelMode ? tr('chat.undockPanel', 'Undock panel') : tr('chat.dockToRight', 'Dock to right')}
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
          data-testid="chat-popup-close"
          onPointerDown={stopHeaderDrag}
          onClick={onClose}
          aria-label={t("window.close")}
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

      {/* Messages area — sits under the header bar in the flow, so it needs
          no clearance beyond its own breathing room.

          It is the tab strip's PANEL: `aria-labelledby` names whichever tab is
          selected, so the conversation on screen is announced as that tab's
          content. `tabIndex={0}` because a scrollable region has to be
          reachable by keyboard — several of its bubbles carry nothing
          focusable, and the transcript is the one thing here worth paging
          through. */}
      <div
        id={TRANSCRIPT_PANEL_ID}
        role="tabpanel"
        aria-labelledby={tabDomId(activeTabKey)}
        tabIndex={0}
        data-testid="chat-transcript"
        style={{
          flex: 1, overflowY: 'auto', padding: '12px 14px 12px',
          display: 'flex', flexDirection: 'column', gap: 10,
          userSelect: 'text',
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(255,255,255,0.1) transparent',
        }}
      >
        {(status === 'connecting' || reloadingSkill) && (reloadingSkill || messages.length === 0) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 14, color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } } @keyframes dots { 0%,20% { content: '' } 40% { content: '.' } 60% { content: '..' } 80%,100% { content: '...' } } @keyframes clawReloadFill { from { transform: scaleX(0.04) } to { transform: scaleX(0.9) } }`}</style>
            {reloadingSkill ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, width: '85%' }}>
                <div style={SPINNER_STYLE} />
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, width: '100%' }}>
                  {/* Two states only: a skill change no longer restarts the
                      gateway, so it never raises this overlay (TASK-508). */}
                  <span>{reloadReason === 'provider' ? 'Switching AI provider...' : 'Restarting chat...'}</span>
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
            <img src="/clawbox-crab.png" alt="" style={{ width: 25, height: 25, objectFit: 'contain', opacity: 0.4 }} />
            <span>{t("chat.saySomething")}</span>
          </div>
        )}

        {!reloadingSkill && messages.map((msg, i) => {
          const isSuccess = msg.variant === 'success';
          const isUser = msg.role === 'user';
          const isSystem = msg.role === 'system';
          // Messages the agent pointed at, as `EMAIL:<uid>` lines in the reply.
          // Derived at render rather than stored on the message: a replayed
          // turn carries the same directive text a live one did, so deriving
          // here makes history and live identical for free — and keeps the
          // owner's mail out of the cached transcript, which is where it very
          // deliberately does not belong.
          const emailRefs = msg.role === 'assistant' ? splitEmailRefs(msg.text) : null;
          const bodyText = emailRefs ? emailRefs.text : msg.text;
          // A long paste folds behind "Show more": the paste is the owner's
          // own text, and the answer should not sit a page of it away.
          const longKey = `${i}:${msg.timestamp}`;
          const isLongUser = isUser && bodyText.length > USER_CLAMP_CHARS;
          const userExpanded = expandedLong.has(longKey);
          const shownText = isLongUser && !userExpanded
            ? `${bodyText.slice(0, USER_CLAMP_CHARS).trimEnd()}…`
            : bodyText;
          // Which model actually answered, as the turn recorded it. The header
          // pills are a request; this is the record — the one thing on screen
          // that settles "which model are you" after a mid-conversation
          // switch. Provider by its full display name, model by its full id —
          // a record, so nothing is trimmed off it; nothing when not recorded.
          const served = msg.role === 'assistant' && msg.model
            ? `${msg.provider ? `${hermesProviderName(msg.provider)} · ` : ''}${msg.model}`
            : null;
          return (
            <div key={i} style={{
              display: 'flex',
              justifyContent: isUser ? 'flex-end' : 'flex-start',
            }}>
              {/* Three treatments, after the Claude Code web UI: the owner's
                  words in a quiet right-aligned pill, the assistant's answer
                  as plain unbubbled text, and system notices as a bordered
                  row that keeps the green/red verdict on the text alone. */}
              <div style={isUser ? {
                maxWidth: '85%',
                padding: '8px 14px',
                borderRadius: 14,
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.07)',
                color: 'rgba(255,255,255,0.92)',
                fontSize: 13.5,
                lineHeight: 1.45,
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
              } : isSystem ? {
                width: '100%',
                padding: '6px 12px',
                borderRadius: 10,
                background: 'rgba(255,255,255,0.02)',
                border: `1px solid ${isSuccess ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.3)'}`,
                color: isSuccess ? '#86efac' : '#fca5a5',
                fontSize: 12.5,
                lineHeight: 1.45,
                wordBreak: 'break-word',
              } : {
                width: '100%',
                padding: '2px 2px',
                color: 'rgba(255,255,255,0.88)',
                fontSize: 13.5,
                lineHeight: 1.5,
                wordBreak: 'break-word',
              }}>
                {msg.images && msg.images.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: bodyText ? 6 : 0 }}>
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
                {bodyText ? (isUser ? shownText : renderText(bodyText, t("chat.table"))) : null}
                {isLongUser && (
                  <button
                    type="button"
                    data-testid="chat-user-expand"
                    aria-expanded={userExpanded}
                    onClick={() => setExpandedLong(prev => {
                      const next = new Set(prev);
                      if (next.has(longKey)) next.delete(longKey);
                      else next.add(longKey);
                      return next;
                    })}
                    style={{
                      display: 'block', marginTop: 6, background: 'none', border: 0,
                      padding: 0, color: 'rgba(255,255,255,0.55)', cursor: 'pointer',
                      font: 'inherit', fontSize: 12, textDecoration: 'underline',
                    }}
                  >
                    {userExpanded ? t("chat.showLess") : t("chat.showMore")}
                  </button>
                )}
                {msg.audio && msg.audio.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: bodyText ? 8 : 0 }}>
                    {msg.audio.map((src) => (
                      // The player and, under it, the two things a player
                      // cannot say for itself: which voice spoke, when it was
                      // not the one the owner picked, and that the browser
                      // would not start it.
                      <div key={src} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {/* The browser's own player, not a bespoke one: play,
                          pause, scrub and duration are what "a normal playable
                          message" means, and every one of them already works
                          here and is reachable from the keyboard.

                          `preload="metadata"` so the duration is on screen
                          before anything is played, without pulling the whole
                          file down for a reply nobody listens to. The src is
                          this box's own media route, which answers Range
                          requests — without that the scrubber does not move.

                          Keyed by the URL: the harness names every file with a
                          uuid, so re-rendering a transcript cannot hand one
                          player another player's audio. */}
                      <audio
                        key={src}
                        data-testid="chat-audio"
                        // Markdown source must not reach an accessible name —
                        // it is read out character for character. See
                        // plainTextForLabel. `bodyText` rather than `msg.text`
                        // for one more reason: the stored text keeps its
                        // `EMAIL:` directives, so the raw string announced
                        // "EMAIL 4471" after a summary short enough to survive
                        // the 100-character trim.
                        //
                        // The RECORDED clip is a second copy of the same words,
                        // and WHERE it is made decides who strips them. On
                        // Hermes ClawBox makes it, so the route strips there
                        // too (setup-api/hermes/chat/route.ts). On OpenClaw the
                        // gateway picks the engine: a cloud voice, whose text
                        // ClawBox never touches, or on-device Kokoro, which it
                        // speaks by running ClawBox's own
                        // scripts/openclaw/clawbox-tts.sh with the reply in
                        // argv. Neither engine strips the id, so it is still
                        // spoken on that edition — the outbound half, TASK-697,
                        // which covers both voices at once.
                        aria-label={audioLabel(bodyText, t("chat.audioReply"))}
                        controls
                        preload="metadata"
                        src={src}
                        style={{ width: '100%', maxWidth: 280, height: 34 }}
                      >
                        <a href={src} download={mediaFileName(src)}>{t("chat.downloadAudio")}</a>
                      </audio>
                      {cloudSpoken.includes(src) && (
                        <span data-testid="chat-audio-cloud" style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
                          {t("chat.spokenByCloud")}
                        </span>
                      )}
                      {autoplayBlocked.includes(src) && (
                        <span data-testid="chat-audio-blocked" style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                          {t("chat.tapToHearReply")}
                        </span>
                      )}
                      </div>
                    ))}
                  </div>
                )}
                {/* A way back to the real message, for each one the reply
                    referred to. The agent's summary is what the bubble says;
                    this is the mail itself, opened on demand and fetched only
                    then — see lib/chat-email-refs.ts. */}
                {emailRefs && emailRefs.uids.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: bodyText ? 8 : 0 }}>
                    {emailRefs.uids.map(uid => (
                      <EmailCard key={uid} uid={uid} onOpen={setOpenEmailUid} t={t} />
                    ))}
                  </div>
                )}
                {/* What the agent DID and what it was thinking, under the
                    answer and never inside it. Both come off the stored
                    message, so a replayed turn shows exactly what the live one
                    did — the chips sit where the live pills sat, and the
                    monologue stays collapsed until it is asked for. */}
                {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                  <ToolCallSummaryChips
                    toolCalls={msg.toolCalls}
                    label={t("chat.toolsUsed")}
                    ranLabel={t(msg.toolCalls.length === 1 ? "chat.ranCommand" : "chat.ranCommands", { n: msg.toolCalls.length })}
                  />
                )}
                {msg.role === 'assistant' && msg.reasoning && (
                  <ReasoningDisclosure reasoning={msg.reasoning} label={t("chat.reasoning")} />
                )}
                {served && (
                  <div
                    data-testid="chat-served-model"
                    // Sighted readers get the answer from where the line sits —
                    // under the reply, in the place the tool chips and the
                    // monologue use. A screen reader gets two proper nouns and
                    // a middot, so the label says what they are; the visible
                    // text stays as short as the bubble needs it to be.
                    aria-label={`${t("chat.servedBy")}: ${served}`}
                    // 0.55 over the panel's #0d1117 is ~6:1 — AA. The quiet
                    // 0.35 the tool chips use is ~3.2:1, which is fine for a
                    // decoration and not for the one line that answers a
                    // question. Wraps rather than clips: an id cut to an
                    // ellipsis with the rest in a mouse-only title is not
                    // visible.
                    style={{ marginTop: 4, fontSize: 11, lineHeight: 1.3, color: 'rgba(255,255,255,0.55)', wordBreak: 'break-all' }}
                  >
                    {served}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {!reloadingSkill && <ToolCallPills toolCalls={toolCalls} runningLabel={t("chat.running")} />}

        {/* Not tool pills: `coding_agent_run` returns its run id in
            milliseconds while the run itself works for minutes, so these are
            fed by the device's run record. They stay after the run ends and
            report the outcome — a badge that vanished with the run was gone
            before the owner had read the message above it, since runs here
            take 9-15 seconds. See src/lib/use-coding-agent-activity.ts. */}
        {/* MAIN TAB ONLY. A run record carries no session key — the hook adopts
            runs by START TIME, not by conversation — so a card drawn in every
            tab claimed the run belonged to whichever chat happened to be open,
            and survived a tab switch because switchSession blanks `messages`
            and not `codingRuns`. `activeTabKey === null` is the predicate the
            strip itself already uses for "main is selected" (the main session's
            key is stored as null), so this is the same test, not a new one. */}
        {activeTabKey === null && codingRuns.map(codingAgentCard)}

        {/* Attached to the IN-FLIGHT turn, next to the pills, and never to a
            message: see the note on `clarifies` above for why this is the one
            thing a turn produces that is deliberately not persisted. */}
        {!reloadingSkill && clarifies.map(card => (
          <ClarifyPrompt key={card.requestId} card={card} onAnswer={answerClarify} />
        ))}

        {/* Outgoing mail, one card per batch. Below the clarifies and above the
            image banner, i.e. at the bottom of the transcript where the turn
            that produced it just ended — this is a decision about what the
            agent has ALREADY done, so it belongs after the answer rather than
            beside the composer. */}
        {!reloadingSkill && emailBatches.map(card => (
          <EmailBatchCard
            key={card.batchId}
            card={card}
            hermes={harnessId === 'hermes'}
            onApprove={approveEmailBatch}
            onCancel={cancelEmailBatch}
          />
        ))}

        {/* The picture outlives the turn that asked for it, so this banner is
            the only thing on screen during the 20-40s wait — the tool pill has
            already gone green and `sending` is back to false. */}
        {/* One banner, both waits — the agent drawing on its own and the box
            fetching on the composer's behalf look identical to the person
            waiting, and should. */}
        {!reloadingSkill && (generatingImage || drawing) && (
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

        {/* Streaming message — the same plain treatment the finished answer
            gets, so nothing jumps when the turn lands. */}
        {!reloadingSkill && streaming && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              width: '100%', padding: '2px 2px',
              color: 'rgba(255,255,255,0.88)',
              fontSize: 13.5, lineHeight: 1.5, wordBreak: 'break-word',
            }}>
              {/* Lifted out HERE, not on the way into state, so an interrupted
                  turn keeps the directive and can still become cards. */}
              {renderText(streamingEmailRefsText(streaming), t("chat.table"))}
              <span style={{ display: 'inline-block', width: 6, height: 14, background: '#f97316', borderRadius: 1, marginLeft: 2, animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom' }} />
              <style>{`@keyframes blink { 50% { opacity: 0 } }`}</style>
            </div>
          </div>
        )}

        {/* The status line: a small spinner, what the harness says it is
            doing (or just "Working…"), and a ticking clock for the whole
            turn. Shown for the whole run — under the stream too — because a
            moving second is the cheapest proof a long turn is alive. The
            clock is aria-hidden: a live region that re-announced itself every
            second would talk over the answer. */}
        {!reloadingSkill && (sending || isBootstrappingHistory) && (
          <div
            data-testid="chat-turn-status"
            role="status"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px', fontSize: 12, color: 'rgba(255,255,255,0.5)' }}
          >
            <span aria-hidden="true" style={TURN_SPINNER_STYLE} />
            <span>{turnStatus ?? (sending && turnVerbRef.current ? `${turnVerbRef.current}…` : t("chat.working"))}</span>
            {sending && turnStartedAtRef.current > 0 && (
              <span aria-hidden="true">
                · {(() => {
                  const s = Math.max(0, Math.round((turnNow - turnStartedAtRef.current) / 1000));
                  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
                })()}
              </span>
            )}
          </div>
        )}

        {/* The box is making the sound. Under the newest bubble, where the
            reply it belongs to already is: the words land first and the voice
            follows a cold Kokoro 13-19 s later, and with nothing on screen for
            that gap the chat looked finished and then spoke out of nowhere.
            The seconds are what tells a wait from a hang — the same counter
            Settings → Voice runs while it auditions a voice. */}
        {speakingReply && (
          <div
            data-testid="chat-speaking-reply"
            role="status"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px', fontSize: 12, color: 'rgba(255,255,255,0.5)' }}
          >
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15 }}>graphic_eq</span>
            <span>{t("chat.speakingReply", { seconds: speakingFor })}</span>
          </div>
        )}

        {queuedSends.map((q) => (
          <div key={q.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{
              maxWidth: '85%', padding: '7px 12px',
              borderRadius: 14,
              background: 'rgba(255,255,255,0.04)',
              color: 'rgba(255,255,255,0.6)',
              fontSize: 13, lineHeight: 1.4, wordBreak: 'break-word',
              display: 'flex', alignItems: 'center', gap: 8,
              border: '1px dashed rgba(255,255,255,0.25)',
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
      {/* Mounted by the CAPTURE's state, not by the capability. `canTranscribe`
          follows a credential that is re-probed at runtime, so it can flip to
          false mid-recording — and gating this on it took the pulsing dot and
          the running clock off screen while the microphone was still open,
          breaking the one invariant a live capture has. */}
      {voice.state !== 'idle' && (
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
          {/* One line while a capture is live — the row sits over the composer
              and a wrapping status would push the input around every second.
              An ERROR is the opposite case: it is the only place the reason and
              the remedy are written, and a sentence cut off at "Open this
              ClawBox…" tells the owner a problem exists and hides the fix. */}
          <span style={voice.state === 'error'
            ? { flex: 1, whiteSpace: 'normal' }
            : { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                : voice.error === 'insecure' ? t("chat.voice.insecureContext")
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
      {/* Same reason as the status row above: whoever can start a capture must
          always be able to end one. */}
      {(voice.state === 'recording' || voice.state === 'transcribing') && (
        <div data-testid="voice-privacy" style={{ padding: '0 14px 6px', background: 'rgba(0,0,0,0.2)', fontSize: 10.5, color: 'rgba(255,255,255,0.45)' }}>
          {t("chat.voice.privacy")}
        </div>
      )}

      {/* The New app card, over the composer. Same ground and hairline as the
          composer so it reads as part of it, not as a dialog over the chat. */}
      {showNewApp && (
        <div data-testid="chat-new-app" style={{ padding: '10px 14px 0', background: 'rgba(0,0,0,0.2)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <NewAppWizardCard
            key={`${newAppOptions.project ?? ''}|${newAppOptions.team ? 'team' : ''}`}
            initialProject={newAppOptions.project}
            initialTeam={newAppOptions.team}
            maxTaskChars={newAppMaxChars ?? DEFAULT_MAX_TASK_CHARS}
            onClose={closeNewApp}
            // In the chat it floats over the composer like a popover, so it
            // behaves like one: click away (or Escape) and it goes.
            closeOnOutsideClick
          />
        </div>
      )}

      {/* Composer — the shape people know from Claude's own UI: the text
          box on top, full width, and one row under it with the attach,
          microphone and picture buttons on the left and, on the right, the
          provider / model / effort pills beside the send button. */}
      <div style={{
        padding: '10px 14px 10px',
        borderTop: (attachments.length > 0 || showNewApp) ? 'none' : '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.2)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
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
            width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)',
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
        {/* The row's layout lives in globals.css (.chat-composer-row), because
            what the pills need against the 36px buttons beside them is a wrap
            rule and a flex-basis — see the block there. */}
        <div data-testid="chat-composer-row" className="chat-composer-row">
        {/* Shown only where a file staged here can actually reach the model.
            The alternative is worse than a missing button: the picture is drawn
            into the user's own bubble and then dropped, so the customer sees
            their screenshot in the transcript and an answer that never looked
            at it. */}
        {(caps.canAttachImages || caps.canAttachDocuments) && (
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={status !== 'connected'}
          title={tr('chat.attachFile', 'Attach file')}
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
              // On an origin the browser will not open a microphone on, the
              // button says WHY on hover and to a screen reader, instead of
              // naming an action it cannot perform. It stays clickable so the
              // same reason lands in the status row for anyone who tries.
              title={captureAvailability === 'insecure' ? t("chat.voice.insecureContext") : t("chat.voice.record")}
              aria-label={captureAvailability === 'insecure' ? t("chat.voice.insecureContext") : t("chat.voice.record")}
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
        {/* Create: the Coding Agent's New app wizard, right here. The owner
            asked for it beside the attach and microphone buttons — the chat is
            where the handoff lands, so it is where the request should start. */}
        <button
          onClick={toggleNewApp}
          title={t("codingAgent.createNewProject")}
          aria-label={t("codingAgent.createNewProject")}
          aria-pressed={showNewApp}
          data-testid="chat-new-app-toggle"
          style={{
            width: 36, height: 36, borderRadius: 10, border: 'none',
            background: showNewApp ? 'rgba(249,115,22,0.2)' : 'rgba(255,255,255,0.06)',
            color: showNewApp ? '#f97316' : 'rgba(255,255,255,0.4)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(249,115,22,0.15)'; e.currentTarget.style.color = '#f97316' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = showNewApp ? 'rgba(249,115,22,0.2)' : 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = showNewApp ? '#f97316' : 'rgba(255,255,255,0.4)' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 22 }}>add</span>
        </button>
        {/* Making a picture, where the AGENT cannot.
            Shown on the trigger and not on `canGenerateImages`, because the two
            answer different questions: the flag says a picture can be made
            here, the trigger says who makes it. On OpenClaw the customer simply
            asks and the agent's own tool draws — a button there would be a
            second way to ask for something the chat already does, and the
            adapter refuses it outright. */}
        {caps.imageGenerationTrigger === 'composer' && (
          <button
            onClick={() => { void generatePicture() }}
            // Disabled with nothing typed, because the composer's text IS the
            // prompt and an empty one would spend a generation on silence. The
            // title says which of the two reasons applies rather than going
            // blank, so a customer is never left guessing at a dead control.
            disabled={status !== 'connected' || drawing || input.trim().length === 0}
            title={input.trim().length === 0 ? t("chat.generatePictureEmpty") : t("chat.generatePicture")}
            aria-label={t("chat.generatePicture")}
            data-testid="generate-image"
            style={{
              width: 36, height: 36, borderRadius: 10, border: 'none',
              background: 'rgba(255,255,255,0.06)',
              color: drawing ? '#f97316' : 'rgba(255,255,255,0.4)',
              cursor: status === 'connected' && !drawing && input.trim().length > 0 ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => { if (status === 'connected' && !drawing && input.trim().length > 0) { e.currentTarget.style.background = 'rgba(249,115,22,0.15)'; e.currentTarget.style.color = '#f97316' } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; if (!drawing) e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
              {drawing ? 'hourglass_top' : 'imagesmode'}
            </span>
          </button>
        )}
          <div className="chat-header-pills" style={{ justifyContent: 'flex-end' }}>
          {harnessId === 'hermes' ? (
            // Same three pills, same order and widths as the OpenClaw branch
            // below — provider → model (scoped to it) → thinking effort. Every
            // pill label is de-duplicated against its neighbour (see
            // src/lib/chat-header-pills.ts) to fit un-truncated, and when the
            // row can no longer hold them beside the composer's buttons they
            // take a line of their own rather than being cut to "Cla…" (see
            // .chat-composer-row in globals.css). Narrower still they truncate
            // with "…"; the popovers keep the full text either way. Falls back
            // to a plain label until the catalogue loads.
            hermesProviders.length > 0 ? (
              <>
                <HeaderDropdown
                  ariaLabel={tr('chat.pillChatProvider', 'Chat provider')}
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
                    ariaLabel={tr('chat.pillHermesModel', 'Hermes model')}
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
                    ariaLabel={hermesBinaryReasoning ? tr('chat.pillThinking', 'Thinking') : tr('chat.pillReasoningEffort', 'Reasoning effort')}
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
                          ? tr('chat.thinkingOnHint', 'Better at reasoning. Much slower.')
                          : tr('chat.thinkingOffHint', 'Fastest. Answers immediately.'))
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
            // No `activeOptionId` means no row on this list is what the box
            // is running — whether because the primary matches none of them,
            // or because nothing is pinned at all. Both used to default to
            // options[0], which named the first provider in the list — ClawBox
            // AI on every paired box — as the active one. It also made the
            // owner's most natural recovery gesture a no-op: HeaderDropdown
            // fires onChange only when the pick differs from `value`, so
            // clicking the row the header was already showing did nothing.
            // Empty `value` keeps that click live and the label honest.
            //
            // The `activeModel` half of this test was dropped when chat/model
            // stopped resolving a null primary onto the Local-AI placeholder:
            // that made "nothing pinned" a null/null state, which this
            // predicate had been reading as "a row is active".
            const unselectableActive = !chatModelState.activeOptionId
            const activeId = chatModelState.activeOptionId
              ?? (unselectableActive ? '' : (chatModelState.options[0]?.id ?? ''))
            const activeOption = chatModelState.options.find(o => o.id === activeId)
            const triggerLabel = activeOption
              ? getProviderPillText(activeOption)
              : (unselectableActive ? t('chat.noChatModel') : activeId)
            return (
              <HeaderDropdown
                ariaLabel={tr('chat.pillChatProvider', 'Chat provider')}
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
            // The ChatGPT row's UI id is `codex` while its models are written
            // `openai/<id>` — OpenClaw 2 retired the namespace but not the
            // label (src/lib/chatgpt-subscription.ts). Comparing the row's id
            // against the reference verbatim answered "not this provider's
            // model" on every ChatGPT box and took this dropdown — the only
            // way to move between GPT-5.5 / GPT-5.4 / GPT-5.6 after setup —
            // off the screen entirely.
            let activeModelId = extractProviderModelId(
              chatModelState.activeModel,
              chatgptReferenceProvider(activeOption.provider),
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
                ariaLabel={tr('chat.pillProviderModel', '{provider} model', { provider: activeOption.label })}
                value={activeModelId}
                triggerLabel={shortModelPillLabel(
                  activeModelLabel,
                  getProviderPillText(activeOption),
                )}
                // A model the box's SUBSCRIPTION surface does not carry is
                // SHOWN, not hidden, and it says why — the same treatment the
                // setup wizard gives it, because the wizard's help line sends
                // the customer here to switch models. Dropping the row would
                // be the same lie in the other direction.
                options={modelOptions.map(option => {
                  const blocked = !isModelUsableOnSubscription(option, headerOnSubscription)
                  return {
                    id: option.id,
                    label: option.label,
                    hint: option.hint,
                    disabled: blocked,
                    unavailableReason: blocked ? t('ai.modelNeedsApiKey') : undefined,
                  }
                })}
                onChange={(nextId) => {
                  if (nextId === activeModelId) return
                  // The list already refuses a disabled row, but the switch is
                  // not allowed to depend on that: the server guard exists for
                  // ids that arrive some other way, and this one exists so the
                  // customer is never shown a "Switched to ..." for a model
                  // the same screen just told them the box cannot run.
                  const next = modelOptions.find(option => option.id === nextId)
                  if (next && !isModelUsableOnSubscription(next, headerOnSubscription)) return
                  // Wire-format provider for ClawBox AI is `deepseek`
                  // (Mike's gateway routes via DeepSeek). Sending
                  // `clawai/...` would be rejected by the gateway as
                  // an unknown provider.
                  // The ChatGPT row's models are written `openai/<id>`: its
                  // UI id `codex` is a label, not a namespace. Posting
                  // `codex/<id>` from the product's own daily switcher made the
                  // server's legacy-ref shim — written for a stale tab — the
                  // happy path, and the row signal below the thing that was
                  // never exercised. `clawai`/`deepseek` pass through unchanged.
                  const wireProvider = activeOption.provider === 'clawai'
                    ? 'deepseek'
                    : chatgptReferenceProvider(activeOption.provider)
                  void switchChatModel({
                    provider: activeOption.provider,
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
              ariaLabel={tr('chat.pillReasoningEffort', 'Reasoning effort')}
              value={effectiveThinkingLevel}
              /* THINKING_LEVEL_LABELS is the gateway's English vocabulary;
                 the pill is a control on a desktop that may be in any of ten
                 languages, so the level is worded here and the English is
                 the floor for a level the catalogue does not know. */
              options={visibleThinkingLevels.map(level => ({
                id: level,
                label: tr(`chat.effort.${level}`, THINKING_LEVEL_LABELS[level] ?? level),
              }))}
              onChange={handleThinkingLevelChange}
              onPointerDown={stopHeaderDrag}
              /* Brain glyph instead of a "Thinking: " word prefix — see
                 REASONING_PILL_ICON. */
              triggerLabel={tr(`chat.effort.${effectiveThinkingLevel}`, THINKING_LEVEL_LABELS[effectiveThinkingLevel] ?? effectiveThinkingLevel)}
              triggerIcon={REASONING_PILL_ICON}
              triggerMaxWidth={120}
              popoverWidth={180}
            />
          )}
          </>)}
        </div>
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
      </div>

      {/* Where a drop against an edge would land the chat — the same plate the
          app windows draw, portalled so the popup's own overflow cannot clip
          it. */}
      {!mobile && !panelMode && snapPreview && createPortal(
        <SnapPreviewOverlay zone={snapPreview} />,
        document.body,
      )}

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

      {/* Where the microphone DOES work, when this origin cannot record.
          The component portals itself to <body> for the same containing-block
          reason as the image preview below. */}
      <VoiceTunnelDialog open={tunnelDialogOpen} onClose={() => setTunnelDialogOpen(false)} />

      {/* The whole email, when one has been opened from a card in the
          transcript. It portals itself to <body> for the same containing-block
          reason as the image preview below, and brings its own dialog
          behaviour — focus, Tab trap, Escape — from the shared hook. */}
      {openEmailUid !== null && (
        <EmailFullView key={openEmailUid} uid={openEmailUid} onClose={closeEmail} t={t} />
      )}

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
