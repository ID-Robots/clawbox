/**
 * The installed-app icon (src/components/InstalledAppIcon.tsx).
 *
 * A web app is registered on the desktop before the icon ClawBox AI draws for
 * it exists, so the first request for the local icon 404s. What is pinned here
 * is that the component remembers that failure for as long as its sources are
 * the same — and forgets it the moment they change, which is how the server's
 * `register_webapp` re-push (with a fresh `iconUrl`) makes the new icon appear
 * without a reload. And that the fresh, versioned URL is tried FIRST: the bare
 * one may be sitting in the browser's cache from an earlier app with the same
 * id, and a cache hit never errors, so it would never get out of the way.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import InstalledAppIcon from "@/components/InstalledAppIcon";

const LOCAL = "/setup-api/apps/icon/todo";
const VERSIONED = `${LOCAL}?v=1756000000000`;

function img(): HTMLImageElement | null {
  return screen.queryByRole("img") as HTMLImageElement | null;
}

describe("InstalledAppIcon", () => {
  it("tries the local icon first, then the store URL, then falls back to the glyph", () => {
    render(<InstalledAppIcon appId="todo" iconUrl="https://store.test/todo.png" name="Todo" />);
    expect(img()?.getAttribute("src")).toBe(LOCAL);

    fireEvent.error(img()!);
    expect(img()?.getAttribute("src")).toBe("https://store.test/todo.png");

    fireEvent.error(img()!);
    expect(img()).toBeNull();
    expect(screen.getByText("extension")).toBeInTheDocument();
  });

  it("stays on the glyph across re-renders with the same sources", () => {
    const { rerender } = render(<InstalledAppIcon appId="todo" iconUrl="" name="Todo" />);
    fireEvent.error(img()!);
    expect(img()).toBeNull();

    rerender(<InstalledAppIcon appId="todo" iconUrl="" name="Todo" />);
    expect(img()).toBeNull();
  });

  it("tries again when the iconUrl changes, starting from the versioned local URL", () => {
    const { rerender } = render(<InstalledAppIcon appId="todo" iconUrl="" name="Todo" />);
    fireEvent.error(img()!);
    expect(img()).toBeNull();

    // The nudge the server sends once the generated icon is on disk. The
    // versioned URL is one the browser has never cached, so it comes first.
    rerender(<InstalledAppIcon appId="todo" iconUrl={VERSIONED} name="Todo" />);
    expect(img()?.getAttribute("src")).toBe(VERSIONED);

    // And should it fail, the bare local URL is next; the versioned one is
    // not tried a second time.
    fireEvent.error(img()!);
    expect(img()?.getAttribute("src")).toBe(LOCAL);
    fireEvent.error(img()!);
    expect(img()).toBeNull();
  });

  it("puts a versioned local iconUrl ahead of the bare one from the first render", () => {
    // A desktop loaded after the icon landed has the versioned URL in its
    // saved preferences; a cached bare URL for a previous app with this id
    // must not win.
    render(<InstalledAppIcon appId="todo" iconUrl={VERSIONED} name="Todo" />);
    expect(img()?.getAttribute("src")).toBe(VERSIONED);
  });

  it("does not mistake another app's local URL for this app's versioned one", () => {
    render(<InstalledAppIcon appId="todo" iconUrl="/setup-api/apps/icon/notes?v=1" name="Todo" />);
    expect(img()?.getAttribute("src")).toBe(LOCAL);
    fireEvent.error(img()!);
    expect(img()?.getAttribute("src")).toBe("/setup-api/apps/icon/notes?v=1");
  });

  it("tries again when the appId changes", () => {
    const { rerender } = render(<InstalledAppIcon appId="todo" name="Todo" />);
    fireEvent.error(img()!);
    expect(img()).toBeNull();

    rerender(<InstalledAppIcon appId="notes" name="Notes" />);
    expect(img()?.getAttribute("src")).toBe("/setup-api/apps/icon/notes");
  });

  /**
   * The size contract, pinned because a caller got it wrong: `size` is the
   * fallback glyph's, and the picture fills the caller's box. A caller with no
   * box of its own therefore paints the icon at the full width of whatever
   * holds it — which is exactly what the Coding Agent's project rows did.
   */
  it("sizes the glyph from `size` and leaves the picture filling the caller's box", () => {
    const { rerender } = render(<InstalledAppIcon appId="todo" name="Todo" size="w-7 h-7" />);
    expect(img()).toHaveClass("w-full", "h-full");
    expect(img()).not.toHaveClass("w-7", "h-7");

    fireEvent.error(img()!);
    expect(screen.getByText("extension")).toHaveStyle({ fontSize: "28px" });

    rerender(<InstalledAppIcon appId="notes" name="Notes" size="w-12 h-12" />);
    fireEvent.error(img()!);
    expect(screen.getByText("extension")).toHaveStyle({ fontSize: "48px" });
  });

  it("shows the glyph straight away when there is nothing to load", () => {
    render(<InstalledAppIcon name="Nothing" />);
    expect(img()).toBeNull();
    expect(screen.getByText("extension")).toBeInTheDocument();
  });
});
