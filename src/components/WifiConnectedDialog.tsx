"use client";

import { useT } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useDeviceAddress } from "@/hooks/useDeviceAddress";

/** What /setup-api/wifi/connect-status answers (src/lib/network.ts ConnectStatus). */
export interface WifiConnectStatus {
  phase?: string;
  ssid?: string | null;
  reason?: string | null;
  message?: string;
  step?: string | null;
  ip?: string | null;
  at?: number;
}

/**
 * A connect-status poll in words: the step while it is connecting, the reason
 * when it failed. Null when there is nothing to say (idle, connected, a step
 * this page does not know).
 */
export function wifiConnectStatusText(
  t: (key: string, params?: Record<string, string | number>) => string,
  s: WifiConnectStatus,
  ssid: string,
): { type: "info" | "error"; message: string } | null {
  if (s.phase === "connecting") {
    const message =
      s.step === "radio-on" ? t("wifi.stepRadioOn")
      : s.step === "switching" ? t("wifi.stepSwitching", { ssid })
      : s.step === "joining" ? `${t("wifi.handoffJoining", { ssid })}…`
      : s.step === "restoring" ? t("wifi.stepRestoring", { ssid })
      : null;
    return message ? { type: "info", message } : null;
  }
  if (s.phase === "failed") {
    if (s.reason === "wrong-password") return { type: "error", message: t("wifi.wrongPassword") };
    const reason = s.message || t("unknownError");
    if (s.reason === "radio-off") return { type: "error", message: t("wifi.radioOff", { reason }) };
    return { type: "error", message: t("wifi.connectionFailed", { error: reason }) };
  }
  return null;
}

/**
 * "Connected" after the box switched from its hotspot to a WiFi network: the
 * network, the address it got there and its .local name, so the owner knows
 * where to find it. One OK button; the shared modal hook traps focus and
 * closes on Escape.
 */
export default function WifiConnectedDialog({
  ssid,
  ip,
  onClose,
}: {
  ssid: string;
  ip: string | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const { localUrl } = useDeviceAddress();
  const panelRef = useModalDialog<HTMLDivElement>({ onClose });
  let local = localUrl;
  try {
    local = new URL(localUrl).host;
  } catch {
    /* keep raw */
  }
  const rows: [string, string][] = [
    [t("wifi.connectedNetwork"), ssid],
    ...(ip ? [[t("wifi.connectedIp"), ip] as [string, string]] : []),
    [t("wifi.connectedLocal"), local],
  ];

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/65 p-4" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wifi-connected-title"
        data-testid="wifi-connected-dialog"
        className="card-surface rounded-2xl p-6 w-full max-w-md shadow-2xl border border-[var(--border-subtle)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#00e5cc]/15">
            <span className="material-symbols-rounded text-[#00e5cc]" style={{ fontSize: 22 }} aria-hidden="true">wifi</span>
          </div>
          <h3 id="wifi-connected-title" className="text-lg font-semibold text-[var(--text-primary)]">
            {t("wifi.connectedTitle")}
          </h3>
        </div>
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-[var(--text-muted)]">{label}</dt>
              <dd className="font-medium text-[var(--text-primary)] break-all select-all">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mb-5 text-xs text-[var(--text-secondary)]">{t("wifi.connectedHint")}</p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--coral-bright)] hover:opacity-90 transition-opacity"
          >
            {t("wifi.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
