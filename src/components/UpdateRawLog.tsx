"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTr } from "@/lib/i18n-floor";
import { getTerminalSettings, loadTerminalSettings, terminalThemeFor } from "@/lib/terminal-settings";
import { copyToClipboard } from "@/lib/terminal-clipboard";
import { XTERM_LOOK, loadXtermModules, terminalBufferText, xtermLiveOptions } from "@/lib/xterm-setup";
import "@xterm/xterm/css/xterm.css";

/**
 * The update's RAW log behind the update screen's terminal button (TASK-2428):
 * a small read-only terminal, drawn the way the Terminal app draws one (the
 * same xterm setup and theme, src/lib/xterm-setup.ts), showing every byte the
 * update's steps printed — install.sh, apt, npm, pip, the build — colours and
 * progress bars as they were sent.
 *
 * The bytes come from `/setup-api/update/log` as Server-Sent Events, followed
 * live. The browser's EventSource sends the last event id back when it
 * reconnects, so the web server being replaced by the update's own rebuild
 * costs a pause, not a line. Scrolled up, the panel stays where the owner put
 * it and offers the way back to the newest output; Copy takes the selection or
 * the whole log, and the download is the file on the box.
 */

type XTerm = import("@xterm/xterm").Terminal;
type XFitAddon = import("@xterm/addon-fit").FitAddon;

export const UPDATE_LOG_STREAM = "/setup-api/update/log";

export type RawLogStatus = "connecting" | "live" | "reconnecting" | "ended" | "none" | "unavailable";

const SETTINGS_WAIT_MS = 1500;
const COPIED_MS = 1500;
/** While a run is going on and the stream shows an ended one, how often it asks again. */
const RECONNECT_ENDED_MS = 3000;
/** At least this much scrollback, whatever the Terminal app's own setting: a rebuild prints thousands of lines. */
const MIN_SCROLLBACK = 50_000;
/** Hide the cursor: nothing is typed here. */
const HIDE_CURSOR = "\x1b[?25l";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
  ]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

function atBottom(term: XTerm): boolean {
  const buffer = term.buffer.active;
  return buffer.viewportY >= buffer.baseY;
}

export default function UpdateRawLog({
  id,
  label,
  live,
}: {
  id: string;
  /** The panel's accessible name. */
  label: string;
  /** A run is going on now: a stream that already ended is opened again for it. */
  live: boolean;
}) {
  const tr = useTr();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const runRef = useRef<string | null>(null);
  /** The last event id received: `<run>:<offset>` of the bytes on screen. */
  const lastIdRef = useRef<string | null>(null);
  const followRef = useRef(true);
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<RawLogStatus>("connecting");
  const [runId, setRunId] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [copied, setCopied] = useState(false);
  const [ground, setGround] = useState<string | undefined>(undefined);

  const write = useCallback((text: string) => {
    const term = termRef.current;
    if (!term) return;
    term.write(text, () => {
      if (followRef.current) term.scrollToBottom();
    });
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current || typeof EventSource === "undefined") {
      if (typeof EventSource === "undefined") setStatus("unavailable");
      return;
    }
    sourceRef.current?.close();
    setStatus("connecting");
    // Asked again (a run started while this showed the last one's end): from
    // the byte already on screen, so the same run is not drawn twice.
    const after = lastIdRef.current;
    const source = new EventSource(after ? `${UPDATE_LOG_STREAM}?after=${encodeURIComponent(after)}` : UPDATE_LOG_STREAM);
    sourceRef.current = source;
    const mine = () => sourceRef.current === source && mountedRef.current;
    // A new stream starts at byte 0 unless it was asked to continue; the
    // browser's own reconnect of this one resumes where it was. Either way a
    // different run is drawn from a clean screen.
    let first = after === null;
    source.addEventListener("run", (event) => {
      if (!mine()) return;
      let next: string | null = null;
      try { next = (JSON.parse((event as MessageEvent).data) as { id?: string }).id ?? null; } catch { /* no id */ }
      if (first || (runRef.current !== null && next !== runRef.current)) {
        termRef.current?.reset();
        termRef.current?.write(HIDE_CURSOR);
        followRef.current = true;
        setFollowing(true);
      }
      first = false;
      runRef.current = next;
      setRunId(next);
      setStatus("live");
    });
    source.onmessage = (event) => {
      if (!mine()) return;
      if (event.lastEventId) lastIdRef.current = event.lastEventId;
      try {
        write(JSON.parse(event.data) as string);
      } catch { /* not a chunk */ }
    };
    source.addEventListener("end", () => {
      if (!mine()) return;
      source.close();
      setStatus("ended");
    });
    source.addEventListener("none", () => {
      if (mine()) setStatus("none");
    });
    source.onopen = () => {
      if (mine()) setStatus((was) => (was === "reconnecting" ? (runRef.current ? "live" : "connecting") : was));
    };
    source.onerror = () => {
      if (!mine()) return;
      // CLOSED: refused (signed out, not the owner) and not retried. Otherwise
      // the browser is already reconnecting, with the last event id.
      setStatus(source.readyState === EventSource.CLOSED ? "unavailable" : "reconnecting");
    };
  }, [write]);

  useEffect(() => {
    mountedRef.current = true;
    let resize: ResizeObserver | null = null;
    let disposed = false;
    void (async () => {
      await withTimeout(loadTerminalSettings(), SETTINGS_WAIT_MS).catch(() => undefined);
      let modules: Awaited<ReturnType<typeof loadXtermModules>>;
      try {
        modules = await loadXtermModules();
      } catch {
        if (!disposed) setStatus("unavailable");
        return;
      }
      const container = containerRef.current;
      if (disposed || !container) return;
      const settings = getTerminalSettings();
      setGround(terminalThemeFor(settings.theme).colors.background);
      const { Terminal, FitAddon, WebLinksAddon, Unicode11Addon } = modules;
      const term = new Terminal({
        ...xtermLiveOptions(settings),
        ...XTERM_LOOK,
        // A log, not a shell: nothing typed goes anywhere, a bare \n is a new
        // line (as on a console), and the cursor is not drawn.
        disableStdin: true,
        convertEol: true,
        cursorBlink: false,
        scrollback: Math.max(settings.scrollback, MIN_SCROLLBACK),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      if (Unicode11Addon) {
        try {
          term.loadAddon(new Unicode11Addon());
          term.unicode.activeVersion = "11";
        } catch { /* xterm's own widths */ }
      }
      // Copy is the one key the panel answers: the selection, as the Terminal app copies it.
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        const copyKey = (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c";
        if (copyKey && ev.type === "keydown") {
          const selected = term.getSelection();
          if (selected) {
            ev.preventDefault();
            void copyToClipboard(selected);
            return false;
          }
        }
        return true;
      });
      term.open(container);
      termRef.current = term;
      fitRef.current = fit;
      try { fit.fit(); } catch { /* not laid out yet */ }
      term.write(HIDE_CURSOR);
      // Scrolled away from the bottom: new output no longer moves the view.
      term.onScroll(() => {
        const bottom = atBottom(term);
        followRef.current = bottom;
        setFollowing(bottom);
      });
      if (typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(() => {
          try { fit.fit(); } catch { /* hidden */ }
        });
        resize.observe(container);
      }
      connect();
    })();
    return () => {
      disposed = true;
      mountedRef.current = false;
      resize?.disconnect();
      sourceRef.current?.close();
      sourceRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [connect]);

  // While a run goes on, a stream that stopped is asked for again, unhurried,
  // from the byte on screen: one that showed the end of the LAST run (until
  // the new run's log is the newest), and one the browser gave up on — a web
  // server half-way through its restart can answer with an error page, which
  // ends an EventSource for good.
  useEffect(() => {
    if (!live || (status !== "ended" && status !== "unavailable") || !termRef.current) return;
    const timer = setTimeout(connect, RECONNECT_ENDED_MS);
    return () => clearTimeout(timer);
  }, [live, status, connect]);

  const jumpToLatest = () => {
    followRef.current = true;
    setFollowing(true);
    termRef.current?.scrollToBottom();
  };

  const copy = () => {
    const term = termRef.current;
    if (!term) return;
    let text = term.getSelection();
    if (!text) {
      try { text = terminalBufferText(term); } catch { text = ""; }
    }
    void copyToClipboard(text).then((ok) => {
      if (!ok || !mountedRef.current) return;
      setCopied(true);
      setTimeout(() => { if (mountedRef.current) setCopied(false); }, COPIED_MS);
    });
  };

  const statusText: Record<RawLogStatus, string> = {
    connecting: tr("update.connecting", "Connecting…"),
    live: tr("update.rawLogLive", "Live"),
    reconnecting: tr("update.rawLogReconnecting", "Reconnecting…"),
    ended: tr("update.rawLogEnded", "Run ended"),
    none: tr("update.rawLogNone", "No update has written a log on this box yet."),
    unavailable: tr("update.rawLogUnavailable", "The update log could not be opened."),
  };
  const dot = status === "live" ? "bg-emerald-400" : status === "reconnecting" || status === "connecting" ? "bg-amber-300" : "bg-gray-500";
  const downloadHref = `${UPDATE_LOG_STREAM}?download=1${runId ? `&run=${encodeURIComponent(runId)}` : ""}`;
  const button = "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-[var(--r-1)] px-2 py-1 text-[var(--text-muted)] hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)]";

  return (
    <section
      id={id}
      aria-label={label}
      className="us-full-log mt-4 flex flex-col overflow-hidden rounded-[var(--r-1)] border border-[var(--border-subtle)] bg-[var(--bg-deep)]"
      data-testid="update-raw-log"
      data-status={status}
    >
      <div className="us-raw-head flex min-w-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)]">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" role="status" data-testid="update-raw-log-status">{statusText[status]}</span>
        {!following && (
          <button type="button" onClick={jumpToLatest} className={`${button} text-amber-200`} data-testid="update-raw-log-follow">
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: "calc(14em / 11)" }}>vertical_align_bottom</span>
            {tr("update.rawLogFollow", "Paused · jump to latest")}
          </button>
        )}
        <button type="button" onClick={copy} className={button} data-testid="update-raw-log-copy">
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: "calc(14em / 11)" }}>{copied ? "check" : "content_copy"}</span>
          {copied ? tr("update.rawLogCopied", "Copied") : tr("update.rawLogCopy", "Copy")}
        </button>
        {status !== "none" && status !== "unavailable" && (
          <a href={downloadHref} download className={`${button} no-underline`} data-testid="update-raw-log-download">
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: "calc(14em / 11)" }}>download</span>
            {tr("update.rawLogDownload", "Download log")}
          </a>
        )}
      </div>
      <div
        ref={containerRef}
        className="us-raw-term h-[240px] min-h-0 px-2 py-1"
        style={ground ? { backgroundColor: ground } : undefined}
        data-testid="update-raw-log-terminal"
      />
    </section>
  );
}
