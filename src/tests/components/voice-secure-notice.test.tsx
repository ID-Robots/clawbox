import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import VoiceSecureNotice from "@/components/VoiceSecureNotice";
import { I18nProvider } from "@/lib/i18n";
import { translations } from "@/lib/translations";

/**
 * TASK-2058. Voice input on http://<ip>/ answered with a red error line — a
 * fault on a box that has none — and the way to the tunnel only after a mic
 * click. This line says it calmly and up front, with the one remedy that
 * works: this very page on the Remote Access tunnel when it runs, and where to
 * turn it on when it does not.
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

const READY = { tunnel: { installed: true, service: "active", url: "https://lively-crab.trycloudflare.com" } };
const OFF = { tunnel: { installed: true, service: "inactive", url: null } };
const SETTINGS = translations.en["remoteControl.title"];

function renderNotice() {
  const navigate = vi.fn();
  const onDismiss = vi.fn();
  const onOpenRemoteAccess = vi.fn();
  render(
    <I18nProvider>
      <VoiceSecureNotice onDismiss={onDismiss} onOpenRemoteAccess={onOpenRemoteAccess} navigate={navigate} />
    </I18nProvider>,
  );
  return { navigate, onDismiss, onOpenRemoteAccess };
}

describe("VoiceSecureNotice", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.pushState({}, "", "/");
  });

  it("is a calm note, not the red error line", async () => {
    stubPortalStatus(OFF);
    renderNotice();

    const notice = await screen.findByTestId("voice-secure-notice");
    expect(notice).toHaveAttribute("role", "note");
    // The error red the voice row uses (#f87171) — and no alert semantics.
    expect(notice.style.color).not.toBe("rgb(248, 113, 113)");
    expect(notice.getAttribute("role")).not.toBe("alert");
  });

  it("offers this very page on the live tunnel when Remote Access is running", async () => {
    window.history.pushState({}, "", "/apps/chat?tab=2#voice");
    stubPortalStatus(READY);
    const { navigate } = renderNotice();

    const go = await screen.findByTestId("voice-secure-notice-go");
    await waitFor(() => expect(go.textContent).toBe(translations.en["chat.voice.tunnel.open"]));
    expect(screen.getByTestId("voice-secure-notice").textContent).toContain(translations.en["chat.voice.secureNotice.ready"]);

    fireEvent.click(go);
    expect(navigate).toHaveBeenCalledWith("https://lively-crab.trycloudflare.com/apps/chat?tab=2#voice");
    expect(screen.queryByTestId("voice-secure-notice-settings")).toBeNull();
  });

  it("asks for Remote Access to be turned on when it is off — and offers no dead link", async () => {
    stubPortalStatus(OFF);
    const { onOpenRemoteAccess } = renderNotice();

    const open = await screen.findByTestId("voice-secure-notice-settings");
    const notice = screen.getByTestId("voice-secure-notice");
    await waitFor(() =>
      expect(notice.textContent).toContain(translations.en["chat.voice.secureNotice.off"].replace("{settings}", SETTINGS)),
    );
    expect(open.textContent).toBe(translations.en["chat.voice.secureNotice.openSettings"].replace("{settings}", SETTINGS));
    expect(screen.queryByTestId("voice-secure-notice-go")).toBeNull();

    fireEvent.click(open);
    expect(onOpenRemoteAccess).toHaveBeenCalledTimes(1);
  });

  it("says it could not check rather than claiming Remote Access is off", async () => {
    stubPortalStatus({}, false);
    renderNotice();

    const notice = await screen.findByTestId("voice-secure-notice");
    await waitFor(() => expect(notice.getAttribute("data-tunnel")).toBe("failed"));
    await waitFor(() =>
      expect(notice.textContent).toContain(translations.en["chat.voice.secureNotice.failed"].replace("{settings}", SETTINGS)),
    );
    expect(notice.textContent).not.toContain(translations.en["chat.voice.secureNotice.off"].replace("{settings}", SETTINGS));
    expect(screen.queryByTestId("voice-secure-notice-go")).toBeNull();
  });

  it("can be dismissed", async () => {
    stubPortalStatus(OFF);
    const { onDismiss } = renderNotice();

    const dismiss = await screen.findByTestId("voice-secure-notice-dismiss");
    await waitFor(() => expect(dismiss.getAttribute("aria-label")).toBe(translations.en["chat.voice.dismiss"]));
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
