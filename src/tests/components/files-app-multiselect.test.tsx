/**
 * The Files app's multi-select (TASK-1273), move (TASK-1274) and upload
 * destination (TASK-1275), driven the way the owner drives them: clicks with
 * and without Ctrl/⌘ and Shift, Ctrl+A, the selection bar, "Move to…" through
 * the folder picker, the keep-both/skip question, a drag onto a folder, and
 * an upload into a folder that is not the one on screen.
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
  { name: "Archive", type: "directory", size: null, modified: ISO },
  { name: "a.txt", type: "file", size: 5, modified: ISO },
  { name: "b.txt", type: "file", size: 6, modified: ISO },
  { name: "c.txt", type: "file", size: 7, modified: ISO },
];
// Sorted as the app shows them: folders first, then by name.
const SHOWN = ["Archive", "Projects", "a.txt", "b.txt", "c.txt"];

let writes: Array<{ url: string; method: string; body: unknown }>;
/** Answers for the next non-GET requests, in order; the last one repeats. */
let answers: Array<{ status: number; body: Record<string, unknown> }>;

beforeEach(() => {
  window.localStorage.clear();
  writes = [];
  answers = [{ status: 200, body: { ok: true, moved: [], skipped: [], failed: [] } }];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      if (url.includes("project-folders")) return { ok: true, status: 200, json: async () => ({ folders: [], suggestions: [], max: 50 }) };
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ files: HOME, availableSpace: 1e12 }) };
    }
    let parsed: unknown = null;
    if (typeof init?.body === "string") { try { parsed = JSON.parse(init.body); } catch { parsed = init.body; } }
    else if (init?.body) parsed = init.body;
    writes.push({ url, method, body: parsed });
    const answer = answers.length > 1 ? answers.shift()! : answers[0];
    return { ok: answer.status < 400, status: answer.status, statusText: "", json: async () => answer.body };
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const entry = (name: string) => screen.getAllByTestId("files-entry").find((el) => el.getAttribute("data-name") === name)!;
const selectedNames = () => screen.getAllByTestId("files-entry").filter((el) => el.getAttribute("aria-selected") === "true").map((el) => el.getAttribute("data-name"));

async function open() {
  render(<FilesApp />);
  await waitFor(() => expect(screen.getAllByTestId("files-entry").map((el) => el.getAttribute("data-name"))).toEqual(SHOWN));
}

describe("FilesApp — selecting many", () => {
  it("click, Ctrl-click and Shift-click select the way a desktop file manager does", async () => {
    await open();
    fireEvent.click(entry("a.txt"));
    expect(selectedNames()).toEqual(["a.txt"]);
    fireEvent.click(entry("c.txt"), { ctrlKey: true });
    expect(selectedNames()).toEqual(["a.txt", "c.txt"]);
    fireEvent.click(entry("Projects"), { shiftKey: true });
    // From the anchor (c.txt) back up to Projects — the range replaces the rest.
    expect(selectedNames()).toEqual(["Projects", "a.txt", "b.txt", "c.txt"]);
    fireEvent.click(entry("b.txt"), { metaKey: true });
    expect(selectedNames()).toEqual(["Projects", "a.txt", "c.txt"]);
    expect(screen.getByTestId("files-selection-count")).toHaveTextContent(t("files.selectedOf", { count: 3, total: 5 }));
    expect(screen.getByTestId("files-status-selected")).toHaveTextContent(t("files.selectedCount", { count: 3 }));
  });

  it("Ctrl/⌘+A selects everything shown, Escape clears it, and the toolbar control does both", async () => {
    await open();
    const app = screen.getByTestId("files-app");
    fireEvent.keyDown(app, { key: "a", ctrlKey: true });
    expect(selectedNames()).toEqual(SHOWN);
    fireEvent.keyDown(app, { key: "Escape" });
    expect(selectedNames()).toEqual([]);

    const toggle = screen.getByTestId("files-select-all");
    fireEvent.click(toggle);
    expect(selectedNames()).toEqual(SHOWN);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(selectedNames()).toEqual([]);
  });

  it("does not take Ctrl+A from a text field", async () => {
    await open();
    fireEvent.click(screen.getByTitle(t("files.search")));
    const input = await screen.findByPlaceholderText(t("files.searchPlaceholder"));
    fireEvent.keyDown(input, { key: "a", ctrlKey: true });
    expect(selectedNames()).toEqual([]);
  });

  it("a click on the empty area clears the selection; one item shows no selection bar", async () => {
    await open();
    fireEvent.click(entry("a.txt"));
    expect(screen.queryByTestId("files-selection-bar")).toBeNull();
    fireEvent.click(entry("b.txt"), { ctrlKey: true });
    expect(screen.getByTestId("files-selection-bar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("files-grid"));
    expect(selectedNames()).toEqual([]);
  });
});

describe("FilesApp — acting on the selection", () => {
  it("deletes the selection after one confirmation, one request per item", async () => {
    await open();
    fireEvent.click(entry("a.txt"));
    fireEvent.click(entry("Archive"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("files-selection-delete"));
    expect(await screen.findByText(t("files.deleteManyTitle", { count: 2 }))).toBeInTheDocument();
    // A folder is in it, so the dialog says its contents go too.
    expect(screen.getByTestId("files-delete-body")).toHaveTextContent(t("files.deleteConfirm"));
    fireEvent.click(screen.getByRole("button", { name: t("files.delete") }));
    await waitFor(() => expect(screen.getByTestId("files-status")).toHaveTextContent(t("files.deletedCount", { count: 2 })));
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      "DELETE /setup-api/files/Archive",
      "DELETE /setup-api/files/a.txt",
    ]);
  });

  it("says how many a bulk delete could not remove, and carries on past the refusal", async () => {
    answers = [
      { status: 400, body: { error: "nope", code: "protected_container" } },
      { status: 200, body: { ok: true } },
    ];
    await open();
    fireEvent.keyDown(screen.getByTestId("files-app"), { key: "a", metaKey: true });
    fireEvent.keyDown(screen.getByTestId("files-app"), { key: "Delete" });
    fireEvent.click(await screen.findByRole("button", { name: t("files.delete") }));
    await waitFor(() => expect(screen.getByTestId("files-status")).toHaveTextContent(
      t("files.deleteSomeFailed", { deleted: 4, total: 5, failed: 1, message: t("files.protectedFolder") }),
    ));
    expect(writes).toHaveLength(5);
  });

  it("downloads a selection of several as one ZIP through a ticket", async () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.getAttribute("href") ?? ""); });
    answers = [{ status: 200, body: { name: "selection.zip", files: 2, bytes: 11, entries: 2, tooMany: false, limit: 100000, ticket: "ab".repeat(16) } }];
    await open();
    fireEvent.click(entry("a.txt"));
    fireEvent.click(entry("b.txt"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("files-selection-download"));
    await waitFor(() => expect(clicks).toEqual([`/setup-api/files?zip=${"ab".repeat(16)}`]));
    expect(writes[0]).toMatchObject({ method: "POST", url: "/setup-api/files?dir=", body: { action: "zip", paths: ["a.txt", "b.txt"] } });
    expect(screen.getByTestId("files-status")).toHaveTextContent("selection.zip");
  });

  it("says a selection is too big for one ZIP instead of starting a download", async () => {
    answers = [{ status: 413, body: { code: "too_many_entries", limit: 100000 } }];
    await open();
    fireEvent.click(screen.getByTestId("files-select-all"));
    fireEvent.click(screen.getByTestId("files-selection-download"));
    await waitFor(() => expect(screen.getByTestId("files-status")).toHaveTextContent(
      t("files.zipSelectionTooMany", { max: (100000).toLocaleString() }),
    ));
  });
});

describe("FilesApp — moving", () => {
  it("moves the selection through “Move to…” and the folder picker", async () => {
    answers = [{ status: 200, body: { ok: true, moved: [{}, {}], skipped: [], failed: [] } }];
    await open();
    fireEvent.click(entry("a.txt"));
    fireEvent.click(entry("b.txt"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("files-selection-move"));
    const dialog = await screen.findByTestId("files-move-dialog");
    expect(within(dialog).getByText(t("files.moveTitleMany", { count: 2 }))).toBeInTheDocument();
    // It opens where the items are, and moving them there would move nothing.
    expect(within(dialog).getByTestId("files-move-dialog-confirm")).toBeDisabled();
    const projects = await within(dialog).findAllByTestId("files-picker-folder");
    fireEvent.click(projects.find((b) => b.getAttribute("data-name") === "Projects")!);
    await waitFor(() => expect(within(dialog).getByTestId("files-picker-destination")).toHaveTextContent("~/Projects"));
    await waitFor(() => expect(within(dialog).getByTestId("files-move-dialog-confirm")).toBeEnabled());
    fireEvent.click(within(dialog).getByTestId("files-move-dialog-confirm"));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ method: "POST", url: "/setup-api/files?dir=Projects", body: { action: "move", paths: ["a.txt", "b.txt"], conflict: "fail" } });
    await waitFor(() => expect(screen.getByTestId("files-status")).toHaveTextContent(t("files.movedTo", { count: 2, folder: "Projects" })));
  });

  it("never offers a folder that is being moved as the place to move it into", async () => {
    await open();
    fireEvent.contextMenu(entry("Projects"));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("files.moveTo") }));
    const dialog = await screen.findByTestId("files-move-dialog");
    const rows = await within(dialog).findAllByTestId("files-picker-folder");
    const self = rows.find((b) => b.getAttribute("data-name") === "Projects")!;
    expect(self).toBeDisabled();
    expect(self).toHaveAttribute("title", t("files.pickerBeingMoved"));
    expect(rows.find((b) => b.getAttribute("data-name") === "Archive")).toBeEnabled();
  });

  it("asks keep-both or skip when the destination holds a name, then re-sends with the answer", async () => {
    answers = [
      { status: 409, body: { code: "conflict", error: "exists", conflicts: [{ path: "a.txt", name: "a.txt" }] } },
      { status: 200, body: { ok: true, moved: [{}], skipped: [], failed: [] } },
    ];
    await open();
    fireEvent.contextMenu(entry("a.txt"));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("files.moveTo") }));
    const dialog = await screen.findByTestId("files-move-dialog");
    fireEvent.click((await within(dialog).findAllByTestId("files-picker-folder")).find((b) => b.getAttribute("data-name") === "Archive")!);
    await waitFor(() => expect(within(dialog).getByTestId("files-move-dialog-confirm")).toBeEnabled());
    fireEvent.click(within(dialog).getByTestId("files-move-dialog-confirm"));

    const conflict = await screen.findByTestId("files-conflict-dialog");
    expect(conflict).toHaveTextContent(t("files.conflictOne", { name: "a.txt" }));
    fireEvent.click(within(conflict).getByTestId("files-conflict-keep-both"));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].body).toMatchObject({ action: "move", paths: ["a.txt"], conflict: "rename" });
    expect(screen.queryByTestId("files-conflict-dialog")).toBeNull();
  });

  it("moves what is dragged onto a folder — the whole selection when the item is part of one", async () => {
    await open();
    fireEvent.click(entry("a.txt"));
    fireEvent.click(entry("c.txt"), { ctrlKey: true });
    const data = new Map<string, string>();
    const dataTransfer = {
      get types() { return [...data.keys()]; },
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      effectAllowed: "", dropEffect: "", files: [] as File[],
    };
    fireEvent.dragStart(entry("c.txt"), { dataTransfer });
    const target = entry("Archive");
    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveAttribute("data-drop-target", "true");
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ url: "/setup-api/files?dir=Archive", body: { action: "move", paths: ["a.txt", "c.txt"] } });
  });

  it("refuses to drop a folder on itself", async () => {
    await open();
    const data = new Map<string, string>();
    const dataTransfer = {
      get types() { return [...data.keys()]; },
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      effectAllowed: "", dropEffect: "", files: [] as File[],
    };
    fireEvent.dragStart(entry("Projects"), { dataTransfer });
    fireEvent.dragOver(entry("Projects"), { dataTransfer });
    expect(entry("Projects")).not.toHaveAttribute("data-drop-target");
    fireEvent.dragEnd(entry("Projects"), { dataTransfer });
  });
});

describe("FilesApp — upload destination", () => {
  it("uploads into the folder chosen in the upload dialog, defaulting to the one on screen", async () => {
    render(<FilesApp initialPath="Archive" />);
    await waitFor(() => expect(screen.getAllByTestId("files-entry").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId("files-upload"));
    const dialog = await screen.findByTestId("files-upload-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("files-picker-destination")).toHaveTextContent("~/Archive"));
    // No files yet: nothing to upload.
    expect(within(dialog).getByTestId("files-upload-dialog-confirm")).toBeDisabled();

    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.change(within(dialog).getByTestId("files-upload-input"), { target: { files: [file] } });
    });
    expect(within(dialog).getByTestId("files-upload-chosen")).toHaveTextContent("1 file(s)");
    // Somewhere else: Home, via the places row.
    fireEvent.click(within(within(dialog).getByTestId("files-picker-places")).getByText(t("files.documents")));
    await waitFor(() => expect(within(dialog).getByTestId("files-picker-destination")).toHaveTextContent("~/Documents"));
    await waitFor(() => expect(within(dialog).getByTestId("files-upload-dialog-confirm")).toBeEnabled());
    fireEvent.click(within(dialog).getByTestId("files-upload-dialog-confirm"));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ method: "PUT", url: "/setup-api/files?dir=Documents&name=hello.txt" });
    await waitFor(() => expect(screen.getByTestId("files-status")).toHaveTextContent(t("files.uploadedTo", { ok: 1, total: 1, folder: "Documents" })));
  });

  it("keeps a file drag away from the desktop's own drop zone, and refuses one no target took", async () => {
    // The desktop under every window saves dropped files to Downloads; a drop
    // meant for this window used to reach it too and upload twice.
    const desktopDrop = vi.fn();
    const desktopEnter = vi.fn();
    render(<div onDrop={desktopDrop} onDragEnter={desktopEnter} onDragOver={desktopEnter}><FilesApp /></div>);
    await waitFor(() => expect(screen.getAllByTestId("files-entry").length).toBe(SHOWN.length));
    const file = new File(["x"], "here.txt");
    const dataTransfer = { types: ["Files"], files: [file], getData: () => "", dropEffect: "" };
    fireEvent.dragEnter(screen.getByTestId("files-grid"), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("files-grid"), { dataTransfer });
    fireEvent.drop(screen.getByTestId("files-grid"), { dataTransfer });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].url).toBe("/setup-api/files?dir=&name=here.txt");
    expect(desktopDrop).not.toHaveBeenCalled();
    expect(desktopEnter).not.toHaveBeenCalled();
    // Over the sidebar's heading nothing takes it — and the browser must not
    // either (it would open the file in place of the desktop).
    const heading = screen.getByText(t("files.favorites"));
    expect(fireEvent.dragOver(heading, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("none");
  });

  it("uploads files dragged from the computer onto a folder into that folder", async () => {
    await open();
    const file = new File(["x"], "dropped.txt");
    const dataTransfer = { types: ["Files"], files: [file], getData: () => "", dropEffect: "" };
    fireEvent.dragOver(entry("Projects"), { dataTransfer });
    fireEvent.drop(entry("Projects"), { dataTransfer });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].url).toBe("/setup-api/files?dir=Projects&name=dropped.txt");
  });
});
