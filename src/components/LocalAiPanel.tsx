"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/format-bytes";
import { dispatchOpenApp, onStandaloneAppPage } from "@/lib/ui-events";
import type { LocalModelEntry, LocalModelsSnapshot, RunState } from "@/lib/local-models";

/**
 * Settings → Local AI: everything that runs on the box itself, grouped by
 * what it is for, one compact row each, with the actions behind a "more"
 * menu instead of a card per concern.
 *
 * Three stacked cards (a provider list, a status card, a set-up wizard) and a
 * separate inventory tab all described the same handful of engines; the owner
 * asked for one list. The rows come from the inventory route; each row's
 * ROLE — primary or fallback — comes from the surface that owns that
 * decision (the provider default for the language model, the voice order for
 * speech out, the transcription order for speech in), so this panel never
 * holds a second copy of any of those.
 */

type Kind = LocalModelEntry["kind"];
type Role = "primary" | "fallback" | null;
type Translate = ReturnType<typeof useT>["t"];

const GROUPS: { kind: Kind; titleKey: string; icon: string }[] = [
  { kind: "llm", titleKey: "localModels.group.llm", icon: "smart_toy" },
  { kind: "tts", titleKey: "localModels.group.tts", icon: "record_voice_over" },
  { kind: "stt", titleKey: "localModels.group.stt", icon: "mic" },
  { kind: "embedding", titleKey: "localModels.group.other", icon: "database" },
];

const RUN_LABEL_KEY: Record<RunState, string> = {
  running: "localModels.run.running",
  idle: "localModels.run.idle",
  "on-demand": "localModels.run.onDemand",
  "not-installed": "localModels.run.notInstalled",
  "not-on-this-edition": "localModels.run.notOnThisEdition",
};

const RUN_TONE: Record<RunState, string> = {
  running: "bg-cyan-500/10 text-cyan-300 border-cyan-400/20",
  idle: "bg-white/[0.06] text-[var(--text-secondary)] border-white/10",
  "on-demand": "bg-white/[0.06] text-[var(--text-secondary)] border-white/10",
  "not-installed": "bg-amber-500/10 text-amber-300 border-amber-400/20",
  "not-on-this-edition": "bg-white/[0.06] text-[var(--text-secondary)] border-white/10",
};

const RUN_STATES = Object.keys(RUN_LABEL_KEY) as RunState[];
const KINDS = GROUPS.map((g) => g.kind);
const CONTROLS = ["none", "user-unit", "system-unit"];

// The keyboard ring every focusable control here shows — the same outline
// the wizard's buttons use, so a keyboard user sees one ring across the app.
const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--coral-ring)]";

/** Every field the render reads, checked before the payload is trusted. */
function isEntry(value: unknown): value is LocalModelEntry {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  for (const key of ["id", "name", "runtime", "detail"]) {
    if (typeof m[key] !== "string") return false;
  }
  if (typeof m.installed !== "boolean") return false;
  if (m.enabled !== null && typeof m.enabled !== "boolean") return false;
  for (const key of ["diskBytes", "memoryBytes"]) {
    if (m[key] !== null && typeof m[key] !== "number") return false;
  }
  return KINDS.includes(m.kind as Kind)
    && RUN_STATES.includes(m.running as RunState)
    && CONTROLS.includes(m.control as string);
}

function isSnapshot(value: unknown): value is LocalModelsSnapshot {
  if (!value || typeof value !== "object") return false;
  const models = (value as { models?: unknown }).models;
  const unavailable = (value as { unavailable?: unknown }).unavailable;
  if (!Array.isArray(models) || !Array.isArray(unavailable)) return false;
  if (!unavailable.every((u) => typeof u === "string")) return false;
  return models.every(isEntry);
}

/**
 * The name a row would carry, for an engine whose row is missing. The
 * inventory reports a failed probe by its builder id and drops the row, so
 * the banner is the only place that engine is named — and "llamacpp" next to
 * rows titled Kokoro and Whisper reads like a different list. The language
 * model's row name depends on which model is served, which is exactly what an
 * unanswered probe does not know, so its group title stands in for it.
 */
function unavailableName(id: string, t: Translate): string {
  switch (id) {
    case "llamacpp": return t("localModels.group.llm");
    case "ollama": return "Ollama";
    case "kokoro": return "Kokoro";
    case "whisper": return "Whisper";
    // The key the row's own `nameCode` renders through.
    case "embeddings": return t("localModels.name.memorySearch");
    default: return id;
  }
}

/**
 * A row's name, runtime or detail line. The inventory sends each as a code
 * (`nameCode`, `runtimeCode`, `detailCode`, with `params` for the names it
 * mentions) beside the English sentence. The code goes through the catalogue;
 * the English stands in when there is no code, or the code has no key — an
 * older server, a code this build does not know — because `t()` answers an
 * unknown key with the key itself, and that must never reach the row.
 */
function rowText(t: Translate, prefix: string, code: string | undefined, params: Record<string, string> | undefined, english: string): string {
  if (!code) return english;
  const key = `${prefix}.${code}`;
  const text = t(key, params);
  return text === key ? english : text;
}

/**
 * Read the llama.cpp install route's answer. It is not JSON: it answers 200
 * and streams NDJSON — `status` lines while it builds, downloads and starts
 * the model, then ONE closing line, `success` or `error`. A stream that ends
 * with neither is a failure too (the server went away mid-install); a line
 * that is not JSON is a torn write and is skipped, as the wizard skips them.
 */
async function readInstallStream(
  res: Response,
  onStatus: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const reader = res.body?.getReader();
  if (!reader) return { ok: false };
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (line: string): { ok: boolean; error?: string } | null => {
    if (!line) return null;
    let payload: { status?: unknown; error?: unknown; success?: unknown };
    try {
      payload = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof payload.status === "string") onStatus(payload.status);
    if (typeof payload.error === "string") return { ok: false, error: payload.error };
    if (payload.success === true) return { ok: true };
    return null;
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const outcome = consume(line);
      if (outcome) return outcome;
    }
    if (done) break;
  }
  // The closing line may arrive without its newline; it still decides the
  // outcome — dropping it turned a finished multi-minute install into an
  // error.
  return consume(buffer.trim()) ?? { ok: false };
}

/** The on-device roles by kind, each read from the surface that decides it. */
type Roles = Partial<Record<Kind, Role>>;

interface Action {
  id: string;
  labelKey: string;
  run: () => Promise<Response>;
  /** Red, for the one action that takes a configured model away. */
  destructive?: boolean;
  /** The route streams progress (see readInstallStream) instead of answering JSON. */
  streams?: true;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export default function LocalAiPanel({ active, edition }: { active: boolean; edition: string | null }) {
  const { t } = useT();
  const [snapshot, setSnapshot] = useState<LocalModelsSnapshot | null>(null);
  const [roles, setRoles] = useState<Roles>({});
  const [localOnly, setLocalOnly] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the FIRST read has nothing to fall back on; a later failed poll keeps
  // the last good reading. So this is only ever true while there is no snapshot.
  const [loadFailed, setLoadFailed] = useState(false);
  // One entry per row with a request in flight — two rows can be busy at
  // once, and each keeps its own spinner until its own request settles.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // The last progress line of a streaming action, by row.
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [focusedItem, setFocusedItem] = useState(0);
  // An action takes seconds; the poll must not overwrite any row mid-flight.
  const pendingRef = useRef(new Set<string>());
  const snapshotRef = useRef<LocalModelsSnapshot | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Each row's "more" button, so a closing menu can hand focus back to it.
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());

  const applySnapshot = useCallback((next: LocalModelsSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    setLoadFailed(false);
  }, []);

  const refreshRoles = useCallback(async () => {
    const read = async (url: string) => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    };
    const [providers, tts, stt] = await Promise.all([
      read("/setup-api/providers/status"),
      read("/setup-api/tts"),
      read("/setup-api/stt"),
    ]);
    const rows = Array.isArray(providers?.providers) ? providers.providers as { section: string; state: string; isDefault: boolean }[] : [];
    // The provider list already says which row is the on-device one.
    const local = rows.find((r) => r.section === "localAi");
    const llm: Role = !local ? null : local.isDefault ? "primary" : local.state === "connected" ? "fallback" : null;
    const localVoice = Array.isArray(tts?.engines) && (tts.engines as { id: string; configured: boolean }[]).some((e) => e.id === "local" && e.configured);
    const ttsRole: Role = !localVoice ? null : tts?.choice === "local" ? "primary" : "fallback";
    const localStt = stt?.engines?.local?.installed === true;
    const sttRole: Role = !localStt ? null : stt?.primary === "local" ? "primary" : "fallback";
    setRoles({ llm, tts: ttsRole, stt: sttRole });
  }, []);

  const refresh = useCallback(async () => {
    if (pendingRef.current.size > 0) return;
    try {
      const res = await fetch("/setup-api/local-models", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (isSnapshot(data)) {
        applySnapshot(data);
        return;
      }
    } catch {
      /* fall through: keep the last good reading rather than blanking the page */
    }
    // With no reading yet the skeleton would pulse forever; say so instead.
    // The poll keeps trying, so the message clears itself once the box answers.
    if (!snapshotRef.current) setLoadFailed(true);
  }, [applySnapshot]);

  // The inventory (is it running, how much memory) changes on its own, so it
  // is polled — but not while the tab is hidden, where nobody sees it and the
  // box pays eight process spawns a tick. Roles change only through this
  // panel's own actions, so they are read once here and again after each one.
  useEffect(() => {
    if (!active) return;
    void refresh();
    void refreshRoles();
    if (edition !== "hermes") {
      fetch("/setup-api/local-ai/exclusive", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setLocalOnly(!!d.enabled))
        .catch(() => setLocalOnly(false));
    }
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [active, edition, refresh, refreshRoles]);

  // The menu closes on a click anywhere else or on Escape, like any menu.
  // Escape hands focus back to the button that opened it — the item that had
  // focus is about to unmount, and focus falling to <body> loses the owner's
  // place. A click elsewhere does not: focus belongs to what was clicked.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      triggerRefs.current.get(menuFor)?.focus();
      setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  // Opening puts focus on the first item; the arrows move it (roving
  // tabindex, the pattern the Files app's context menu uses).
  useEffect(() => {
    if (!menuFor) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    items?.[focusedItem]?.focus();
  }, [menuFor, focusedItem]);

  const openMenu = (id: string) => {
    setFocusedItem(0);
    setMenuFor(id);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent, id: string, count: number) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedItem((i) => (i + 1) % count);
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedItem((i) => (i - 1 + count) % count);
        break;
      case "Home":
        e.preventDefault();
        setFocusedItem(0);
        break;
      case "End":
        e.preventDefault();
        setFocusedItem(count - 1);
        break;
      case "Tab":
        // Tabbing out closes the menu. Focus goes back to the button first so
        // the browser's own Tab carries on from there, not from a node that
        // no longer exists.
        triggerRefs.current.get(id)?.focus();
        setMenuFor(null);
        break;
    }
  };

  const runAction = useCallback(async (entry: LocalModelEntry, action: Action) => {
    // The item just activated unmounts with the menu; its button stays.
    triggerRefs.current.get(entry.id)?.focus();
    setMenuFor(null);
    pendingRef.current.add(entry.id);
    setPending((p) => new Set(p).add(entry.id));
    setError(null);
    try {
      const res = await action.run();
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data?.error === "string" ? data.error : t("localModels.error.changeFailed"));
        return;
      }
      if (action.streams) {
        const outcome = await readInstallStream(res, (line) => setProgress((p) => ({ ...p, [entry.id]: line })));
        if (!outcome.ok) setError(outcome.error ?? t("localModels.error.changeFailed"));
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (isSnapshot(data)) applySnapshot(data);
    } catch {
      setError(t("localModels.error.unreachable"));
    } finally {
      pendingRef.current.delete(entry.id);
      setPending((p) => {
        const next = new Set(p);
        next.delete(entry.id);
        return next;
      });
      setProgress((p) => {
        if (!(entry.id in p)) return p;
        const rest = { ...p };
        delete rest[entry.id];
        return rest;
      });
      // refresh() waits for the last in-flight action; roles are cheap.
      void refresh();
      void refreshRoles();
    }
  }, [applySnapshot, refresh, refreshRoles, t]);

  const toggleLocalOnly = useCallback(async (next: boolean) => {
    setLocalOnly(null);
    // A refusal from the last flip must not outlive a flip that went through.
    setError(null);
    try {
      const res = await post("/setup-api/local-ai/exclusive", { enabled: next });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(typeof data?.error === "string" ? data.error : t("localModels.error.changeFailed"));
      setLocalOnly(res.ok ? next : !next);
    } catch {
      setError(t("localModels.error.unreachable"));
      setLocalOnly(!next);
    }
  }, [t]);

  /**
   * What a row can do, decided from the same facts the row shows. Only actions
   * that have a route on this box are offered — a voice engine is installed by
   * the installer, not from here, so "install" appears only for the language
   * model, which has one.
   */
  const actionsFor = (entry: LocalModelEntry): Action[] => {
    const actions: Action[] = [];
    if (entry.control !== "none" && entry.enabled !== null && entry.installed) {
      // Enabled but not running is Ollama's standby (or a unit that exited
      // with an error): the next request would start it, and so does this,
      // without the wait. Same route, same body as Enable — the engine is
      // already enabled, so the route only has the start left to do.
      if (entry.enabled && entry.running !== "running") {
        actions.push({
          id: "turn-on",
          labelKey: "localModels.menu.turnOn",
          run: () => post("/setup-api/local-models", { id: entry.id, enabled: true }),
        });
      }
      actions.push({
        id: entry.enabled ? "disable" : "enable",
        labelKey: entry.enabled ? "localModels.menu.disable" : "localModels.menu.enable",
        run: () => post("/setup-api/local-models", { id: entry.id, enabled: !entry.enabled }),
      });
    }
    if (entry.kind === "llm" && entry.id === "llamacpp") {
      if (!entry.installed) {
        actions.push({ id: "install", labelKey: "localModels.menu.install", streams: true, run: () => post("/setup-api/llamacpp/install", { scope: "local" }) });
      } else if (roles.llm === "primary") {
        actions.push({ id: "fallback", labelKey: "localModels.menu.useAsFallback", run: () => post("/setup-api/providers/default", { provider: "clawai" }) });
      } else {
        actions.push({ id: "primary", labelKey: "localModels.menu.makePrimary", streams: true, run: () => post("/setup-api/llamacpp/install", { scope: "local", activate: true }) });
        if (roles.llm == null) {
          actions.push({ id: "fallback", labelKey: "localModels.menu.useAsFallback", streams: true, run: () => post("/setup-api/llamacpp/install", { scope: "local" }) });
        }
      }
      if (roles.llm != null) {
        actions.push({ id: "turn-off", labelKey: "localModels.menu.turnOffLocalAi", destructive: true, run: () => post("/setup-api/local-ai", { action: "disable" }) });
      }
    }
    if (entry.kind === "tts" && entry.installed) {
      if (roles.tts === "primary") {
        actions.push({ id: "fallback", labelKey: "localModels.menu.useAsFallback", run: () => post("/setup-api/tts", { action: "select", choice: "auto" }) });
      } else {
        actions.push({ id: "primary", labelKey: "localModels.menu.makePrimary", run: () => post("/setup-api/tts", { action: "select", choice: "local" }) });
      }
    }
    if (entry.kind === "stt" && entry.installed) {
      if (roles.stt === "primary") {
        actions.push({ id: "fallback", labelKey: "localModels.menu.useAsFallback", run: () => post("/setup-api/stt", { primary: "cloud" }) });
      } else {
        actions.push({ id: "primary", labelKey: "localModels.menu.makePrimary", run: () => post("/setup-api/stt", { primary: "local" }) });
      }
    }
    return actions;
  };

  // The agent-model role belongs to the engine Local AI manages (llama.cpp);
  // Ollama serves extra models and is not the on-device provider row.
  const roleFor = (entry: LocalModelEntry): Role => {
    if (!entry.installed) return null;
    if (entry.kind === "llm" && entry.managedBy !== "localAi") return null;
    return roles[entry.kind] ?? null;
  };

  if (!snapshot) {
    return (
      <div className="max-w-2xl space-y-3" data-testid="local-ai-loading">
        {loadFailed && (
          <div role="alert" className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-200" data-testid="local-ai-load-failed">
            {t("settings.localAi.loadFailed")}
          </div>
        )}
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 motion-safe:animate-pulse">
            <div className="h-3 w-40 rounded bg-white/[0.08]" />
            <div className="h-2 w-64 rounded bg-white/[0.06] mt-3" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4" data-testid="local-ai-panel">
      <p className="text-sm text-[var(--text-secondary)]">{t("localModels.intro")}</p>

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {snapshot.unavailable.length > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-200" data-testid="local-ai-unavailable">
          {t("localModels.unavailable", { list: snapshot.unavailable.map((id) => unavailableName(id, t)).join(", ") })}
        </div>
      )}

      {/* Local-only mode is OpenClaw's fallback-chain machinery; Hermes has no
          equivalent, so the switch is not offered there. */}
      {edition !== "hermes" && roles.llm != null && (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--text-primary)]">{t("localModels.localOnly.title")}</div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">{t("localModels.localOnly.hint")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={t("localModels.localOnly.title")}
            aria-checked={!!localOnly}
            aria-busy={localOnly === null}
            disabled={localOnly === null}
            onClick={() => void toggleLocalOnly(!localOnly)}
            data-testid="local-ai-local-only"
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 shrink-0 ${FOCUS_RING} focus-visible:outline-offset-2 ${
              localOnly ? "bg-[var(--coral-bright)]" : "bg-gray-600"
            }`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${localOnly ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
      )}

      {GROUPS.map((group) => {
        const entries = snapshot.models.filter((m) => m.kind === group.kind);
        if (entries.length === 0) return null;
        return (
          <section key={group.kind} data-testid={`local-ai-group-${group.kind}`}>
            <h3 className="flex items-center gap-2 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2 px-1">
              <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }} aria-hidden="true">{group.icon}</span>
              {t(group.titleKey)}
            </h3>
            <ul className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] divide-y divide-white/[0.06]">
              {entries.map((entry) => {
                const role = roleFor(entry);
                const actions = entry.managedBy === "clawkeep" ? [] : actionsFor(entry);
                const busy = pending.has(entry.id);
                const disk = formatBytes(entry.diskBytes);
                const memory = formatBytes(entry.memoryBytes);
                const open = menuFor === entry.id;
                const name = rowText(t, "localModels.name", entry.nameCode, entry.params, entry.name);
                const runtime = rowText(t, "localModels.runtime", entry.runtimeCode, entry.params, entry.runtime);
                const detail = rowText(t, "localModels.detail", entry.detailCode, entry.params, entry.detail);
                return (
                  <li key={entry.id} className="relative flex items-center gap-3 px-4 py-3" aria-busy={busy} data-testid={`local-model-${entry.id}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--text-primary)]">{name}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${RUN_TONE[entry.running]}`}>
                          {t(RUN_LABEL_KEY[entry.running])}
                        </span>
                        {role && (
                          <span
                            data-testid={`local-model-role-${entry.id}`}
                            className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                              role === "primary"
                                ? "text-[var(--coral-bright)] border-[var(--coral-bright)]/40"
                                : "text-[var(--text-secondary)] border-white/15"
                            }`}
                          >
                            {t(role === "primary" ? "localModels.role.primary" : "localModels.role.fallback")}
                          </span>
                        )}
                      </div>
                      {/* Wraps rather than truncates: on a phone the memory
                          figure is the last thing on the line, and an ellipsis
                          there hid the one number the row carries. Secondary,
                          not muted: the figures must not be the dimmest text
                          in the row (muted fails AA on the card). */}
                      <p className="text-xs text-[var(--text-secondary)] mt-0.5 break-words">
                        {runtime}
                        {disk ? ` · ${t("localModels.disk", { size: disk })}` : ""}
                        {memory ? ` · ${t("localModels.memoryInUse", { size: memory })}` : ""}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)] mt-1">{detail}</p>
                      {busy && progress[entry.id] && (
                        <p className="text-xs text-[var(--text-secondary)] mt-1 break-words" data-testid={`local-model-progress-${entry.id}`}>
                          {progress[entry.id]}
                        </p>
                      )}
                    </div>

                    {busy && (
                      <span className="material-symbols-rounded motion-safe:animate-spin text-[var(--text-secondary)]" style={{ fontSize: 18 }} aria-hidden="true">
                        progress_activity
                      </span>
                    )}

                    {entry.managedBy === "clawkeep" ? (
                      // The index this row embeds for is managed in Memory
                      // Shard now; ClawKeep only keeps a card pointing there.
                      // Opening ClawKeep would cost the owner a second click
                      // to reach the thing they were sent to manage. On the
                      // standalone page there is no desktop to open a window
                      // into, so the button navigates there instead.
                      <button
                        type="button"
                        onClick={() => {
                          if (onStandaloneAppPage()) window.location.assign("/app/memory-shard");
                          else dispatchOpenApp("memory-shard");
                        }}
                        className={`text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 shrink-0 ${FOCUS_RING}`}
                        data-testid={`local-model-manage-${entry.id}`}
                      >
                        {t("localModels.menu.manageInMemoryShard")}
                      </button>
                    ) : actions.length > 0 && (
                      <div className="relative shrink-0" ref={open ? menuRef : undefined}>
                        {/* aria-disabled, not disabled: the button keeps
                            focus through the seconds the action takes, so
                            a keyboard user is not dropped to <body>. */}
                        <button
                          type="button"
                          ref={(el) => {
                            if (el) triggerRefs.current.set(entry.id, el);
                            else triggerRefs.current.delete(entry.id);
                          }}
                          aria-label={t("localModels.menu.more", { name })}
                          aria-haspopup="menu"
                          aria-expanded={open}
                          aria-disabled={busy}
                          onClick={() => {
                            if (busy) return;
                            if (open) setMenuFor(null);
                            else openMenu(entry.id);
                          }}
                          data-testid={`local-model-menu-${entry.id}`}
                          className={`w-8 h-8 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 aria-disabled:opacity-50 aria-disabled:cursor-default flex items-center justify-center ${FOCUS_RING}`}
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">more_horiz</span>
                        </button>
                        {open && (
                          <div
                            role="menu"
                            aria-label={t("localModels.menu.more", { name })}
                            onKeyDown={(e) => onMenuKeyDown(e, entry.id, actions.length)}
                            className="absolute right-0 top-9 z-20 min-w-[12rem] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] shadow-2xl py-1"
                          >
                            {actions.map((action, i) => (
                              <button
                                key={action.id}
                                type="button"
                                role="menuitem"
                                tabIndex={i === focusedItem ? 0 : -1}
                                onClick={() => void runAction(entry, action)}
                                data-testid={`local-model-action-${entry.id}-${action.id}`}
                                className={`w-full text-left px-3 py-2 text-sm hover:bg-white/[0.06] ${FOCUS_RING} focus-visible:-outline-offset-2 ${
                                  action.destructive ? "text-red-300" : "text-[var(--text-primary)]"
                                }`}
                              >
                                {t(action.labelKey)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <p className="text-xs text-[var(--text-secondary)]">{t("localModels.footer")}</p>
    </div>
  );
}
