"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyCodingAgentChanged, onCodingAgentChanged } from "@/lib/ui-events";
import { BOX_SCOPE, MIN_SECRET_VALUE_CHARS, SECRET_NAME_RE } from "@/lib/project-secrets-shape";
import { BTN_QUIET, BTN_SECONDARY, CARD, FIELD, INSET_SURFACE } from "./coding-agent-ui";
import CodingAgentSwitch from "./CodingAgentSwitch";
import HelpTip from "./HelpTip";

/**
 * Settings → Coding Agent → "Secrets": the credentials the owner keeps on the
 * box for a delegated run — a deploy token, a test-mode API key, an SSH target.
 *
 * WHAT IT NEVER DOES: show a value. Not after a save, not on a re-read, not in
 * a disabled field with dots in it. The store is write-only from every surface
 * (src/lib/project-secrets.ts) and there is no route that would answer with
 * one, so an input that looked as though it held the saved value would be a
 * lie about what the box can tell you. Replacing a rotated token means typing
 * it again, which is the honest shape.
 *
 * THREE THINGS ON ONE CARD, because they are one decision made in three parts:
 *   - the MASTER SWITCH, which is the consent. Off — the default — every entry
 *     is stored and no run is handed any of them.
 *   - the LIST, each row with its scope and its own tick. A row's tick decides
 *     whether that entry is offered at all; the scope decides which runs it
 *     reaches.
 *   - the ADD form, with the scope picker.
 *
 * And, for the OWNER only, "Import from assistant": a picker of the NAMES of
 * keys the main assistant already holds, which copies one into this list
 * server-side (src/lib/assistant-secrets.ts). The value never reaches the
 * browser — not in the picker, not in the answer — and the copy arrives
 * un-ticked, so the three parts above still decide whether a run gets it. The
 * picker can also limit the copy to one run or to a last day (none by
 * default), and the row then says so — or that it no longer reaches a run. The
 * button is drawn only when the import route answers this session with a
 * source to copy from: another ClawBox user, a box without one, or a box with
 * the feature switched off sees the card exactly as before.
 *
 * Its own component and its own reads and writes, like CodingAgentRulesCard:
 * the settings panel serialises its writes through one chain so two answers
 * cannot land out of order, and a list with an add, a remove and a per-row
 * toggle does not belong in that chain. Every write answers with the whole
 * re-read payload, so what is on screen is the box's own answer.
 */

/** One row of the owner's list. Never a value — see the header. */
interface SecretRow {
  name: string;
  scope: string;
  createdAt: number;
  updatedAt: number;
  inject: boolean;
  readable: boolean;
  /** A copy's expiry: "run" or an ISO instant (SecretExpiry). Absent for most rows. */
  expiresAt?: string;
  /** No run will be handed it again — see SecretView. */
  expired?: boolean;
}

/** The import picker's expiry choice. "none" is the default and sends nothing. */
type ImportExpiry = "none" | "run" | "date";

/** Today in the browser's own calendar, as a date input writes it (YYYY-MM-DD). */
function todayInput(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * The end of the chosen day in the owner's own time zone, as the instant the
 * box stores — "until the 25th" means through the 25th where the owner is. Null
 * for a day that is not one, or that is already over.
 */
function endOfDay(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  if (Number.isNaN(end.getTime()) || end.getDate() !== Number(m[3]) || end.getTime() <= Date.now()) return null;
  return end.toISOString();
}

interface SecretsPayload {
  secrets?: unknown;
  max?: unknown;
  maxValueChars?: unknown;
  injectSecrets?: unknown;
  error?: string;
  code?: string;
}

interface ProjectOption {
  /** The project's identity, which is also the scope a secret is saved under. */
  folder: string;
  name: string;
}

function isSecretRow(value: unknown): value is SecretRow {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.name === "string" && typeof r.scope === "string" && typeof r.inject === "boolean";
}

function rowsOf(payload: SecretsPayload): SecretRow[] {
  return Array.isArray(payload.secrets)
    ? payload.secrets.filter(isSecretRow).map((r) => ({ ...r, readable: r.readable !== false }))
    : [];
}

/** The projects route answers a bare array or `{ projects }`; both read alike. */
function projectsOf(data: unknown): ProjectOption[] {
  const list = Array.isArray(data) ? data : (data as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => {
    const row = p as Record<string, unknown> | null;
    return row && typeof row.folder === "string" && typeof row.name === "string"
      ? [{ folder: row.folder, name: row.name }]
      : [];
  });
}

/** One key the assistant holds, by NAME. Never a value — see the header. */
interface AssistantKey {
  name: string;
  source: string;
}

/**
 * The import route's answer, or null when there is nothing to offer: a refusal
 * (not the owner, switched off), an older box without the route, or a box
 * whose assistant keeps nothing this box can copy (`sources` empty).
 */
function assistantKeysOf(data: unknown): AssistantKey[] | null {
  const d = data as { names?: unknown; sources?: unknown } | null;
  if (!d || !Array.isArray(d.sources) || d.sources.length === 0 || !Array.isArray(d.names)) return null;
  return d.names.flatMap((n) => {
    const row = n as Record<string, unknown> | null;
    return row && typeof row.name === "string" && SECRET_NAME_RE.test(row.name)
      ? [{ name: row.name, source: typeof row.source === "string" ? row.source : "" }]
      : [];
  });
}

/**
 * What the import route told this session: the keys to offer, null for nothing
 * to offer (see `assistantKeysOf`), or "unreadable" — the owner's session on a
 * box with a source whose key file could not be read, which is said on the
 * card rather than hidden behind a missing button.
 */
type AssistantKeys = AssistantKey[] | null | "unreadable";

async function fetchAssistantKeys(): Promise<AssistantKeys | undefined> {
  try {
    const res = await fetch("/setup-api/coding-agent/secrets/import", { cache: "no-store" });
    if (res.ok) return assistantKeysOf(await res.json());
    const refusal = await res.json().catch(() => null) as { code?: unknown } | null;
    return refusal?.code === "source_unreadable" ? "unreadable" : null;
  } catch {
    // No answer at all (the network blinked) is not "nothing to offer": the
    // caller keeps what it last knew rather than taking the import away.
    return undefined;
  }
}

/** A row's key: one name may exist once per scope, so both name it. */
function rowKey(row: { name: string; scope: string }): string {
  return `${row.scope}/${row.name}`;
}

export default function CodingAgentSecretsCard() {
  const { t } = useT();
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [max, setMax] = useState(64);
  const [maxValueChars, setMaxValueChars] = useState(8_192);
  const [injectSecrets, setInjectSecrets] = useState(false);
  /** False until the first read is back, so an empty list is not claimed early. */
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState(BOX_SCOPE);
  /** Which control is mid-write: the master switch, a row's key, or the add. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** The assistant's key names, null when this session is offered no import, or "unreadable". */
  const [assistantKeys, setAssistantKeys] = useState<AssistantKeys>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState("");
  const [importScope, setImportScope] = useState(BOX_SCOPE);
  const [importExpiry, setImportExpiry] = useState<ImportExpiry>("none");
  const [importUntil, setImportUntil] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const apply = useCallback((payload: SecretsPayload) => {
    setRows(rowsOf(payload));
    if (typeof payload.max === "number" && payload.max > 0) setMax(payload.max);
    if (typeof payload.maxValueChars === "number" && payload.maxValueChars > 0) setMaxValueChars(payload.maxValueChars);
    if (typeof payload.injectSecrets === "boolean") setInjectSecrets(payload.injectSecrets);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/coding-agent/secrets", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      apply(await res.json() as SecretsPayload);
      setError(null);
      // ONLY here, never in a `finally`. `loaded` is what unlocks the add form
      // and the master switch, and it is what turns "no rows yet" into "this
      // box has no secrets". A failed FIRST read that set it would draw the
      // empty state over a list nobody could see and enable Save over it — and
      // a save replaces an entry of the same name and scope, so the owner
      // could overwrite a credential the card never showed them (found in
      // review). A read that failed leaves the card locked and says so.
      setLoaded(true);
    } catch {
      // The card keeps what it last knew rather than claiming the list is
      // empty — the same reasoning as the rules card's: an empty list invites
      // the owner to re-enter a credential that is already there.
      setError(t("codingAgent.secretsFailed"));
    }
  }, [apply, t]);

  useEffect(() => { void load(); }, [load]);
  // The master switch is also reachable from the panel's own status, and a
  // reset clears it: follow the event the app raises either way.
  useEffect(() => onCodingAgentChanged(() => { void load(); }), [load]);

  // The scope picker's options. Read once: a project appearing while this card
  // is open is not worth a poll, and the box scope is always there.
  useEffect(() => {
    let active = true;
    fetch("/setup-api/coding-agent/projects", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (active) setProjects(projectsOf(data)); })
      .catch(() => { /* the box scope alone is a working card */ });
    return () => { active = false; };
  }, []);

  // The assistant's key NAMES. Asked on mount, so the button is only drawn for
  // a session the route will answer, and again each time the picker opens, so
  // a key added to the assistant meanwhile is offered.
  useEffect(() => {
    let active = true;
    void fetchAssistantKeys().then((keys) => { if (active && keys !== undefined) setAssistantKeys(keys); });
    return () => { active = false; };
  }, []);

  /**
   * The refusal, worded here when the box sent a code this build knows.
   *
   * The store answers a stable `code` beside its own English sentence; the code
   * is what this card can say in the owner's language, and the sentence is the
   * fallback for a code this build has not heard of — an older box, a newer
   * route.
   */
  const refusalText = (payload: SecretsPayload | null): string => {
    const key = payload?.code ? REFUSAL_KEYS[payload.code] : undefined;
    // `n` for the too-short sentence, which an import can reach as well as the
    // add form; a sentence without the placeholder ignores it.
    if (key) return t(key, { n: MIN_SECRET_VALUE_CHARS });
    return payload?.error || t("codingAgent.secretsFailed");
  };

  const write = async (init: RequestInit, url: string, which: string): Promise<boolean> => {
    setBusy(which);
    setError(null);
    setSaved(null);
    setCopied(null);
    try {
      const res = await fetch(url, init);
      const payload = await res.json().catch(() => null) as SecretsPayload | null;
      if (!res.ok) throw new Error(refusalText(payload));
      if (payload) apply(payload);
      // The panel's own status carries `injectSecrets`, and a second window's
      // card reads the same list.
      notifyCodingAgentChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.secretsFailed"));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const trimmedName = name.trim().toUpperCase();
    if (!SECRET_NAME_RE.test(trimmedName)) {
      setError(t("codingAgent.secretsRefusedName"));
      return;
    }
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      setError(t("codingAgent.secretsRefusedEmpty"));
      return;
    }
    // The same floor the store enforces, checked here so the owner is told
    // before a credential leaves the browser.
    if (trimmedValue.length < MIN_SECRET_VALUE_CHARS) {
      setError(t("codingAgent.secretsRefusedShort", { n: MIN_SECRET_VALUE_CHARS }));
      return;
    }
    const ok = await write(
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Ticked on the way in: the owner saving a secret for a run means it to
        // be used, and the master switch above is the gate that makes that a
        // consent rather than an assumption.
        body: JSON.stringify({ name: trimmedName, value, scope, inject: true }),
      },
      "/setup-api/coding-agent/secrets",
      "add",
    );
    if (ok) {
      // Cleared at once, and the value is never read back into it.
      setName("");
      setValue("");
      setSaved(trimmedName);
    }
  };

  const toggleRow = (row: SecretRow) => write(
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: row.name, scope: row.scope, inject: !row.inject }),
    },
    "/setup-api/coding-agent/secrets",
    rowKey(row),
  );

  const remove = (row: SecretRow) => write(
    { method: "DELETE" },
    `/setup-api/coding-agent/secrets?name=${encodeURIComponent(row.name)}&scope=${encodeURIComponent(row.scope)}`,
    rowKey(row),
  );

  /** Already in the list under that name for that scope — the copy would be refused. */
  const isHere = (keyName: string, keyScope: string): boolean =>
    rows.some((row) => row.name === keyName && row.scope === keyScope);

  // The picker's choice: the one the owner picked while it is still offered and
  // not already here, else the first that can be copied. Derived rather than
  // kept in sync by an effect, so a re-read list can never leave it stale.
  const importChoice = (() => {
    const keys = Array.isArray(assistantKeys) ? assistantKeys : [];
    if (importName && keys.some((k) => k.name === importName) && !isHere(importName, importScope)) return importName;
    return keys.find((k) => !isHere(k.name, importScope))?.name ?? "";
  })();

  /** Ask again what is on offer; no answer at all keeps what the card last knew. */
  const refreshAssistantKeys = () => {
    void fetchAssistantKeys().then((keys) => { if (keys !== undefined) setAssistantKeys(keys); });
  };

  const openImport = () => {
    setImportOpen(true);
    setError(null);
    setCopied(null);
    // Every opening starts from "no expiry": a choice left behind by a Cancel
    // must not ride along on the next copy unseen.
    setImportExpiry("none");
    setImportUntil("");
    refreshAssistantKeys();
    // And the list itself: a one-run copy goes when its run ends, and the
    // picker must not keep calling that name "already here".
    void load();
  };

  const copyFromAssistant = async () => {
    if (!importChoice) return;
    const name = importChoice;
    let expiresAt: string | undefined;
    if (importExpiry === "run") expiresAt = "run";
    if (importExpiry === "date") {
      const until = endOfDay(importUntil);
      if (!until) {
        setError(t("codingAgent.secretsImportUntilInvalid"));
        return;
      }
      expiresAt = until;
    }
    const ok = await write(
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The name, the scope and the expiry, and nothing else: the box reads
        // the value itself and never sends it here.
        body: JSON.stringify({ name, scope: importScope, ...(expiresAt ? { expiresAt } : {}) }),
      },
      "/setup-api/coding-agent/secrets/import",
      "import",
    );
    if (ok) {
      setImportOpen(false);
      setImportName("");
      setImportExpiry("none");
      setImportUntil("");
      setCopied(name);
    } else {
      // A refusal can mean the assistant's side moved — the key gone from its
      // file, the feature switched off — so ask again what is on offer rather
      // than keep offering the same refused name. The refusal stays on screen.
      refreshAssistantKeys();
    }
  };

  const expiryText = (row: SecretRow): string => {
    if (row.expiresAt === "run") return t(row.expired ? "codingAgent.secretsExpiryUsed" : "codingAgent.secretsExpiryRun");
    if (row.expired) return t("codingAgent.secretsExpired");
    const until = new Date(row.expiresAt ?? "");
    return Number.isNaN(until.getTime())
      ? t("codingAgent.secretsExpired")
      : t("codingAgent.secretsExpiryUntil", { date: until.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) });
  };

  const scopeLabel = (s: string): string => {
    if (s === BOX_SCOPE) return t("codingAgent.secretsScopeBox");
    const project = projects.find((p) => p.folder === s);
    return project ? project.name : s;
  };

  // Locked until the first read came back: see `load`. `full` is the other
  // reason the form is closed, and the count beside the title explains it.
  const full = rows.length >= max;
  const formLocked = !loaded || busy !== null || full;

  return (
    <div className={CARD} data-testid="coding-agent-secrets-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium text-[var(--text-secondary)]">{t("codingAgent.secretsTitle")}</span>
          <HelpTip
            text={t("codingAgent.secretsHint")}
            label={t("codingAgent.secretsTitle")}
            testId="coding-agent-secrets-help"
          />
        </div>
        <span className="text-[11px] text-[var(--text-muted)] shrink-0" data-testid="coding-agent-secrets-count">
          {t("codingAgent.secretsCount", { n: rows.length, max })}
        </span>
      </div>

      {/* THE CONSENT. Above the list, because it governs every row in it: with
          this off, a ticked row is stored and still handed to nobody. */}
      <div className={`${INSET_SURFACE} mt-3 px-3 py-2.5 flex items-center justify-between gap-3`}>
        <div className="min-w-0">
          <span className="text-xs text-[var(--text-secondary)]">{t("codingAgent.secretsInjectLabel")}</span>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)] leading-relaxed">
            {t("codingAgent.secretsInjectHint")}
          </p>
        </div>
        <CodingAgentSwitch
          checked={injectSecrets}
          busy={busy === "inject"}
          disabled={!loaded || (busy !== null && busy !== "inject")}
          label={t("codingAgent.secretsInjectLabel")}
          testId="coding-agent-secrets-inject"
          onChange={(next) => void write(
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ injectSecrets: next }) },
            // The store's own route, not `enable`: this switch is the consent
            // for handing credentials to an unattended shell, and that route
            // carries the same-origin check the others do not need.
            "/setup-api/coding-agent/secrets",
            "inject",
          )}
        />
      </div>

      {loaded && rows.length === 0 ? (
        <p className="mt-3 text-[11px] text-[var(--text-muted)] leading-relaxed" data-testid="coding-agent-secrets-empty">
          {t("codingAgent.secretsEmpty")}
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {rows.map((row) => (
            <li
              key={rowKey(row)}
              className={`${INSET_SURFACE} px-3 py-2 flex items-center justify-between gap-3`}
              data-testid="coding-agent-secret-row"
            >
              <div className="min-w-0">
                <code className="text-[11px] font-mono text-[var(--text-secondary)] break-all">{row.name}</code>
                <p className="mt-0.5 text-[11px] text-[var(--text-muted)] truncate">{scopeLabel(row.scope)}</p>
                {/* Only ever drawn when it is a problem: a row sealed under a
                    key this box no longer has cannot be handed to a run, and
                    the only fix is to type the value again. */}
                {!row.readable && (
                  <p className="mt-0.5 text-[11px] text-amber-300 leading-relaxed" data-testid="coding-agent-secret-unreadable">
                    {t("codingAgent.secretsUnreadable")}
                  </p>
                )}
                {/* A copy the owner limited: how long it may still reach runs,
                    or that it no longer reaches any. */}
                {(row.expiresAt || row.expired) && (
                  <p
                    className={`mt-0.5 text-[11px] leading-relaxed ${row.expired ? "text-amber-300" : "text-[var(--text-muted)]"}`}
                    data-testid="coding-agent-secret-expiry"
                  >
                    {expiryText(row)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <CodingAgentSwitch
                  checked={row.inject}
                  busy={busy === rowKey(row)}
                  disabled={busy !== null && busy !== rowKey(row)}
                  label={t("codingAgent.secretsRowInject", { name: row.name })}
                  testId="coding-agent-secret-inject"
                  onChange={() => void toggleRow(row)}
                />
                <button
                  type="button"
                  onClick={() => void remove(row)}
                  disabled={busy !== null}
                  aria-label={t("codingAgent.secretsRemoveOne", { name: row.name })}
                  data-testid="coding-agent-secret-remove"
                  className={BTN_QUIET}
                >
                  {t("codingAgent.secretsRemove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Adding one. Disabled at the cap rather than hidden, so the count
          beside the title explains why nothing can be added. */}
      <div className="mt-3 space-y-1.5">
        <label htmlFor="coding-agent-secret-name" className="text-xs font-medium text-[var(--text-secondary)]">
          {t("codingAgent.secretsAddLabel")}
        </label>
        <input
          id="coding-agent-secret-name"
          type="text"
          value={name}
          spellCheck={false}
          autoCapitalize="characters"
          autoCorrect="off"
          placeholder={t("codingAgent.secretsNamePlaceholder")}
          aria-label={t("codingAgent.secretsNameLabel")}
          onChange={(e) => setName(e.target.value)}
          disabled={formLocked}
          data-testid="coding-agent-secret-name"
          className={`w-full text-base sm:text-xs ${FIELD}`}
        />
        <input
          id="coding-agent-secret-value"
          // `password`, so it is not read out by a screen reader standing over
          // the owner's shoulder and not offered to a password manager's
          // autofill as a plain field. It is cleared on save and never re-read.
          type="password"
          value={value}
          spellCheck={false}
          autoComplete="new-password"
          maxLength={maxValueChars}
          placeholder={t("codingAgent.secretsValuePlaceholder")}
          // A placeholder is not a label: it is gone the moment the owner types
          // and it is not an accessible name. Both fields carry one of their
          // own, because the one visible `<label>` above belongs to the group
          // rather than to either input (found in review).
          aria-label={t("codingAgent.secretsValueLabel")}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          disabled={formLocked}
          data-testid="coding-agent-secret-value"
          className={`w-full text-base sm:text-xs ${FIELD}`}
        />
        <div className="flex items-center gap-1.5">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={formLocked}
            aria-label={t("codingAgent.secretsScopeLabel")}
            data-testid="coding-agent-secret-scope"
            className={`flex-1 min-w-0 text-base sm:text-xs ${FIELD}`}
          >
            <option value={BOX_SCOPE}>{t("codingAgent.secretsScopeBox")}</option>
            {projects.map((p) => (
              <option key={p.folder} value={p.folder}>{p.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void add()}
            disabled={formLocked}
            data-testid="coding-agent-secret-add"
            className={`${BTN_SECONDARY} shrink-0`}
          >
            {t("codingAgent.secretsAdd")}
          </button>
        </div>
      </div>

      {/* Import from assistant — the owner's only, and only where there is a
          source to copy from (see the header). Names in, names out. */}
      {assistantKeys === "unreadable" && (
        <p className="mt-3 text-[11px] text-[var(--text-muted)] leading-relaxed" data-testid="coding-agent-secrets-import-unreadable">
          {t("codingAgent.secretsImportSourceFailed")}
        </p>
      )}
      {Array.isArray(assistantKeys) && (
        <div className="mt-3" data-testid="coding-agent-secrets-import">
          {!importOpen ? (
            <button
              type="button"
              onClick={openImport}
              disabled={formLocked}
              data-testid="coding-agent-secrets-import-open"
              className={BTN_QUIET}
            >
              {t("codingAgent.secretsImportOpen")}
            </button>
          ) : (
            <div className={`${INSET_SURFACE} px-3 py-2.5 space-y-1.5`} data-testid="coding-agent-secrets-import-picker">
              <p className="text-xs font-medium text-[var(--text-secondary)]">{t("codingAgent.secretsImportOpen")}</p>
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t("codingAgent.secretsImportHint")}</p>
              {assistantKeys.length === 0 ? (
                <p className="text-[11px] text-[var(--text-muted)] leading-relaxed" data-testid="coding-agent-secrets-import-empty">
                  {t("codingAgent.secretsImportEmpty")}
                </p>
              ) : (
                <div className="flex flex-col sm:flex-row gap-1.5">
                  <select
                    value={importChoice}
                    onChange={(e) => setImportName(e.target.value)}
                    disabled={busy !== null}
                    aria-label={t("codingAgent.secretsImportNameLabel")}
                    data-testid="coding-agent-secrets-import-name"
                    className={`flex-1 min-w-0 text-base sm:text-xs font-mono ${FIELD}`}
                  >
                    {importChoice === "" && <option value="">{t("codingAgent.secretsImportNoneLeft")}</option>}
                    {assistantKeys.map((k) => {
                      const here = isHere(k.name, importScope);
                      return (
                        <option key={k.name} value={k.name} disabled={here}>
                          {here ? t("codingAgent.secretsImportHere", { name: k.name }) : k.name}
                        </option>
                      );
                    })}
                  </select>
                  <select
                    value={importScope}
                    onChange={(e) => setImportScope(e.target.value)}
                    disabled={busy !== null}
                    aria-label={t("codingAgent.secretsScopeLabel")}
                    data-testid="coding-agent-secrets-import-scope"
                    className={`flex-1 min-w-0 text-base sm:text-xs ${FIELD}`}
                  >
                    <option value={BOX_SCOPE}>{t("codingAgent.secretsScopeBox")}</option>
                    {projects.map((p) => (
                      <option key={p.folder} value={p.folder}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* How long the copy may reach runs. None by default: the copy is
                  inert until ticked whatever is picked here. */}
              {assistantKeys.length > 0 && (
                <div className="flex flex-col sm:flex-row gap-1.5">
                  <select
                    value={importExpiry}
                    onChange={(e) => setImportExpiry(e.target.value as ImportExpiry)}
                    disabled={busy !== null}
                    aria-label={t("codingAgent.secretsImportExpiryLabel")}
                    data-testid="coding-agent-secrets-import-expiry"
                    className={`flex-1 min-w-0 text-base sm:text-xs ${FIELD}`}
                  >
                    <option value="none">{t("codingAgent.secretsImportExpiryNone")}</option>
                    <option value="run">{t("codingAgent.secretsImportExpiryRun")}</option>
                    <option value="date">{t("codingAgent.secretsImportExpiryDate")}</option>
                  </select>
                  {importExpiry === "date" && (
                    <input
                      type="date"
                      value={importUntil}
                      min={todayInput()}
                      onChange={(e) => setImportUntil(e.target.value)}
                      disabled={busy !== null}
                      aria-label={t("codingAgent.secretsImportUntilLabel")}
                      data-testid="coding-agent-secrets-import-until"
                      className={`flex-1 min-w-0 text-base sm:text-xs ${FIELD}`}
                    />
                  )}
                </div>
              )}
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setImportOpen(false)}
                  disabled={busy === "import"}
                  data-testid="coding-agent-secrets-import-cancel"
                  className={BTN_QUIET}
                >
                  {t("codingAgent.secretsImportCancel")}
                </button>
                {assistantKeys.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void copyFromAssistant()}
                    disabled={busy !== null || !importChoice || full}
                    data-testid="coding-agent-secrets-import-copy"
                    className={`${BTN_SECONDARY} shrink-0`}
                  >
                    {t("codingAgent.secretsImportCopy")}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* The name it was saved under, and nothing about the value — the one
          confirmation this card can honestly give. */}
      {saved && (
        <p className="mt-2 text-[11px] text-emerald-300" data-testid="coding-agent-secrets-saved">
          {t("codingAgent.secretsSaved", { name: saved })}
        </p>
      )}
      {copied && (
        <p className="mt-2 text-[11px] text-emerald-300" data-testid="coding-agent-secrets-imported">
          {t("codingAgent.secretsImported", { name: copied })}
        </p>
      )}

      {/* Announced, like the rules card's: a refusal is only ever rendered
          after the route has answered. */}
      {error && (
        <p role="alert" className="mt-2 text-[11px] text-red-300" data-testid="coding-agent-secrets-error">{error}</p>
      )}
    </div>
  );
}

/**
 * The store's refusal codes, as catalogue keys.
 *
 * The same shape as ALLOW_RULE_REFUSAL_KEYS and for the same reason: the route
 * answers a code beside an English sentence, and only the code can be worded in
 * the owner's language. A code missing from this table falls back to the box's
 * own sentence rather than to silence.
 */
const REFUSAL_KEYS: Record<string, string> = {
  invalid_name: "codingAgent.secretsRefusedName",
  reserved_name: "codingAgent.secretsRefusedReserved",
  invalid_scope: "codingAgent.secretsRefusedScope",
  invalid_value: "codingAgent.secretsRefusedEmpty",
  value_too_long: "codingAgent.secretsRefusedLong",
  value_too_short: "codingAgent.secretsRefusedShort",
  full: "codingAgent.secretsRefusedFull",
  not_found: "codingAgent.secretsRefusedGone",
  exists: "codingAgent.secretsRefusedExists",
  not_importable: "codingAgent.secretsRefusedNotImportable",
  not_held: "codingAgent.secretsImportGone",
  source_unreadable: "codingAgent.secretsImportSourceFailed",
  disabled: "codingAgent.secretsImportDisabled",
  invalid_expiry: "codingAgent.secretsImportUntilInvalid",
  store_unreadable: "codingAgent.secretsStoreFailed",
  store_unwritable: "codingAgent.secretsStoreFailed",
  key_unavailable: "codingAgent.secretsKeyFailed",
  malformed: "codingAgent.secretsFailed",
};
