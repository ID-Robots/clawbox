'use client'

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, RefObject, SyntheticEvent } from 'react'
import {
  applySlashCommand,
  filterSlashCommands,
  slashQueryAt,
  type SlashCommand,
} from '@/lib/chat-slash-commands'
import type { HarnessAdapter, HarnessStatus } from '@/lib/harness/transport'

/**
 * The composer's slash-command autocomplete, as one hook, so the mascot chat
 * and the full-screen chat get the SAME behaviour rather than two of it.
 *
 * The house rule this follows (transport.ts): a chat feature is written once
 * and both surfaces get it. The two composers are duplicated markup — that is
 * pre-existing — but everything this feature knows lives here and in
 * `chat-slash-commands.ts`, so a surface's share of it is a `useSlashCommands`
 * call, three handlers on the textarea, and the menu.
 *
 * The CATALOGUE is the adapter's, which is the harness's. This hook decides
 * only when to ask for it.
 *
 * Nothing here is kept in step with an effect that writes state. What the menu
 * shows is DERIVED at render from the draft, the caret and the catalogue, and
 * every piece of remembered state is paired with what it belongs to — the
 * catalogue with the adapter that answered it, the highlight with the query it
 * was chosen under — so a stale pairing is simply not read. The cascading
 * re-render an effect-per-reset would cause is on a composer, where it would be
 * paid on every keystroke.
 */

export interface UseSlashCommandsOptions {
  /** Null until the harness resolves; the hook simply stays closed. */
  adapter: HarnessAdapter | null
  /** The transport's state. The catalogue is fetched once per `connected`. */
  status: HarnessStatus
  /** The composer's current draft and its setter. */
  value: string
  setValue: (next: string) => void
  /** The textarea the menu anchors to and whose caret is read. */
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** False while the composer is disabled, so the menu cannot outlive it. */
  enabled?: boolean
}

export interface UseSlashCommandsResult {
  /** Whether the popover should render. */
  open: boolean
  /** The filtered rows, already capped. */
  items: readonly SlashCommand[]
  activeIndex: number
  setActiveIndex: (index: number) => void
  listboxId: string
  optionId: (index: number) => string
  /** The row the textarea advertises as active, or undefined when closed. */
  activeOptionId: string | undefined
  accept: (command: SlashCommand) => void
  close: () => void
  /** The composer's `onChange`: sets the draft and tracks the caret. */
  handleChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  /** The composer's `onSelect`: the caret moved without the text changing. */
  handleSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void
  /**
   * Handle a key BEFORE the composer does. Returns true when the key was the
   * menu's — the caller returns immediately and never sends.
   */
  handleKeyDown: (event: ReactKeyboardEvent) => boolean
}

const NO_COMMANDS: readonly SlashCommand[] = []

/** Where the caret is, or the end of the text when the DOM cannot say. */
function caretOf(input: HTMLTextAreaElement | null, text: string): number {
  const position = input?.selectionStart
  return typeof position === 'number' ? position : text.length
}

export function useSlashCommands(options: UseSlashCommandsOptions): UseSlashCommandsResult {
  const { adapter, status, value, setValue, inputRef, enabled = true } = options
  /**
   * The catalogue, WITH the adapter that answered it.
   *
   * Paired rather than reset, so a harness swap cannot leave the other one's
   * commands on screen for the render between the swap and a reset effect —
   * the rows are simply not read once the adapter beside them is not the
   * current one.
   */
  const [catalogue, setCatalogue] = useState<{
    adapter: HarnessAdapter | null
    list: readonly SlashCommand[]
  }>({ adapter: null, list: NO_COMMANDS })
  /** The highlight, WITH the query it was chosen under. Same reasoning. */
  const [highlight, setHighlight] = useState<{ query: string; index: number }>({
    query: '',
    index: 0,
  })
  /**
   * The token the owner dismissed with Escape.
   *
   * The token itself rather than a boolean, so typing on re-opens the menu —
   * dismissing `/mo` must not silence `/mod` — and cleared by `handleChange`
   * the moment the draft stops being a command, so a dismissal cannot outlive
   * the message it was aimed at.
   */
  const [dismissed, setDismissed] = useState<string | null>(null)
  /**
   * The caret, WITH the draft it was measured against.
   *
   * Paired for the third time in this hook, and here it is load-bearing rather
   * than tidy: the draft is set from places that are not this composer's own
   * `onChange` — the mascot chat restores a per-tab draft on a tab switch, the
   * send path clears it — and a caret left over from the previous draft is a
   * caret pointing into text that no longer exists. Read against a different
   * draft it becomes -1, which `slashQueryAt` refuses, so "we do not know where
   * the caret is" opens no menu instead of opening one over the wrong token.
   */
  const [measured, setMeasured] = useState<{ value: string; caret: number }>({
    value: '',
    caret: 0,
  })
  const reactId = useId()
  const listboxId = `slash-menu-${reactId}`
  const optionId = useCallback((index: number) => `${listboxId}-${index}`, [listboxId])

  const commands = catalogue.adapter === adapter ? catalogue.list : NO_COMMANDS
  const caret = measured.value === value ? measured.caret : -1
  const query = enabled ? slashQueryAt(value, caret) : null
  const open = query !== null && query !== dismissed && commands.length > 0
  const items = useMemo(
    () => (query === null ? NO_COMMANDS : filterSlashCommands(commands, query)),
    [commands, query],
  )
  // A highlight chosen under another query belongs to that query; this one
  // starts at the top. Clamped too, because the list narrows as the owner
  // types and Enter must never point at a row that is no longer rendered.
  const activeIndex =
    highlight.query === (query ?? '') ? Math.min(highlight.index, Math.max(0, items.length - 1)) : 0

  /**
   * Fetch the catalogue once the transport is up, and AGAIN on every
   * reconnect.
   *
   * Re-fetching is the point rather than an afterthought: a command list read
   * once at startup and then believed for the life of the tab is exactly the
   * probe-once shape this codebase keeps producing. A box that installs a skill
   * gains a command, an update changes the set, and a gateway that restarted is
   * a different process — all three land on a reconnect, which is where this
   * asks again.
   *
   * A rejection stores an EMPTY list against this adapter rather than leaving
   * yesterday's: the adapter rejects only when it could not ASK, and offering
   * commands nothing has checked is the promise this feature exists not to
   * make.
   */
  useEffect(() => {
    if (!adapter || status !== 'connected') return
    let live = true
    adapter
      .listCommands()
      .then((next) => { if (live) setCatalogue({ adapter, list: next }) })
      .catch(() => { if (live) setCatalogue({ adapter, list: NO_COMMANDS }) })
    return () => { live = false }
  }, [adapter, status])

  const setActiveIndex = useCallback((index: number) => {
    setHighlight({ query: query ?? '', index })
  }, [query])

  const close = useCallback(() => { setDismissed(query) }, [query])

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value
    setValue(next)
    setMeasured({ value: next, caret: caretOf(event.target, next) })
    // A dismissal belongs to the command the owner was typing. Once the draft
    // is not one at all, the next `/` starts afresh — without this, Escape
    // silenced the menu for the rest of the tab's life.
    if (!next.startsWith('/')) setDismissed(null)
  }, [setValue])

  const handleSelect = useCallback((event: SyntheticEvent<HTMLTextAreaElement>) => {
    // The caret moved on its own — a click back into the token, Home, an
    // arrow. The draft has not changed, so nothing else here has to.
    const el = event.currentTarget
    setMeasured({ value: el.value, caret: caretOf(el, el.value) })
  }, [])

  const accept = useCallback((command: SlashCommand) => {
    const input = inputRef.current
    const next = applySlashCommand(value, caretOf(input, value), command)
    setValue(next.text)
    // A completed command is a CLOSED token: `/status` still parses as one the
    // caret is sitting in, so without this the menu stayed up over the finished
    // word and ate the Enter that was meant to send it — the command could be
    // picked and never sent. Dismissing the exact text, rather than clearing,
    // is what lets a backspace reopen the menu on the token it becomes.
    setDismissed(command.id)
    // The caret is KNOWN here — this call is what moves it — so it is recorded
    // now, against the text it belongs to, rather than read back after the
    // frame below. Waiting left the menu matching the old caret for a render,
    // which parsed a shorter token out of a draft that had already grown: the
    // menu stayed open over the finished command and the next Enter accepted it
    // again instead of sending.
    setMeasured({ value: next.text, caret: next.caret })
    // Focus never left, but the caret has to be put where the owner types
    // next — after the command, or after the space when it takes arguments.
    // Deferred one frame because React has not written `next.text` into the
    // DOM yet, and setting a range on the old value would clamp it.
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      try { el.setSelectionRange(next.caret, next.caret) } catch { /* detached */ }
    })
  }, [inputRef, setValue, value])

  const handleKeyDown = useCallback((event: ReactKeyboardEvent): boolean => {
    // An IME candidate window owns these keys while it is up; stealing Enter
    // from it would commit half a word as a message.
    if (event.nativeEvent && (event.nativeEvent as { isComposing?: boolean }).isComposing) {
      return false
    }
    if (!open) return false
    // Escape belongs to the menu whenever the menu is up, INCLUDING when the
    // filter matched nothing: that state still renders a popover, and an
    // Escape that fell through it would close the whole chat window instead of
    // the thing the owner was looking at.
    if (event.key === 'Escape') {
      event.preventDefault()
      // The mascot chat closes on a window-level Escape registered when it
      // opened, which runs whatever this handler does. Stopping it here is
      // what keeps Escape meaning "close the menu" while the menu is up.
      event.stopPropagation()
      event.nativeEvent?.stopImmediatePropagation?.()
      close()
      return true
    }
    if (items.length === 0) return false
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((activeIndex + 1) % items.length)
        return true
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((activeIndex - 1 + items.length) % items.length)
        return true
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        return true
      case 'End':
        event.preventDefault()
        setActiveIndex(items.length - 1)
        return true
      case 'Enter':
      case 'Tab': {
        // Shift+Enter is the composer's newline and stays the composer's.
        if (event.key === 'Enter' && event.shiftKey) return false
        const picked = items[activeIndex]
        if (!picked) return false
        event.preventDefault()
        accept(picked)
        return true
      }
      default:
        return false
    }
  }, [accept, activeIndex, close, items, open, setActiveIndex])

  return {
    open,
    items,
    activeIndex,
    setActiveIndex,
    listboxId,
    optionId,
    activeOptionId: open && items.length > 0 ? optionId(activeIndex) : undefined,
    accept,
    close,
    handleChange,
    handleSelect,
    handleKeyDown,
  }
}
