"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "@/lib/i18n";
import { MAX_PHONE_NAME_LENGTH, type PhoneRequestStatus } from "@/lib/phone-pairing-shared";

/**
 * /phone-pair — what a phone sees after scanning the owner's QR invite in
 * Settings → Phones. Public: the phone has no ClawBox session.
 *
 *   ask      the phone names itself and asks to pair (POST nodes/request).
 *            The answer is a claim this page keeps, in this tab only.
 *   waiting  until the owner approves or rejects THIS phone in the box UI
 *            (POST nodes/request/status, every few seconds).
 *   approved the box hands this page — and only this page — the phone's own
 *            single-use setup code, to paste into the OpenClaw app.
 *
 * The invite is read from the URL fragment, which the browser never sends to
 * the box; the claim lives in sessionStorage so a reload keeps waiting.
 */

type Phase =
  | { kind: "loading" }
  | { kind: "form" }
  | { kind: "asking" }
  | { kind: "waiting"; expiresAtMs: number }
  | { kind: "approved"; setupCode: string; expiresAtMs: number }
  | { kind: "rejected" }
  | { kind: "expired" }
  | { kind: "invalid" }
  | { kind: "used" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

const POLL_MS = 2_500;
/** How often a code on screen is checked with the box, which alone says when it has expired. */
const RECHECK_MS = 15_000;
const INVITE_RE = /^[A-Za-z0-9_-]{22}$/;

function claimKey(invite: string): string {
  return `clawbox-phone-claim:${invite}`;
}

function askStatus(invite: string, claim: string): Promise<Response> {
  return fetch("/setup-api/nodes/request/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invite, claim }),
    cache: "no-store",
  });
}

export default function PhonePairPage() {
  const { t } = useT();
  const [invite, setInvite] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const codeRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const fromHash = window.location.hash.replace(/^#/, "");
    if (!INVITE_RE.test(fromHash)) {
      setPhase({ kind: "invalid" });
      return;
    }
    setInvite(fromHash);
    const stored = window.sessionStorage.getItem(claimKey(fromHash));
    setPhase(stored ? { kind: "waiting", expiresAtMs: Date.now() } : { kind: "form" });
  }, []);

  const poll = useCallback(async (): Promise<boolean> => {
    if (!invite) return false;
    const claim = window.sessionStorage.getItem(claimKey(invite));
    if (!claim) {
      setPhase({ kind: "form" });
      return false;
    }
    try {
      const res = await askStatus(invite, claim);
      if (res.status === 404) {
        const body = (await res.json().catch(() => null)) as { code?: string } | null;
        setPhase(body?.code === "unavailable" ? { kind: "unavailable" } : { kind: "invalid" });
        return false;
      }
      if (res.status === 429) {
        // Too many asks from this network (phones on one LAN share a bucket):
        // keep waiting. A fresh phase object is what arms the next poll.
        setPhase((p) => (p.kind === "waiting" ? { ...p } : p));
        return true;
      }
      if (!res.ok) {
        setPhase({ kind: "error", message: `HTTP ${res.status}` });
        return false;
      }
      const status = (await res.json()) as PhoneRequestStatus;
      setNow(Date.now());
      if (status.state === "waiting") {
        setPhase({ kind: "waiting", expiresAtMs: status.expiresAtMs });
        return true;
      }
      if (status.state === "approved") {
        setPhase({ kind: "approved", setupCode: status.setupCode, expiresAtMs: status.expiresAtMs });
        return false;
      }
      window.sessionStorage.removeItem(claimKey(invite));
      setPhase({ kind: status.state });
      return false;
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }, [invite]);

  // While waiting: ask again every few seconds until the owner decides.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    let alive = true;
    const timer = setTimeout(async () => {
      if (alive) await poll();
    }, POLL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [phase, poll]);

  // While a code is shown: keep its countdown moving, and ask the box again now
  // and then. The BOX says when the code has expired, never this phone's clock:
  // a phone or a box whose clock is off must not lose a code the gateway still
  // takes. A check that does not get an answer (offline, rate-limited) leaves
  // the code on screen.
  useEffect(() => {
    if (phase.kind !== "approved" || !invite) return;
    let alive = true;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const recheck = setInterval(async () => {
      const claim = window.sessionStorage.getItem(claimKey(invite));
      if (!claim) return;
      try {
        const res = await askStatus(invite, claim);
        if (!alive || !res.ok) return;
        const status = (await res.json()) as PhoneRequestStatus;
        if (alive && (status.state === "expired" || status.state === "rejected")) {
          window.sessionStorage.removeItem(claimKey(invite));
          setPhase({ kind: status.state });
        }
      } catch {
        // No answer this time: the code stays.
      }
    }, RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(tick);
      clearInterval(recheck);
    };
  }, [phase.kind, invite]);

  const ask = async () => {
    if (!invite) return;
    setPhase({ kind: "asking" });
    try {
      const res = await fetch("/setup-api/nodes/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite, name }),
      });
      const body = (await res.json().catch(() => null)) as { claim?: string; expiresAtMs?: number; code?: string; error?: string } | null;
      if (res.ok && body?.claim && typeof body.expiresAtMs === "number") {
        window.sessionStorage.setItem(claimKey(invite), body.claim);
        setNow(Date.now());
        setPhase({ kind: "waiting", expiresAtMs: body.expiresAtMs });
        return;
      }
      if (res.status === 409) setPhase({ kind: "used" });
      else if (res.status === 410) setPhase({ kind: "expired" });
      else if (res.status === 404) setPhase(body?.code === "unavailable" ? { kind: "unavailable" } : { kind: "invalid" });
      else setPhase({ kind: "error", message: body?.error ?? `HTTP ${res.status}` });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // No clipboard (an insecure page, an old browser): select it for a manual copy.
      codeRef.current?.select();
    }
  };

  const minutes = (expiresAtMs: number) => Math.max(1, Math.ceil((expiresAtMs - now) / 60_000));

  return (
    <main className="min-h-dvh flex items-center justify-center bg-[#0a0f1a] px-5 py-10 text-white">
      <div className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-white/[0.04] p-6 space-y-5" data-testid="phone-pair">
        <div className="flex items-center gap-3">
          <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 28 }} aria-hidden="true">smartphone</span>
          <h1 className="text-lg font-semibold">{t("phonePair.title")}</h1>
        </div>

        {phase.kind === "loading" && <p className="text-sm text-white/60">{t("phonePair.loading")}</p>}

        {(phase.kind === "form" || phase.kind === "asking") && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <p className="text-sm text-white/70 leading-relaxed">{t("phonePair.intro")}</p>
            <label className="block space-y-1.5">
              <span className="text-xs text-white/60">{t("phonePair.nameLabel")}</span>
              <input
                type="text"
                value={name}
                maxLength={MAX_PHONE_NAME_LENGTH}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("phonePair.namePlaceholder")}
                autoComplete="off"
                data-testid="phone-pair-name"
                className="w-full h-11 rounded-lg bg-black/40 border border-white/[0.12] px-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-[var(--coral-bright)]"
              />
            </label>
            <button
              type="submit"
              disabled={phase.kind === "asking"}
              data-testid="phone-pair-ask"
              className="w-full h-11 btn-gradient rounded-lg text-sm font-medium text-white cursor-pointer disabled:opacity-60"
            >
              {phase.kind === "asking" ? t("phonePair.asking") : t("phonePair.ask")}
            </button>
            <p className="text-xs text-white/60 leading-relaxed">{t("phonePair.needApp")}</p>
          </form>
        )}

        {phase.kind === "waiting" && (
          <div className="space-y-3" data-testid="phone-pair-waiting" role="status">
            <div className="flex items-center gap-3">
              <span className="spinner" aria-hidden="true" />
              <p className="text-sm text-white/80 leading-relaxed">{t("phonePair.waiting")}</p>
            </div>
            <p className="text-xs text-white/50">{t("phonePair.waitingHint")}</p>
          </div>
        )}

        {phase.kind === "approved" && (
          <div className="space-y-4" data-testid="phone-pair-approved">
            <p className="text-sm font-medium text-emerald-300">{t("phonePair.approvedTitle")}</p>
            <p className="text-sm text-white/70 leading-relaxed">{t("phonePair.approvedSteps")}</p>
            <textarea
              ref={codeRef}
              readOnly
              value={phase.setupCode}
              rows={4}
              aria-label={t("phonePair.codeLabel")}
              data-testid="phone-pair-code"
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-lg bg-black/40 border border-white/[0.12] p-3 text-xs font-mono text-white break-all resize-none"
            />
            <button
              type="button"
              onClick={() => void copyCode(phase.setupCode)}
              className="w-full h-11 btn-gradient rounded-lg text-sm font-medium text-white cursor-pointer"
            >
              {copied ? t("phonePair.copied") : t("phonePair.copyCode")}
            </button>
            <p className="text-[11px] text-white/50 leading-relaxed">
              {t("phonePair.codeExpires", { minutes: minutes(phase.expiresAtMs) })}
            </p>
          </div>
        )}

        {phase.kind === "rejected" && <Message testId="phone-pair-rejected" text={t("phonePair.rejected")} />}
        {phase.kind === "expired" && <Message testId="phone-pair-expired" text={t("phonePair.expired")} />}
        {phase.kind === "invalid" && <Message testId="phone-pair-invalid" text={t("phonePair.invalidLink")} />}
        {phase.kind === "used" && <Message testId="phone-pair-used" text={t("phonePair.usedLink")} />}
        {phase.kind === "unavailable" && <Message testId="phone-pair-unavailable" text={t("phonePair.unavailable")} />}
        {phase.kind === "error" && <Message testId="phone-pair-error" text={t("phonePair.error", { error: phase.message })} />}
      </div>
    </main>
  );
}

function Message({ text, testId }: { text: string; testId: string }) {
  return (
    <p className="text-sm text-white/80 leading-relaxed" data-testid={testId} role="status">
      {text}
    </p>
  );
}
