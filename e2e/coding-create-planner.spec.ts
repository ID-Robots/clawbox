import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

/**
 * The desktop's "+" tile and the Create planner window (2026-11-01).
 *
 * The tile closes the icon grid; a press opens the planner as a desktop window
 * of its own — dragged and resized like any other — with the chat still
 * closed. The brief's lists continue on Enter, a pasted picture becomes a
 * thumbnail and an `[image 1]` in the brief, and Create hands one message to
 * the chat, which opens for it.
 */

const COMPLETE_SETUP = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

test("the + tile opens the Create planner as a window, and Create hands the plan to the chat", async ({ page }) => {
  await installClawboxMocks(page, { initialSetup: COMPLETE_SETUP });
  // The Coding Agent is set up and on, so the tile opens the planner rather
  // than the app's wizard. Registered after the shared mocks, so it wins.
  await page.route("**/setup-api/coding-agent/status", (route) =>
    route.fulfill({ json: { enabled: true, setupComplete: true, maxTaskChars: 4000 } }),
  );
  let staged = 0;
  await page.route("**/setup-api/chat/attachments", (route) => {
    staged += 1;
    return route.fulfill({ json: { name: `plan-${staged}.png`, path: `/home/clawbox/.openclaw/media/chat/plan-${staged}.png` } });
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  const tile = page.getByTestId("desktop-create-app-tile");
  await expect(tile).toBeVisible();
  // Not an icon: never selected, dragged or saved.
  await expect(tile.locator("[data-desktop-icon-id]")).toHaveCount(0);
  await tile.getByRole("button").click();

  const win = page.getByTestId("chrome-window-coding-planner");
  await expect(win).toBeVisible();
  await expect(win.getByText("Create app").first()).toBeVisible();
  // The chat stays closed until the plan is handed over.
  await expect(page.getByTestId("chat-popup")).toHaveCount(0);

  // A window: the title bar drags it, the corner resizes it.
  const before = (await win.boundingBox())!;
  await page.mouse.move(before.x + 120, before.y + 18);
  await page.mouse.down();
  await page.mouse.move(before.x + 60, before.y + 48, { steps: 6 });
  await page.mouse.up();
  const moved = (await win.boundingBox())!;
  expect(Math.round(moved.x)).toBe(Math.round(before.x - 60));
  expect(Math.round(moved.y)).toBe(Math.round(before.y + 30));
  await page.mouse.move(moved.x + moved.width - 3, moved.y + moved.height - 3);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width - 63, moved.y + moved.height - 43, { steps: 6 });
  await page.mouse.up();
  const resized = (await win.boundingBox())!;
  expect(Math.round(resized.width)).toBe(Math.round(moved.width - 60));

  await win.getByTestId("coding-agent-new-name").fill("Invoices");
  const brief = win.getByTestId("coding-agent-new-what");
  await brief.click();
  await page.keyboard.type("An invoice generator for a small shop that keeps its customers.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- Customers");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Invoices with PDF export");
  await expect(brief).toHaveValue("An invoice generator for a small shop that keeps its customers.\n\n- Customers\n- Invoices with PDF export");
  await expect(win.getByTestId("coding-agent-planner-check-features")).toHaveAttribute("data-ok", "true");

  // Paste a picture into the brief.
  await brief.evaluate((el) => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "image.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(win.getByTestId("coding-agent-planner-image")).toHaveCount(1);
  await expect(brief).toHaveValue(/\[image 1\] $/);
  await expect(win.getByTestId("coding-agent-new-create")).toBeEnabled();

  await win.screenshot({ path: test.info().outputPath("planner.png") });

  await win.getByTestId("coding-agent-new-create").click();
  await expect(win).toHaveCount(0);
  const chat = page.getByTestId("chat-popup");
  await expect(chat).toBeVisible();
  // The one message the planner composed, in the conversation: the brief,
  // the picture's path and how the run gets it.
  await expect(chat).toContainText('Create a new ClawBox app called "Invoices"');
  await expect(chat).toContainText("Invoices with PDF export [image 1]");
  // A long message is folded in its bubble; the paths are under "Show more".
  await chat.getByText("Show more").first().click();
  await expect(chat).toContainText("[image 1] /home/clawbox/.openclaw/media/chat/plan-1.png");
});
