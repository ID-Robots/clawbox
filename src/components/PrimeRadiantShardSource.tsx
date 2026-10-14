"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { dispatchOpenApp } from "@/lib/ui-events";
import { BTN_SECONDARY } from "./coding-agent-ui";
import { API, PRODUCT_NAME, type PrimeRadiantStatus } from "./prime-radiant-ui";

/**
 * One line on Memory Shard's home: the Prime Radiant wiki is one of the
 * sources it searches, with the page count and a way into the wiki app.
 *
 * Drawn only once the wiki exists — the status read creates nothing, and a
 * box that never opened Prime Radiant has no wiki for Memory Shard to search.
 * A server that predates Prime Radiant answers 404, and the line simply is
 * not drawn.
 */
export default function PrimeRadiantShardSource() {
  const { t } = useT();
  const [pages, setPages] = useState<number | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`${API}/status`, { cache: "no-store", signal: ctl.signal })
      .then((res) => (res.ok ? (res.json() as Promise<PrimeRadiantStatus>) : null))
      .then((s) => {
        if (s && s.initialised === true && typeof s.vault?.pages === "number") setPages(s.vault.pages);
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, []);

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
      <button type="button" className={BTN_SECONDARY} onClick={() => dispatchOpenApp("prime-radiant")}>
        {t("primeRadiant.shardSourceOpen")}
      </button>
    </div>
  );
}
