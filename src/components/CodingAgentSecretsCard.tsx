"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyCodingAgentChanged, onCodingAgentChanged } from "@/lib/ui-events";
import { BOX_SCOPE, SECRET_NAME_RE } from "@/lib/project-secrets-shape";
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
    } catch {
      // The card keeps what it last knew rather than claiming the list is
      // empty — the same reasoning as the rules card's: an empty list invites
      // the owner to re-enter a credential that is already there.
      setError(t("codingAgent.secretsFailed"));
    } finally {
      setLoaded(true);
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
    if (key) return t(key);
    return payload?.error || t("codingAgent.secretsFailed");
  };

  const write = async (init: RequestInit, url: string, which: string): Promise<boolean> => {
    setBusy(which);
    setError(null);
    setSaved(null);
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
    if (!value.trim()) {
      setError(t("codingAgent.secretsRefusedEmpty"));
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

  const scopeLabel = (s: string): string => {
    if (s === BOX_SCOPE) return t("codingAgent.secretsScopeBox");
    const project = projects.find((p) => p.folder === s);
    return project ? project.name : s;
  };

  const full = rows.length >= max;

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
            "/setup-api/coding-agent/enable",
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
          onChange={(e) => setName(e.target.value)}
          disabled={busy !== null || full}
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
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          disabled={busy !== null || full}
          data-testid="coding-agent-secret-value"
          className={`w-full text-base sm:text-xs ${FIELD}`}
        />
        <div className="flex items-center gap-1.5">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={busy !== null || full}
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
            disabled={busy !== null || full}
            data-testid="coding-agent-secret-add"
            className={`${BTN_SECONDARY} shrink-0`}
          >
            {t("codingAgent.secretsAdd")}
          </button>
        </div>
      </div>

      {/* The name it was saved under, and nothing about the value — the one
          confirmation this card can honestly give. */}
      {saved && (
        <p className="mt-2 text-[11px] text-emerald-300" data-testid="coding-agent-secrets-saved">
          {t("codingAgent.secretsSaved", { name: saved })}
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
  full: "codingAgent.secretsRefusedFull",
  not_found: "codingAgent.secretsRefusedGone",
  store_unreadable: "codingAgent.secretsStoreFailed",
  store_unwritable: "codingAgent.secretsStoreFailed",
  key_unavailable: "codingAgent.secretsKeyFailed",
  malformed: "codingAgent.secretsFailed",
};
