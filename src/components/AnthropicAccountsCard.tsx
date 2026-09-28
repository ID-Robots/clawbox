"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatAccountReset } from "@/lib/anthropic-chat-swap";
import { useT } from "@/lib/i18n";

/**
 * Settings → Providers → Anthropic accounts (TASK-902, TASK-1260).
 *
 * More than one Anthropic account on the box, in the owner's order, and ONE of
 * them active: every Claude consumer on the box — coding runs, the chat's
 * gateway and its scheduled tasks — uses it. When it hits its usage limit, or
 * Anthropic refuses its credential, all of them move to the next account
 * together and the interrupted work carries on (src/lib/anthropic-swap.ts);
 * the box stays there unless the owner turned on "return to the first
 * account". This card is where the owner sees that happen — which account is
 * active, which is limited and until when, the last swap and what each
 * consumer did about it — and where accounts are connected, ordered (the first
 * usable one in a new order becomes active), renamed, re-authenticated and
 * removed.
 *
 * A Claude account is connected through the box's EXISTING Anthropic sign-in
 * (`/setup-api/ai-models/oauth/start` → the owner pastes the code Anthropic
 * shows → `…/exchange`), which leaves the tokens in the server's handoff file;
 * the accounts route takes them from there. No token ever reaches this page:
 * the route answers labels and states, and a pasted API key is cleared from
 * the field the moment it has landed.
 */

type AccountKind = "oauth" | "api_key" | "login";
type AccountStatus = "ok" | "limited" | "expired" | "revoked";

interface AccountView {
  id: string;
  label: string;
  email: string | null;
  kind: AccountKind;
  status: AccountStatus;
  limitedUntil: number | null;
  priority: number;
  active: boolean;
}

type SwapCause = "limit" | "auth" | "reset" | "owner" | "removed" | "added" | "renewed";
type ConsumerName = "coding" | "gateway" | "retries";

interface ConsumerOutcome {
  status: "ok" | "skipped" | "failed" | "pending";
  code: string | null;
  count: number | null;
}

interface SwapView {
  at: number;
  fromLabel: string | null;
  toLabel: string | null;
  cause: SwapCause;
  limitedUntil: number | null;
  nextResetAt: number | null;
  consumers: Partial<Record<ConsumerName, ConsumerOutcome>>;
}

interface PoolView {
  accounts: AccountView[];
  health: { total: number; healthy: number; limited: number; allLimited: boolean; nextResetAt: number | null };
  activeAccountId: string | null;
  loginAvailable: boolean;
  /** TASK-1260 — absent from an older server's answer. */
  returnToPrimary?: boolean;
  lastSwap?: SwapView | null;
  /** POST only. */
  verified?: boolean;
}

const CAUSE_KEY: Record<SwapCause, string> = {
  limit: "settings.anthropicAccounts.reasonLimitNoTime",
  auth: "settings.anthropicAccounts.reasonAuth",
  reset: "settings.anthropicAccounts.reasonReset",
  owner: "settings.anthropicAccounts.reasonOwner",
  removed: "settings.anthropicAccounts.reasonRemoved",
  added: "settings.anthropicAccounts.reasonAdded",
  renewed: "settings.anthropicAccounts.reasonRenewed",
};

const CONSUMER_KEY: Record<ConsumerName, string> = {
  coding: "settings.anthropicAccounts.consumerCoding",
  gateway: "settings.anthropicAccounts.consumerGateway",
  retries: "settings.anthropicAccounts.consumerRetries",
};

/** A consumer's fixed outcome word, as the owner reads it. Never a process's own text. */
function outcomeKey(outcome: ConsumerOutcome): string {
  if (outcome.status === "pending") return outcome.code === "waiting_for_reset" ? "settings.anthropicAccounts.outcomeHeld" : "settings.anthropicAccounts.outcomePending";
  if (outcome.status === "failed") return "settings.anthropicAccounts.outcomeFailed";
  switch (outcome.code) {
    case "moved": return "settings.anthropicAccounts.outcomeMoved";
    case "nothing_running": return "settings.anthropicAccounts.outcomeNothing";
    case "switched":
    case "renewed":
    case "already": return "settings.anthropicAccounts.outcomeSwitched";
    case "retried": return "settings.anthropicAccounts.outcomeRetried";
    case "not_transferable": return "settings.anthropicAccounts.outcomeNotTransferable";
    default: return "settings.anthropicAccounts.outcomeNotAffected";
  }
}

/** What the connect panel is doing: adding an account, or signing one in again. */
type Panel =
  | { mode: "connect"; method: "oauth" | "key" }
  | { mode: "reauth"; method: "oauth" | "key"; id: string; label: string };

/** How often the card re-reads while it is on screen — a limit's state changes on its own clock. */
const POLL_MS = 30_000;
/** How long the two-tap Remove stays armed. */
const CONFIRM_MS = 5_000;

const KIND_KEY: Record<AccountKind, string> = {
  oauth: "settings.anthropicAccounts.kindOauth",
  api_key: "settings.anthropicAccounts.kindApiKey",
  login: "settings.anthropicAccounts.kindLogin",
};

/** A reset in the owner's own clock, with the weekday when it is not today. */
const formatReset = formatAccountReset;

export default function AnthropicAccountsCard() {
  const { t, locale } = useT();
  const [view, setView] = useState<PoolView | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [signInOpened, setSignInOpened] = useState(false);
  const [code, setCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Writes started — a read issued before one is dropped, like the Coding Agent's own card. */
  const writes = useRef(0);

  const load = useCallback(async () => {
    const issuedAt = writes.current;
    try {
      const res = await fetch("/setup-api/anthropic/accounts", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = await res.json() as PoolView;
      if (writes.current !== issuedAt) return;
      setView(next);
      setReadFailed(false);
    } catch {
      // Keep what the card last knew rather than claiming the accounts are gone.
      if (writes.current === issuedAt) setReadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  /**
   * The two refusals a re-authentication with the WRONG Claude account earns,
   * in the owner's language, built from the facts the route sends beside its
   * English sentence. Null for any other answer, which keeps that sentence.
   */
  const localRefusal = (code: unknown, details: unknown): string | null => {
    if (!details || typeof details !== "object") return null;
    const d = details as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v ? v : null);
    const signedIn = text(d.signedIn);
    const expected = text(d.expected);
    const label = text(d.label);
    if (code === "wrong_account" && signedIn && expected && label) {
      return t("settings.anthropicAccounts.refusedWrongAccount", { signedIn, expected, label });
    }
    if (code === "duplicate" && signedIn && label) return t("settings.anthropicAccounts.refusedDuplicate", { signedIn, label });
    return null;
  };

  const readError = async (res: Response): Promise<string> => {
    try {
      const body = await res.json() as { error?: unknown; code?: unknown; details?: unknown };
      const local = localRefusal(body.code, body.details);
      // `t` answers the bare key until the locale pack has loaded.
      if (local && !local.startsWith("settings.")) return local;
      return typeof body.error === "string" && body.error.trim() ? body.error : t("settings.anthropicAccounts.actionFailed");
    } catch {
      return t("settings.anthropicAccounts.actionFailed");
    }
  };

  /** One write to the accounts route; answers the re-read pool, or null after saying why it failed. */
  const act = async (body: Record<string, unknown>, tag: string): Promise<PoolView | null> => {
    writes.current += 1;
    setBusy(tag);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/setup-api/anthropic/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      const next = await res.json() as PoolView;
      setView(next);
      setReadFailed(false);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.anthropicAccounts.actionFailed"));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const closePanel = () => {
    // The panel's refusal goes with the panel: after Cancel it would sit over
    // the list describing a key or a code that is no longer on screen.
    setError(null);
    setPanel(null);
    setSignInOpened(false);
    setCode("");
    setApiKey("");
    setLabel("");
  };

  const openPanel = (next: Panel) => {
    closePanel();
    setError(null);
    setNote(null);
    setPanel(next);
  };

  /** Step 1: the box's own Anthropic sign-in, opened in a new tab. */
  const startSignIn = async () => {
    setBusy("signin");
    setError(null);
    try {
      const res = await fetch("/setup-api/ai-models/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const { url } = await res.json() as { url?: unknown };
      if (typeof url !== "string" || !url.startsWith("https://")) throw new Error(t("settings.anthropicAccounts.actionFailed"));
      window.open(url, "_blank", "noopener,noreferrer");
      setSignInOpened(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.anthropicAccounts.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  /** Step 2: the pasted code → the tokens in the server's handoff → an account in the pool. */
  const finishSignIn = async () => {
    if (!panel || !code.trim()) return;
    setBusy("connect");
    setError(null);
    try {
      const res = await fetch("/setup-api/ai-models/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.anthropicAccounts.actionFailed"));
      setBusy(null);
      return;
    }
    const done = panel.mode === "reauth"
      ? await act({ action: "reauth_oauth", id: panel.id }, "connect")
      : await act({ action: "connect_oauth", label: label.trim() || undefined }, "connect");
    if (done) closePanel();
  };

  const saveKey = async () => {
    if (!panel || !apiKey.trim()) return;
    const done = panel.mode === "reauth"
      ? await act({ action: "replace_key", id: panel.id, apiKey: apiKey.trim() }, "connect")
      : await act({ action: "add_key", apiKey: apiKey.trim(), label: label.trim() || undefined }, "connect");
    // Out of the DOM the moment it has landed, whatever the answer said.
    setApiKey("");
    if (done) {
      closePanel();
      if (done.verified === false) setNote(t("settings.anthropicAccounts.savedUnchecked"));
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    if (!view) return;
    const ids = view.accounts.map((a) => a.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    void act({ action: "reorder", ids }, `move:${ids[to]}`);
  };

  const armRemove = (id: string) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmRemove(null), CONFIRM_MS);
    setConfirmRemove(id);
  };

  const now = Date.now();
  const accounts = view?.accounts ?? [];
  const health = view?.health;
  const activeAccount = accounts.find((a) => a.id === view?.activeAccountId) ?? null;
  const lastSwap = view?.lastSwap ?? null;

  const summary = !view
    ? null
    : health && health.total === 0
      ? { text: t("settings.anthropicAccounts.summaryNone"), tone: "muted" as const }
      : health?.allLimited && health.nextResetAt
        ? { text: t("settings.anthropicAccounts.summaryAllLimited", { time: formatReset(health.nextResetAt, locale, now) }), tone: "amber" as const }
        : { text: t("settings.anthropicAccounts.summaryReady", { ready: health?.healthy ?? 0, total: health?.total ?? 0 }), tone: (health?.healthy ?? 0) > 0 ? "ok" as const : "amber" as const };

  const statusChip = (account: AccountView) => {
    if (account.status === "limited" && account.limitedUntil) {
      return { text: t("settings.anthropicAccounts.statusLimited", { time: formatReset(account.limitedUntil, locale, now) }), cls: "text-amber-300 border-amber-400/40 bg-amber-500/[0.08]", icon: "hourglass_top" };
    }
    if (account.status === "expired") return { text: t("settings.anthropicAccounts.statusExpired"), cls: "text-red-300 border-red-400/40 bg-red-500/[0.06]", icon: "key_off" };
    if (account.status === "revoked") return { text: t("settings.anthropicAccounts.statusRevoked"), cls: "text-red-300 border-red-400/40 bg-red-500/[0.06]", icon: "key_off" };
    if (account.active) return { text: t("settings.anthropicAccounts.statusInUse"), cls: "text-emerald-300 border-emerald-400/40 bg-emerald-500/[0.08]", icon: "bolt" };
    return { text: t("settings.anthropicAccounts.statusReady"), cls: "text-[var(--text-secondary)] border-white/15", icon: "check" };
  };

  /**
   * Said where the owner is looking. While the connect panel is open the
   * refusal belongs beside its Save/Connect button: at the top of the card it
   * sat a whole list above that button — 926 px on a phone with eight
   * accounts — so a refused key simply vanished from its field with no word
   * on screen.
   */
  const errorAlert = error ? (
    <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300" data-testid="anthropic-accounts-error">
      {error}
    </div>
  ) : null;

  const iconButton = "inline-flex items-center justify-center w-7 h-7 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed";
  const field = "w-full min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-base sm:text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--coral-bright)]/60";
  const primaryButton = "text-xs font-medium px-3 py-2 rounded-lg bg-[var(--coral-bright)] text-white hover:opacity-90 disabled:opacity-50 shrink-0";
  const secondaryButton = "text-xs px-3 py-2 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50 shrink-0";

  return (
    <div className="@container rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="anthropic-accounts">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">switch_account</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.anthropicAccounts.title")}
        </h3>
        {summary && (
          <span
            data-testid="anthropic-accounts-summary"
            className={`ml-auto text-[10px] font-semibold rounded-full border px-2 py-0.5 ${
              summary.tone === "amber"
                ? "text-amber-300 border-amber-400/40"
                : summary.tone === "ok"
                  ? "text-emerald-300 border-emerald-400/40"
                  : "text-[var(--text-muted)] border-white/15"
            }`}
          >
            {summary.text}
          </span>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-4 leading-relaxed">
        {t("settings.anthropicAccounts.intro")}
      </p>

      {view && accounts.length > 0 && (
        health?.allLimited ? (
          <div role="status" className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-200" data-testid="anthropic-accounts-all-limited">
            <span className="material-symbols-rounded shrink-0" style={{ fontSize: 16 }} aria-hidden="true">hourglass_top</span>
            <span>
              {health.nextResetAt
                ? t("settings.anthropicAccounts.allLimitedBanner", { time: formatReset(health.nextResetAt, locale, now) })
                : t("settings.anthropicAccounts.noneCanAnswer")}
            </span>
          </div>
        ) : activeAccount ? (
          <p className="mb-3 flex items-start gap-2 text-[11px] text-[var(--text-secondary)]" data-testid="anthropic-accounts-active">
            <span className="material-symbols-rounded shrink-0 text-emerald-300" style={{ fontSize: 16 }} aria-hidden="true">bolt</span>
            <span>{t("settings.anthropicAccounts.activeNow", { label: activeAccount.label })}</span>
          </p>
        ) : null
      )}

      {!panel && errorAlert && <div className="mb-3">{errorAlert}</div>}
      <div role="status" aria-live="polite" className={note ? "mb-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200" : ""}>
        {note ?? ""}
      </div>

      {!view ? (
        <p className="text-[11px] text-[var(--text-muted)]" data-testid="anthropic-accounts-loading">
          {readFailed ? t("settings.anthropicAccounts.loadFailed") : t("settings.anthropicAccounts.loading")}
        </p>
      ) : accounts.length === 0 ? (
        <p className="rounded-xl border border-white/[0.08] px-3 py-3 text-[11px] text-[var(--text-muted)]" data-testid="anthropic-accounts-empty">
          {t("settings.anthropicAccounts.empty")}
        </p>
      ) : (
        <ol className="rounded-xl border border-white/[0.08] overflow-hidden divide-y divide-white/[0.06] list-none p-0 m-0">
          {accounts.map((account, index) => {
            const chip = statusChip(account);
            const rowBusy = busy !== null;
            const isRenaming = renaming?.id === account.id;
            return (
              <li key={account.id} className="flex flex-col @md:flex-row @md:items-center gap-2 @md:gap-3 px-3 py-2.5" data-testid={`anthropic-account-${account.id}`}>
                <span className="flex items-start gap-3 min-w-0 @md:flex-1">
                  <span
                    className={`flex items-center justify-center w-7 h-7 mt-0.5 rounded-full shrink-0 text-[11px] font-semibold ${
                      account.active ? "bg-[var(--coral-bright)] text-white" : "bg-white/[0.06] text-[var(--text-secondary)]"
                    }`}
                    aria-hidden="true"
                  >
                    {account.priority}
                  </span>
                  <span className="min-w-0 flex-1">
                    {isRenaming ? (
                      <span className="flex items-center gap-2">
                        <input
                          type="text"
                          value={renaming.label}
                          maxLength={60}
                          aria-label={t("settings.anthropicAccounts.renameLabel")}
                          onChange={(e) => setRenaming({ id: account.id, label: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void act({ action: "rename", id: account.id, label: renaming.label }, "rename").then((ok) => { if (ok) setRenaming(null); });
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          className={field}
                          data-testid={`anthropic-account-rename-field-${account.id}`}
                        />
                        <button
                          type="button"
                          disabled={rowBusy || !renaming.label.trim()}
                          onClick={() => void act({ action: "rename", id: account.id, label: renaming.label }, "rename").then((ok) => { if (ok) setRenaming(null); })}
                          className={secondaryButton}
                        >
                          {t("settings.anthropicAccounts.renameSave")}
                        </button>
                      </span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="min-w-0 text-sm font-medium text-[var(--text-primary)] break-words" data-testid={`anthropic-account-label-${account.id}`}>
                          {account.label}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full border px-2 py-0.5 ${chip.cls}`}
                          data-testid={`anthropic-account-status-${account.id}`}
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 12 }} aria-hidden="true">{chip.icon}</span>
                          {chip.text}
                        </span>
                      </span>
                    )}
                    <span className="block text-[11px] text-[var(--text-muted)] break-all">
                      {[account.email, t(KIND_KEY[account.kind])].filter(Boolean).join(" · ")}
                    </span>
                    {account.kind === "login" && (
                      <span className="block text-[11px] text-[var(--text-muted)] mt-0.5">
                        {t("settings.anthropicAccounts.loginNote")}
                      </span>
                    )}
                  </span>
                </span>

                <span className="flex flex-wrap items-center gap-1.5 shrink-0 pl-10 @md:pl-0" data-testid={`anthropic-account-controls-${account.id}`}>
                  <button type="button" className={iconButton} disabled={rowBusy || index === 0} onClick={() => move(index, -1)} aria-label={t("settings.anthropicAccounts.moveUp")} title={t("settings.anthropicAccounts.moveUp")}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">arrow_upward</span>
                  </button>
                  <button type="button" className={iconButton} disabled={rowBusy || index === accounts.length - 1} onClick={() => move(index, 1)} aria-label={t("settings.anthropicAccounts.moveDown")} title={t("settings.anthropicAccounts.moveDown")}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">arrow_downward</span>
                  </button>
                  <button type="button" className={iconButton} disabled={rowBusy} onClick={() => setRenaming({ id: account.id, label: account.label })} aria-label={t("settings.anthropicAccounts.rename")} title={t("settings.anthropicAccounts.rename")}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">edit</span>
                  </button>
                  {account.kind !== "login" && (
                    <button
                      type="button"
                      className={iconButton}
                      disabled={rowBusy}
                      onClick={() => openPanel({ mode: "reauth", method: account.kind === "api_key" ? "key" : "oauth", id: account.id, label: account.label })}
                      aria-label={t("settings.anthropicAccounts.reauth")}
                      title={t("settings.anthropicAccounts.reauth")}
                      data-testid={`anthropic-account-reauth-${account.id}`}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">key</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={rowBusy}
                    onClick={() => {
                      if (confirmRemove === account.id) {
                        setConfirmRemove(null);
                        void act({ action: "remove", id: account.id }, "remove");
                      } else armRemove(account.id);
                    }}
                    onBlur={() => { if (confirmRemove === account.id) setConfirmRemove(null); }}
                    // The armed button's name is the word it shows, so a screen
                    // reader hears that the next press removes the account.
                    aria-label={confirmRemove === account.id ? t("settings.anthropicAccounts.removeConfirm") : t("settings.anthropicAccounts.remove")}
                    title={confirmRemove === account.id ? t("settings.anthropicAccounts.removeConfirm") : t("settings.anthropicAccounts.remove")}
                    data-testid={`anthropic-account-remove-${account.id}`}
                    className={confirmRemove === account.id
                      ? "text-[11px] px-2.5 h-7 rounded-lg border border-red-400/40 text-red-300 hover:bg-red-400/10"
                      : iconButton}
                  >
                    {confirmRemove === account.id
                      ? t("settings.anthropicAccounts.removeConfirm")
                      : <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">delete</span>}
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {view && accounts.length > 1 && (
        <label className="mt-3 flex items-start gap-2.5 cursor-pointer select-none" data-testid="anthropic-accounts-return-to-primary">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--coral-bright)]"
            checked={view.returnToPrimary === true}
            disabled={busy !== null}
            onChange={(e) => void act({ action: "set_return_to_primary", on: e.target.checked }, "preference")}
          />
          <span className="min-w-0">
            <span className="block text-xs text-[var(--text-primary)]">{t("settings.anthropicAccounts.returnToPrimary")}</span>
            <span className="block text-[11px] text-[var(--text-muted)] leading-relaxed">{t("settings.anthropicAccounts.returnToPrimaryHint")}</span>
          </span>
        </label>
      )}

      {lastSwap && (
        <div className="mt-3 rounded-xl border border-white/[0.08] px-3 py-2.5" data-testid="anthropic-accounts-last-swap">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-1">
            {t("settings.anthropicAccounts.lastSwapTitle")}
          </p>
          <p className="text-xs text-[var(--text-primary)] break-words">
            <span className="text-[var(--text-muted)]">{formatReset(lastSwap.at, locale, now)}</span>
            {" · "}
            {lastSwap.fromLabel ?? t("settings.anthropicAccounts.swapNoAccount")}
            {" → "}
            {lastSwap.toLabel ?? t("settings.anthropicAccounts.swapNoAccount")}
          </p>
          <p className="text-[11px] text-[var(--text-muted)]">
            {lastSwap.cause === "limit" && lastSwap.limitedUntil
              ? t("settings.anthropicAccounts.reasonLimit", { time: formatReset(lastSwap.limitedUntil, locale, now) })
              : t(CAUSE_KEY[lastSwap.cause] ?? CAUSE_KEY.owner)}
          </p>
          {Object.keys(lastSwap.consumers ?? {}).length > 0 && (
            <ul className="mt-1.5 space-y-0.5 list-none p-0 m-0">
              {(["coding", "gateway", "retries"] as const).map((name) => {
                const outcome = lastSwap.consumers?.[name];
                if (!outcome) return null;
                return (
                  <li key={name} className="flex flex-wrap gap-x-1.5 text-[11px]" data-testid={`anthropic-accounts-swap-${name}`}>
                    <span className="text-[var(--text-secondary)]">{t(CONSUMER_KEY[name])}:</span>
                    <span className={outcome.status === "failed" ? "text-red-300" : outcome.status === "ok" ? "text-emerald-300" : "text-[var(--text-muted)]"}>
                      {t(outcomeKey(outcome), { count: outcome.count ?? 0 })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {panel ? (
        <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 space-y-3" data-testid="anthropic-accounts-panel">
          <p className="text-xs font-medium text-[var(--text-primary)]">
            {panel.mode === "reauth"
              ? t("settings.anthropicAccounts.reauthTitle", { label: panel.label })
              : panel.method === "key" ? t("settings.anthropicAccounts.keyTitle") : t("settings.anthropicAccounts.connectTitle")}
          </p>
          {panel.mode === "connect" && (
            <input
              type="text"
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              aria-label={t("settings.anthropicAccounts.labelField")}
              placeholder={t("settings.anthropicAccounts.labelPlaceholder")}
              className={field}
              data-testid="anthropic-accounts-label"
            />
          )}
          {panel.method === "oauth" ? (
            <>
              <div className="space-y-2">
                {/* Re-authenticating takes the SAME account only (the pool refuses
                    another one), so "the account you want to add" would send the
                    owner straight into that refusal. */}
                <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">{t(panel.mode === "reauth" ? "settings.anthropicAccounts.stepSignInReauth" : "settings.anthropicAccounts.stepSignIn")}</p>
                <button type="button" onClick={() => void startSignIn()} disabled={busy !== null} className={signInOpened ? secondaryButton : primaryButton} data-testid="anthropic-accounts-signin">
                  {t("settings.anthropicAccounts.openSignIn")}
                </button>
              </div>
              <div className="space-y-2">
                <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">{t("settings.anthropicAccounts.stepPaste")}</p>
                <div className="flex flex-col @sm:flex-row gap-2">
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void finishSignIn(); }}
                    aria-label={t("settings.anthropicAccounts.codePlaceholder")}
                    placeholder={t("settings.anthropicAccounts.codePlaceholder")}
                    className={field}
                    data-testid="anthropic-accounts-code"
                  />
                  <button type="button" onClick={() => void finishSignIn()} disabled={busy !== null || !code.trim()} className={signInOpened ? primaryButton : secondaryButton} data-testid="anthropic-accounts-finish">
                    {busy === "connect" ? t("settings.anthropicAccounts.connecting") : t("settings.anthropicAccounts.connect")}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col @sm:flex-row gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void saveKey(); }}
                aria-label={t("settings.anthropicAccounts.apiKeyLabel")}
                placeholder={t("settings.anthropicAccounts.apiKeyPlaceholder")}
                className={field}
                data-testid="anthropic-accounts-key"
              />
              <button type="button" onClick={() => void saveKey()} disabled={busy !== null || !apiKey.trim()} className={primaryButton} data-testid="anthropic-accounts-save-key">
                {busy === "connect" ? t("settings.anthropicAccounts.connecting") : t("settings.anthropicAccounts.saveKey")}
              </button>
            </div>
          )}
          {errorAlert}
          <div className="flex flex-wrap items-center gap-3">
            {panel.mode === "connect" && (
              <button
                type="button"
                className="text-[11px] text-[var(--coral-bright)] hover:underline"
                onClick={() => setPanel({ mode: "connect", method: panel.method === "oauth" ? "key" : "oauth" })}
                data-testid="anthropic-accounts-switch-method"
              >
                {panel.method === "oauth" ? t("settings.anthropicAccounts.useApiKey") : t("settings.anthropicAccounts.useSignIn")}
              </button>
            )}
            <button type="button" className="text-[11px] text-[var(--text-muted)] hover:underline ml-auto" onClick={closePanel}>
              {t("settings.anthropicAccounts.cancel")}
            </button>
          </div>
        </div>
      ) : (
        view && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openPanel({ mode: "connect", method: "oauth" })}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[var(--coral-bright)]/40 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/10 disabled:opacity-50"
              data-testid="anthropic-accounts-connect"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">add</span>
              {accounts.length === 0 ? t("settings.anthropicAccounts.connectFirst") : t("settings.anthropicAccounts.connectAnother")}
            </button>
            {view.loginAvailable && (
              <button type="button" onClick={() => void act({ action: "add_login" }, "login")} disabled={busy !== null} className={secondaryButton} data-testid="anthropic-accounts-add-login">
                {t("settings.anthropicAccounts.addLogin")}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
