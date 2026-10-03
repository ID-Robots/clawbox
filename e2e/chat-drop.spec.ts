import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openChatPopup } from "./helpers/clawbox";
import { installFakeGatewaySocket } from "./helpers/fake-gateway";

// TASK-1276: files AND folders dragged onto the desktop chat. A folder is
// staged file by file into one batch with its structure kept, rides along as
// ONE attachment, and the turn names the folder as staged.

const STAGING = "/home/clawbox/.openclaw/media/chat-attachments";

/**
 * Drop onto the chat what a browser hands over for a dragged folder: an entry
 * whose directory reader answers its children. A synthetic event is the only
 * way to put a FOLDER in a drop — Playwright's file drops are flat.
 */
async function dropFolder(page: Page) {
  await page.evaluate(() => {
    type Entry = Record<string, unknown>;
    const make = (name: string, text: string) => new File([text], name, { type: "text/plain" });
    const fileEntry = (f: File): Entry => ({ isFile: true, isDirectory: false, name: f.name, file: (ok: (f: File) => void) => ok(f) });
    const dirEntry = (name: string, children: Entry[]): Entry => ({
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => {
        let done = false;
        return { readEntries: (ok: (e: Entry[]) => void) => { const out = done ? [] : children; done = true; setTimeout(() => ok(out), 0); } };
      },
    });
    const tree = dirEntry("project", [
      fileEntry(make("README.md", "# project")),
      dirEntry("src", [fileEntry(make("main.py", "print('hi')"))]),
      fileEntry(make(".env", "SECRET=1")),
    ]);
    const loose = make("notes.txt", "loose file");
    const dataTransfer = {
      types: ["Files"],
      items: [
        { kind: "file", webkitGetAsEntry: () => tree, getAsFile: () => null },
        { kind: "file", webkitGetAsEntry: () => fileEntry(loose), getAsFile: () => loose },
      ],
      files: [loose],
      dropEffect: "none",
    };
    const target = document.querySelector('[data-testid="chat-popup"]')!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      target.dispatchEvent(event);
    }
  });
}

test("a folder and a file dropped on the chat attach, and the turn names the folder", async ({ page }) => {
  await installFakeGatewaySocket(page);
  await installClawboxMocks(page, {
    timeoutCapMs: 300_000,
    kvEntries: { "clawbox-mascot-hidden": "1" },
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    preferences: { ui_mascot_hidden: 1 },
  });

  // The staging route, answering the way the real one does: a folder's files
  // under `<batch>/<relativePath>`, with the folder as staged in `root`.
  const staged: string[] = [];
  await page.route("**/setup-api/chat/attachments", async (route) => {
    const body = route.request().postDataBuffer()?.toString("utf8") ?? "";
    const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1] ?? null;
    const filename = /filename="([^"]*)"/.exec(body)?.[1] ?? "file";
    const batch = field("batch");
    const relativePath = field("relativePath");
    staged.push(relativePath ?? filename);
    const answer = batch && relativePath
      ? { ok: true, name: filename, path: `${STAGING}/${batch}/${relativePath}`, root: `${STAGING}/${batch}/${relativePath.split("/")[0]}` }
      : { ok: true, name: filename, path: `${STAGING}/0000-${filename}` };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer) });
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await openChatPopup(page);
  await expect(page.getByTestId("chat-popup")).toBeVisible();
  // Connected: the composer's attach button is live.
  await expect(page.getByTestId("chat-attach")).toBeEnabled();

  await dropFolder(page);

  const strip = page.getByTestId("chat-attachments");
  await expect(strip).toContainText("project");
  await expect(strip.getByTestId("chat-attachment-folder-count")).toHaveText("2 files");
  await expect(strip).toContainText("notes.txt");
  await expect(page.getByTestId("chat-uploads")).toHaveCount(0);
  // The folder's structure went up; its hidden file did not.
  expect([...staged].sort()).toEqual(["notes.txt", "project/README.md", "project/src/main.py"]);

  await page.locator("textarea").last().fill("Summarise this project");
  await page.getByTitle("Send").click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __chatSends?: string[] }).__chatSends ?? []))
    .toContainEqual(expect.stringMatching(/\[Attached file: \/home\/clawbox\/\.openclaw\/media\/chat-attachments\/[0-9a-f]{32}\/project\]/));
  const sent = await page.evaluate(() => (window as unknown as { __chatSends?: string[] }).__chatSends ?? []);
  expect(sent.find((s) => s.includes("Summarise this project"))).toContain(`[Attached file: ${STAGING}/0000-notes.txt]`);
});
