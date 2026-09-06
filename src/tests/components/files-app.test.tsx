/**
 * The Files app, at the size it is actually opened at.
 *
 * A Files window is 507 px wide on a 1920 px screen, and every Tailwind
 * `sm:`/`md:` branch in it answered for the SCREEN: the sidebar stayed in
 * flow, the list view's name column was one letter wide and the breadcrumb
 * was squeezed to nothing — and what a squeezed trail clips is the folder the
 * owner is standing in. Pinned here with the window measured, plus the status
 * line's one clock and the rename that has to stay a name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import FilesApp from "@/components/FilesApp";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", localeResolved: true, setLocale: () => {}, t }),
}));

const ISO = "2026-09-01T10:00:00.000Z";
const HOME = [
  { name: "Projects", type: "directory", size: null, modified: ISO },
  { name: "notes.txt", type: "file", size: 12, modified: ISO },
  { name: ".config", type: "file", size: 3, modified: ISO },
];

/** Every non-GET the app made, in order. */
let writes: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
/** What the next non-GET is answered with. */
let nextWrite: { ok: boolean; status: number; body: Record<string, unknown> };
/** What a `search=` GET is answered with, when a test runs one. */
let searchAnswer: Record<string, unknown>;

function stubFetch(listing: typeof HOME = HOME) {
  writes = [];
  nextWrite = { ok: true, status: 200, body: { ok: true } };
  searchAnswer = { files: [], search: "", truncated: false, stoppedBy: null };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const body = url.includes("search=") ? searchAnswer : { files: listing, availableSpace: 1e9 };
      return { ok: true, status: 200, statusText: "OK", json: async () => body };
    }
    writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: nextWrite.ok, status: nextWrite.status, statusText: "", json: async () => nextWrite.body };
  }));
}

/** A window of `width` px, answered the moment the app observes itself. */
function stubWindowWidth(width: number) {
  class RO {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(el: Element) { this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); void el; }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  window.localStorage.clear();
  stubFetch();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FilesApp — the toolbar in a window", () => {
  it("keeps the whole trail in a wide window, and lets the ancestors — never the current folder — give way", async () => {
    render(<FilesApp initialPath="Projects/angry-pigs" />);
    const crumbs = await screen.findByTestId("files-breadcrumbs");
    await waitFor(() => expect(within(crumbs).getAllByRole("button")).toHaveLength(3));
    const buttons = within(crumbs).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([t("files.home"), "Projects", "angry-pigs"]);
    // The container may shrink to nothing; the crumbs inside it decide what
    // survives, and the folder the owner is IN is the one that must.
    expect(crumbs.className).toContain("min-w-0");
    expect(buttons[0].parentElement).toHaveClass("shrink");
    expect(buttons[1].parentElement).toHaveClass("shrink");
    expect(buttons[2].parentElement).toHaveClass("shrink-0");
  });

  it("folds the ancestors behind one “…” in a narrow window, keeping the current folder whole", async () => {
    stubWindowWidth(390);
    render(<FilesApp initialPath="Projects/angry-pigs" />);
    const crumbs = await screen.findByTestId("files-breadcrumbs");
    await waitFor(() => expect(within(crumbs).getAllByRole("button")).toHaveLength(2));
    const buttons = within(crumbs).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["…", "angry-pigs"]);
    // The fold still walks up: it stands for the parent folder.
    expect(buttons[0]).toHaveAttribute("title", "Projects");
    fireEvent.click(buttons[0]);
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("dir=Projects&") || String(url).endsWith("dir=Projects"))).toBe(true),
    );
  });

  it("gives the files the sidebar's 200 px back in a narrow window, and paints it over them only there", async () => {
    stubWindowWidth(390);
    const { unmount } = render(<FilesApp />);
    await screen.findByTestId("files-app");
    // Narrow: closed on the way in, and the toolbar button is the way back.
    expect(document.querySelector("aside")).toBeNull();
    fireEvent.click(screen.getByTestId("files-sidebar-toggle"));
    const overlaid = document.querySelector("aside")!;
    expect(overlaid.className).toContain("absolute");
    expect(overlaid.className).toContain("z-[6]");
    unmount();

    // Wide: in flow, and with no z-index — positioned above the window's own
    // resize handles it made the left edge of the Files window undraggable.
    stubWindowWidth(1200);
    render(<FilesApp />);
    await screen.findByTestId("files-app");
    const inFlow = document.querySelector("aside")!;
    expect(inFlow.className).not.toContain("absolute");
    expect(inFlow.className).not.toContain("z-[");
  });

  it("drops the Modified column in a narrow window so the name is readable", async () => {
    stubWindowWidth(390);
    render(<FilesApp />);
    await screen.findByTestId("files-app");
    fireEvent.click(screen.getByTitle(t("files.switchToList")));
    const list = await screen.findByTestId("files-list");
    expect(within(list).queryByText(t("files.modified"))).toBeNull();
    expect(within(list).getByText(t("files.name")).parentElement!.style.gridTemplateColumns).toBe("1fr 80px");
  });

  it("keeps all three columns in a wide window", async () => {
    stubWindowWidth(1200);
    render(<FilesApp />);
    await screen.findByTestId("files-app");
    fireEvent.click(screen.getByTitle(t("files.switchToList")));
    const list = await screen.findByTestId("files-list");
    expect(within(list).getByText(t("files.modified"))).toBeInTheDocument();
    expect(within(list).getByText(t("files.name")).parentElement!.style.gridTemplateColumns).toBe("1fr 80px 160px");
  });
});

describe("FilesApp — the status line", () => {
  it("counts through the dictionary and keeps the hidden count off a message", async () => {
    render(<FilesApp />);
    const status = await screen.findByTestId("files-status");
    await waitFor(() => expect(status).toHaveTextContent(t("files.items", { count: 2 })));
    expect(status.textContent).toContain("1 hidden");
  });

  it("does not let an earlier success's clock wipe the error that replaced it", async () => {
    vi.useFakeTimers();
    render(<FilesApp />);
    await flush();

    const newFolder = async (answer: { ok: boolean; status: number; body: Record<string, unknown> }) => {
      fireEvent.click(screen.getByTitle(t("files.newFolder")));
      fireEvent.change(screen.getByPlaceholderText(t("files.folderName")), { target: { value: "x" } });
      nextWrite = answer;
      fireEvent.click(screen.getByText(t("files.ok")));
      await flush();
    };

    await newFolder({ ok: true, status: 200, body: { ok: true } });
    const status = screen.getByTestId("files-status");
    expect(status).toHaveTextContent("Folder created");
    // A message stands on its own — "Folder created · 1 hidden" was the count
    // of hidden entries riding along behind every transient line.
    expect(status.textContent).not.toContain("hidden");

    // The duplicate lands well inside the first message's 2 s clock.
    act(() => { vi.advanceTimersByTime(500); });
    await newFolder({ ok: false, status: 409, body: { error: "Already exists" } });
    expect(status).toHaveTextContent("Error: Already exists");

    // The moment the earlier clock would have fired, and past it.
    act(() => { vi.advanceTimersByTime(2000); });
    expect(status).toHaveTextContent("Error: Already exists");
  });

  it("says a search stopped early instead of calling every match it found a first page", async () => {
    render(<FilesApp />);
    await screen.findByTestId("files-app");
    fireEvent.click(screen.getByTitle(t("files.search")));
    const box = await screen.findByPlaceholderText(t("files.searchPlaceholder"));
    searchAnswer = {
      files: [{ name: "pad.ts", type: "file", size: 2, modified: ISO, path: "proj/src/pad.ts" }],
      search: "pad",
      truncated: true,
      stoppedBy: "scanned",
    };
    fireEvent.change(box, { target: { value: "pad" } });
    fireEvent.keyDown(box, { key: "Enter" });

    const note = await screen.findByTestId("files-search-stopped");
    expect(note).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(t("files.searchTruncated", { count: 1 })))).toBeNull();
  });
});

describe("FilesApp — rename", () => {
  const openRename = async () => {
    render(<FilesApp />);
    const entry = await screen.findByText("notes.txt");
    fireEvent.contextMenu(entry, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByText(t("files.rename")));
    return screen.getByPlaceholderText(t("files.newName"));
  };

  it("refuses a path in the rename box — a rename may not move the file out of its folder", async () => {
    const box = await openRename();
    fireEvent.change(box, { target: { value: "../escape.txt" } });
    expect(screen.getByTestId("files-rename-invalid")).toBeInTheDocument();
    fireEvent.click(screen.getByText(t("files.ok")));
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    // Nothing was sent, and the dialog is still up with the typed name in it.
    expect(writes).toHaveLength(0);
    expect(screen.getByPlaceholderText(t("files.newName"))).toHaveValue("../escape.txt");
  });

  it("still renames to a plain name", async () => {
    const box = await openRename();
    fireEvent.change(box, { target: { value: "b.txt" } });
    expect(screen.queryByTestId("files-rename-invalid")).toBeNull();
    fireEvent.click(screen.getByText(t("files.ok")));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe("PUT");
    expect(writes[0].body).toEqual({ newName: "b.txt" });
  });
});
