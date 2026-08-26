"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
   * Hermes edition: the ambient accent takes the agent's green
   * (`--agent-live`) instead of coral, exactly as the Step-3 handoff overlay
   * does. Coral stays on the primary button: coral means ACTION on every
   * edition, and only the ambient identity of a screen changes with it.
   */
  hermes?: boolean;
  /** Acknowledged — run the save that was interposed. */
  onConfirm: () => void;
  /** Escape or Back — return to the form with nothing saved. */
  onCancel: () => void;
}

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
 * So the save does not fire straight off the button. This dialog reads the
 * values back in full, plainly, one per plate, and asks for a deliberate
 * acknowledgement before it lets the save proceed. The passwords shown here
 * are the customer's own input echoed on their own screen — nothing is
 * transmitted, stored or logged by this component.
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
  const leadId = useId();
  const panelRef = useModalDialog<HTMLDivElement>({ onClose: onCancel });

  // The ambient accent, written as full literal class strings on both branches
  // so Tailwind's scanner sees them — the same shape ReconnectStage uses. The
  // colour rides in the unambiguous arbitrary-property form (`[color:…]`)
  // rather than `text-[…]`, which is ambiguous between colour and size.
  const accentEdge = hermes
    ? "border-[var(--agent-live,#4ade80)]"
    : "border-[var(--coral-bright)]";
  const accentInk = hermes
    ? "[color:var(--agent-live,#4ade80)]"
    : "[color:var(--coral-bright)]";
  const accentControl = hermes
    ? "[accent-color:var(--agent-live,#4ade80)]"
    : "[accent-color:var(--coral-bright)]";

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
        aria-describedby={leadId}
        data-agent={hermes ? "hermes" : undefined}
        data-testid="credentials-writedown-dialog"
        className="my-auto w-full max-w-[520px] rounded-[var(--r-3)] border p-[var(--s-5)] sm:p-[var(--s-6)]"
        style={{
          // Opaque, not the translucent card surface: text a customer is being
          // asked to transcribe character by character must not have the page
          // showing through it.
          background: "var(--bg-elevated)",
          borderColor: "var(--border-subtle)",
          boxShadow: "0 24px 64px rgba(0, 0, 0, 0.55)",
        }}
      >
        <div className="mb-[var(--s-3)] flex items-start gap-[var(--s-3)]">
          <span
            aria-hidden="true"
            className="material-symbols-rounded grid h-10 w-10 shrink-0 place-items-center rounded-[var(--r-1)]"
            style={{
              fontSize: 22,
              color: "var(--amber-ink)",
              background: "var(--amber-wash)",
              border: "1px solid var(--amber-edge)",
            }}
          >
            edit_note
          </span>
          <h2
            id={titleId}
            className="font-display min-w-0 font-bold text-[var(--text-primary)]"
            style={{ fontSize: "var(--t-5)", lineHeight: 1.25 }}
          >
            {t("credentials.writeDownTitle")}
          </h2>
        </div>

        <p
          id={leadId}
          className="mb-[var(--s-5)] text-[var(--text-secondary)]"
          style={{ fontSize: "var(--t-3)", lineHeight: 1.6 }}
        >
          {t("credentials.writeDownLead")}
        </p>

        <PasswordPlate
          edgeClass={accentEdge}
          inkClass={accentInk}
          label={t("credentials.writeDownSystem")}
          value={systemPassword}
          testId="writedown-system"
        />

        {hotspotPassword !== null && (
          <PasswordPlate
            edgeClass={accentEdge}
            inkClass={accentInk}
            label={t("credentials.writeDownHotspot")}
            caption={t("credentials.writeDownNetwork", { ssid: hotspotSsid })}
            value={hotspotPassword}
            testId="writedown-hotspot"
          />
        )}

        <p
          className="mt-[var(--s-4)] rounded-[var(--r-1)] px-[var(--s-3)] py-[var(--s-3)]"
          style={{
            fontSize: "var(--t-2)",
            lineHeight: 1.6,
            color: "var(--amber-ink)",
            background: "var(--amber-wash)",
            border: "1px solid var(--amber-edge)",
          }}
        >
          {t("credentials.writeDownWhy")}
        </p>

        <label
          className="mt-[var(--s-5)] flex cursor-pointer items-start gap-[var(--s-3)] rounded-[var(--r-1)] border border-[var(--hair-2)] bg-[var(--fill-1)] px-[var(--s-3)] py-[var(--s-3)]"
          style={{ transition: "border-color var(--d-2) var(--ease-standard)" }}
        >
          <input
            type="checkbox"
            data-testid="writedown-ack"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className={`mt-[2px] h-5 w-5 shrink-0 cursor-pointer ${accentControl}`}
          />
          <span
            className="min-w-0 text-[var(--text-primary)]"
            style={{ fontSize: "var(--t-3)", lineHeight: 1.5 }}
          >
            {t("credentials.writeDownAck")}
          </span>
        </label>

        <div className="mt-[var(--s-5)] flex flex-col-reverse gap-[var(--s-3)] sm:flex-row">
          <button
            type="button"
            data-testid="writedown-cancel"
            onClick={onCancel}
            className="inline-flex min-h-[var(--h-control)] flex-1 cursor-pointer items-center justify-center rounded-[var(--r-1)] border border-[var(--hair-2)] bg-[var(--fill-2)] px-[var(--s-5)] text-[var(--text-secondary)] hover:bg-[var(--fill-3)]"
            style={{
              fontSize: "var(--t-4)",
              fontWeight: "var(--w-label)",
              transition: "background-color var(--d-2) var(--ease-standard)",
            }}
          >
            {t("back")}
          </button>
          <button
            type="button"
            data-testid="writedown-continue"
            onClick={onConfirm}
            disabled={!acknowledged}
            className={`inline-flex min-h-[var(--h-control)] flex-1 items-center justify-center rounded-[var(--r-1)] px-[var(--s-5)] ${
              acknowledged
                ? "btn-gradient cursor-pointer text-white"
                : "cursor-not-allowed border border-[var(--hair-2)] bg-[var(--fill-2)] text-[var(--text-muted)]"
            }`}
            style={{
              fontSize: "var(--t-4)",
              fontWeight: "var(--w-label)",
              transition:
                "background-color var(--d-2) var(--ease-standard), color var(--d-2) var(--ease-standard)",
            }}
          >
            {t("continue")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One password, read back in full: the label, the network it belongs to when
 * there is one, the literal characters in mono at a size that survives being
 * copied onto paper, and a copy button for the customer who keeps a password
 * manager instead.
 */
function PasswordPlate({
  edgeClass,
  inkClass,
  label,
  caption,
  value,
  testId,
}: {
  edgeClass: string;
  inkClass: string;
  label: string;
  caption?: ReactNode;
  value: string;
  testId: string;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const labelId = useId();

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (!ok) return;
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    // `role="group"` + the label's id is what ties the characters below to
    // the name of the thing they are: a bare <p> carries no name, and screen
    // readers would announce a password with nothing to say which one it is.
    <div
      role="group"
      aria-labelledby={labelId}
      data-testid={`${testId}-plate`}
      className={`mb-[var(--s-3)] rounded-[var(--r-2)] border bg-[var(--fill-1)] px-[var(--s-4)] py-[var(--s-3)] ${edgeClass}`}
    >
      <div className="flex items-center gap-[var(--s-2)]">
        <span
          id={labelId}
          className={`min-w-0 flex-1 uppercase ${inkClass}`}
          style={{
            fontSize: "var(--t-1)",
            fontWeight: "var(--w-label)",
            letterSpacing: "0.14em",
          }}
        >
          {label}
        </span>
        <button
          type="button"
          data-testid={`${testId}-copy`}
          onClick={copy}
          aria-label={`${t("copy")}: ${label}`}
          className="inline-flex shrink-0 cursor-pointer items-center gap-[var(--s-1)] rounded-[var(--r-1)] border border-[var(--hair-2)] bg-transparent px-[var(--s-2)] py-[var(--s-1)] text-[var(--text-muted)] hover:bg-[var(--fill-3)] hover:text-[var(--text-primary)]"
          style={{ fontSize: "var(--t-1)", fontWeight: "var(--w-label)" }}
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>
            {copied ? "check" : "content_copy"}
          </span>
          {copied ? t("copied") : t("copy")}
        </button>
      </div>

      {/* The value itself. `select-all` so one tap on a phone grabs the whole
          string, and `break-all` so a long password wraps instead of pushing
          the plate off screen. */}
      <p
        data-testid={`${testId}-value`}
        className="mt-[var(--s-2)] text-[length:var(--t-6)] font-mono break-all text-[var(--text-primary)] select-all"
        style={{ lineHeight: 1.3 }}
      >
        {value}
      </p>

      {caption && (
        <p
          className="mt-[var(--s-1)] text-[var(--text-muted)]"
          style={{ fontSize: "var(--t-2)", lineHeight: 1.5 }}
        >
          {caption}
        </p>
      )}
    </div>
  );
}
