// Browser automation over CDP against the real Chromium window on the desktop.
//
// The four COORDINATE tools (click, type, keypress, scroll) are OpenClaw-only.
// Clicking at an x,y read off a screenshot is the failure mode a 4-8B model
// cannot recover from — it misses, the page does not change, and it retries the
// same coordinates — and Hermes ships a ten-tool browser toolset of its own
// that works from element handles instead. Open/navigate/screenshot/close stay
// on both, because they are how the agent shows the user a page.
//
// browser_launch is gone: it was a byte-identical alias of browser_open, and
// two tools with one behaviour is precisely the tie a small model breaks wrongly.

import { apiPost } from "../lib/api";
import { ToolError, type ErrorRule } from "../lib/errors";
import { text, type Registrar, type ToolResult } from "../lib/register";
import { zEnumOf, zInt, zText } from "../lib/schema";

interface BrowserReply {
  sessionId?: string;
  screenshot?: string;
  url?: string;
  title?: string;
  error?: string;
}

/**
 * `opening` is browser_open itself. A `next` that names the tool that just
 * failed is a guaranteed retry loop for a small model, so the advice has to
 * differ depending on who is asking.
 */
const CDP_DOWN = (opening = false) =>
  new ToolError(
    "ENDPOINT_DOWN",
    "The desktop browser is not running, so it cannot be controlled.",
    opening
      ? "Do not call browser_open again. Tell the user to open the Browser app on the ClawBox desktop themselves."
      : "Call browser_open first. If that fails too, tell the user to open the Browser app on the ClawBox desktop.",
  );

// The launch route refuses addresses on the device's own network BEFORE any
// browser starts, with 400 "Blocked internal address". That is an argument
// problem the agent can fix; reporting it as "the browser is not running" sent
// it back to browser_open with the same url, forever.
const LAUNCH_RULES: ErrorRule[] = [
  {
    status: 400,
    match: /blocked internal address/i,
    code: "BAD_ARGUMENT",
    message: "That address is on the device's own private network, so the browser will not open it.",
    next: "Do not retry that address. Ask the user for a public https:// address, or use ui_open_app to show them a ClawBox app instead.",
  },
  {
    status: 400,
    code: "BAD_ARGUMENT",
    message: "The device refused that address.",
    next: "Pass a full public address starting with https://, and do not retry the one that was refused.",
  },
];

let sessionId: string | null = null;

async function browserCall(
  action: string,
  params: Record<string, unknown> = {},
  rules?: ErrorRule[],
): Promise<BrowserReply> {
  return apiPost<BrowserReply>("/setup-api/browser", { action, ...params }, { timeoutMs: 45_000, rules });
}

/** Attach to the live window, reusing the session when it is still alive. */
async function ensureSession(url?: string, opening = false): Promise<string> {
  if (sessionId) {
    try {
      const alive = await browserCall("screenshot", { sessionId });
      if (!alive.error) return sessionId;
    } catch {
      // Session died with the window — fall through and launch a new one.
    }
    sessionId = null;
  }
  let reply: BrowserReply;
  try {
    reply = await browserCall("launch", { ...(url ? { url } : {}) }, LAUNCH_RULES);
  } catch (err) {
    // A mapped refusal is the device's real answer and is the ONLY thing the
    // agent can act on. Only a genuine "nothing answered" becomes CDP_DOWN.
    if (err instanceof ToolError) throw err;
    throw CDP_DOWN(opening);
  }
  if (!reply.sessionId) throw CDP_DOWN(opening);
  sessionId = reply.sessionId;
  return sessionId;
}

async function act(action: string, params: Record<string, unknown> = {}): Promise<BrowserReply> {
  const id = await ensureSession();
  return browserCall(action, { sessionId: id, ...params });
}

function withScreenshot(message: string, reply: BrowserReply): ToolResult {
  const lines = [message];
  if (reply.url) lines.push(`URL: ${reply.url}`);
  if (reply.title) lines.push(`Title: ${reply.title}`);
  const content: ToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
  if (reply.screenshot) content.push({ type: "image", data: reply.screenshot, mimeType: "image/png" });
  return { content };
}

export function registerBrowserTools(reg: Registrar): void {
  reg.tool(
    "browser_open",
    "Open the web browser on the ClawBox desktop and optionally go to a page. Use this whenever the user asks to open the browser, open a site, or look something up on the web. It drives the real window the user can see, and returns a picture of the page.",
    { url: zText(2_000, "Page to open, starting with http:// or https://. Omit to just open the browser.").optional() },
    { editions: ["openclaw", "hermes"], readOnly: false, openWorld: true },
    async ({ url }: { url?: string }) => {
      if (url && !/^https?:\/\//i.test(url)) {
        throw new ToolError(
          "BAD_ARGUMENT",
          "That is not a web address.",
          "Pass a full address starting with https://, or omit the url to just open the browser.",
        );
      }
      // Close any stale session so "open the browser" always gives a live one.
      if (sessionId) {
        await browserCall("close", { sessionId }).catch(() => { /* already gone */ });
        sessionId = null;
      }
      const id = await ensureSession(url, true);
      const reply = await browserCall("screenshot", { sessionId: id });
      return withScreenshot(url ? `Opened ${url} in the browser on the desktop.` : "Opened the browser on the desktop.", reply);
    },
  );

  reg.tool(
    "browser_navigate",
    "Send the browser that is already open to a different page. Returns a picture of the loaded page. If the browser is not open yet, use browser_open.",
    { url: zText(2_000, "Page to go to, starting with http:// or https://") },
    { editions: ["openclaw", "hermes"], readOnly: false, openWorld: true },
    async ({ url }: { url: string }) => {
      if (!/^https?:\/\//i.test(url)) {
        throw new ToolError("BAD_ARGUMENT", "That is not a web address.", "Pass a full address starting with https://.");
      }
      return withScreenshot(`Went to ${url}.`, await act("navigate", { url }));
    },
  );

  reg.tool(
    "browser_screenshot",
    "Take a picture of the page currently loaded in the desktop browser. Use it to see what a page says before acting on it. To photograph the whole desktop instead, use screen_capture.",
    {},
    { editions: ["openclaw", "hermes"], readOnly: true },
    async () => withScreenshot("The page currently in the browser.", await act("screenshot")),
  );

  reg.tool(
    "browser_close",
    "Stop controlling the desktop browser. The window itself stays open for the user. Call this when you are finished with a browsing task.",
    {},
    { editions: ["openclaw", "hermes"], readOnly: false },
    async () => {
      if (sessionId) {
        await browserCall("close", { sessionId }).catch(() => { /* already gone */ });
        sessionId = null;
      }
      return text("Stopped controlling the browser. The window is still open on the desktop.");
    },
  );

  // ── Coordinate control (OpenClaw only) ─────────────────────────────────────

  reg.tool(
    "browser_click",
    "Click at a point on the page in the desktop browser. Take a browser_screenshot first and read the coordinates off it; 0,0 is the top-left of the page.",
    {
      x: zInt(0, 10_000, 0, "Horizontal position in pixels from the left edge."),
      y: zInt(0, 10_000, 0, "Vertical position in pixels from the top edge."),
      button: zEnumOf(["left", "right", "middle"], "Which mouse button.").default("left"),
    },
    { editions: ["openclaw"], readOnly: false },
    async ({ x, y, button }: { x: number; y: number; button: string }) =>
      withScreenshot(`Clicked at ${x},${y}.`, await act("click", { x, y, button })),
  );

  reg.tool(
    "browser_type",
    "Type text into the field that is focused in the desktop browser. Click the field with browser_click first. The text itself is never echoed back, because this is the tool that types passwords.",
    { text: zText(2_000, "The text to type into the focused field.") },
    { editions: ["openclaw"], readOnly: false },
    async ({ text: value }: { text: string }) => {
      const reply = await act("type", { text: value });
      // Deliberately reports a COUNT, not the text: echoing it put passwords
      // and one-time codes into the model's context and the session transcript.
      return withScreenshot(`Typed ${value.length} characters into the page.`, reply);
    },
  );

  reg.tool(
    "browser_keypress",
    "Press a single named key in the desktop browser, for example Enter to submit a form or Escape to close a dialog. To type words, use browser_type.",
    {
      key: zEnumOf(
        ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"],
        "Which key to press.",
      ),
    },
    { editions: ["openclaw"], readOnly: false },
    async ({ key }: { key: string }) => withScreenshot(`Pressed ${key}.`, await act("keydown", { key })),
  );

  reg.tool(
    "browser_scroll",
    "Scroll the page in the desktop browser. A positive scroll_y scrolls down the page, a negative one scrolls up.",
    {
      x: zInt(0, 10_000, 0, "Horizontal position on the page to scroll at."),
      y: zInt(0, 10_000, 0, "Vertical position on the page to scroll at."),
      scroll_y: zInt(-20_000, 20_000, 600, "How far to scroll vertically, in pixels. Positive is down."),
      scroll_x: zInt(-20_000, 20_000, 0, "How far to scroll horizontally, in pixels."),
    },
    { editions: ["openclaw"], readOnly: false },
    async ({ x, y, scroll_y, scroll_x }: { x: number; y: number; scroll_y: number; scroll_x: number }) =>
      withScreenshot(
        `Scrolled ${scroll_y >= 0 ? "down" : "up"} ${Math.abs(scroll_y)} pixels.`,
        await act("scroll", { x, y, deltaY: scroll_y, deltaX: scroll_x }),
      ),
  );
}
