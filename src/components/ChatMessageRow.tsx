'use client'

import React, { memo } from 'react'

import type { ChatMessage as BaseChatMessage } from '@/lib/chat-history-cache'
import { ToolCallSummaryChips } from '@/lib/chat-tool-events'
import { ReasoningDisclosure } from '@/lib/chat-reasoning-disclosure'
import { mediaFileName } from '@/lib/chat-media'
import ChatFileCard from '@/components/ChatFileCard'
import { splitEmailRefs, streamingEmailRefsText } from '@/lib/chat-email-refs'
import { EmailCard } from '@/lib/chat-email'
import { renderText, audioLabel } from '@/lib/chat-markdown'
import SpokenReplyPlayer from '@/components/SpokenReplyPlayer'
import { samePlainData } from '@/lib/same-plain-data'

// ── One bubble of the mascot chat's transcript ──
//
// Split out of ChatPopup so React can SKIP it. The popup is one very large
// component that renders on every keystroke in the composer, every streamed
// chunk, every tick of a clock and every desktop render, and while the
// bubbles were built inline each of those renders parsed the Markdown of every
// reply in the conversation again (`renderText`, then `renderInline`'s
// regexes) and handed React a fresh element tree to diff — tens of
// milliseconds a keystroke on a Jetson with a long conversation, for a
// transcript that had not changed. Memoised, a bubble renders again only when
// what it shows does: its message, its fold, its notes, the language.
//
// Nothing on screen changed in the move. The markup is the one the popup drew,
// line for line; the parent still keys rows by position, so a bubble's own
// state (an open `<details>`, a player mid-clip, an unfolded monologue) stays
// exactly where it was.

/** The popup's message: the stored one, plus the colour of a system notice. */
export type ChatRowMessage = BaseChatMessage & { variant?: 'success' | 'error' }

type Translate = (key: string, params?: Record<string, string | number>) => string

// Past this, a pasted user message folds behind "Show more".
export const USER_CLAMP_CHARS = 700

/** The notes a bubble with no player cannot show — one array, so they never re-render it. */
export const NO_AUDIO_NOTES: readonly string[] = Object.freeze([]) as readonly string[]

export interface ChatMessageRowProps {
  msg: ChatRowMessage
  /** Position and timestamp: what an unfolded long paste is remembered by. */
  longKey: string
  /** Whether the owner unfolded this (long, user) message. */
  expanded: boolean
  onToggleExpand: (longKey: string) => void
  /** "Provider · model" that answered, as the turn recorded it, or null. */
  served: string | null
  t: Translate
  onPreview: (preview: { src: string; alt: string }) => void
  onOpenEmail: (uid: number) => void
  /** Clip URLs the cloud voice spoke. Hand a bubble without audio NO_AUDIO_NOTES. */
  cloudSpoken: readonly string[]
  /** Clip URLs the browser would not start on its own. Same rule. */
  autoplayBlocked: readonly string[]
}

// Messages are compared by VALUE: a history reconcile rebuilds EVERY message
// object from the gateway's answer even when only the newest one is new, so
// comparing them by identity would re-parse the whole conversation at the end
// of every turn. The rule lives in src/lib/same-plain-data.ts, shared with the
// full-page chat's rows; re-exported here, where it was first written.
export { samePlainData }

// The message and the two note lists by VALUE (see samePlainData), everything
// else — the strings, the flags, `t` and the popup's stable callbacks — by
// identity. A prop added later is compared by identity without anyone having
// to remember this function.
function sameRowProps(prev: ChatMessageRowProps, next: ChatMessageRowProps): boolean {
  for (const key of Object.keys(next) as (keyof ChatMessageRowProps)[]) {
    if (key === 'msg' || key === 'cloudSpoken' || key === 'autoplayBlocked') {
      if (!samePlainData(prev[key], next[key])) return false
    } else if (!Object.is(prev[key], next[key])) {
      return false
    }
  }
  return Object.keys(prev).length === Object.keys(next).length
}

function ChatMessageRowImpl({
  msg, longKey, expanded, onToggleExpand, served, t, onPreview, onOpenEmail, cloudSpoken, autoplayBlocked,
}: ChatMessageRowProps) {
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
  const isLongUser = isUser && bodyText.length > USER_CLAMP_CHARS;
  const shownText = isLongUser && !expanded
    ? `${bodyText.slice(0, USER_CLAMP_CHARS).trimEnd()}…`
    : bodyText;
  return (
    <div style={{
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
                  onClick={() => onPreview({ src, alt: imageAlt })}
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
                    save it under the name the harness gave it.

                    No backdrop blur: a blur is a render pass of its own for
                    every picture in the transcript, redone on each frame of a
                    scroll and under every change behind it, for a 26px chip.
                    The fill is a touch darker instead (0.55 + blur(4px) was
                    0.62 flat), which keeps the glyph as legible over a busy
                    picture as the blur did. */}
                <a
                  href={src}
                  download={mediaFileName(src)}
                  title={t("chat.downloadImage")}
                  aria-label={t("chat.downloadImage")}
                  style={{
                    position: 'absolute', top: 6, right: 6,
                    width: 26, height: 26, borderRadius: 8,
                    background: 'rgba(0,0,0,0.62)', color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    textDecoration: 'none',
                  }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
                </a>
              </div>
            );
            })}
          </div>
        )}
        {bodyText ? (isUser ? shownText : renderText(bodyText, t("chat.table"), t("chat.detailsSummary"))) : null}
        {isLongUser && (
          <button
            type="button"
            data-testid="chat-user-expand"
            aria-expanded={expanded}
            onClick={() => onToggleExpand(longKey)}
            style={{
              display: 'block', marginTop: 6, background: 'none', border: 0,
              padding: 0, color: 'rgba(255,255,255,0.55)', cursor: 'pointer',
              font: 'inherit', fontSize: 12, textDecoration: 'underline',
            }}
          >
            {expanded ? t("chat.showLess") : t("chat.showMore")}
          </button>
        )}
        {msg.files && msg.files.length > 0 && (
          // Files the agent sent that no bubble can render inline: one
          // download card each (name, size, button). Keyed by URL.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: bodyText ? 8 : 0, minWidth: 0 }}>
            {msg.files.map(src => <ChatFileCard key={src} src={src} />)}
          </div>
        )}
        {msg.audio && msg.audio.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: bodyText ? 8 : 0 }}>
            {msg.audio.map((src) => (
              // The player and, under it, the two things a player
              // cannot say for itself: which voice spoke, when it was
              // not the one the owner picked, and that the browser
              // would not start it.
              <div key={src} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {/* ClawBox's own transport, not the browser's grey bar.
                  The customer's pick from the voice mockups (TASK-782,
                  A2): a play button, the clip's own waveform as the
                  scrub target, a clock and a download — because the one
                  thing people do with a spoken reply, scrub back four
                  seconds to catch a number, had a 3px track to aim at
                  in a 370px panel. Play, pause, seek and duration all
                  still work and are all still reachable from the
                  keyboard; see SpokenReplyPlayer for how.

                  `preload="metadata"` and the box's own media route,
                  which answers Range requests, are kept inside the
                  component: without the Range answers a custom
                  scrubber is exactly as dead as the browser's was.

                  Keyed by the URL: the harness names every file with a
                  uuid, so re-rendering a transcript cannot hand one
                  player another player's audio. */}
              <SpokenReplyPlayer
                src={src}
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
                label={audioLabel(bodyText, t("chat.audioReply"))}
                downloadName={mediaFileName(src)}
              />
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
              <EmailCard key={uid} uid={uid} onOpen={onOpenEmail} t={t} />
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
}

export const ChatMessageRow = memo(ChatMessageRowImpl, sameRowProps)

/**
 * The reply while it streams in — the same plain treatment the finished answer
 * gets, so nothing jumps when the turn lands.
 *
 * Memoised on the text for the reason the rows are: the reply has to be parsed
 * again on every chunk, but not on every keystroke the owner types while it
 * arrives, nor on every other render of the popup.
 */
export const StreamingReplyBubble = memo(function StreamingReplyBubble({ text, t }: { text: string; t: Translate }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={{
        width: '100%', padding: '2px 2px',
        color: 'rgba(255,255,255,0.88)',
        fontSize: 13.5, lineHeight: 1.5, wordBreak: 'break-word',
      }}>
        {/* Lifted out HERE, not on the way into state, so an interrupted
            turn keeps the directive and can still become cards. */}
        {renderText(streamingEmailRefsText(text), t("chat.table"), t("chat.detailsSummary"))}
        <span style={{ display: 'inline-block', width: 6, height: 14, background: '#f97316', borderRadius: 1, marginLeft: 2, animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom' }} />
        <style>{`@keyframes blink { 50% { opacity: 0 } }`}</style>
      </div>
    </div>
  )
})
