"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { dispatchOpenApp, onStandaloneAppPage, standaloneAppHref } from "@/lib/ui-events";
import { BTN_SECONDARY } from "./coding-agent-ui";
import { API, PRIME_RADIANT_CHANGED_EVENT, PRODUCT_NAME, type PrimeRadiantStatus } from "./prime-radiant-ui";

/**
 * One line on Memory Shard's home: the Prime Radiant wiki is one of the
 * sources it searches, with the page count and a way into the wiki app.
 *
 * Drawn only once the wiki exists — the status read creates nothing, and a
 * box that never opened Prime Radiant has no wiki for Memory Shard to search.
 * A server that predates Prime Radiant answers 404, and the line simply is
 * not drawn.
 *
 * Read again when the window comes back into view and when a Prime Radiant
 * window on this desktop makes or changes the vault, so a Memory Shard window
 * that was open before the wiki existed does not keep leaving it out.
 */
export default function PrimeRadiantShardSource() {
  const { t } = useT();
  const [pages, setPages] = useState<number | null>(null);

  useEffect(() => {
    let ctl: AbortController | null = null;
    const read = () => {
      ctl?.abort();
      const mine = new AbortController();
      ctl = mine;
      fetch(`${API}/status`, { cache: "no-store", signal: mine.signal })
        .then((res) => (res.ok ? (res.json() as Promise<PrimeRadiantStatus>) : null))
        .then((s) => {
          if (mine.signal.aborted || !s) return;
          if (s.initialised === true && typeof s.vault?.pages === "number") setPages(s.vault.pages);
          else if (s.initialised === false) setPages(null);
        })
        .catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    read();
    window.addEventListener(PRIME_RADIANT_CHANGED_EVENT, read);
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ctl?.abort();
      window.removeEventListener(PRIME_RADIANT_CHANGED_EVENT, read);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const open = () => {
    // `/app/memory-shard` has no desktop listening for the open-app event.
    if (onStandaloneAppPage()) window.location.assign(standaloneAppHref("prime-radiant"));
    else dispatchOpenApp("prime-radiant");
  };

  if (pages === null) return null;
  return (
    <div
      className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-black/20 border border-white/[0.07] px-4 py-3 text-xs"
      data-testid="memory-shard-prime-radiant-source"
    >
      <span className="flex items-center gap-2 min-w-0 text-[var(--text-secondary)]">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }} aria-hidden="true">auto_stories</span>
        <span className="truncate">{t("primeRadiant.shardSource", { name: PRODUCT_NAME, n: pages })}</span>
      </span>
      <button type="button" className={BTN_SECONDARY} onClick={open} data-testid="memory-shard-prime-radiant-open">
        {t("primeRadiant.shardSourceOpen")}
      </button>
    </div>
  );
}
