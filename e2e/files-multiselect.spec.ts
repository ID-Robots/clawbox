import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// TASK-1273..1275 in the desktop's Files window: many items selected at once
// and acted on together, moved into another folder (through "Move to…", with
// the keep-both question, and by dragging), and an upload that lands in a
// folder chosen in the upload dialog.

const SETUP = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

const MODIFIED = "2026-09-20T12:00:00.000Z";
const file = (name: string, size = 100) => ({ name, type: "file" as const, size, modified: MODIFIED });
const folder = (name: string) => ({ name, type: "directory" as const, size: null, modified: MODIFIED });

async function openFiles(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await page.getByTestId("shelf-app-files").click();
  const win = page.getByTestId("chrome-window-files");
  await expect(win.getByTestId("files-app")).toBeVisible();
  return win;
}

const entry = (win: Locator, name: string) => win.locator(`[data-testid="files-entry"][data-name="${name}"]`);

test("selects many items and downloads, moves and deletes them together", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: SETUP,
    files: {
      "": [folder("Documents"), folder("Downloads"), file("notes.txt"), file("todo.txt"), file("draft.md")],
      Documents: [file("notes.txt", 5)],
      Downloads: [],
    },
  });
  const win = await openFiles(page);
  await expect(entry(win, "draft.md")).toBeVisible();

  // Click, Ctrl/⌘-click: two selected, and the bar says so.
  await entry(win, "notes.txt").click();
  await entry(win, "todo.txt").click({ modifiers: ["ControlOrMeta"] });
  await expect(win.getByTestId("files-selection-count")).toHaveText("2 of 5 selected");
  await expect(win.getByTestId("files-status")).toContainText("2 selected");

  // Ctrl/⌘+A takes everything shown; Escape lets go.
  await win.getByTestId("files-app").press("ControlOrMeta+a");
  await expect(win.getByTestId("files-selection-count")).toHaveText("5 of 5 selected");
  await win.getByTestId("files-app").press("Escape");
  await expect(win.getByTestId("files-selection-bar")).toHaveCount(0);

  // Shift-click: the range from the anchor.
  await entry(win, "draft.md").click();
  await entry(win, "todo.txt").click({ modifiers: ["Shift"] });
  await expect(win.getByTestId("files-selection-count")).toHaveText("3 of 5 selected");

  // Several go down as ONE ZIP.
  const download = page.waitForEvent("download");
  await win.getByTestId("files-selection-download").click();
  expect((await download).suggestedFilename()).toBe("selection.zip");

  // "Move to…" into Documents, which already has a notes.txt: keep both.
  await win.getByTestId("files-selection-move").click();
  const picker = page.getByTestId("files-move-dialog");
  await expect(picker).toBeVisible();
  await picker.locator('[data-testid="files-picker-folder"][data-name="Documents"]').click();
  await expect(picker.getByTestId("files-picker-destination")).toHaveText("~/Documents");
  await picker.getByTestId("files-move-dialog-confirm").click();
  const conflict = page.getByTestId("files-conflict-dialog");
  await expect(conflict).toContainText("“notes.txt” already exists there.");
  await conflict.getByTestId("files-conflict-keep-both").click();
  await expect(win.getByTestId("files-status")).toContainText("Moved 3 item(s) to Documents");
  await expect(entry(win, "notes.txt")).toHaveCount(0);
  await expect(entry(win, "draft.md")).toHaveCount(0);

  // They are in Documents, the moved notes.txt beside the one already there.
  await entry(win, "Documents").dblclick();
  await expect(entry(win, "notes (2).txt")).toBeVisible();
  await expect(entry(win, "notes.txt")).toBeVisible();
  await expect(entry(win, "todo.txt")).toBeVisible();

  // Select all from the toolbar, delete them all behind one confirmation.
  await win.getByTestId("files-select-all").click();
  await win.getByTestId("files-selection-delete").click();
  await expect(page.getByText("Delete 4 items?")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(win.getByTestId("files-status")).toContainText("Deleted 4 item(s)");
  await expect(win.getByTestId("files-entry")).toHaveCount(0);
});

test("drags items onto a folder, and back up onto a breadcrumb", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: SETUP,
    files: {
      "": [folder("Archive"), folder("Projects"), file("a.txt"), file("b.txt")],
      Archive: [],
      Projects: [],
    },
  });
  const win = await openFiles(page);
  await expect(entry(win, "a.txt")).toBeVisible();

  // A folder is not a place to drop itself.
  await entry(win, "Projects").dragTo(entry(win, "Projects"));
  await expect(entry(win, "Projects")).toBeVisible();

  // Two selected, one dragged: both go.
  await entry(win, "a.txt").click();
  await entry(win, "b.txt").click({ modifiers: ["ControlOrMeta"] });
  await entry(win, "b.txt").dragTo(entry(win, "Archive"));
  await expect(win.getByTestId("files-status")).toContainText("Moved 2 item(s) to Archive");
  await expect(entry(win, "a.txt")).toHaveCount(0);

  // In Archive, drag one back onto the Home crumb.
  await entry(win, "Archive").dblclick();
  await expect(entry(win, "a.txt")).toBeVisible();
  await entry(win, "a.txt").dragTo(win.getByTestId("files-breadcrumbs").getByRole("button", { name: "Home" }));
  await expect(win.getByTestId("files-status")).toContainText("Moved 1 item(s) to Home");
  await expect(entry(win, "a.txt")).toHaveCount(0);
  await expect(entry(win, "b.txt")).toBeVisible();
});

test("uploads into the folder chosen in the upload dialog", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: SETUP,
    files: {
      "": [folder("Documents"), folder("Downloads")],
      Documents: [],
      Downloads: [],
    },
  });
  const win = await openFiles(page);
  await expect(entry(win, "Downloads")).toBeVisible();

  await win.getByTestId("files-upload").click();
  const dialog = page.getByTestId("files-upload-dialog");
  await expect(dialog).toBeVisible();
  // The folder on screen is the default.
  await expect(dialog.getByTestId("files-picker-destination")).toHaveText("Home");
  await expect(dialog.getByTestId("files-upload-dialog-confirm")).toBeDisabled();

  await dialog.getByTestId("files-upload-input").setInputFiles({ name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("quarterly") });
  await expect(dialog.getByTestId("files-upload-chosen")).toContainText("1 file(s)");
  await dialog.locator('[data-testid="files-picker-folder"][data-name="Downloads"]').click();
  await expect(dialog.getByTestId("files-picker-destination")).toHaveText("~/Downloads");
  await dialog.getByTestId("files-upload-dialog-confirm").click();

  await expect(win.getByTestId("files-status")).toContainText("Uploaded 1/1 file(s) to Downloads");
  // Not here — there.
  await expect(entry(win, "report.txt")).toHaveCount(0);
  await entry(win, "Downloads").dblclick();
  await expect(entry(win, "report.txt")).toBeVisible();
});
