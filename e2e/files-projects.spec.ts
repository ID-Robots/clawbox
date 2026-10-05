import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// The Files app's Projects: the owner's project folders shown in the
// desktop's own file manager. The assistant keeps them three hidden folders
// down, so the box suggests that folder; one click pins it, and from then on
// it is a sidebar entry whose trail starts at the project.
const WORKSPACE_PROJECTS = ".openclaw/workspace/projects";

const dir = (name: string) => ({ name, type: "directory" as const, size: null, modified: "2026-09-20T09:00:00.000Z" });
const file = (name: string, size: number) => ({ name, type: "file" as const, size, modified: "2026-09-20T09:00:00.000Z" });

test("the Projects icon opens Files on the owner's project folders: pin a suggestion, open it, download a folder as ZIP", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    files: {
      "": [dir("Documents"), dir("Downloads"), file("notes.txt", 512)],
      Documents: [],
      Downloads: [],
      [WORKSPACE_PROJECTS]: [dir("architektur-review"), dir("website")],
      [`${WORKSPACE_PROJECTS}/architektur-review`]: [file("SELBSTGUTACHTEN.md", 2048), file("anhang.pdf", 4096)],
      [`${WORKSPACE_PROJECTS}/website`]: [file("index.html", 300)],
    },
    projectSuggestions: [{ path: WORKSPACE_PROJECTS, name: "projects" }],
    // Not a fresh install: the one-time greeting chat stays shut, so nothing
    // opens over the desktop icons.
    kvEntries: { "clawbox-chat-greeted": "1", "clawbox-mascot-hidden": "1" },
    chatFacts: { onboardingArmed: false },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  // The desktop's Projects icon is the Files app, opened on its Projects view.
  await page.locator('[data-desktop-icon-id="desktop-projects"] button').click();
  const win = page.getByTestId("chrome-window-projects");
  await expect(win).toBeVisible();
  await expect(win.getByTestId("files-projects-empty")).toBeVisible();

  // One click pins what the box suggested; it lands in the list and the sidebar.
  await win.getByTestId("files-projects-suggestions").getByRole("button", { name: "Add to Projects: projects" }).click();
  const row = win.getByTestId("files-project-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`~/${WORKSPACE_PROJECTS}`);
  await expect(win.getByTestId("files-sidebar-project")).toContainText("projects");
  await expect(win.getByTestId("files-projects-suggestions")).toHaveCount(0);

  // Open it from the sidebar: the trail starts at the project, not at ~/.openclaw.
  await win.getByTestId("files-sidebar-project").click();
  const listing = win.getByTestId("files-grid");
  await expect(listing.getByText("architektur-review", { exact: true })).toBeVisible();
  await expect(win.getByTestId("files-breadcrumbs")).toHaveText(/Projects.*projects/);
  await expect(win.getByTestId("files-breadcrumbs")).not.toContainText(".openclaw");
  await expect(win.getByTestId("files-pin-toggle")).toHaveAttribute("aria-pressed", "true");

  // A folder goes down as one ZIP named after it.
  await listing.getByText("architektur-review", { exact: true }).click({ button: "right" });
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download as ZIP" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("architektur-review.zip");
  await expect(win.getByTestId("files-status")).toContainText("architektur-review.zip");

  // Up from the project's own folder goes back to the Projects view.
  await win.getByTitle("Go up").click();
  await expect(win.getByTestId("files-projects-list")).toBeVisible();

  // And it comes off the list again.
  await row.getByRole("button", { name: "Remove from Projects" }).click();
  await expect(win.getByTestId("files-projects-empty")).toBeVisible();
  await expect(win.getByTestId("files-sidebar-project")).toHaveCount(0);
});
