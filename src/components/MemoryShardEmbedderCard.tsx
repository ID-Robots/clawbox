"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { readInstallStream } from "@/lib/install-stream";
import {
  cloudEmbedderPickable,
  cloudUnavailableNoteKey,
  type EmbedderChoiceStatus,
  type EmbeddingSource,
  parseEmbedderChoiceStatus,
} from "@/lib/memory-shard-state";
import { notifyMemoryShardChanged } from "@/lib/ui-events";
import StatusMessage from "./StatusMessage";
import { CARD, SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";

/**
 * Where Memory Shard's index is embedded: the ClawBox AI cloud, or the model on
 * this box (the owner's ask, 2026-09-15).
 *
 * A switch that costs something either way, and the card says so before it is
 * pressed: the model on this box may first be a ~640 MB download, and moving
 * the index in either direction changes what its vectors belong to, so every
 * switch is followed by a FULL pass — the same rebuild the wizard asks for.
 * Nothing here is optimistic: the choice drawn is always the one the route
 * re-reads after the write.
 */

type Phase = "idle" | "downloading" | "switching" | "switched";

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : "";
}

export default function MemoryShardEmbedderCard() {
  const { t } = useT();
  const [status, setStatus] = useState<EmbedderChoiceStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/clawkeep/memory/provider", { cache: "no-store" });
      const parsed = parseEmbedderChoiceStatus(res.ok ? await res.json() : null);
      // A read that failed keeps the last answer the box gave rather than
      // blanking the card or inventing one.
      if (live.current && parsed) setStatus(parsed);
    } catch {
      // A box that cannot say keeps the card out of the way rather than
      // drawing a choice it cannot back.
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // An older server, or a read that failed: there is no choice to draw.
  if (!status) return null;
  const busy = phase === "downloading" || phase === "switching";

  const choose = async (next: EmbeddingSource) => {
    if (busy || next === status.source) return;
    setError(null);
    setDetail(null);
    try {
      if (next === "local" && !status.localInstalled) {
        setPhase("downloading");
        const pull = await fetch("/setup-api/embed/install", { method: "POST" });
        if (!pull.ok) throw new Error(await refusal(pull));
        const outcome = await readInstallStream(pull, (progress) => {
          if (progress.status && live.current) setDetail(progress.status);
        });
        if (!outcome.ok) throw new Error(outcome.error || t("clawkeep.memory.setup.pullFailed"));
      }
      setPhase("switching");
      setDetail(null);
      const res = await fetch("/setup-api/clawkeep/memory/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: next }),
      });
      if (!res.ok) throw new Error(await refusal(res));
      // A FULL pass: the index belongs to the embedder that wrote it, and the
      // core pauses vector search over one built for another until it is
      // rebuilt. A 409 is a pass already running, or a switched-off feature —
      // the switch itself has landed either way.
      const index = await fetch("/setup-api/clawkeep/memory/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      });
      if (!index.ok && index.status !== 409) throw new Error(t("clawkeep.memory.startFailed"));
      notifyMemoryShardChanged();
      if (live.current) setPhase("switched");
    } catch (err) {
      if (live.current) {
        setPhase("idle");
        setError(err instanceof Error && err.message ? err.message : t("clawkeep.memory.embedder.failed"));
      }
    } finally {
      await load();
    }
  };

  return (
    <div className={CARD} data-testid="memory-shard-embedder-card">
      <div className="flex items-center gap-2">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">hub</span>
        <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("clawkeep.memory.embedder.title")}
        </span>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">{t("clawkeep.memory.embedder.hint")}</p>

      <div className={`${SEGMENTED_TRACK} mt-3`} role="radiogroup" aria-label={t("clawkeep.memory.embedder.title")}>
        {(["cloud", "local"] as const).map((option) => {
          // Moving ONTO the cloud needs it to be on offer here; a box already
          // on it can always be taken back to the model on this box. The rule
          // itself is shared with the wizard's step 3, which had its own copy.
          const blocked = option === "cloud" && !cloudEmbedderPickable(status);
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={status.source === option}
              disabled={busy || blocked}
              onClick={() => void choose(option)}
              data-testid={`memory-shard-embedder-${option}`}
              className={`${status.source === option ? SEGMENT_ON : SEGMENT_OFF} disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {t(`clawkeep.memory.embedder.${option}`)}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]" data-testid="memory-shard-embedder-hint">
        {t(status.source === "cloud" ? "clawkeep.memory.embedder.cloudHint" : "clawkeep.memory.embedder.localHint")}
      </p>
      {/* This branch is unreachable against any server on this branch — the
          route hard-codes `cloudSupported: true` since 2026-09-18 — and is kept
          for the two cases that can still produce a false: an OLDER server this
          page is talking to across an update, and the build-time kill switch
          `CloudDefaultsFacts.embeddingsSupported` documents. Its string is in
          all ten locales; deleting the branch would mean writing it back under
          whichever of those happened first. */}
      {!status.cloudSupported ? (
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]" data-testid="memory-shard-embedder-cloud-unsupported">
          {t("clawkeep.memory.embedder.cloudUnsupported")}
        </p>
      ) : !cloudEmbedderPickable(status) ? (
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]" data-testid="memory-shard-embedder-cloud-unavailable">
          {t(cloudUnavailableNoteKey(status.cloudReason))}
        </p>
      ) : null}

      {busy && (
        <div className="mt-3 flex items-center gap-2" role="status" data-testid="memory-shard-embedder-progress">
          <span aria-hidden="true" className="inline-block w-3 h-3 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent motion-safe:animate-spin" />
          <span className="text-xs text-[var(--text-secondary)]">
            {t(phase === "downloading" ? "clawkeep.memory.embedder.downloading" : "clawkeep.memory.embedder.switching")}
          </span>
        </div>
      )}
      {busy && detail && <p className="mt-1.5 font-mono text-[10px] text-[var(--text-muted)] truncate">{detail}</p>}
      {phase === "switched" && (
        <p className="mt-3 text-[11px] text-emerald-400" role="status" data-testid="memory-shard-embedder-switched">
          {t("clawkeep.memory.embedder.switched")}
        </p>
      )}
      {error && <StatusMessage type="error" message={error} />}
    </div>
  );
}
