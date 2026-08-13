"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import StatusMessage from "./StatusMessage";
import CredentialsHandoffOverlay from "./CredentialsHandoffOverlay";
import { useT } from "@/lib/i18n";

interface CredentialsStepProps {
  onNext: () => void;
}

/* ─────────────────────────────────────────────────────────────────────────
   Shared surfaces for this card, expressed in the ladders.

   Every white alpha here is a rung (--fill-1..4), every corner a rung of the
   radius ladder (--r-2 for inputs, --r-1 for everything else, --r-3 for the
   card), and every size a rung of the type ramp. Font sizes ride in `style`
   rather than in a Tailwind arbitrary value because `text-[…]` is ambiguous
   between colour and size; the rest is Tailwind so hover and focus states
   stay declarative.

   There is no danger rung in the ladders, so invalid borders keep the
   product's shipped red-500 / red-400.
   ───────────────────────────────────────────────────────────────────────── */

const T_SEC_HEAD = {
  fontSize: "var(--t-1)",
  fontWeight: "var(--w-label)" as const,
  letterSpacing: "0.16em",
} as const;
const T_LABEL = { fontSize: "var(--t-2)", fontWeight: "var(--w-label)" as const } as const;
const T_FIELD = { fontSize: "var(--t-5)" } as const;

const FIELD_MOTION = {
  transition:
    "border-color var(--d-2) var(--ease-standard), background-color var(--d-2) var(--ease-standard)",
} as const;

/** 48px minimum height is the product's control height, not a new invention. */
const FIELD =
  "w-full min-h-[48px] pl-[var(--s-4)] py-[var(--s-3)] bg-[var(--fill-2)] border rounded-[var(--r-2)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:bg-[var(--fill-3)]";
/** Plain field: symmetric gutters. */
const FIELD_PAD = "pr-[var(--s-4)]";
/** Field with a reveal button: 48px of room so the glyph never sits on text. */
const FIELD_PAD_REVEAL = "pr-12";

const REVEAL =
  "absolute right-[var(--s-1)] top-1/2 -translate-y-1/2 grid place-items-center w-10 h-10 rounded-[var(--r-1)] bg-transparent border-none cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-3)]";

/**
 * A section rule: the label at the smallest rung, uppercase, with a hairline
 * running out to the card's edge. Sans, not mono — mono means "a machine
 * produced this literal", which a section name is not.
 */
function SectionHead({ children }: { children: ReactNode }) {
  return (
    <h2
      className="flex items-center gap-[var(--s-2)] mb-[var(--s-3)] uppercase text-[var(--text-muted)]"
      style={T_SEC_HEAD}
    >
      <span className="min-w-0">{children}</span>
      <span aria-hidden="true" className="flex-1 h-px bg-[var(--hair)]" />
    </h2>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="block mb-[var(--s-2)] text-[var(--text-secondary)]"
      style={T_LABEL}
    >
      {children}
    </label>
  );
}

export default function CredentialsStep({ onNext }: CredentialsStepProps) {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [hostname, setHostname] = useState("clawbox");
  const [hotspotName, setHotspotName] = useState("ClawBox-Setup");
  const [hotspotPassword, setHotspotPassword] = useState("");
  const [showHotspotPassword, setShowHotspotPassword] = useState(false);
  const [confirmHotspotPassword, setConfirmHotspotPassword] = useState("");
  const [showConfirmHotspot, setShowConfirmHotspot] = useState(false);
  const [hotspotEnabled, setHotspotEnabled] = useState(true);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  // Purely presentational disclosure state. Both fields behind them already
  // carry a working default read back from the device, so the screen opens on
  // what the customer must supply and keeps what they may rename one tap away.
  const [nameOpen, setNameOpen] = useState(false);
  const [hotspotNameOpen, setHotspotNameOpen] = useState(false);
  // The hotspot secret is the one disclosure here with no working default
  // behind it, so the row that opens it states the outstanding requirement
  // rather than merely hinting there is a field.
  const [hotspotSecretOpen, setHotspotSecretOpen] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  // When a save restarts the setup AP (and/or renames the device), the connection
  // drops; the overlay probes clawbox.local until the box answers, then continues.
  const [handoff, setHandoff] = useState<{
    targetUrl: string;
    sameOrigin: boolean;
    hotspotSsid: string | null;
  } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/system/hotspot", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted) {
          if (data.ssid) setHotspotName(data.ssid);
          if (typeof data.enabled === "boolean") setHotspotEnabled(data.enabled);
        }
      })
      .catch(() => {});
    fetch("/setup-api/system/hostname", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.hostname && !controller.signal.aborted) setHostname(data.hostname);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      saveControllerRef.current?.abort();
    };
  }, []);

  const save = async () => {
    setTouched(true);
    // Validate hostname
    const normalizedHostname = hostname.trim().toLowerCase().replace(/\.local$/, "");
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedHostname)) {
      setStatus({ type: "error", message: t("credentials.hostnameInvalid") });
      return;
    }
    // Validate system password (required)
    if (!password) {
      setStatus({ type: "error", message: t("credentials.passwordRequired") });
      return;
    }
    if (password.length < 8) {
      setStatus({
        type: "error",
        message: t("credentials.passwordMinLength"),
      });
      return;
    }
    if (password !== confirmPassword) {
      setStatus({ type: "error", message: t("credentials.passwordsDontMatch") });
      return;
    }

    // Validate hotspot fields (only when enabled)
    if (hotspotEnabled) {
      if (!hotspotName.trim()) {
        setStatus({ type: "error", message: t("credentials.hotspotNameRequired") });
        return;
      }
      if (!hotspotPassword) {
        setStatus({ type: "error", message: t("credentials.hotspotPasswordRequired") });
        return;
      }
      if (hotspotPassword.length < 8) {
        setStatus({
          type: "error",
          message: t("credentials.hotspotPasswordMinLength"),
        });
        return;
      }
      if (hotspotPassword !== confirmHotspotPassword) {
        setStatus({ type: "error", message: t("credentials.hotspotPasswordsDontMatch") });
        return;
      }
    }

    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    setSaving(true);
    setStatus(null);
    const newHost = `${normalizedHostname}.local`;
    const newSetupUrl = new URL("/setup", window.location.href);
    newSetupUrl.hostname = newHost;
    // Only ever redirect within the same scheme/port and to a *.local hostname
    // built from the validated normalizedHostname. This keeps the redirect
    // narrowly scoped even if window.location.href is unexpected.
    const isAllowedRedirect =
      newSetupUrl.protocol === window.location.protocol &&
      newSetupUrl.port === window.location.port &&
      newSetupUrl.hostname === newHost &&
      /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(newSetupUrl.hostname);
    try {
      // Save hostname (applies live; mDNS update is non-fatal on failure)
      try {
        await fetch("/setup-api/system/hostname", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostname: normalizedHostname }),
          signal: controller.signal,
        });
      } catch (hostnameErr) {
        if (hostnameErr instanceof DOMException && hostnameErr.name === "AbortError") return;
        // Non-fatal during setup: reboot at the end will still apply from config.
      }
      if (controller.signal.aborted) return;

      // Save system password if provided
      if (password) {
        const res = await fetch("/setup-api/system/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setStatus({
            type: "error",
            message: data.error || t("credentials.failedSetPassword"),
          });
          return;
        }
      }

      // Save hotspot settings
      const hotspotRes = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: hotspotEnabled ? hotspotName.trim() : "ClawBox-Setup",
          password: hotspotEnabled ? (hotspotPassword || undefined) : undefined,
          enabled: hotspotEnabled,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const hotspotData = await hotspotRes.json().catch(() => ({}));
      if (!hotspotRes.ok) {
        setStatus({
          type: "error",
          message: hotspotData.error || t("credentials.failedSaveHotspot"),
        });
        return;
      }

      // Decide whether this submit drops or moves the connection. Everything
      // stays on clawbox.local: when the setup AP actually restarted
      // (apRestarted) anyone on it must rejoin the renamed hotspot, and when the
      // device name changed the box reappears at a new *.local origin. Either
      // way the overlay probes until the box answers, then continues.
      const apRestarted = hotspotData.apRestarted === true;
      const currentHost = window.location.hostname.toLowerCase();
      const hostnameChanged =
        currentHost.endsWith(".local") && currentHost !== newHost && isAllowedRedirect;

      if (apRestarted || hostnameChanged) {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setHandoff({
          targetUrl: hostnameChanged
            ? newSetupUrl.toString()
            : new URL("/setup", window.location.href).toString(),
          sameOrigin: !hostnameChanged,
          hotspotSsid: apRestarted && hotspotEnabled ? hotspotName.trim() : null,
        });
        return;
      }

      setStatus({
        type: "success",
        message: t("credentials.settingsSaved"),
      });
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => onNext(), 1500);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof TypeError && err.message.includes("fetch")) {
        // The save dropped this tab mid-flight — the AP restart (or device-name
        // change) took the connection down before the response arrived. Settings
        // are applied server-side; hand off to the reconnect overlay, which
        // probes clawbox.local (or the new name) until the box answers.
        const currentHost = window.location.hostname.toLowerCase();
        const hostnameChanged =
          currentHost.endsWith(".local") && currentHost !== newHost && isAllowedRedirect;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setHandoff({
          targetUrl: hostnameChanged
            ? newSetupUrl.toString()
            : new URL("/setup", window.location.href).toString(),
          sameOrigin: !hostnameChanged,
          hotspotSsid: hotspotEnabled ? hotspotName.trim() : null,
        });
        return;
      }
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  const inputBorder = (hasError: boolean) =>
    hasError
      ? "border-red-500 focus:border-red-500"
      : "border-[var(--hair-2)] focus:border-[var(--coral-bright)]";

  const EyeOpen = (
    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>visibility</span>
  );
  const EyeClosed = (
    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>visibility_off</span>
  );

  // Same expression the hostname validator uses, hoisted so the address the
  // customer reads and the border they see can never disagree.
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.local$/, "");
  const hostnameValid = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedHostname);
  const displayHostname = normalizedHostname || "clawbox";

  // A field that is the reason the save failed cannot stay behind a
  // disclosure: once validation has run and rejected it, it is open whatever
  // the customer last chose, and the red border is on screen with the message.
  const nameVisible = nameOpen || (touched && !hostnameValid);
  const hotspotNameVisible =
    hotspotEnabled && (hotspotNameOpen || (touched && !hotspotName.trim()));

  // The hotspot password and its confirmation are the only fields on this
  // screen that a disclosure could turn into a silent blocker: unlike the two
  // names, nothing is read back from the device to stand in for them, and the
  // primary action is unavailable until both are supplied. So the row that
  // opens them is never merely a chevron — while they are missing it carries
  // the requirement itself ("Minimum 8 characters", the same words the field's
  // own placeholder uses), in amber, directly above the button it is holding.
  // And once validation has actually rejected them the panel is open with its
  // red borders whatever the customer last chose, exactly as the device name
  // above behaves.
  const hotspotSecretMissing = !hotspotPassword || !confirmHotspotPassword;
  const hotspotSecretInvalid =
    hotspotSecretMissing ||
    hotspotPassword.length < 8 ||
    hotspotPassword !== confirmHotspotPassword;
  const hotspotSecretVisible =
    hotspotEnabled && (hotspotSecretOpen || (touched && hotspotSecretInvalid));

  // The same expression the button has always been disabled by, split in two
  // so the button can paint the two reasons differently: "not yet" (something
  // is still missing) is a quiet control, while "in flight" keeps its coral —
  // the action is happening, and coral means ACTION.
  const incomplete =
    !password ||
    !confirmPassword ||
    (hotspotEnabled && (!hotspotPassword || !confirmHotspotPassword));
  const blocked = saving || incomplete;

  return (
    <div className="w-full max-w-[520px]" data-testid="setup-step-credentials">
      {handoff && (
        <CredentialsHandoffOverlay
          targetUrl={handoff.targetUrl}
          sameOrigin={handoff.sameOrigin}
          hotspotSsid={handoff.hotspotSsid}
          onContinue={onNext}
        />
      )}
      <div className="card-surface rounded-[var(--r-3)] p-[var(--s-5)] sm:p-[var(--s-7)]">
        <h1
          className="font-bold font-display mb-[var(--s-2)]"
          style={{ fontSize: "var(--t-6)", lineHeight: 1.15 }}
        >
          {t("credentials.title")}
        </h1>
        <p
          className="text-[var(--text-secondary)] mb-[var(--s-6)]"
          style={{ fontSize: "var(--t-4)", lineHeight: 1.6 }}
        >
          {t("credentials.description")}
        </p>

        {/* ── The address ──
            The new address of the box is the outcome of this screen, so it is
            stated as a fact rather than inferred from a text input with a
            suffix. The name behind it already has a working value read back
            from the device, so the field itself is one tap away instead of
            costing a label, a 48px control and a help line on first paint. */}
        <div className="mb-[var(--s-6)] rounded-[var(--r-1)] border border-[var(--border-subtle)] bg-[var(--fill-1)]">
          <button
            type="button"
            onClick={() => setNameOpen((v) => !v)}
            aria-expanded={nameVisible}
            aria-controls="cred-hostname-panel"
            aria-label={`${t("credentials.localUrlLabel")}: http://${displayHostname}.local`}
            className="flex w-full items-center gap-[var(--s-3)] min-h-[48px] px-[var(--s-4)] py-[var(--s-2)] text-left bg-transparent border-none rounded-[var(--r-1)] cursor-pointer hover:bg-[var(--fill-2)]"
            style={{ transition: "background-color var(--d-2) var(--ease-standard)" }}
          >
            <span
              className="flex-1 min-w-0 font-mono break-all text-[var(--text-secondary)]"
              style={{ fontSize: "var(--t-4)", lineHeight: 1.4 }}
            >
              http://
              <em className="not-italic text-[var(--coral-bright)]">{displayHostname}</em>
              .local
            </span>
            <span
              aria-hidden="true"
              className="material-symbols-rounded shrink-0 text-[var(--text-muted)]"
              style={{ fontSize: 18 }}
            >
              edit
            </span>
          </button>

          {nameVisible && (
            <div
              id="cred-hostname-panel"
              className="border-t border-[var(--hair)] px-[var(--s-4)] pt-[var(--s-3)] pb-[var(--s-4)]"
            >
              <FieldLabel htmlFor="cred-hostname">{t("credentials.localUrlLabel")}</FieldLabel>
              <div
                className={`flex items-center bg-[var(--fill-2)] border rounded-[var(--r-2)] overflow-hidden ${
                  touched && !hostnameValid
                    ? "border-red-500"
                    : "border-[var(--hair-2)] focus-within:border-[var(--coral-bright)]"
                }`}
                style={FIELD_MOTION}
              >
                <input
                  id="cred-hostname"
                  type="text"
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") save(); }}
                  maxLength={63}
                  placeholder="clawbox"
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1 min-w-0 min-h-[48px] pl-[var(--s-4)] pr-[var(--s-1)] py-[var(--s-3)] bg-transparent text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                  style={T_FIELD}
                />
                <span
                  className="shrink-0 pr-[var(--s-4)] font-mono text-[var(--text-muted)] select-none"
                  style={{ fontSize: "var(--t-4)" }}
                >
                  .local
                </span>
              </div>
              <p
                className="mt-[var(--s-2)] text-[var(--text-muted)]"
                style={{ fontSize: "var(--t-2)", lineHeight: 1.5 }}
              >
                {t("credentials.localUrlHelp")}
              </p>
            </div>
          )}
        </div>

        {/* ── System password ── */}
        <SectionHead>{t("credentials.systemPassword")}</SectionHead>

        <div className="mb-[var(--s-5)]">
          <FieldLabel htmlFor="cred-password">{t("credentials.newPassword")}</FieldLabel>
          <div className="relative">
            <input
              id="cred-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              placeholder={t("credentials.minChars")}
              autoComplete="new-password"
              className={`${FIELD} ${FIELD_PAD_REVEAL} ${inputBorder(touched && !password)}`}
              style={{ ...T_FIELD, ...FIELD_MOTION }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className={REVEAL}
            >
              {showPassword ? EyeClosed : EyeOpen}
            </button>
          </div>
        </div>

        <div className="mb-[var(--s-6)]">
          <FieldLabel htmlFor="cred-confirm">{t("credentials.confirmPassword")}</FieldLabel>
          <div className="relative">
            <input
              id="cred-confirm"
              type={showConfirm ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              placeholder={t("credentials.reenterPassword")}
              autoComplete="new-password"
              className={`${FIELD} ${FIELD_PAD_REVEAL} ${inputBorder(touched && !confirmPassword)}`}
              style={{ ...T_FIELD, ...FIELD_MOTION }}
            />
            <button
              type="button"
              onClick={() => setShowConfirm((v) => !v)}
              aria-label={showConfirm ? "Hide password" : "Show password"}
              className={REVEAL}
            >
              {showConfirm ? EyeClosed : EyeOpen}
            </button>
          </div>
        </div>

        {/* ── Hotspot ──
            The switch, the network's name and what the switch's position means
            are one object, so they share one bordered surface instead of being
            a heading, a control floated to the right of it and a caption. The
            name is shown, not typed: renaming it is behind the same edit
            affordance as the device name. */}
        <SectionHead>{t("credentials.hotspotSettings")}</SectionHead>

        <div className="rounded-[var(--r-1)] border border-[var(--border-subtle)] bg-[var(--fill-1)]">
          <div className="flex items-center gap-[var(--s-2)] pl-[var(--s-4)] pr-[var(--s-2)]">
            <div className="flex-1 min-w-0 py-[var(--s-2)]">
              <div className="flex items-center gap-[var(--s-1)]">
                <span
                  className="min-w-0 truncate text-[var(--text-primary)]"
                  style={{ fontSize: "var(--t-4)", fontWeight: "var(--w-label)" }}
                >
                  {hotspotName || "ClawBox-Setup"}
                </span>
                {hotspotEnabled && (
                  <button
                    type="button"
                    onClick={() => setHotspotNameOpen((v) => !v)}
                    aria-expanded={hotspotNameVisible}
                    aria-controls="hotspot-name-panel"
                    aria-label={t("credentials.hotspotName")}
                    className="grid place-items-center shrink-0 w-8 h-8 -my-1 rounded-[var(--r-1)] bg-transparent border-none cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-3)]"
                  >
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>edit</span>
                  </button>
                )}
              </div>
              <p
                className="mt-[var(--s-0)] text-[var(--text-muted)]"
                style={{ fontSize: "var(--t-1)", lineHeight: 1.5 }}
              >
                {hotspotEnabled
                  ? t("credentials.hotspotChangesApply")
                  : t("credentials.hotspotDisabled")}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={hotspotEnabled}
              aria-label="Enable hotspot"
              onClick={() => setHotspotEnabled((v) => !v)}
              className="grid place-items-center shrink-0 h-12 px-[var(--s-1)] bg-transparent border-none cursor-pointer"
            >
              <span
                aria-hidden="true"
                className={`relative block w-[46px] h-[26px] rounded-[var(--r-full)] ${
                  hotspotEnabled ? "bg-[var(--coral-bright)]" : "bg-[var(--fill-3)]"
                }`}
                style={{ transition: "background-color var(--d-2) var(--ease-standard)" }}
              >
                <span
                  className="absolute top-[3px] left-[3px] block w-5 h-5 rounded-[var(--r-full)] bg-white"
                  style={{
                    transform: hotspotEnabled ? "translateX(20px)" : "translateX(0)",
                    transition: "transform var(--d-1) var(--ease-standard)",
                  }}
                />
              </span>
            </button>
          </div>

          {hotspotNameVisible && (
            <div
              id="hotspot-name-panel"
              className="border-t border-[var(--hair)] px-[var(--s-4)] pt-[var(--s-3)] pb-[var(--s-4)]"
            >
              <FieldLabel htmlFor="hotspot-name">{t("credentials.hotspotName")}</FieldLabel>
              <input
                id="hotspot-name"
                type="text"
                value={hotspotName}
                onChange={(e) => setHotspotName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
                maxLength={32}
                /* An SSID is a radio network name, not a username — declared so
                   it is not paired with the passphrase below as a login form.
                   (See the `::backdrop` note in globals.css for what an autofill
                   popover used to do to this screen.) */
                name="hotspot-ssid"
                autoComplete="off"
                className={`${FIELD} ${FIELD_PAD} ${inputBorder(touched && !hotspotName.trim())}`}
                style={{ ...T_FIELD, ...FIELD_MOTION }}
              />
            </div>
          )}

          {/* The hotspot's password belongs to the hotspot, so it lives on the
              hotspot's own surface rather than floating below the card. The
              row stays put when the panel opens: a disclosure trigger that
              unmounts itself drops keyboard focus on the floor. */}
          {hotspotEnabled && (
            <button
              type="button"
              onClick={() => setHotspotSecretOpen((v) => !v)}
              aria-expanded={hotspotSecretVisible}
              aria-controls="hotspot-secret-panel"
              className={`flex w-full items-center gap-[var(--s-3)] min-h-[var(--h-control)] px-[var(--s-4)] py-[var(--s-2)] text-left bg-transparent border-t border-[var(--hair)] cursor-pointer hover:bg-[var(--fill-2)] ${
                hotspotSecretVisible ? "" : "rounded-b-[var(--r-1)]"
              }`}
              style={{ transition: "background-color var(--d-2) var(--ease-standard)" }}
            >
              {/* Also the open panel's heading — the field below it is not
                  labelled twice, it borrows this one through aria-labelledby. */}
              <span
                id="hotspot-secret-label"
                className="flex-1 min-w-0 text-[var(--text-secondary)]"
                style={T_LABEL}
              >
                {t("credentials.hotspotPassword")}
              </span>
              {/* Closed, the row answers "what is behind this?" — and while the
                  answer is "nothing yet", it states the rule the field will be
                  judged by rather than a decorative asterisk, so the reason the
                  primary action below is unavailable is never off screen. Open,
                  the field speaks for itself. */}
              {hotspotSecretVisible ? null : hotspotSecretMissing ? (
                <span
                  className="shrink-0 px-[var(--s-2)] py-[var(--s-0)] rounded-[var(--r-1)] border border-[var(--amber-edge)] bg-[var(--amber-wash)] text-[var(--amber-ink)]"
                  style={{
                    fontSize: "var(--t-1)",
                    fontWeight: "var(--w-label)",
                    lineHeight: "var(--lh-tight)",
                  }}
                >
                  {t("credentials.minChars")}
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className="shrink-0 text-[var(--text-muted)]"
                  style={{ fontSize: "var(--t-4)", fontFamily: "var(--f-mono)" }}
                >
                  ••••••••
                </span>
              )}
              <span
                aria-hidden="true"
                className="material-symbols-rounded shrink-0 text-[var(--text-muted)]"
                style={{ fontSize: 18 }}
              >
                {hotspotSecretVisible ? "expand_less" : "edit"}
              </span>
            </button>
          )}

          {hotspotSecretVisible && (
            <div
              id="hotspot-secret-panel"
              className="border-t border-[var(--hair)] px-[var(--s-4)] pt-[var(--s-3)] pb-[var(--s-4)]"
            >
              <div className="relative">
                <input
                  id="hotspot-password"
                  aria-labelledby="hotspot-secret-label"
                  type={showHotspotPassword ? "text" : "password"}
                  value={hotspotPassword}
                  onChange={(e) => setHotspotPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                  }}
                  placeholder={t("credentials.minChars")}
                  /* A WPA passphrase for this box's own access point, not a
                     website credential: no autofill, no capture, and NOT
                     `new-password` (the system password above is the field that
                     legitimately wants that). */
                  name="hotspot-passphrase"
                  autoComplete="off"
                  className={`${FIELD} ${FIELD_PAD_REVEAL} ${inputBorder(touched && (!hotspotPassword || hotspotPassword !== confirmHotspotPassword))}`}
                  style={{ ...T_FIELD, ...FIELD_MOTION }}
                />
                <button
                  type="button"
                  onClick={() => setShowHotspotPassword((v) => !v)}
                  aria-label={showHotspotPassword ? "Hide password" : "Show password"}
                  className={REVEAL}
                >
                  {showHotspotPassword ? EyeClosed : EyeOpen}
                </button>
              </div>

              <div className="mt-[var(--s-3)]">
                <FieldLabel htmlFor="hotspot-confirm">
                  {t("credentials.confirmHotspotPassword")}
                </FieldLabel>
                <div className="relative">
                  <input
                    id="hotspot-confirm"
                    type={showConfirmHotspot ? "text" : "password"}
                    value={confirmHotspotPassword}
                    onChange={(e) => setConfirmHotspotPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save();
                    }}
                    placeholder={t("credentials.reenterHotspot")}
                    /* Confirmation half of the hotspot passphrase — same
                       reasoning as the field above. */
                    name="hotspot-passphrase-confirm"
                    autoComplete="off"
                    className={`${FIELD} ${FIELD_PAD_REVEAL} ${inputBorder(touched && hotspotPassword !== confirmHotspotPassword)}`}
                    style={{ ...T_FIELD, ...FIELD_MOTION }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmHotspot((v) => !v)}
                    aria-label={showConfirmHotspot ? "Hide password" : "Show password"}
                    className={REVEAL}
                  >
                    {showConfirmHotspot ? EyeClosed : EyeOpen}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}

        {/* A disabled primary reads "not yet", not "broken": the product's own
            quiet-control recipe, solid. Opacity is deliberately not the signal
            — a button becoming unavailable is a fact, not a fade. */}
        <div className="mt-[var(--s-6)]">
          <button
            type="button"
            onClick={save}
            disabled={blocked}
            className={`w-full sm:w-auto inline-flex items-center justify-center gap-[var(--s-2)] min-h-[48px] px-[var(--s-6)] rounded-[var(--r-1)] ${
              incomplete
                ? "bg-[var(--fill-2)] border border-[var(--hair-2)] text-[var(--text-muted)] cursor-not-allowed"
                : `btn-gradient text-white ${saving ? "cursor-wait" : "cursor-pointer"}`
            }`}
            style={{
              fontSize: "var(--t-5)",
              fontWeight: "var(--w-label)",
              transition:
                "background-color var(--d-2) var(--ease-standard), border-color var(--d-2) var(--ease-standard), color var(--d-2) var(--ease-standard)",
            }}
          >
            {saving && (
              <span
                aria-hidden="true"
                className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"
              />
            )}
            {saving ? t("connecting") : t("settings.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
