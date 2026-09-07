import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import userEvent from "@testing-library/user-event";
import AppStore from "@/components/AppStore";
import { I18nProvider } from "@/lib/i18n";

/**
 * The store's list and detail views from the keyboard and the screen reader.
 *
 * A UI sweep (2026-09-07) found three things on these two screens:
 *
 *  - every card was a `<div onClick>`: not focusable, no role, so Tab walked
 *    search → sort → chips → each card's Install button and the detail view
 *    could not be opened without a mouse — and Enter on the only thing Tab
 *    reached would START AN INSTALL. The fix is the Hermes store's shape: a
 *    real button on the name, stretched over the card, never a `role=button`
 *    on the container (that makes its children presentational, so VoiceOver
 *    could reach neither the Install button nor the heading) — and focus is
 *    handed on at both crossings, because each unmounts the tree the focused
 *    element was in;
 *  - the detail view's Back button had no accessible name: its content is the
 *    Material ligature, so a screen reader announced "arrow_back";
 *  - the header count was printed bare ("9397 AI Skills") while the detail
 *    view on the same screen formats installs ("18,389 installs").
 *
 * `useT` falls back to identity when no provider is mounted, so copy asserts
 * as translation keys ("store.back"); the count test mounts the provider,
 * because the identity `t` ignores `{count}` altogether.
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
  total: 9397,
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
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderStore() {
  return render(<AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />);
}

/** The card opens through a button named after the app; the detail view is told by its Back button. */
async function findCard() {
  return screen.findByRole("button", { name: APP.name });
}

function detailHeading() {
  return screen.getByRole("heading", { name: APP.name, level: 2 });
}

function detailOpen() {
  return screen.queryByRole("button", { name: "store.back" }) !== null;
}

describe("App Store cards from the keyboard", () => {
  it("puts one real button per card in the tab order, with nothing interactive nested", async () => {
    renderStore();
    const card = await findCard();
    expect(card.tagName).toBe("BUTTON");
    expect(card.tabIndex).toBe(0);
    // The name is still a heading — a `role=button` container would have
    // flattened it away.
    expect(card.closest("h3")).not.toBeNull();
    expect(card.closest('[role="button"]')).toBeNull();
    // The Install button is a sibling control, not a child of the card's button.
    const install = screen.getByRole("button", { name: "store.install" });
    expect(card.contains(install)).toBe(false);
    expect(install.closest('[role="button"]')).toBeNull();
  });

  it("opens the detail on Enter and on Space, and hands focus to the detail's heading", async () => {
    const user = userEvent.setup();
    renderStore();
    const card = await findCard();

    card.focus();
    await user.keyboard("{Enter}");
    expect(detailOpen()).toBe(true);
    expect(document.activeElement).toBe(detailHeading());

    fireEvent.click(screen.getByRole("button", { name: "store.back" }));
    expect(detailOpen()).toBe(false);

    (await findCard()).focus();
    await user.keyboard(" ");
    expect(detailOpen()).toBe(true);
    expect(document.activeElement).toBe(detailHeading());
  });

  it("gives focus back to the card the owner came from on Back", async () => {
    renderStore();
    fireEvent.click(await findCard());
    expect(detailOpen()).toBe(true);
    expect(document.activeElement).toBe(detailHeading());

    fireEvent.click(screen.getByRole("button", { name: "store.back" }));
    expect(detailOpen()).toBe(false);
    expect(document.activeElement).toBe(await findCard());
  });

  it("keeps the Install button its own control: it never opens the detail", async () => {
    renderStore();
    await findCard();
    const install = screen.getByRole("button", { name: "store.install" });

    fireEvent.click(install);
    expect(detailOpen()).toBe(false);
    // And it did what it says: the install confirmation is up.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("App Store detail's Back button", () => {
  it("has an accessible name, not the icon ligature", async () => {
    renderStore();
    fireEvent.click(await findCard());

    const back = screen.getByRole("button", { name: "store.back" });
    expect(back.getAttribute("aria-label")).toBe("store.back");
    // The ligature is decoration once the button has a name of its own.
    expect(back.querySelector('[aria-hidden="true"]')?.textContent).toBe("arrow_back");
    expect(screen.queryByRole("button", { name: "arrow_back" })).toBeNull();

    fireEvent.click(back);
    expect(detailOpen()).toBe(false);
  });
});

describe("App Store header count", () => {
  it("is formatted in the UI's locale, the way the detail view formats installs", async () => {
    render(
      <I18nProvider>
        <AppStore installedAppIds={[]} onInstall={vi.fn()} onUninstall={vi.fn()} />
      </I18nProvider>,
    );
    // The provider starts at "en" and loads the catalogue in an effect.
    expect(await screen.findByText(/9,397 AI Skills/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/9397/)).toBeNull();
  });
});
