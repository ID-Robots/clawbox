import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import VoiceTunnelDialog from "@/components/VoiceTunnelDialog";
import { I18nProvider } from "@/lib/i18n";
import { translations } from "@/lib/translations";

/**
 * The popup behind the chat microphone on an insecure origin (TASK-470,
 * Yanko 2026-08-22 19:34: "Notification and popup that redirects to the
 * cloudflare tunnel"). Its acceptance has three legs and each gets a test:
 * a working one-click route when the tunnel is up, an honest "it is off,
 * here is the setting" when it is not — never a dead link — and an equally
 * honest "could not check" when the status is unreadable.
 */

function stubPortalStatus(payload: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/portal/status")) {
        return { ok, json: async () => payload };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

function renderDialog(navigate = vi.fn(), onClose = vi.fn()) {
  render(
    <I18nProvider>
      <VoiceTunnelDialog open onClose={onClose} navigate={navigate} />
    </I18nProvider>,
  );
  return { navigate, onClose };
}

describe("VoiceTunnelDialog", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("offers a one-click route to this box's live tunnel address", async () => {
    stubPortalStatus({ tunnel: { installed: true, service: "active", url: "https://lively-crab.trycloudflare.com" } });
    const { navigate } = renderDialog();

    const go = await screen.findByTestId("voice-tunnel-go");
    expect(go.textContent).toBe(translations.en["chat.voice.tunnel.open"]);

    fireEvent.click(go);
    // The whole point of the card: the destination is the LIVE address the
    // box published, not a hardcoded or remembered one.
    expect(navigate).toHaveBeenCalledWith("https://lively-crab.trycloudflare.com/");
  });

  it("says the tunnel is off and names the setting, with no dead link", async () => {
    stubPortalStatus({ tunnel: { installed: true, service: "inactive", url: null } });
    renderDialog();

    const dialog = await screen.findByTestId("voice-tunnel-dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain(translations.en["remoteControl.title"]);
    });
    // Offering a link that goes nowhere is worse than the message this popup
    // replaces, so the action button must not exist in this state.
    expect(screen.queryByTestId("voice-tunnel-go")).toBeNull();
  });

  it("admits it could not check rather than claiming the tunnel is off", async () => {
    stubPortalStatus({}, false);
    renderDialog();

    const dialog = await screen.findByTestId("voice-tunnel-dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain(
        translations.en["chat.voice.tunnel.failed"].replace("{settings}", translations.en["remoteControl.title"]),
      );
    });
    expect(screen.queryByTestId("voice-tunnel-go")).toBeNull();
  });

  it("is a labelled modal dialog and closes from its Close button", async () => {
    stubPortalStatus({ tunnel: { installed: true, service: "active", url: "https://x.trycloudflare.com" } });
    const { onClose } = renderDialog();

    const dialog = await screen.findByTestId("voice-tunnel-dialog");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.getAttribute("aria-label")).toBe(translations.en["chat.voice.tunnel.title"]);

    fireEvent.click(screen.getByTestId("voice-tunnel-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape without letting the key reach the page behind", async () => {
    stubPortalStatus({ tunnel: { installed: true, service: "active", url: "https://x.trycloudflare.com" } });
    const { onClose } = renderDialog();
    await screen.findByTestId("voice-tunnel-dialog");

    // ChatPopup closes the whole chat on Escape from a window-level handler;
    // an un-trapped dialog would hand this keystroke straight to it and the
    // customer would lose the chat under the popup.
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", behind);
    }
    expect(onClose).toHaveBeenCalled();
    expect(behind).not.toHaveBeenCalled();
  });

  it("traps Tab inside the dialog", async () => {
    stubPortalStatus({ tunnel: { installed: true, service: "active", url: "https://x.trycloudflare.com" } });
    renderDialog();
    const go = await screen.findByTestId("voice-tunnel-go");
    const close = screen.getByTestId("voice-tunnel-close");

    // Focus moved into the dialog on open…
    expect(document.activeElement).toBe(close);
    // …and Tab wraps from the last control back to the first instead of
    // walking out into the page behind the scrim.
    go.focus();
    fireEvent.keyDown(go, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(go);
  });

  it("renders nothing while closed", () => {
    stubPortalStatus({ tunnel: { installed: true, service: "active", url: "https://x.trycloudflare.com" } });
    render(
      <I18nProvider>
        <VoiceTunnelDialog open={false} onClose={() => {}} navigate={() => {}} />
      </I18nProvider>,
    );
    expect(screen.queryByTestId("voice-tunnel-dialog")).toBeNull();
  });
});
