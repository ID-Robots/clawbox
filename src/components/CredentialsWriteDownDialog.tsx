"use client";

import { useEffect, useId, useRef, useState } from "react";
import { accentFor, type Accent } from "@/lib/edition-accent";
import { copyToClipboard } from "@/lib/clipboard";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useT } from "@/lib/i18n";

export interface CredentialsWriteDownDialogProps {
  /** The system/sudo password exactly as the customer typed it. */
  systemPassword: string;
  /** The hotspot password as typed, or null when the hotspot is switched off. */
  hotspotPassword: string | null;
  /** The network the hotspot password belongs to — a password with no network
   *  name next to it is half an instruction. */
  hotspotSsid: string;
  /**
   * Hermes edition: the ACCENT — copy buttons, the acknowledgement box, the
   * primary button, the hover edges — takes the agent's green instead of
   * coral, exactly as the Step-3 handoff overlay does.
   *
   * The warning band above them stays red on BOTH editions. Red here is the
   * semantic danger colour, not the brand accent: a band that changed hue with
   * the SKU would be reading as decoration, and the one thing this screen must
   * not be read as is decoration.
   */
  hermes?: boolean;
  /** Acknowledged — run the save that was interposed. */
  onConfirm: () => void;
  /** Escape or Back — return to the form with nothing saved. */
  onCancel: () => void;
}

/* ── The danger band's palette ──────────────────────────────────────────────
   Written out rather than tokenised because there is no danger rung in the
   wizard's ladders — CredentialsStep says as much where its invalid borders
   keep the product's shipped red. These are that same red family. */
const DANGER_TINT = "rgba(255, 95, 82, 0.20)";
const DANGER_FADE = "rgba(255, 95, 82, 0.04)";
const DANGER_EDGE = "rgba(255, 95, 82, 0.28)";
const DANGER_BADGE_FILL = "rgba(255, 95, 82, 0.18)";
const DANGER_BADGE_EDGE = "rgba(255, 95, 82, 0.30)";
const DANGER_INK = "#ffd9d5";
const DANGER_INK_2 = "rgba(255, 180, 172, 0.85)";

/**
 * The last thing between a customer and a password they can never be shown
 * again.
 *
 * Step 3 sets the box's system password (sudo and SSH) and the setup hotspot's
 * password. Both are write-only from here on: nothing on the device can read
 * either one back, so a customer who mistypes into two matching fields, or
 * simply forgets what they chose, has no route back except a factory reset —
 * which erases the setup they are in the middle of doing.
 *
 * So the save does not fire straight off the button. This dialog opens under a
 * red band that names the stake, reads the values back in full, one card each,
 * and asks for a deliberate acknowledgement before it lets the save proceed.
 * The passwords shown here are the customer's own input echoed on their own
 * screen — nothing is transmitted, stored or logged by this component.
 */
export default function CredentialsWriteDownDialog({
  systemPassword,
  hotspotPassword,
  hotspotSsid,
  hermes = false,
  onConfirm,
  onCancel,
}: CredentialsWriteDownDialogProps) {
  const { t } = useT();
  const [acknowledged, setAcknowledged] = useState(false);
  const titleId = useId();
  const sublineId = useId();
  const panelRef = useModalDialog<HTMLDivElement>({ onClose: onCancel });

  const accent = accentFor(hermes);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto px-[var(--s-4)] py-[var(--s-6)]"
      style={{ background: "rgba(0, 0, 0, 0.62)", backdropFilter: "blur(6px)" }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={sublineId}
        data-agent={hermes ? "hermes" : undefined}
        data-testid="credentials-writedown-dialog"
        className="my-auto w-full max-w-[480px] overflow-hidden rounded-[var(--r-3)] border"
        style={{
          // Opaque, not the translucent card surface: characters a customer is
          // being asked to transcribe must not have the page showing through.
          background: "var(--bg-elevated)",
          borderColor: "var(--border-subtle)",
          boxShadow: "0 24px 64px rgba(0, 0, 0, 0.55)",
        }}
      >
        {/* ── The stake ──
            Full-bleed and red on every edition. The panel clips it, so the band
            reaches both edges without a corner of the card showing past it. */}
        <div
          data-testid="writedown-danger-band"
          className="flex items-start gap-[var(--s-3)] px-[var(--s-5)] py-[var(--s-4)]"
          style={{
            background: `linear-gradient(180deg, ${DANGER_TINT} 0%, ${DANGER_FADE} 100%)`,
            borderBottom: `1px solid ${DANGER_EDGE}`,
          }}
        >
          {/* The badge and the glyph are two elements on purpose. `globals.css`
              declares `.material-symbols-rounded { display: inline-block }`
              UNLAYERED, and Tailwind's `.grid` lives inside `@layer utilities`
              — unlayered always wins the cascade over layered, whatever the
              source order. So a badge that wore the font class ITSELF stayed
              inline-block, `place-items-center` had no grid to act on, and the
              lock sat against the top-left corner of the 2.3rem square. Kept
              apart, the badge is a real grid box and centres its child on both
              axes — the same shape the acknowledgement box below uses, and the
              icon badges in UpdateStep. */}
          <span
            aria-hidden="true"
            data-testid="writedown-danger-badge"
            className="grid shrink-0 place-items-center rounded-[10px]"
            style={{
              width: "2.3rem",
              height: "2.3rem",
              color: DANGER_INK,
              background: DANGER_BADGE_FILL,
              border: `1px solid ${DANGER_BADGE_EDGE}`,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
              lock
            </span>
          </span>
          <div className="min-w-0">
            <h2
              id={titleId}
              className="font-display font-bold"
              style={{ fontSize: "1rem", lineHeight: 1.25, color: DANGER_INK }}
            >
              {t("credentials.writeDownTitle")}
            </h2>
            <p
              id={sublineId}
              className="mt-[var(--s-0)]"
              style={{ fontSize: "0.76rem", lineHeight: 1.45, color: DANGER_INK_2 }}
            >
              {t("credentials.writeDownSubline")}
            </p>
          </div>
        </div>

        <div style={{ padding: "1.25rem" }}>
          <div className="flex flex-col" style={{ gap: "0.65rem" }}>
            <CredentialCard
              accent={accent}
              label={t("credentials.writeDownSystem")}
              value={systemPassword}
              testId="writedown-system"
            />
            {hotspotPassword !== null && (
              <CredentialCard
                accent={accent}
                label={`${t("credentials.writeDownHotspot")} · ${hotspotSsid}`}
                value={hotspotPassword}
                testId="writedown-hotspot"
              />
            )}
          </div>

          {/* ── The acknowledgement ──
              A real checkbox, visually replaced. The input keeps the semantics,
              the label and the tab stop; the square beside it is what the
              customer sees, and its focus ring is `peer`-driven so the keyboard
              state stays declarative rather than mirrored into React state. */}
          <label
            data-testid="writedown-ack-label"
            className="flex cursor-pointer items-start gap-[var(--s-3)]"
            style={{ marginTop: "0.9rem" }}
          >
            <input
              type="checkbox"
              data-testid="writedown-ack"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              data-testid="writedown-ack-box"
              className="mt-[2px] grid shrink-0 place-items-center peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2"
              style={{
                width: "1.15rem",
                height: "1.15rem",
                borderRadius: "6px",
                border: acknowledged ? "2px solid transparent" : "2px solid var(--hair-2)",
                background: acknowledged ? accent.gradient : "transparent",
                boxShadow: acknowledged ? `0 0 0 4px ${accent.dim}` : "none",
                color: accent.on,
                outlineColor: accent.solid,
                transition:
                  "background var(--d-2) var(--ease-standard), border-color var(--d-2) var(--ease-standard), box-shadow var(--d-2) var(--ease-standard)",
              }}
            >
              {acknowledged && (
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>
                  check
                </span>
              )}
            </span>
            <span
              className="min-w-0 text-[var(--text-primary)]"
              style={{ fontSize: "0.86rem", lineHeight: 1.5 }}
            >
              {t("credentials.writeDownAck")}
            </span>
          </label>

          <button
            type="button"
            data-testid="writedown-continue"
            onClick={onConfirm}
            disabled={!acknowledged}
            className="font-display mt-[var(--s-5)] w-full font-bold"
            style={{
              padding: "0.8rem",
              borderRadius: "11px",
              border: "none",
              fontSize: "0.92rem",
              background: accent.gradient,
              color: accent.on,
              boxShadow: acknowledged ? accent.glow : "none",
              opacity: acknowledged ? 1 : 0.32,
              filter: acknowledged ? "none" : "saturate(0.45)",
              cursor: acknowledged ? "pointer" : "not-allowed",
              transition:
                "transform var(--d-2) var(--ease-standard), box-shadow var(--d-2) var(--ease-standard), opacity var(--d-2) var(--ease-standard)",
            }}
            onMouseEnter={(e) => {
              if (acknowledged) e.currentTarget.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            {t("credentials.writeDownContinue")}
          </button>

          <button
            type="button"
            data-testid="writedown-cancel"
            onClick={onCancel}
            className="mt-[var(--s-2)] w-full cursor-pointer bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            style={{
              padding: "0.6rem",
              borderRadius: "11px",
              border: "1px solid var(--hair-2)",
              fontSize: "0.82rem",
              fontWeight: "var(--w-label)",
              transition: "color var(--d-2) var(--ease-standard)",
            }}
          >
            {t("back")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One credential, read back in full: a micro-label naming what it opens, the
 * literal characters in mono at a size that survives being copied onto paper,
 * and a copy button for the customer who keeps a password manager instead.
 */
function CredentialCard({
  accent,
  label,
  value,
  testId,
}: {
  accent: Accent;
  label: string;
  value: string;
  testId: string;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [hot, setHot] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const labelId = useId();

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  /** Put the value on the clipboard, and say so only if it actually landed. */
  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (!ok) return;
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1800);
  };

  const filled = copied || hot;

  return (
    // `role="group"` + the label's id is what ties the characters below to the
    // name of the thing they are: a bare <p> carries no name, and a screen
    // reader would announce a password with nothing to say which one it is.
    <div
      role="group"
      aria-labelledby={labelId}
      data-testid={`${testId}-plate`}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{
        background: "rgba(0, 0, 0, 0.35)",
        border: `1px solid ${hot ? accent.edge : "var(--border-subtle)"}`,
        borderRadius: "10px",
        padding: "0.8rem",
        transition: "border-color var(--d-2) var(--ease-standard)",
      }}
    >
      <div className="flex items-start gap-[var(--s-2)]">
        <span
          id={labelId}
          className="min-w-0 flex-1 uppercase text-[var(--text-muted)]"
          style={{ fontSize: "0.66rem", fontWeight: "var(--w-label)", letterSpacing: "0.13em" }}
        >
          {label}
        </span>
        <button
          type="button"
          data-testid={`${testId}-copy`}
          onClick={copy}
          aria-label={`${t("copy")}: ${label}`}
          className="shrink-0 cursor-pointer font-mono uppercase"
          style={{
            fontSize: "0.64rem",
            letterSpacing: "0.08em",
            padding: "0.22rem 0.5rem",
            borderRadius: "6px",
            border: "none",
            background: filled ? accent.solid : accent.dim,
            color: filled ? accent.on : accent.solid,
            transition:
              "background var(--d-2) var(--ease-standard), color var(--d-2) var(--ease-standard)",
          }}
        >
          {copied ? t("copied") : t("copy")}
        </button>
      </div>

      {/* The button's own label changing from "Copy" to "Copied" is a visual
          confirmation only — a screen reader is not told that the content of a
          control it is not focused on has changed. This is where it hears it.
          The region is always mounted so the announcement is a text change
          inside a live region rather than a region appearing, which some
          screen readers do not read at all. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? `${t("copied")} ${label}` : ""}
      </span>

      {/* `select-all` so one tap on a phone grabs the whole string, `break-all`
          so a long password wraps instead of pushing the card off screen. */}
      <p
        data-testid={`${testId}-value`}
        className="mt-[var(--s-2)] font-mono break-all text-[var(--text-primary)] select-all"
        style={{ fontSize: "1.04rem", lineHeight: 1.35 }}
      >
        {value}
      </p>
    </div>
  );
}
