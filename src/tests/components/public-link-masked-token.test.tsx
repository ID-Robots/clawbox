import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { PublicLinkDialog, PublicLinkMenuItems, shareableLinkUrl, type PublicLinkInfo } from "@/components/PublicAppLink";

/**
 * Anyone but the owner is answered a link's URL with its token masked
 * (`k=••••••••`). That address opens nothing anywhere, so it is never what
 * Copy or Open hand on: on a link with a password the address without the
 * token is (it shows the password page), and a link without a password has
 * no address to hand on but the owner's.
 */
const live = (over: Partial<PublicLinkInfo>): PublicLinkInfo => ({
  appId: "notes",
  mode: "permanent",
  createdAt: 1,
  expiresAt: null,
  apiAllow: ["/api"],
  state: "live",
  url: "https://example.trycloudflare.com/apps/notes/?k=AbC123",
  ...over,
});
const MASKED = "https://example.trycloudflare.com/apps/notes/?k=••••••••";

function renderMenu(link: PublicLinkInfo) {
  return render(<PublicLinkMenuItems link={link} onCreate={() => {}} onDisable={() => {}} onPassword={() => {}} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the address a viewer can hand on", () => {
  it("is the owner's URL as it is, token and all", () => {
    expect(shareableLinkUrl(live({}))).toBe("https://example.trycloudflare.com/apps/notes/?k=AbC123");
    expect(shareableLinkUrl(live({ passwordProtected: true }))).toBe("https://example.trycloudflare.com/apps/notes/?k=AbC123");
  });

  it("is the address without the masked token on a link with a password, and nothing on one without", () => {
    expect(shareableLinkUrl(live({ url: MASKED, tokenMasked: true, passwordProtected: true }))).toBe("https://example.trycloudflare.com/apps/notes/");
    expect(shareableLinkUrl(live({ url: `${MASKED}&view=list`, tokenMasked: true, passwordProtected: true }))).toBe("https://example.trycloudflare.com/apps/notes/?view=list");
    expect(shareableLinkUrl(live({ url: MASKED, tokenMasked: true }))).toBeNull();
    expect(shareableLinkUrl(live({ url: null, tokenMasked: true, passwordProtected: true }))).toBeNull();
  });

  it("is what the menu copies and opens; a masked link without a password offers neither", () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    renderMenu(live({ url: MASKED, tokenMasked: true, passwordProtected: true }));
    fireEvent.click(screen.getByTestId("ctx-public-link-copy"));
    fireEvent.click(screen.getByTestId("ctx-public-link-open"));
    expect(writeText).toHaveBeenCalledWith("https://example.trycloudflare.com/apps/notes/");
    expect(open).toHaveBeenCalledWith("https://example.trycloudflare.com/apps/notes/", "_blank", "noopener,noreferrer");
    cleanup();

    renderMenu(live({ url: MASKED, tokenMasked: true }));
    expect(screen.getByTestId("ctx-public-link-status")).toBeTruthy();
    expect(screen.queryByTestId("ctx-public-link-copy")).toBeNull();
    expect(screen.queryByTestId("ctx-public-link-open")).toBeNull();
    cleanup();

    renderMenu(live({}));
    fireEvent.click(screen.getByTestId("ctx-public-link-copy"));
    expect(writeText).toHaveBeenLastCalledWith("https://example.trycloudflare.com/apps/notes/?k=AbC123");
  });
});

describe("the link dialog", () => {
  function renderDialog(link: PublicLinkInfo) {
    return render(
      <PublicLinkDialog
        open
        appId="notes"
        appName="Notes"
        link={link}
        onCreate={async () => null}
        onSetPassword={async () => null}
        onClose={() => {}}
      />,
    );
  }

  it("never shows a masked address in its address field", () => {
    renderDialog(live({ url: MASKED, tokenMasked: true }));
    expect(screen.queryByTestId("public-link-url")).toBeNull();
    expect(document.body.textContent ?? "").not.toContain("••••");
    cleanup();

    renderDialog(live({ url: MASKED, tokenMasked: true, passwordProtected: true }));
    expect((screen.getByTestId("public-link-url") as HTMLInputElement).value).toBe("https://example.trycloudflare.com/apps/notes/");
    cleanup();

    renderDialog(live({}));
    expect((screen.getByTestId("public-link-url") as HTMLInputElement).value).toBe("https://example.trycloudflare.com/apps/notes/?k=AbC123");
  });

  it("says the app's data is open when a stored path covers its /api", () => {
    for (const apiAllow of [["/"], ["/api/"], ["/api"]]) {
      renderDialog(live({ apiAllow }));
      expect(screen.getByTestId("public-link-api-status").textContent).not.toBe("");
      const open = screen.getByTestId("public-link-api-status").textContent;
      cleanup();
      renderDialog(live({ apiAllow: ["/upload"] }));
      const off = screen.getByTestId("public-link-api-status").textContent;
      cleanup();
      expect(open).not.toBe(off);
    }
  });
});
