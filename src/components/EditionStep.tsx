"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { useT } from "@/lib/i18n";

/**
 * "Choose your assistant" — the first-setup step on a unified-image box
 * (TASK-1149, reports/clawbox/unified-image-design-2026-09.md §3).
 *
 * Rendered by SetupWizard as a gate in front of step 2 (Update) only while
 * /setup-api/setup/status says `edition_choice_needed`: the box carries both
 * agents and nobody has picked one, or an earlier pick was cut short. A box
 * with a fixed edition never sees it. The step numbers are not touched, so a
 * resumed setup lands where it always did.
 *
 * Written for someone unboxing their first AI appliance: two cards, one
 * sentence each, who each one suits, the recommendation for anyone unsure,
 * and one button. No product internals on screen; the root step's own
 * sentence is behind "Details" when something fails.
 *
 * The choice runs as a root step that ends by restarting the web server, so
 * the stream that reports it can drop at the very end (or earlier, on a flaky
 * connection). The step therefore never depends on the stream to finish: it
 * falls back to asking GET /setup-api/setup/edition until the box answers
 * from a NEW server process with the choice made, and then reloads, which
 * resumes the wizard at the Update step for the chosen agent.
 */

type Agent = "openclaw" | "hermes";
type Phase = "request" | "check" | "lock" | "provision" | "cleanup" | "done";

const PHASES: readonly Phase[] = ["request", "check", "lock", "provision", "cleanup", "done"];

/** The rows of the progress list: the step's four phases, then the restart. */
const PROGRESS_ROWS: readonly { phase: Phase; key: string }[] = [
  { phase: "check", key: "assistant.phaseCheck" },
  { phase: "lock", key: "assistant.phaseLock" },
  { phase: "provision", key: "assistant.phaseProvision" },
  { phase: "cleanup", key: "assistant.phaseCleanup" },
  { phase: "done", key: "assistant.phaseRestart" },
];

/** Names and logos are the products' own and are not translated. */
const AGENTS: Record<Agent, { name: string; logo: string; whatKey: string; fitKeys: readonly string[] }> = {
  openclaw: {
    name: "OpenClaw",
    logo: "/openclaw-logo.svg",
    whatKey: "assistant.openclawWhat",
    fitKeys: ["assistant.openclawFit1", "assistant.openclawFit2", "assistant.openclawFit3"],
  },
  hermes: {
    name: "Hermes",
    logo: "/hermes-agent.png",
    whatKey: "assistant.hermesWhat",
    fitKeys: ["assistant.hermesFit1", "assistant.hermesFit2", "assistant.hermesFit3"],
  },
};

/** What we recommend to anyone unsure — and the card that starts selected without a hint. */
const RECOMMENDED: Agent = "openclaw";

const DEFAULT_POLL_MS = 2500;
/**
 * How long to wait for the web server's restart once the box reports the
 * choice made. The root step schedules it ten seconds after it ends; past
 * this the page reloads anyway, onto a box that already runs the agent.
 */
const RESTART_WAIT_MS = 90_000;
const STATUS_TIMEOUT_MS = 8_000;

const T_H1 = { fontSize: "var(--t-6)", lineHeight: 1.15 } as const;
const T_LEDE = { fontSize: "var(--t-4)", lineHeight: 1.6 } as const;
const T_BTN = { fontSize: "var(--t-5)", fontWeight: "var(--w-label)" as const } as const;
const T_QUIET = { fontSize: "var(--t-2)", fontWeight: "var(--w-label)" as const } as const;
const T_SMALL = { fontSize: "var(--t-3)", lineHeight: 1.5 } as const;

const BTN_PRIMARY =
  "w-full sm:w-auto inline-flex items-center justify-center gap-[var(--s-2)] min-h-[48px] px-[var(--s-6)] rounded-[var(--r-1)] btn-gradient text-white cursor-pointer disabled:opacity-60 disabled:cursor-default";
const BTN_QUIET =
  "inline-flex items-center justify-center min-h-[40px] px-[var(--s-3)] rounded-[var(--r-1)] bg-transparent border-none cursor-pointer text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-2)]";

function isAgent(value: unknown): value is Agent {
  return value === "openclaw" || value === "hermes";
}

function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

export interface EditionChoiceStatus {
  needed: boolean;
  unselected: boolean;
  pending: Agent | null;
  hint: Agent | null;
  inProgress: boolean;
  inProgressTarget: Agent | null;
  serverStartedAt: number | null;
}

/** The route's GET, validated; anything else (an older server, an HTML error page) is null. */
export function readEditionChoiceStatus(body: unknown): EditionChoiceStatus | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.needed !== "boolean") return null;
  return {
    needed: b.needed,
    unselected: b.unselected === true,
    pending: isAgent(b.pending) ? b.pending : null,
    hint: isAgent(b.hint) ? b.hint : null,
    inProgress: b.inProgress === true,
    inProgressTarget: isAgent(b.inProgressTarget) ? b.inProgressTarget : null,
    serverStartedAt: typeof b.serverStartedAt === "number" ? b.serverStartedAt : null,
  };
}

type StreamOutcome =
  | { kind: "success" }
  | { kind: "error"; code: string; error: string | null; pending: Agent | null }
  | { kind: "lost" };

/** Read the POST's NDJSON to its closing line, reporting each phase on the way. */
async function readSelectStream(res: Response, onPhase: (phase: Phase) => void): Promise<StreamOutcome> {
  const consume = (line: string): StreamOutcome | null => {
    if (!line) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (payload.success === true) return { kind: "success" };
    if (typeof payload.error === "string" || typeof payload.code === "string") {
      return {
        kind: "error",
        code: typeof payload.code === "string" ? payload.code : "select_failed",
        error: typeof payload.error === "string" ? payload.error : null,
        pending: isAgent(payload.pending) ? payload.pending : null,
      };
    }
    if (isPhase(payload.phase)) onPhase(payload.phase);
    return null;
  };

  const reader = res.body?.getReader();
  if (!reader) {
    const text = typeof res.text === "function" ? await res.text() : "";
    let outcome: StreamOutcome | null = null;
    for (const line of text.split("\n")) outcome = consume(line.trim()) ?? outcome;
    return outcome ?? { kind: "lost" };
  }
  const decoder = new TextDecoder();
  let buffer = "";
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
  return consume(buffer.trim()) ?? { kind: "lost" };
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

async function fetchChoiceStatus(): Promise<EditionChoiceStatus | null> {
  try {
    const res = await fetch("/setup-api/setup/edition", { cache: "no-store", signal: timeoutSignal(STATUS_TIMEOUT_MS) });
    if (!res.ok) return null;
    return readEditionChoiceStatus(await res.json());
  } catch {
    // The web server is restarting, or the connection blinked.
    return null;
  }
}

type View =
  | { kind: "loading" }
  | { kind: "loadError" }
  | { kind: "choose" }
  | { kind: "working"; target: Agent; phase: Phase }
  | { kind: "failed"; target: Agent; pending: boolean; detail: string | null; messageKey: string | null };

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-[640px]" data-testid="setup-step-edition">
      <div className="card-surface rounded-[var(--r-3)] p-[var(--s-5)] sm:p-[var(--s-7)]">{children}</div>
    </div>
  );
}

function AgentCard({
  agent,
  selected,
  recommended,
  onSelect,
  radioName,
  t,
}: {
  agent: Agent;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
  radioName: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const uid = useId();
  const face = AGENTS[agent];
  return (
    <label
      data-testid={`edition-card-${agent}`}
      data-selected={selected ? "true" : "false"}
      className={`flex flex-col gap-[var(--s-3)] p-[var(--s-4)] rounded-[var(--r-2)] border cursor-pointer transition-colors duration-[var(--d-2)] ease-[var(--ease-standard)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--coral-bright)] ${
        selected
          ? "border-[var(--coral-bright)] bg-[var(--coral-wash)]"
          : "border-[var(--border-subtle)] bg-[var(--fill-1)] hover:bg-[var(--fill-3)]"
      }`}
    >
      <input
        type="radio"
        name={radioName}
        value={agent}
        checked={selected}
        onChange={onSelect}
        aria-labelledby={`${uid}-name`}
        aria-describedby={`${uid}-what`}
        className="sr-only"
      />
      <span className="flex items-center gap-[var(--s-3)]">
        <span
          aria-hidden="true"
          className="flex items-center justify-center w-11 h-11 rounded-[var(--r-1)] bg-[var(--fill-2)] shrink-0 overflow-hidden"
        >
          <Image src={face.logo} alt="" width={36} height={36} className="w-9 h-9 object-contain" />
        </span>
        <span className="flex-1 min-w-0 flex flex-wrap items-center gap-[var(--s-2)]">
          <span id={`${uid}-name`} className="font-semibold text-[var(--text-primary)]" style={{ fontSize: "var(--t-5)" }}>
            {face.name}
          </span>
          {recommended && (
            <span
              className="px-2 py-0.5 rounded-[var(--r-full)] bg-[var(--cyan-veil)] text-[var(--cyan-bright)]"
              style={{ fontSize: "var(--t-1)", fontWeight: "var(--w-label)" }}
            >
              {t("assistant.recommended")}
            </span>
          )}
        </span>
        <span
          aria-hidden="true"
          className={`flex items-center justify-center w-5 h-5 rounded-[var(--r-full)] border-2 shrink-0 ${
            selected ? "border-[var(--coral-bright)]" : "border-[var(--text-muted)]"
          }`}
        >
          {selected && <span className="w-2.5 h-2.5 rounded-[var(--r-full)] bg-[var(--coral-bright)]" />}
        </span>
      </span>
      <span id={`${uid}-what`} className="text-[var(--text-secondary)]" style={T_SMALL}>
        {t(face.whatKey)}
      </span>
      <span className="flex flex-col gap-[var(--s-1)]">
        <span className="text-[var(--text-muted)] uppercase tracking-wide" style={{ fontSize: "var(--t-1)", fontWeight: "var(--w-label)" }}>
          {t("assistant.goodFor")}
        </span>
        <ul className="list-none m-0 p-0 flex flex-col gap-[var(--s-1)]">
          {face.fitKeys.map((key) => (
            <li key={key} className="flex items-start gap-[var(--s-2)] text-[var(--text-primary)]" style={T_SMALL}>
              <span aria-hidden="true" className="material-symbols-rounded text-[var(--cyan-bright)] shrink-0" style={{ fontSize: 16, lineHeight: 1.4 }}>
                check
              </span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      </span>
    </label>
  );
}

interface EditionStepProps {
  /**
   * Called once the box runs the chosen agent and the web server has come
   * back after its restart — or straight away when the box turns out to need
   * no choice. Defaults to reloading the page, which resumes the wizard at
   * the Update step with the chosen agent's copy and skin.
   */
  onReady?: () => void;
  /** How often to ask the box while it works without a stream. Test seam. */
  pollMs?: number;
}

export default function EditionStep({ onReady, pollMs = DEFAULT_POLL_MS }: EditionStepProps) {
  const { t } = useT();
  const radioName = useId();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [selected, setSelected] = useState<Agent>(RECOMMENDED);
  const [hint, setHint] = useState<Agent | null>(null);
  // The server process the page is talking to, as last seen before the
  // choice: a different value afterwards means the restart has happened.
  const startedAtRef = useRef<number | null>(null);
  const aliveRef = useRef(true);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const ready = useCallback(() => {
    if (!aliveRef.current) return;
    if (readyRef.current) readyRef.current();
    else window.location.reload();
  }, []);

  /**
   * Ask the box until the activation has ended one way or the other. `success`
   * says the stream already confirmed it, so only the restart is awaited.
   */
  const follow = useCallback(async (target: Agent, success: boolean) => {
    const baseline = startedAtRef.current;
    let finishedAt: number | null = success ? Date.now() : null;
    while (aliveRef.current) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (!aliveRef.current) return;
      const status = await fetchChoiceStatus();
      if (!status) continue;
      const restarted = baseline !== null && status.serverStartedAt !== null && status.serverStartedAt !== baseline;
      if (!status.needed && !status.inProgress) {
        if (restarted) { ready(); return; }
        if (finishedAt === null) {
          finishedAt = Date.now();
          setView((v) => (v.kind === "working" ? { ...v, phase: "done" } : v));
        }
        if (Date.now() - finishedAt >= RESTART_WAIT_MS) { ready(); return; }
        continue;
      }
      if (status.inProgress) continue;
      // The box still needs a choice and nothing is running: the activation
      // ended without finishing. Where it stopped decides what "try again" is.
      const agent = status.pending ?? target;
      setSelected(agent);
      setView({ kind: "failed", target: agent, pending: status.pending !== null, detail: null, messageKey: null });
      return;
    }
  }, [pollMs, ready]);

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    const status = await fetchChoiceStatus();
    if (!aliveRef.current) return;
    if (!status) { setView({ kind: "loadError" }); return; }
    startedAtRef.current = status.serverStartedAt;
    if (!status.needed && !status.inProgress) { ready(); return; }
    setHint(status.hint);
    const preselect = status.inProgressTarget ?? status.pending ?? status.hint ?? RECOMMENDED;
    setSelected(preselect);
    if (status.inProgress) {
      setView({ kind: "working", target: preselect, phase: "request" });
      void follow(preselect, false);
      return;
    }
    if (status.pending) {
      setView({ kind: "failed", target: status.pending, pending: true, detail: null, messageKey: null });
      return;
    }
    setView({ kind: "choose" });
  }, [follow, ready]);

  useEffect(() => {
    void load();
  }, [load]);

  const start = useCallback(async (target: Agent) => {
    setView({ kind: "working", target, phase: "request" });
    let res: Response;
    try {
      res = await fetch("/setup-api/setup/edition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edition: target }),
      });
    } catch {
      // No answer at all: the request may still have reached the box.
      void follow(target, false);
      return;
    }
    if (!aliveRef.current) return;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { code?: unknown; error?: unknown };
      const code = typeof body.code === "string" ? body.code : "";
      if (code === "already_chosen") { ready(); return; }
      if (code === "busy") { void follow(target, false); return; }
      if (code === "pending_other") { void load(); return; }
      setView({
        kind: "failed",
        target,
        pending: false,
        detail: typeof body.error === "string" ? body.error : null,
        messageKey: code === "update_in_progress" ? "assistant.updateRunning" : null,
      });
      return;
    }
    let outcome: StreamOutcome;
    try {
      outcome = await readSelectStream(res, (phase) => {
        setView((v) => {
          if (v.kind !== "working") return v;
          return PHASES.indexOf(phase) > PHASES.indexOf(v.phase) ? { ...v, phase } : v;
        });
      });
    } catch {
      outcome = { kind: "lost" };
    }
    if (!aliveRef.current) return;
    if (outcome.kind === "success") {
      setView({ kind: "working", target, phase: "done" });
      void follow(target, true);
      return;
    }
    if (outcome.kind === "error" && outcome.code !== "still_running") {
      const agent = outcome.pending ?? target;
      setSelected(agent);
      setView({ kind: "failed", target: agent, pending: outcome.pending !== null, detail: outcome.error, messageKey: null });
      return;
    }
    // Still running, or the stream ended without its closing line (the
    // restart, a dropped connection): the box knows how it ends.
    void follow(target, false);
  }, [follow, load, ready]);

  if (view.kind === "loading") {
    return (
      <Card>
        <div className="flex items-center justify-center py-[var(--s-7)]">
          <div className="spinner" role="status" aria-label={t("loading")} />
        </div>
      </Card>
    );
  }

  if (view.kind === "loadError") {
    return (
      <Card>
        <h1 className="font-bold font-display mb-[var(--s-2)]" style={T_H1}>{t("assistant.title")}</h1>
        <p className="text-red-400 mb-[var(--s-6)]" style={T_LEDE}>{t("assistant.loadFailed")}</p>
        <button type="button" onClick={() => void load()} className={BTN_PRIMARY} style={T_BTN}>
          {t("retry")}
        </button>
      </Card>
    );
  }

  if (view.kind === "working") {
    const name = AGENTS[view.target].name;
    const current = view.phase === "request" ? 0 : PROGRESS_ROWS.findIndex((row) => row.phase === view.phase);
    return (
      <Card>
        <div className="flex items-center gap-[var(--s-3)] mb-[var(--s-2)]">
          <Image src={AGENTS[view.target].logo} alt="" width={36} height={36} className="w-9 h-9 object-contain" />
          <h1 className="font-bold font-display" style={T_H1} aria-live="polite">
            {t("assistant.settingUpTitle", { agent: name })}
          </h1>
        </div>
        <p className="text-[var(--text-secondary)] mb-[var(--s-5)]" style={T_LEDE}>{t("assistant.settingUpBody")}</p>
        <ol className="list-none m-0 p-0 flex flex-col gap-[var(--s-2)]" data-testid="edition-progress">
          {PROGRESS_ROWS.map((row, index) => {
            const state = index < current ? "done" : index === current ? "current" : "todo";
            return (
              <li key={row.phase} data-state={state} className="flex items-center gap-[var(--s-3)]" style={T_SMALL}>
                {state === "done" ? (
                  <span className="grid place-items-center shrink-0 w-[18px] h-[18px] rounded-[var(--r-full)] bg-[var(--cyan-bright)]">
                    <span className="material-symbols-rounded text-[#06202a]" aria-hidden="true" style={{ fontSize: 12 }}>check</span>
                  </span>
                ) : state === "current" ? (
                  <span className="grid place-items-center shrink-0 w-[18px] h-[18px]">
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent animate-spin" />
                  </span>
                ) : (
                  <span className="grid place-items-center shrink-0 w-[18px] h-[18px] rounded-[var(--r-full)] bg-[var(--fill-2)]">
                    <span className="w-1.5 h-1.5 rounded-[var(--r-full)] bg-[var(--text-muted)]" />
                  </span>
                )}
                <span
                  className={
                    state === "done"
                      ? "text-[var(--cyan-bright)]"
                      : state === "current"
                        ? "text-[var(--text-primary)]"
                        : "text-[var(--text-muted)]"
                  }
                >
                  {t(row.key, { agent: name })}
                </span>
              </li>
            );
          })}
        </ol>
      </Card>
    );
  }

  if (view.kind === "failed") {
    const name = AGENTS[view.target].name;
    const body = view.messageKey
      ? t(view.messageKey)
      : view.pending
        ? t("assistant.pendingBody", { agent: name })
        : t("assistant.failedBody");
    return (
      <Card>
        <h1 className="font-bold font-display mb-[var(--s-2)]" style={T_H1}>
          {t("assistant.failedTitle", { agent: name })}
        </h1>
        <p className="text-[var(--text-secondary)] mb-[var(--s-4)]" style={T_LEDE} data-testid="edition-failed-body">
          {body}
        </p>
        {view.detail && (
          <details className="mb-[var(--s-5)] text-[var(--text-muted)]" style={T_SMALL}>
            <summary className="cursor-pointer">{t("assistant.details")}</summary>
            <p className="mt-[var(--s-2)] break-words" data-testid="edition-failed-detail">{view.detail}</p>
          </details>
        )}
        <div className="flex flex-col sm:flex-row sm:items-center gap-[var(--s-3)]">
          <button
            type="button"
            onClick={() => void start(view.target)}
            className={BTN_PRIMARY}
            style={T_BTN}
            data-testid="edition-retry"
          >
            {t("retry")}
          </button>
          {!view.pending && (
            <button type="button" onClick={() => setView({ kind: "choose" })} className={BTN_QUIET} style={T_QUIET}>
              {t("assistant.chooseOther")}
            </button>
          )}
        </div>
      </Card>
    );
  }

  const name = AGENTS[selected].name;
  return (
    <Card>
      <h1 id={`${radioName}-title`} className="font-bold font-display mb-[var(--s-2)]" style={T_H1}>
        {t("assistant.title")}
      </h1>
      <p className="text-[var(--text-secondary)] mb-[var(--s-5)]" style={T_LEDE}>{t("assistant.lede")}</p>
      {hint && (
        <p
          className="mb-[var(--s-4)] px-[var(--s-3)] py-[var(--s-2)] rounded-[var(--r-1)] bg-[var(--cyan-veil)] text-[var(--text-primary)]"
          style={T_SMALL}
          data-testid="edition-hint"
        >
          {t("assistant.hint", { agent: AGENTS[hint].name })}
        </p>
      )}
      <div role="radiogroup" aria-labelledby={`${radioName}-title`} className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--s-3)]">
        {(["openclaw", "hermes"] as const).map((agent) => (
          <AgentCard
            key={agent}
            agent={agent}
            selected={selected === agent}
            recommended={agent === RECOMMENDED}
            onSelect={() => setSelected(agent)}
            radioName={radioName}
            t={t}
          />
        ))}
      </div>
      <p className="mt-[var(--s-4)] text-[var(--text-primary)]" style={T_SMALL}>{t("assistant.recommendLine")}</p>
      <p className="mt-[var(--s-1)] mb-[var(--s-5)] text-[var(--text-muted)]" style={T_SMALL}>{t("assistant.changeLater")}</p>
      <button
        type="button"
        onClick={() => void start(selected)}
        className={BTN_PRIMARY}
        style={T_BTN}
        data-testid="edition-continue"
      >
        {t("assistant.continue", { agent: name })}
      </button>
    </Card>
  );
}
