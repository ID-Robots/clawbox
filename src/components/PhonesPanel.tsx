"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import type { PhoneInviteView, PhonePlatform, PhonesState } from "@/lib/phone-pairing-shared";

/**
 * Settings → Phones: pair the official OpenClaw app on a phone, one phone at
 * a time, each approved here by the owner (src/lib/phone-pairing.ts).
 *
 *  1. The switch (off by default) opens the box's phone link.
 *  2. "Add a phone" shows a one-use QR invite. The phone opens it, names
 *     itself and asks to pair; nothing it holds can reach the assistant yet.
 *  3. The phone appears under "Waiting for your approval". Approve mints that
 *     phone's own short-lived setup code and hands it to that phone only.
 *  4. Paired phones are listed from the assistant's own records, each with
 *     Revoke — available whether the switch is on or off.
 *
 * Polls while it is on screen: every few seconds while something is in
 * flight (an open invite, a phone waiting or collecting its code), otherwise
 * every 15 s, so a phone that pairs or drops shows up without a reload.
 */

const FAST_POLL_MS = 3_000;
const SLOW_POLL_MS = 15_000;

/** Brand names, the same in every language. */
const PLATFORM_BRAND: Partial<Record<PhonePlatform, string>> = { ios: "iPhone", android: "Android" };

type Notice = { kind: "ok" | "error"; text: string } | null;

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, body: parsed };
}

function errorText(body: Record<string, unknown> | null, fallback: string): string {
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

function minutesLeft(expiresAtMs: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAtMs - now) / 60_000));
}

function timeOf(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function PhonesPanel() {
  const { t } = useT();
  const [state, setState] = useState<PhonesState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [shownInvite, setShownInvite] = useState<PhoneInviteView | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Each row's phone name labels that row's buttons ("Approve Pixel 9"), so a
  // screen reader does not hear the same "Approve" for every waiting phone.
  const rowId = useId();
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  const stateRef = useRef<PhonesState | null>(null);

  // The notice is the last thing in the pane, below the waiting list, an open
  // invite's QR code and the paired phones: bring it into view, or an owner who
  // pressed Approve near the top never sees whether it worked.
  useEffect(() => {
    if (notice) noticeRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [notice]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/nodes", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !body || typeof body.available !== "boolean") {
        setLoadError(errorText(body, `HTTP ${res.status}`));
        return;
      }
      const next = body as unknown as PhonesState;
      stateRef.current = next;
      setState(next);
      setLoadError(null);
      setNow(Date.now());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await load();
      if (!alive) return;
      const s = stateRef.current;
      const inFlight = !!s && (s.invites.length > 0 || s.requests.length > 0 || s.approved.length > 0);
      timer = setTimeout(tick, inFlight ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  // The invite on screen closes once a phone has asked on it or it lapses.
  useEffect(() => {
    if (shownInvite && state && !state.invites.some((i) => i.invite === shownInvite.invite)) {
      setShownInvite(null);
      setCopied(false);
    }
  }, [state, shownInvite]);

  const act = useCallback(
    async (key: string, url: string, body: unknown, success?: string): Promise<Record<string, unknown> | null> => {
      setBusy(key);
      setNotice(null);
      try {
        const res = await postJson(url, body);
        if (!res.ok) {
          setNotice({ kind: "error", text: t("settings.phones.actionFailed", { error: errorText(res.body, t("settings.phones.noAnswer")) }) });
          return null;
        }
        if (success) setNotice({ kind: "ok", text: success });
        return res.body ?? {};
      } catch (err) {
        setNotice({ kind: "error", text: t("settings.phones.actionFailed", { error: err instanceof Error ? err.message : String(err) }) });
        return null;
      } finally {
        setBusy(null);
        await load();
      }
    },
    [load, t],
  );

  const platformLabel = (platform: PhonePlatform) => PLATFORM_BRAND[platform] ?? t("settings.phones.platformOther");

  if (!state) {
    return (
      <div className="max-w-xl space-y-5" data-testid="phones-panel">
        <Header t={t} />
        {loadError ? (
          <p className="text-sm text-red-300" data-testid="phones-load-error">
            {t("settings.phones.loadFailed", { error: loadError })}
          </p>
        ) : (
          <p className="text-sm text-white/50">{t("settings.phones.loading")}</p>
        )}
      </div>
    );
  }

  if (!state.available) {
    return (
      <div className="max-w-xl space-y-5" data-testid="phones-panel">
        <Header t={t} />
        <p className="text-sm text-white/60" data-testid="phones-unavailable">{t("settings.phones.unavailable")}</p>
      </div>
    );
  }

  const waitingCount = state.requests.length + (state.pending?.length ?? 0);

  return (
    <div className="max-w-xl space-y-5" data-testid="phones-panel">
      <Header t={t} />

      <div className="rounded-xl border border-white/[0.08] overflow-hidden">
        <div className="flex items-start gap-3 px-3 py-3">
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium text-[var(--text-primary)]">{t("settings.phones.switchLabel")}</span>
            <span className="block text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">{t("settings.phones.switchHint")}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={state.enabled}
            aria-label={t("settings.phones.switchLabel")}
            aria-busy={busy === "switch"}
            disabled={busy !== null}
            data-testid="phones-switch"
            onClick={() => void act("switch", "/setup-api/nodes/settings", { enabled: !state.enabled })}
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${state.enabled ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${state.enabled ? "left-[22px]" : "left-0.5"}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {state.enabled && !state.host && (
        <p className="text-sm text-[var(--amber-ink)] leading-relaxed" data-testid="phones-needs-link">
          {t("settings.phones.needsLink")}
        </p>
      )}

      {state.enabled && state.host && !shownInvite && (
        <button
          type="button"
          data-testid="phones-add"
          disabled={busy !== null}
          onClick={async () => {
            const body = await act("invite", "/setup-api/nodes/invite", {});
            if (body && typeof body.invite === "string" && typeof body.url === "string" && typeof body.expiresAtMs === "number") {
              setShownInvite({ invite: body.invite, url: body.url, expiresAtMs: body.expiresAtMs });
              setCopied(false);
            }
          }}
          className="w-full inline-flex items-center justify-center gap-2 h-10 btn-gradient rounded-lg text-sm font-medium text-white cursor-pointer disabled:opacity-60"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">add_to_home_screen</span>
          {t("settings.phones.addPhone")}
        </button>
      )}

      {shownInvite && (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 space-y-4" data-testid="phones-invite">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t("settings.phones.inviteTitle")}</h3>
            <p className="text-xs text-white/60 mt-1 leading-relaxed">{t("settings.phones.inviteSteps")}</p>
          </div>
          <div className="flex justify-center">
            <div className="bg-white rounded-xl p-3">
              <QRCodeSVG
                value={shownInvite.url}
                size={208}
                level="M"
                marginSize={4}
                bgColor="#ffffff"
                fgColor="#000000"
                title={t("settings.phones.inviteQrLabel")}
              />
            </div>
          </div>
          <p className="text-[11px] text-white/50 text-center">
            {t("settings.phones.inviteExpires", { minutes: minutesLeft(shownInvite.expiresAtMs, now) })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={async () => {
                // The shared helper, not navigator.clipboard alone: that is
                // undefined on the box's plain-HTTP page, where this did nothing.
                setCopied(await copyToClipboard(shownInvite.url));
              }}
              className="flex-1 px-3 h-8 rounded-lg text-xs text-white/80 bg-white/10 hover:bg-white/15 transition-colors cursor-pointer"
            >
              {copied ? t("settings.phones.copied") : t("settings.phones.copyLink")}
            </button>
            <button
              type="button"
              data-testid="phones-invite-close"
              disabled={busy !== null}
              onClick={async () => {
                const invite = shownInvite.invite;
                setShownInvite(null);
                await act("close", "/setup-api/nodes/reject", { invite });
              }}
              className="flex-1 px-3 h-8 rounded-lg text-xs text-white/80 bg-white/10 hover:bg-white/15 transition-colors cursor-pointer disabled:opacity-60"
            >
              {t("settings.phones.inviteClose")}
            </button>
          </div>
        </div>
      )}

      {waitingCount > 0 && (
        <section className="space-y-2" data-testid="phones-waiting">
          <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
            {t("settings.phones.waitingTitle")}
          </h3>
          <div className="bg-white/5 rounded-xl p-2">
            <ul className="divide-y divide-white/[0.06]">
              {state.requests.map((r, i) => (
                <li key={r.invite} className="px-3 py-3 flex items-center gap-3" data-testid="phones-request">
                  <span className="material-symbols-rounded text-white/60" style={{ fontSize: 20 }} aria-hidden="true">smartphone</span>
                  <span className="flex-1 min-w-0">
                    <span id={`${rowId}-request-${i}`} className="block text-sm font-medium text-white truncate">{r.name}</span>
                    <span className="block text-xs text-white/50">
                      {platformLabel(r.platform)}
                      {r.address ? ` · ${t("settings.phones.from", { address: r.address })}` : ""}
                      {` · ${t("settings.phones.askedAt", { time: timeOf(r.requestedAtMs) })}`}
                    </span>
                  </span>
                  <DecisionButtons
                    t={t}
                    nameId={`${rowId}-request-${i}`}
                    disabled={busy !== null}
                    onApprove={() => void act(`approve:${r.invite}`, "/setup-api/nodes/approve", { invite: r.invite }, t("settings.phones.approved", { name: r.name }))}
                    onReject={() => void act(`reject:${r.invite}`, "/setup-api/nodes/reject", { invite: r.invite })}
                  />
                </li>
              ))}
              {(state.pending ?? []).map((p, i) => (
                <li key={p.requestId} className="px-3 py-3 flex items-center gap-3" data-testid="phones-pending">
                  <span className="material-symbols-rounded text-white/60" style={{ fontSize: 20 }} aria-hidden="true">phonelink_lock</span>
                  <span className="flex-1 min-w-0">
                    <span id={`${rowId}-pending-${i}`} className="block text-sm font-medium text-white truncate">{p.name}</span>
                    <span className="block text-xs text-white/50">
                      {platformLabel(p.platform)}
                      {p.address ? ` · ${t("settings.phones.from", { address: p.address })}` : ""}
                      {` · ${t("settings.phones.heldByAssistant")}`}
                    </span>
                  </span>
                  <DecisionButtons
                    t={t}
                    nameId={`${rowId}-pending-${i}`}
                    disabled={busy !== null}
                    onApprove={() => void act(`approve:${p.requestId}`, "/setup-api/nodes/approve", { requestId: p.requestId }, t("settings.phones.approved", { name: p.name }))}
                    onReject={() => void act(`reject:${p.requestId}`, "/setup-api/nodes/reject", { requestId: p.requestId })}
                  />
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {state.approved.length > 0 && (
        <section className="space-y-2" data-testid="phones-approved">
          <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
            {t("settings.phones.approvedTitle")}
          </h3>
          <div className="bg-white/5 rounded-xl p-2">
            <ul className="divide-y divide-white/[0.06]">
              {state.approved.map((a) => (
                <li key={a.invite} className="px-3 py-3">
                  <span className="block text-sm font-medium text-white truncate">{a.name}</span>
                  <span className="block text-xs text-white/50">
                    {a.delivered ? t("settings.phones.approvedCollected") : t("settings.phones.approvedNotCollected")}
                    {` · ${t("settings.phones.codeExpires", { minutes: minutesLeft(a.expiresAtMs, now) })}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="space-y-2" data-testid="phones-paired">
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.phones.pairedTitle")}
        </h3>
        {state.paired === null ? (
          <p className="text-sm text-[var(--amber-ink)]" data-testid="phones-gateway-error">
            {t("settings.phones.gatewayError", { error: state.gatewayError ?? t("settings.phones.noAnswer") })}
          </p>
        ) : state.paired.length === 0 ? (
          <p className="text-sm text-white/50">{t("settings.phones.noPhones")}</p>
        ) : (
          <div className="bg-white/5 rounded-xl p-2">
            <ul className="divide-y divide-white/[0.06]">
              {state.paired.map((p, i) => (
                <li key={p.deviceId} className="px-3 py-3" data-testid="phones-paired-row">
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-rounded text-white/60" style={{ fontSize: 20 }} aria-hidden="true">smartphone</span>
                    <span className="flex-1 min-w-0">
                      <span id={`${rowId}-paired-${i}`} className="block text-sm font-medium text-white truncate">{p.name}</span>
                      <span className="block text-xs text-white/50">
                        {platformLabel(p.platform)}
                        {" · "}
                        {p.connected
                          ? t("settings.phones.connected")
                          : p.lastSeenAtMs !== null
                            ? t("settings.phones.lastSeen", { time: timeOf(p.lastSeenAtMs) })
                            : t("settings.phones.notConnected")}
                      </span>
                    </span>
                    {confirmRevoke !== p.deviceId && (
                      <button
                        type="button"
                        id={`${rowId}-revoke-${i}`}
                        aria-labelledby={`${rowId}-revoke-${i} ${rowId}-paired-${i}`}
                        disabled={busy !== null}
                        onClick={() => setConfirmRevoke(p.deviceId)}
                        className="px-3 h-8 rounded-lg text-xs text-red-300 bg-red-500/10 hover:bg-red-500/20 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        {t("settings.phones.revoke")}
                      </button>
                    )}
                  </div>
                  {confirmRevoke === p.deviceId && (
                    <div className="mt-3 rounded-lg bg-red-500/10 p-3 space-y-2" data-testid="phones-revoke-confirm">
                      <p className="text-xs text-red-200 leading-relaxed">{t("settings.phones.revokeConfirm", { name: p.name })}</p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={async () => {
                            setConfirmRevoke(null);
                            await act(`revoke:${p.deviceId}`, "/setup-api/nodes/revoke", { deviceId: p.deviceId }, t("settings.phones.revoked", { name: p.name }));
                          }}
                          className="px-3 h-8 rounded-lg text-xs text-white bg-red-500/70 hover:bg-red-500/90 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {t("settings.phones.revokeConfirmButton")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRevoke(null)}
                          className="px-3 h-8 rounded-lg text-xs text-white/80 bg-white/10 hover:bg-white/15 transition-colors cursor-pointer"
                        >
                          {t("settings.phones.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {notice && (
        <p
          ref={noticeRef}
          role="status"
          data-testid="phones-notice"
          className={`text-sm ${notice.kind === "error" ? "text-red-300" : "text-emerald-300"}`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

type T = (key: string, params?: Record<string, string | number>) => string;

function Header({ t }: { t: T }) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t("settings.phones.title")}</h3>
      <p className="text-sm text-[var(--text-secondary)] mt-1 leading-relaxed">{t("settings.phones.subtitle")}</p>
    </div>
  );
}

function DecisionButtons({
  t,
  nameId,
  disabled,
  onApprove,
  onReject,
}: {
  t: T;
  /** The id of the element holding the phone's name, read after each button's own text. */
  nameId: string;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const own = useId();
  return (
    <span className="flex gap-2 shrink-0">
      <button
        type="button"
        id={`${own}-approve`}
        aria-labelledby={`${own}-approve ${nameId}`}
        disabled={disabled}
        onClick={onApprove}
        className="px-3 h-8 rounded-lg text-xs text-white bg-[var(--coral-bright)]/80 hover:bg-[var(--coral-bright)] transition-colors cursor-pointer disabled:opacity-50"
      >
        {t("settings.phones.approve")}
      </button>
      <button
        type="button"
        id={`${own}-reject`}
        aria-labelledby={`${own}-reject ${nameId}`}
        disabled={disabled}
        onClick={onReject}
        className="px-3 h-8 rounded-lg text-xs text-white/80 bg-white/10 hover:bg-white/15 transition-colors cursor-pointer disabled:opacity-50"
      >
        {t("settings.phones.reject")}
      </button>
    </span>
  );
}
