"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import { formatBytes } from "@/lib/format-bytes";
import {
  unreachableSparks,
  type ClusterAnswer,
  type ClusterSnapshot,
  type EngineView,
  type SparkCard,
  type SparkFailure,
} from "@/lib/cluster-shared";

/**
 * Settings → System → Cluster (TASK-2670): one card per Spark of a ClawBox
 * Workstation, the engine's load, and a banner when a Spark cannot be reached.
 * The owner's only: the tab that opens this is drawn for the owner of a box that
 * has a cluster, and the route behind it answers anyone else 403.
 *
 * The System page's own figures are THIS Spark's, which misleads on a cluster:
 * its memory is the local shard of the model, and its GPU idles because the
 * engine spans every Spark. Here a figure that cannot be had is "n/a" and never
 * a zero, and a GB10's N/A GPU memory is its unified system memory, said so.
 */

const POLL_MS = 5_000;

/** A request that is still unanswered after this long is given up, so a read that never settles cannot stop the polling for good. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * GET a JSON answer under ONE deadline of our own (an AbortController, not
 * `AbortSignal.timeout`, which not every runtime has) that covers the body as
 * well as the headers: a response whose headers came promptly and whose body
 * then stalls must not hold the caller for good. A non-OK answer is returned by
 * its status; its body is not read.
 */
async function getJson(url: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Settles (rejects) only at the deadline, whatever the runtime does with the
  // aborted body; never left unhandled.
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("The request took too long.", "AbortError"));
    }, REQUEST_TIMEOUT_MS);
  });
  expired.catch(() => {});
  try {
    const res = await Promise.race([fetch(url, { cache: "no-store", signal: controller.signal }), expired]);
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const data: unknown = await Promise.race([res.json(), expired]);
    return { ok: true, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** The availability question is asked again after a failure that is not an answer, this long after, doubling. */
const AVAILABILITY_RETRY_MS = 2_000;
const AVAILABILITY_RETRY_MAX_MS = 30_000;
/** …at most this many times while System stays open. */
const AVAILABILITY_RETRIES = 8;

/**
 * Is there a cluster to show? Asked when the owner opens System; never by
 * anyone else. Only a DEFINITE answer changes it — the box says there is a
 * cluster, or says there is none or that this person may not ask — so a request
 * that merely failed does not take the tab away from an owner who is on it.
 * A failure is asked again (2 s, 4 s, … at most 30 s apart, at most
 * `AVAILABILITY_RETRIES` times) while System stays open and no definite answer
 * has come, so a route that was briefly down does not hide the tab until the
 * owner reopens System. A definite answer is asked once.
 *
 * The second value is for the panel: the snapshot route itself answered that
 * there is no cluster (`{ enabled: false }`), which is as definite as the
 * availability answer, so the tab goes until System is opened again.
 */
export function useClusterAvailable(active: boolean): [boolean, () => void] {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const ask = () => {
      getJson("/setup-api/system/cluster?availability=1")
        .then((res) => {
          if (!live) return;
          if (res.ok) {
            const enabled = (res.data as { enabled?: unknown } | null)?.enabled;
            if (typeof enabled === "boolean") {
              setAvailable(enabled);
              return;
            }
          } else if (res.status === 401 || res.status === 403 || res.status === 404) {
            setAvailable(false);
            return;
          }
          again();
        })
        .catch(() => {
          // Not an answer: what was known stays, and the question is asked again.
          if (live) again();
        });
    };
    const again = () => {
      if (attempt >= AVAILABILITY_RETRIES) return;
      const delay = Math.min(AVAILABILITY_RETRY_MS * 2 ** attempt, AVAILABILITY_RETRY_MAX_MS);
      attempt += 1;
      retry = setTimeout(ask, delay);
    };
    ask();
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [active]);
  const gone = useCallback(() => setAvailable(false), []);
  return [active && available, gone];
}

function levelColor(percent: number): string {
  return percent >= 90 ? "#ef4444" : percent >= 70 ? "#f97316" : percent >= 50 ? "#eab308" : "#06b6d4";
}

function temperatureColor(celsius: number): string {
  return celsius > 80 ? "#ef4444" : celsius > 60 ? "#f97316" : "#22d3ee";
}

function fixed(n: number, digits: number, locale: string): string {
  return n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
}

/** A labelled figure with a bar under it; `percent` null draws the "n/a" and an empty bar. */
function Meter({
  label,
  value,
  percent,
  color,
  hint,
  testId,
}: {
  label: string;
  value: string;
  percent: number | null;
  color?: string;
  hint?: string;
  testId?: string;
}) {
  const pct = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className="mb-3 last:mb-0" data-testid={testId} title={hint}>
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <span className="text-xs text-[var(--text-muted)] min-w-0 truncate">{label}</span>
        <span className="text-xs font-mono font-semibold text-[var(--text-secondary)] shrink-0">{value}</span>
      </div>
      <div
        className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : pct}
        aria-valuetext={value}
      >
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, backgroundColor: color ?? levelColor(pct) }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ online, label, testId }: { online: boolean; label: string; testId?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] font-semibold shrink-0"
      style={{ color: online ? "#22c55e" : "#ef4444" }}
      data-testid={testId}
      data-online={online ? "true" : "false"}
    >
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: online ? "#22c55e" : "#ef4444" }} aria-hidden="true" />
      {label}
    </span>
  );
}

const CARD = "rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5";

function SparkCardView({ spark, locale }: { spark: SparkCard; locale: string }) {
  const tr = useTr();
  const na = tr("cluster.na", "n/a");
  const f = spark.figures;

  const failureText: Record<SparkFailure, string> = {
    unreachable: tr("cluster.failure.unreachable", "Cannot be reached on the cluster network."),
    timeout: tr("cluster.failure.timeout", "Did not answer in time."),
    auth: tr("cluster.failure.auth", "Refused this box's SSH key."),
    host_key: tr("cluster.failure.hostKey", "Its SSH host key is not trusted by this box."),
    failed: tr("cluster.failure.failed", "Answered, but its figures could not be read."),
  };

  const memoryLabel = f?.unifiedMemory
    ? tr("cluster.memoryUnified", "Memory (unified)")
    : tr("cluster.memory", "Memory");

  return (
    <section className={CARD} data-testid={`cluster-spark-${spark.id}`} aria-label={spark.hostname}>
      <div className="flex items-center gap-2 mb-4">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">dns</span>
        <h3 className="text-sm font-semibold font-mono text-[var(--text-primary)] min-w-0 truncate">{spark.hostname}</h3>
        {spark.local && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--coral-bright)]/80 bg-orange-500/10 px-1.5 py-0.5 rounded-md shrink-0" data-testid={`cluster-spark-${spark.id}-local`}>
            {tr("cluster.thisBox", "This Spark")}
          </span>
        )}
        <span className="ml-auto">
          <StatusBadge
            online={spark.online}
            label={spark.online ? tr("cluster.online", "Online") : tr("cluster.offline", "Offline")}
            testId={`cluster-spark-${spark.id}-status`}
          />
        </span>
      </div>

      {!spark.online || !f ? (
        <p className="text-xs text-[var(--text-muted)]" data-testid={`cluster-spark-${spark.id}-failure`}>
          {failureText[spark.failure ?? "failed"] ?? failureText.failed}
        </p>
      ) : (
        <>
          <Meter
            label={tr("cluster.cpu", "CPU")}
            value={f.cpuPercent === null ? na : `${f.cpuPercent}%`}
            percent={f.cpuPercent}
            testId={`cluster-spark-${spark.id}-cpu`}
          />
          <Meter
            label={memoryLabel}
            value={f.memory ? `${formatBytes(f.memory.usedBytes, locale) ?? "0 B"} / ${formatBytes(f.memory.totalBytes, locale) ?? na}` : na}
            percent={f.memory ? f.memory.percent : null}
            hint={f.unifiedMemory ? tr("cluster.memoryUnifiedHint", "CPU and GPU share this Spark's memory, so this is the GPU's memory too.") : undefined}
            testId={`cluster-spark-${spark.id}-memory`}
          />
          <Meter
            label={tr("cluster.gpu", "GPU")}
            value={f.gpu.utilPercent === null ? na : `${f.gpu.utilPercent}%`}
            percent={f.gpu.utilPercent}
            testId={`cluster-spark-${spark.id}-gpu`}
          />
          {f.gpu.memoryTotalBytes !== null && f.gpu.memoryUsedBytes !== null && (
            <Meter
              label={tr("cluster.gpuMemory", "GPU memory")}
              value={`${formatBytes(f.gpu.memoryUsedBytes, locale) ?? "0 B"} / ${formatBytes(f.gpu.memoryTotalBytes, locale) ?? na}`}
              percent={(f.gpu.memoryUsedBytes / f.gpu.memoryTotalBytes) * 100}
              testId={`cluster-spark-${spark.id}-gpu-memory`}
            />
          )}
          <Meter
            label={tr("cluster.temperature", "Temperature")}
            value={f.temperatureC === null ? na : `${fixed(f.temperatureC, 1, locale)} °C`}
            percent={f.temperatureC}
            color={f.temperatureC === null ? undefined : temperatureColor(f.temperatureC)}
            testId={`cluster-spark-${spark.id}-temperature`}
          />
          <Meter
            label={tr("cluster.disk", "Disk")}
            value={f.disk ? `${formatBytes(f.disk.usedBytes, locale) ?? "0 B"} / ${formatBytes(f.disk.totalBytes, locale) ?? na}` : na}
            percent={f.disk ? f.disk.percent : null}
            testId={`cluster-spark-${spark.id}-disk`}
          />
        </>
      )}
    </section>
  );
}

function EngineRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-xs" data-testid={testId}>
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-mono font-semibold text-[var(--text-secondary)]">{value}</span>
    </div>
  );
}

function EngineCardView({ engine, locale }: { engine: EngineView; locale: string }) {
  const tr = useTr();
  const na = tr("cluster.na", "n/a");

  const reasonText: Record<string, string> = {
    unreachable: tr("cluster.engineReason.unreachable", "The gate did not answer."),
    not_lan: tr("cluster.engineReason.notLan", "The gate is outside the local network, so it was not contacted."),
    unauthorized: tr("cluster.engineReason.unauthorized", "The gate refused the API key."),
    bad_response: tr("cluster.engineReason.badResponse", "The gate answered with something that is not an engine's reply."),
    address_refused: tr("cluster.engineReason.addressRefused", "The gate's address is not allowed."),
  };

  const count = (n: number | null | undefined) => (n === null || n === undefined ? na : String(Math.round(n)));
  const m = engine.metrics;

  return (
    <section className={CARD} data-testid="cluster-engine" aria-label={tr("cluster.engine", "Engine")}>
      <div className="flex items-center gap-2 mb-3">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">hub</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{tr("cluster.engine", "Engine")}</h3>
        {engine.configured && !engine.unread && engine.gate && (
          <span className="ml-auto">
            <StatusBadge
              online={engine.gate.online}
              label={engine.gate.online ? tr("cluster.online", "Online") : tr("cluster.offline", "Offline")}
              testId="cluster-engine-gate"
            />
          </span>
        )}
      </div>

      {engine.unread === "unreadable" ? (
        <p className="text-xs text-[var(--text-muted)]" data-testid="cluster-engine-unreadable">
          {tr("cluster.engineUnreadable", "This box could not read its AI engine settings, so the engine is not shown.")}
        </p>
      ) : engine.unread === "changing" ? (
        <p className="text-xs text-[var(--text-muted)]" data-testid="cluster-engine-changing">
          {tr("cluster.engineChanging", "The AI settings are being changed right now, so the engine was not read. Its load shows again once that is done.")}
        </p>
      ) : !engine.configured ? (
        <p className="text-xs text-[var(--text-muted)]" data-testid="cluster-engine-none">
          {tr("cluster.engineNone", "No AI engine is set up. Add one under Settings → Local AI → External engine.")}
        </p>
      ) : (
        <>
          {engine.model && <EngineRow label={tr("cluster.engineModel", "Model")} value={engine.model} testId="cluster-engine-model" />}
          <EngineRow
            label={tr("cluster.engineGate", "Inference gate")}
            value={engine.gate?.online
              ? tr("cluster.online", "Online")
              : tr("cluster.offline", "Offline")}
            testId="cluster-engine-gate-row"
          />
          {engine.gate && !engine.gate.online && engine.gate.reason && (
            <p className="text-[11px] text-[var(--text-muted)] mb-1" data-testid="cluster-engine-reason">
              {reasonText[engine.gate.reason] ?? reasonText.bad_response}
            </p>
          )}
          <EngineRow label={tr("cluster.engineActive", "Active requests")} value={count(m?.active)} testId="cluster-engine-active" />
          <EngineRow label={tr("cluster.engineQueued", "Queued requests")} value={count(m?.queued)} testId="cluster-engine-queued" />
          <EngineRow
            label={tr("cluster.engineTokens", "Tokens per second")}
            value={m?.tokensPerSecond === null || m?.tokensPerSecond === undefined
              ? na
              : tr("cluster.engineTokensValue", "{value} tok/s", { value: fixed(m.tokensPerSecond, 1, locale) })}
            testId="cluster-engine-tokens"
          />
          {m && !m.available && engine.gate?.online && (
            <p className="text-[11px] text-[var(--text-muted)] mt-1" data-testid="cluster-engine-no-metrics">
              {tr("cluster.engineNoMetrics", "The engine publishes no metrics this page can read, so its load shows n/a.")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** The banner over the cards when a Spark did not answer. */
function UnreachableBanner({ sparks }: { sparks: SparkCard[] }) {
  const tr = useTr();
  if (sparks.length === 0) return null;
  const names = sparks.map((s) => s.hostname).join(", ");
  const text = sparks.length === 1
    ? tr("cluster.warnOne", "1 Spark is unreachable: {names}. Its figures are not shown.", { names })
    : tr("cluster.warnMany", "{count} Sparks are unreachable: {names}. Their figures are not shown.", { count: sparks.length, names });
  return (
    <div
      className="flex items-start gap-2 p-3 rounded-xl border"
      style={{ backgroundColor: "rgba(239,68,68,0.10)", borderColor: "rgba(239,68,68,0.35)", color: "#fca5a5" }}
      role="alert"
      data-testid="cluster-unreachable-banner"
    >
      <span className="material-symbols-rounded shrink-0" style={{ fontSize: 18 }} aria-hidden="true">warning</span>
      <span className="text-xs leading-relaxed" data-testid="cluster-unreachable-text">{text}</span>
    </div>
  );
}

export default function ClusterPanel({ onUnavailable }: {
  /**
   * The route answered that this box has no cluster after all (`{ enabled:
   * false }` — the peers were taken out, or the view turned off). Settings then
   * takes the tab away and goes back to Device, which unmounts the panel and
   * its polling. A failure is not that answer: the tab stays.
   */
  onUnavailable?: () => void;
} = {}) {
  const tr = useTr();
  const { locale } = useT();
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [gone, setGone] = useState(false);
  const busy = useRef(false);
  const goneRef = useRef(false);
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  const read = useCallback(async () => {
    // One read at a time: a slow cluster must not stack requests behind itself.
    // And none at all once the box has said it has no cluster.
    if (busy.current || goneRef.current) return;
    busy.current = true;
    try {
      const res = await getJson("/setup-api/system/cluster");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = res.data as ClusterAnswer | null;
      if (data?.enabled === true) {
        setSnapshot(data);
      } else if (data?.enabled === false) {
        goneRef.current = true;
        setGone(true);
        onUnavailableRef.current?.();
      } else {
        throw new Error("not a cluster answer");
      }
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void read();
    const iv = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(iv);
  }, [read]);

  if (gone) return null;

  const down = snapshot ? unreachableSparks(snapshot.sparks) : [];

  return (
    <div className="space-y-4" data-testid="cluster-panel">
      {failed && (
        <div
          className="flex items-center gap-2 p-3 rounded-xl border text-xs"
          style={{ backgroundColor: "rgba(239,68,68,0.10)", borderColor: "rgba(239,68,68,0.35)", color: "#fca5a5" }}
          role="alert"
          data-testid="cluster-load-failed"
        >
          <span className="material-symbols-rounded shrink-0" style={{ fontSize: 16 }} aria-hidden="true">error</span>
          {tr("cluster.loadFailed", "The cluster status could not be read.")}
        </div>
      )}

      {!snapshot && !failed && (
        <div className="flex items-center justify-center gap-3 py-8" data-testid="cluster-loading">
          <div className="spinner" role="status" aria-label={tr("cluster.loading", "Reading the cluster…")} />
        </div>
      )}

      {snapshot && (
        <>
          <UnreachableBanner sparks={down} />
          <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
            <span>{tr("cluster.updated", "Updated {time}", { time: new Date(snapshot.generatedAt).toLocaleTimeString(locale) })}</span>
            <button
              type="button"
              onClick={() => void read()}
              className="p-1 rounded hover:bg-white/10 transition-colors cursor-pointer bg-transparent border-none"
              title={tr("cluster.refresh", "Refresh now")}
              aria-label={tr("cluster.refresh", "Refresh now")}
            >
              <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 14 }} aria-hidden="true">refresh</span>
            </button>
          </div>
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }} data-testid="cluster-sparks">
            {snapshot.sparks.map((spark) => (
              <SparkCardView key={spark.id} spark={spark} locale={locale} />
            ))}
          </div>
          <EngineCardView engine={snapshot.engine} locale={locale} />
        </>
      )}
    </div>
  );
}
