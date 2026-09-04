"use client";

import { useEffect, useRef, useState } from "react";
import { I18nProvider, useT } from "@/lib/i18n";

/**
 * The screen the owner sees while an update owns the box.
 *
 * The middleware sends every desktop navigation here for as long as the update
 * lock is set (src/lib/update-lock.ts), so this is a lock and not a courtesy
 * banner: `updateClawBoxAndReboot` runs `git reset --hard` and `git clean -fd`
 * over the project, and an app left open on the desktop can write through
 * /setup-api into the tree being rewritten underneath it.
 *
 * Three things it must get right, in order of how badly each one bites:
 *
 *  1. FAIL CLOSED. Partway through, do_rebuild stops the web server and the box
 *     serves nothing for minutes. A poll failing is the NORMAL course of an
 *     update, not evidence it ended — so a failed poll must never take this
 *     screen down. It is the exact inverse of the usual rule.
 *  2. NEVER TRAP THE OWNER. If the update dies, "no answer" would hold this
 *     screen for ever with no way back to Settings. After the rebuild's own
 *     budget plus a margin, it says so and offers the way out.
 *  3. SAY WHAT IS TRUE. While the box answers, it names the step the server
 *     reports. While it does not, it says the device is restarting — and does
 *     not pretend to know how far along it is, because nothing is reporting.
 */

/** The rebuild's own budget (REBUILD_TAKEOVER_TIMEOUT_MS) plus room to reboot. */
const STUCK_AFTER_MS = 20 * 60 * 1000;
const POLL_MS = 2000;

interface Step { id: string; label: string; status: string }
interface UpdateStatus { phase?: string; steps?: Step[]; error?: string }

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function UpdatingScreen() {
  const { t } = useT();
  /**
   * Translated when the catalogue is there, English when it is not — never the
   * raw key.
   *
   * I18nProvider loads translations in an effect, through a dynamic import, so
   * the server always renders keys and the client fills them in. Every other
   * page can rely on that. This one cannot: it is the ONE screen guaranteed to
   * be open while the box is offline, and i18n.tsx says so itself — "a chunk
   * load can fail ... the device is offline mid-update ... keep whatever copy is
   * already in state (English, or the raw keys on a first load)". Raw keys for
   * the length of an outage is not an acceptable answer here.
   */
  const tr = (key: string, english: string) => {
    const value = t(key);
    return value === key ? english : value;
  };
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Not Date.now() arithmetic across a reboot — this clock only ever measures
  // how long THIS page has been open, in one process, on the viewer's device.
  const openedAt = useRef(Date.now());

  useEffect(() => {
    const tick = window.setInterval(() => setElapsed(Date.now() - openedAt.current), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch("/setup-api/update/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as UpdateStatus;
        if (stop) return;
        setOffline(false);
        setStatus(data);
        // The lock is the middleware's to release. Asking for the desktop again
        // is what tests it: while the flag is still set we are simply sent
        // back here, and the moment it clears the desktop loads.
        if (data.phase && data.phase !== "running") window.location.replace("/");
      } catch {
        // Expected, and for minutes at a time: the rebuild stops the server.
        // Hold the screen.
        if (!stop) setOffline(true);
      }
    };
    void poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => { stop = true; window.clearInterval(id); };
  }, []);

  const running = status?.steps?.find((s) => s.status === "running");
  const done = status?.steps?.filter((s) => s.status === "completed").length ?? 0;
  const total = status?.steps?.length ?? 0;
  const stuck = elapsed > STUCK_AFTER_MS;

  return (
    <main
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-base,#0b1220)] px-6"
      data-testid="updating-page"
      aria-live="polite"
    >
      <div className="w-full max-w-md text-center">
        <div
          className="mx-auto mb-6 h-14 w-14 rounded-full border-2 border-white/15 border-t-white/70 animate-spin"
          aria-hidden="true"
        />
        <h1 className="text-xl font-semibold text-[var(--text-primary,#fff)]">{tr("update.title", "System Update")}</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary,#9aa4b2)]">
          {tr("update.updatingDescription", "Updating your ClawBox with the latest software...")}
        </p>

        {/* What the box last told us. A step count, never a percentage of time. */}
        {total > 0 && (
          <p className="mt-4 text-xs font-mono text-[var(--text-muted,#6b7280)]" data-testid="updating-step">
            {running?.label ?? tr("update.preparingUpdate", "Preparing update...")} · {done}/{total}
          </p>
        )}

        {offline && !stuck && (
          <p className="mt-4 text-xs text-[var(--text-muted,#6b7280)]" data-testid="updating-offline">
            {/* Deliberately not a claim about progress: nothing is reporting. */}
            The device is restarting and is not answering yet. This screen will
            return to the desktop on its own.
          </p>
        )}

        <p className="mt-4 text-xs tabular-nums text-[var(--text-muted,#6b7280)]" data-testid="updating-elapsed">
          {clock(elapsed)}
        </p>

        {stuck && (
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left">
            <p className="text-xs text-amber-200" data-testid="updating-stuck">
              {/*
                Deliberately NOT a link back to the desktop. While the lock is
                set the middleware would redirect any such navigation straight
                back here, so a button offering escape would simply not work.
                The real way out is a restart: at boot the updater looks for an
                update to resume, finds none, and releases the lock
                (resumeContinuation in src/lib/updater.ts) — so this says the
                thing that is actually true.
              */}
              This is taking longer than an update usually does. Nothing has been
              lost. If the device does not come back on its own, restart it — the
              desktop unlocks by itself on the next start.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * The provider is mounted HERE, not inherited.
 *
 * The root layout is a server component and mounts no I18nProvider, and
 * `useT()` without one returns a fallback that renders the KEY — this screen
 * would have shown a literal "update.title" to the owner. /login and
 * /app/[id] each mount their own for exactly this reason; this is the third.
 */
export default function UpdatingPage() {
  return (
    <I18nProvider>
      <UpdatingScreen />
    </I18nProvider>
  );
}
