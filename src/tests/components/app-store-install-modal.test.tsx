import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import AppStore from "@/components/AppStore";

/**
 * Keyboard access to the app store's install confirmation.
 *
 * The dialog used to be unusable without a mouse. It never moved focus in, so
 * focus stayed on the "Install" button BEHIND the scrim; Tab then walked the
 * store's search box, sort menu and category tabs — every control the dialog
 * was supposed to be blocking — and Escape was wired as an `onKeyDown` on the
 * backdrop div, which is not focusable and therefore never received the key.
 * A keyboard or screen-reader user could open the confirmation and had no
 * reliable way to reach "Install anyway" or to dismiss it.
 *
 * These tests assert the behaviour, not the attributes: where focus actually
 * lands after Tab, Shift-Tab and close.
 *
 * `useT` falls back to identity when no provider is mounted, so labels assert
 * as their translation keys ("cancel", "store.installAnyway").
 */

const APP = {
  name: "Weather Deck",
  slug: "weather-deck",
  summary: "Forecast cards for the desktop shell.",
  category: "Utilities",
  rating: 5,
  installs: "2800+",
  channel: "official",
};

const LIST = {
  total: 1,
  categories: [{ id: "Utilities", name: "Utilities", count: 1 }],
  apps: [APP],
};

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

beforeEach(() => {
  // The suite runs with `mockReset: true`, which strips the implementation off
  // the shared IntersectionObserver stub in setup.ts before each test. The
  // store observes a scroll sentinel on mount, so re-stub it here.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/setup-api/apps/store")) return jsonResponse(LIST);
      if (url.startsWith("/setup-api/apps/install")) return jsonResponse({ success: true });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Open the confirmation from the store list and return its panel. */
async function openInstallConfirmation() {
  const view = render(<AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />);

  const installButton = await screen.findByRole("button", { name: "store.install" });
  // Focus the trigger the way a keyboard user would have, so the restore
  // assertion below is about the dialog and not about jsdom's default.
  installButton.focus();
  expect(document.activeElement).toBe(installButton);

  fireEvent.click(installButton);

  const panel = await screen.findByRole("dialog");
  return { panel, installButton, unmount: view.unmount };
}

/** Every control the user can reach inside the dialog, in DOM order. */
function dialogButtons(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll("button"));
}

describe("app store install confirmation — keyboard access", () => {
  it("moves focus into the dialog when it opens", async () => {
    const { panel } = await openInstallConfirmation();

    const [cancel] = dialogButtons(panel);
    expect(document.activeElement).toBe(cancel);
    expect(panel.contains(document.activeElement)).toBe(true);
    // Cancel first, not the confirm: a stray Enter must not install an app the
    // user has not read the warning for.
    expect(cancel).toHaveTextContent("cancel");
  });

  it("wraps Tab from the last control back to the first instead of escaping the dialog", async () => {
    const { panel } = await openInstallConfirmation();

    const buttons = dialogButtons(panel);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    expect(first).not.toBe(last);

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(first);
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("wraps Shift-Tab from the first control back to the last", async () => {
    const { panel } = await openInstallConfirmation();

    const buttons = dialogButtons(panel);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it("pulls focus back in if it lands on the page behind the dialog", async () => {
    const { panel } = await openInstallConfirmation();

    // Focus parked on a store control behind the scrim. A real browser would
    // refuse this — the store is `inert` while the dialog is open — but jsdom
    // does not implement `inert`, which makes it a convenient way to drive the
    // recovery branch: whatever put focus out there, Tab must bring it back.
    const search = screen.getByPlaceholderText("store.searchApps");
    expect(panel.contains(search)).toBe(false);
    search.focus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(dialogButtons(panel)[0]);
  });

  it("closes on Escape and returns focus to the control that opened it", async () => {
    const { panel, installButton } = await openInstallConfirmation();
    expect(panel).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(installButton);
  });

  it("labels the dialog and puts the role on the panel, not the full-screen backdrop", async () => {
    const { panel } = await openInstallConfirmation();

    expect(panel).toHaveAttribute("aria-modal", "true");
    // Asserted structurally rather than on class text: the role must sit on a
    // CHILD of the full-screen backdrop. Had the backdrop carried it, the
    // accessible dialog would be the whole page and its name would absorb the
    // store behind it.
    const backdrop = panel.parentElement as HTMLElement;
    expect(backdrop).not.toHaveAttribute("role", "dialog");
    expect(backdrop.contains(panel)).toBe(true);
    expect(panel).not.toBe(backdrop);
    const title = document.getElementById(panel.getAttribute("aria-labelledby") as string);
    expect(title).toHaveTextContent("store.confirmTitle");
  });

  it("hides the page behind the dialog from assistive tech, and restores it on close", async () => {
    const { panel } = await openInstallConfirmation();

    // The store's own content is a sibling of the dialog's backdrop.
    const store = screen.getByTestId("app-store");
    const hiddenBehind = Array.from(store.children).filter((el) => !el.contains(panel));
    expect(hiddenBehind.length).toBeGreaterThan(0);
    for (const el of hiddenBehind) {
      expect(el).toHaveAttribute("inert");
      expect(el).toHaveAttribute("aria-hidden", "true");
    }

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    for (const el of hiddenBehind) {
      expect(el).not.toHaveAttribute("inert");
      expect(el).not.toHaveAttribute("aria-hidden");
    }
  });

  it("restores the page behind it when the dialog is torn down while still open", async () => {
    // Closing is the easy path. The dangerous one is the whole tree going away
    // with the dialog still up — a window closed, a route swapped, the app
    // remounted. If the restore only ran on close, `inert` + `aria-hidden`
    // would outlive the dialog and quietly make background content
    // unreachable to assistive tech and to any role-based query.
    const { panel, unmount } = await openInstallConfirmation();

    const store = screen.getByTestId("app-store");
    const hiddenBehind = Array.from(store.children).filter((el) => !el.contains(panel));
    expect(hiddenBehind.length).toBeGreaterThan(0);
    expect(hiddenBehind[0]).toHaveAttribute("aria-hidden", "true");
    // Hold the nodes across the unmount so they can be inspected afterwards.
    const detached = [...hiddenBehind];

    unmount();

    for (const el of detached) {
      expect(el).not.toHaveAttribute("inert");
      expect(el).not.toHaveAttribute("aria-hidden");
    }
  });
});
