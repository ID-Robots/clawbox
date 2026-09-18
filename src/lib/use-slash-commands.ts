'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
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
 * Almost nothing here is kept in step with an effect that writes state. What
 * the menu shows is DERIVED at render from the draft, the caret and the
 * catalogue, and every piece of remembered state is paired with what it belongs
 * to — the catalogue with the adapter that answered it, the highlight with the
 * query it was chosen under — so a stale pairing is simply not read. The
 * cascading re-render an effect-per-reset would cause is on a composer, where
 * it would be paid on every keystroke.
 *
 * A dismissal is the one thing a pairing cannot express, because the same token
 * typed twice IS the same token; it is cleared in `handleChange` instead, from
 * the draft the keystroke arrived over.
 */

export interface UseSlashCommandsOptions {
  /** Null until the harness resolves; the hook simply stays closed. */
  adapter: HarnessAdapter | null
  /**
   * The transport's state. A catalogue is read on `connected` — and again on
   * the triggers below, because on an edition with no socket `connected` is
   * reached exactly once per mount.
   */
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

/**
 * How long a catalogue that WAS read stays fresh before a surface coming back
 * into view asks again. A box gains a command when a skill is installed, and on
 * a harness with no socket nothing else would ever say so.
 */
const CATALOGUE_STALE_MS = 60_000
/**
 * The waits after a FAILED read, in order; the length is the budget. Bounded so
 * a box whose dashboard is down is not asked once a second for the life of the
 * tab, and short enough that a dashboard restarting while the chat mounts is
 * picked up before the owner has finished reading the greeting.
 *
 * A read that fails past the last one is not the end of it: the visibility and
 * focus trigger below re-asks with no timestamp to hold it back, because a
 * failure records none.
 */
const CATALOGUE_RETRY_DELAYS_MS = [1_000, 4_000, 12_000]

/**
 * What marks the popover in the DOM, for the outside-pointer dismissal below.
 * `SlashCommandMenu` puts it on its root; the menu is portaled to `<body>`, so
 * containment is the only way to tell a click on it from a click away from it.
 */
export const SLASH_MENU_ATTRIBUTE = 'data-slash-menu'

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
   * Ask for the catalogue, and ask AGAIN — on a reconnect, on a failure, and on
   * the owner coming back to a surface that has been sitting there.
   *
   * Re-asking is the point rather than an afterthought: a command list read
   * once at startup and then believed for the life of the tab is exactly the
   * probe-once shape this codebase keeps producing. On OpenClaw a reconnect
   * covers it — a gateway that restarted is a different process, and `status`
   * really does cycle `connecting → connected`.
   *
   * ON HERMES THERE IS NO RECONNECT. That adapter's `connect()` emits
   * `'connected'` once and returns (`capabilities.hasLiveConnection === false`),
   * so `status` never leaves it and this effect would run exactly once per
   * mount. A box whose dashboard was slow or restarting at that moment answered
   * nothing, `commands` stayed empty, `open` requires a non-empty catalogue —
   * and the full-screen chat, which never unmounts, had no slash menu for the
   * rest of the page's life with nothing on screen saying why. (The mascot chat
   * only recovered because `ChatPopup` unmounts when it closes.) So the two
   * triggers below are not belt-and-braces on that edition, they ARE the
   * re-read: a bounded retry after a failure, and a re-ask when the surface
   * comes back into view over a catalogue older than `CATALOGUE_STALE_MS`.
   *
   * A rejection stores an EMPTY list against this adapter rather than leaving
   * yesterday's: the adapter rejects only when it could not ASK, and offering
   * commands nothing has checked is the promise this feature exists not to
   * make. It also records no read time, which is what lets the next focus ask
   * again immediately.
   */
  const [reload, setReload] = useState(0)
  /** When the catalogue was last ANSWERED. 0 while nothing has been. */
  const readAtRef = useRef(0)
  /** Failures since the last answer, indexing `CATALOGUE_RETRY_DELAYS_MS`. */
  const failuresRef = useRef(0)
  /** The adapter the two counters above belong to. */
  const countedRef = useRef<HarnessAdapter | null>(null)

  useEffect(() => {
    if (!adapter || status !== 'connected') return
    // A different harness is a different catalogue and a different budget.
    if (countedRef.current !== adapter) {
      countedRef.current = adapter
      readAtRef.current = 0
      failuresRef.current = 0
    }
    let live = true
    let retry: ReturnType<typeof setTimeout> | undefined
    adapter
      .listCommands()
      .then((next) => {
        if (!live) return
        readAtRef.current = Date.now()
        failuresRef.current = 0
        setCatalogue({ adapter, list: next })
      })
      .catch(() => {
        if (!live) return
        setCatalogue({ adapter, list: NO_COMMANDS })
        const delay = CATALOGUE_RETRY_DELAYS_MS[failuresRef.current]
        failuresRef.current += 1
        if (delay === undefined) return
        retry = setTimeout(() => setReload((n) => n + 1), delay)
      })
    return () => {
      live = false
      if (retry !== undefined) clearTimeout(retry)
    }
  }, [adapter, status, reload])

  /**
   * The surface coming back into view is the other trigger, and on Hermes the
   * only one that survives the retry budget.
   *
   * Throttled on the last ANSWER rather than on the last attempt: a catalogue
   * read a moment ago is not re-read because the owner alt-tabbed, while one
   * that never landed has no timestamp to hold it back and is asked for at once.
   */
  useEffect(() => {
    if (!adapter || status !== 'connected' || typeof document === 'undefined') return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - readAtRef.current < CATALOGUE_STALE_MS) return
      setReload((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [adapter, status])

  const setActiveIndex = useCallback((index: number) => {
    setHighlight({ query: query ?? '', index })
  }, [query])

  const close = useCallback(() => { setDismissed(query) }, [query])

  /**
   * A pointer that lands anywhere but the composer and the popover closes it.
   *
   * The menu is portaled to `<body>`, `position: fixed`, `z-index: 10050`, and
   * `open` is derived from the draft, the caret and the catalogue — never from
   * focus. So in the full-screen chat, typing `/st` and then clicking into the
   * transcript left it hanging over whatever the owner was now reading, still
   * taking pointer events. The mascot chat only hid it because `ChatPopup`
   * unmounts wholesale.
   *
   * CAPTURE phase, because the popover's own rows cancel the event to keep the
   * caret in the composer; both it and the anchor are excluded by containment,
   * so accepting a row is not read as clicking away from it. Dismissing the
   * token — rather than clearing — is Escape's own mechanism, which is what
   * lets typing on bring the menu back.
   */
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null
      if (!target) return
      if (inputRef.current?.contains(target)) return
      // By attribute rather than by the listbox's id: `useId` produces a value
      // with characters a CSS selector would have to escape, and the popover is
      // this hook's own component either way.
      if (target instanceof Element && target.closest(`[${SLASH_MENU_ATTRIBUTE}]`)) return
      setDismissed(query)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, query, inputRef])

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value
    setValue(next)
    setMeasured({ value: next, caret: caretOf(event.target, next) })
    // A dismissal belongs to the command the owner was typing. Once the draft
    // is not one at all, the next `/` starts afresh — without this, Escape
    // silenced the menu for the rest of the tab's life.
    if (!next.startsWith('/')) setDismissed(null)
    // …and it belongs to the MESSAGE it was typed in. The send path clears the
    // draft DIRECTLY (`ChatApp`'s and `ChatPopup`'s own `setInput('')`), never
    // through this handler, so a dismissal used to outlive its message:
    // accepting `/status` from the menu dismisses that exact token, and after
    // sending it, typing `/status` again by hand opened no menu at all.
    //
    // `value` is the draft as it stood when this keystroke arrived. Empty means
    // this character is the first of a NEW message, so whatever was dismissed
    // belonged to the last one. Read here rather than reset from an effect
    // watching the draft: an effect that writes state on every clear is a
    // cascading render on the composer, and this costs nothing.
    //
    // The stale CARET needs no such rule — `measured` is paired with the draft
    // it was taken against, so after a send it simply stops being read, and the
    // line above has already replaced it.
    else if (value === '') setDismissed(null)
  }, [setValue, value])

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
