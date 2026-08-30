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

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { isInside } from "../../src/lib/file-guard";
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
  description?: string | null;
  descriptionError?: string | null;
}

// ── Coding-agent run context ─────────────────────────────────────────────────
//
// When the coding-agent runner spawns this server (CLAWBOX_MCP_PROFILE=browser)
// it names the run's working folder and evidence folder. In that context the
// calling model CANNOT see images (DeepSeek through the proxy — an image block
// arrives as "[Unsupported Image]"), so the capturing tools ask the backend to
// describe the frame it captures (describe: true) and every reply swaps the
// inline screenshot for the PNG archived into the evidence folder plus that
// written description.

interface RunContext {
  workingDir: string;
  artifactsDir: string;
}

/**
 * All-or-nothing: the runner sets BOTH variables. Anything less is no run
 * context, so a stray variable can never produce a chimera — an inline image
 * the run's model cannot read, or a local-view tool outside any run.
 */
function runContext(): RunContext | null {
  const workingDir = process.env.CLAWBOX_RUN_DIR?.trim();
  const artifactsDir = process.env.CLAWBOX_RUN_ARTIFACTS_DIR?.trim();
  return workingDir && artifactsDir ? { workingDir, artifactsDir } : null;
}

let shotCounter = 0;

/**
 * Screenshots archived per run. The runner's listing shows the newest ones,
 * so past this a capture is still described to the model — it just is not
 * kept, and the reply says so. A run that wants more evidence than this is
 * looping on screenshots, not verifying (run-yuyqta4t archived 99).
 */
const MAX_SHOTS_PER_RUN = 200;

/**
 * The evidence folder's mode is ONE decision, made by ensureArtifactsDir() in
 * src/lib/coding-agent-artifacts.ts: the runner creates the folder before the
 * run starts, and this is the lazy fallback for a folder that is not there.
 * mkdir never changes the mode of a folder that exists, so whichever writer
 * runs first decides it — which is why the two must agree.
 */
const ARTIFACTS_DIR_MODE = 0o700;
/** Readable like report.md beside it; the folder's mode is the guard. */
const SHOT_FILE_MODE = 0o644;

/** Archive one screenshot into the run's evidence folder; null when it was not kept. */
function saveShot(base64: string): string | null {
  const dir = runContext()?.artifactsDir;
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: ARTIFACTS_DIR_MODE });
    const bytes = Buffer.from(base64, "base64");
    // 'wx' creates the file or fails with EEXIST: "is this name free" and the
    // write are one syscall, so a file that appears between them — the run
    // saving its own shot-003.png — is stepped over, never overwritten.
    while (shotCounter < MAX_SHOTS_PER_RUN) {
      shotCounter += 1;
      const name = `shot-${String(shotCounter).padStart(3, "0")}.png`;
      try {
        fs.writeFileSync(path.join(dir, name), bytes, { flag: "wx", mode: SHOT_FILE_MODE });
        return name;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    return null;
  } catch {
    return null;
  }
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

// The describe route's own refusals are argument problems, not an outage:
// mapping them keeps a small model from retrying the same path forever.
const DESCRIBE_RULES: ErrorRule[] = [
  {
    status: 403,
    code: "BLOCKED_PATH",
    message: "That file is outside the folders this caller may look in.",
    next: "Inside a run, pass a file in the working folder or the evidence folder; do not retry that path.",
  },
  {
    status: 404,
    code: "NOT_FOUND",
    message: "There is no image file at that path.",
    next: "Check the path and pass an existing .png, .jpg, .jpeg or .webp file.",
  },
  {
    status: 400,
    code: "BAD_ARGUMENT",
    message: "The device refused that file.",
    next: "Pass an existing .png, .jpg, .jpeg or .webp image under 8 MB, by absolute path.",
  },
];

let sessionId: string | null = null;

/** A plain browser action: the route's 15 s page load plus the capture, with room. */
const ACTION_TIMEOUT_MS = 45_000;

/**
 * A call that asks the backend to DESCRIBE what it captured waits on the
 * vision model on top of that: src/lib/vision-describe.ts gives the round
 * trip DESCRIBE_TIMEOUT_MS (60 s, its one retry included). This must sit
 * ABOVE the sum — a client that gives up before the backend does pays for an
 * answer it discards and then asks the same question again, which is the
 * double-fire describe_image had at apiPost's 8 s default. The backend's
 * constant cannot be imported here (that module's import graph carries the
 * "@/" alias this stdio process must not load — see mcp/lib/guard.ts), so
 * src/tests/unit/mcp-browser-describe.test.ts pins the two in step instead.
 */
export const DESCRIBE_CALL_TIMEOUT_MS = 90_000;

async function browserCall(
  action: string,
  params: Record<string, unknown> = {},
  rules?: ErrorRule[],
): Promise<BrowserReply> {
  const timeoutMs = params.describe === true ? DESCRIBE_CALL_TIMEOUT_MS : ACTION_TIMEOUT_MS;
  return apiPost<BrowserReply>("/setup-api/browser", { action, ...params }, { timeoutMs, rules });
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

function headerLines(message: string, reply: BrowserReply): string[] {
  const lines = [message];
  if (reply.url) lines.push(`URL: ${reply.url}`);
  if (reply.title) lines.push(`Title: ${reply.title}`);
  return lines;
}

function withScreenshot(message: string, reply: BrowserReply): ToolResult {
  const content: ToolResult["content"] = [{ type: "text", text: headerLines(message, reply).join("\n") }];
  if (reply.screenshot) content.push({ type: "image", data: reply.screenshot, mimeType: "image/png" });
  return { content };
}

/**
 * Interaction replies inside a run: no screenshot, no vision call. Measured
 * on run-yuyqta4t: describing every keypress produced 99 archived screenshots
 * and most of the run's $6 — the agent asks for a described look
 * (browser_screenshot) at the states that matter instead.
 */
function briefResult(message: string, reply: BrowserReply): ToolResult {
  if (!runContext()) return withScreenshot(message, reply);
  const lines = headerLines(message, reply);
  lines.push("Use browser_screenshot when you want this state described.");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/**
 * The reply of the capturing tools. Outside a run: text + inline image, as
 * always. Inside a run the call already asked the backend to describe the
 * page (describe: true) — archive the PNG it captured, relay the words, no
 * image. The description comes from the backend's own smaller JPEG capture a
 * moment after the PNG, so on an animating page the two can differ slightly.
 */
function pageResult(message: string, reply: BrowserReply): ToolResult {
  if (!runContext()) return withScreenshot(message, reply);
  const lines = headerLines(message, reply);
  const saved = reply.screenshot ? saveShot(reply.screenshot) : null;
  if (saved) {
    lines.push(`Screenshot archived to this run's evidence folder as ${saved}.`);
  } else if (reply.screenshot) {
    // Said plainly: a model told "archived" every time would cite evidence
    // the owner will never find.
    lines.push("Screenshot not archived: this run's evidence folder is full or cannot be written.");
  }
  if (reply.description) {
    lines.push(`What the page shows: ${reply.description}`);
  } else {
    const reason = reply.descriptionError ? ` (${reply.descriptionError})` : "";
    lines.push(`No vision description is available${reason}. Rely on the URL, the title and your knowledge of the code.`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** In run context, the capturing actions describe the frame they capture. */
function describeParam(): { describe?: true } {
  return runContext() ? { describe: true } : {};
}

export function registerBrowserTools(reg: Registrar): void {
  // Registered only inside a coding-agent run (the runner names the working
  // and evidence folders): a tool that exists but answers "no run active" on
  // the assistant's own server would trip Hermes' circuit breaker for nothing.
  const run = runContext();
  if (run) {
    // The route's realpath check against the ACTIVE run is the one containment
    // implementation; this rule only turns its refusal into a clear next step.
    const viewLocalRules: ErrorRule[] = [
      {
        status: 400,
        match: /blocked file address|file not found/i,
        code: "BAD_ARGUMENT",
        message: "That path is outside this run's working folder, or the file does not exist.",
        next: "Pass a file inside the folder you were started in, e.g. index.html.",
      },
    ];
    reg.tool(
      "browser_view_local",
      "Open a page from this run's working folder in the device browser and get a written description of what actually renders. Use it to verify every page you build before reporting done. Pass the path of an HTML file inside your folder.",
      { path: zText(512, "HTML file to view, relative to the working folder (e.g. index.html) or absolute inside it.") },
      { editions: ["openclaw", "hermes"], family: "browser", readOnly: false },
      async ({ path: given }: { path: string }) => {
        const abs = path.isAbsolute(given) ? given : path.join(run.workingDir, given);
        const fileUrl = pathToFileURL(abs).href;
        const id = await ensureSession();
        const reply = await browserCall("navigate", { sessionId: id, url: fileUrl, ...describeParam() }, viewLocalRules);
        return pageResult(`Viewing ${given}.`, reply);
      },
    );
  }

  // Registered in BOTH contexts: inside a run it is how an image-blind model
  // looks at a file it saved (run-d8816d78 built a viewer.html and drove the
  // device browser at it just to see its own frames); on the assistant's own
  // server it reads a screenshot or photo on disk the same way. The backend
  // answers a clean error when ClawBox AI is not linked, so this never trips
  // the circuit breaker for a healthy box.
  reg.tool(
    "describe_image",
    "Look at a local image file (.png, .jpg, .jpeg, .webp) and get a written description of what it shows, through the device's vision model. Use it to check a screenshot or picture you saved without opening a browser.",
    {
      path: zText(512, "Image file to describe. Relative paths resolve against the working folder."),
      prompt: zText(600, "What to look for, in one sentence. Omit for a general description.").optional(),
    },
    { editions: ["openclaw", "hermes"], family: "browser", readOnly: true },
    async ({ path: given, prompt }: { path: string; prompt?: string }) => {
      const ctx = runContext();
      const abs = path.isAbsolute(given) ? given : path.join(ctx ? ctx.workingDir : process.cwd(), given);
      if (ctx && !isInside(abs, ctx.workingDir) && !isInside(abs, ctx.artifactsDir)) {
        // The route enforces this fence (realpath'd, against the ACTIVE run);
        // this early copy only turns a typo'd path into a helpful message
        // instead of a confusing backend refusal.
        throw new ToolError(
          "BLOCKED_PATH",
          "That file is outside this run's folders.",
          "Pass a path inside the working folder or the evidence folder.",
        );
      }
      // ONE call: the backend already retries a flap of the vision proxy
      // inside its own budget (src/lib/vision-describe.ts), so a client-side
      // retry on top would only re-pay for an answer that was on its way.
      const reply = await apiPost<{ description?: string | null; error?: string | null }>(
        "/setup-api/vision/describe",
        prompt ? { path: abs, prompt } : { path: abs },
        { timeoutMs: DESCRIBE_CALL_TIMEOUT_MS, rules: DESCRIBE_RULES },
      );
      if (typeof reply.description === "string" && reply.description) return text(reply.description);
      throw new ToolError(
        "ENDPOINT_DOWN",
        reply.error || "The vision model did not answer.",
        "The image exists but could not be described right now. Try again, or report what you can without it.",
      );
    },
  );

  reg.tool(
    "browser_open",
    "Open the web browser on the ClawBox desktop and optionally go to a page. Use this whenever the user asks to open the browser, open a site, or look something up on the web. It drives the real window the user can see, and returns a picture of the page.",
    { url: zText(2_000, "Page to open, starting with http:// or https://. Omit to just open the browser.").optional() },
    { editions: ["openclaw", "hermes"], family: "browser", readOnly: false, openWorld: true },
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
      const reply = await browserCall("screenshot", { sessionId: id, ...describeParam() });
      return pageResult(url ? `Opened ${url} in the browser on the desktop.` : "Opened the browser on the desktop.", reply);
    },
  );

  reg.tool(
    "browser_navigate",
    "Send the browser that is already open to a different page. Returns a picture of the loaded page. If the browser is not open yet, use browser_open.",
    { url: zText(2_000, "Page to go to, starting with http:// or https://") },
    { editions: ["openclaw", "hermes"], family: "browser", readOnly: false, openWorld: true },
    async ({ url }: { url: string }) => {
      if (!/^https?:\/\//i.test(url)) {
        throw new ToolError("BAD_ARGUMENT", "That is not a web address.", "Pass a full address starting with https://.");
      }
      return pageResult(`Went to ${url}.`, await act("navigate", { url, ...describeParam() }));
    },
  );

  reg.tool(
    "browser_screenshot",
    "Take a picture of the page currently loaded in the desktop browser. Use it to see what a page says before acting on it. To photograph the whole desktop instead, use screen_capture.",
    {},
    { editions: ["openclaw", "hermes"], family: "browser", readOnly: true },
    async () => pageResult("The page currently in the browser.", await act("screenshot", describeParam())),
  );

  reg.tool(
    "browser_close",
    "Stop controlling the desktop browser. The window itself stays open for the user. Call this when you are finished with a browsing task.",
    {},
    { editions: ["openclaw", "hermes"], family: "browser", readOnly: false },
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
    { editions: ["openclaw"], family: "browser", readOnly: false },
    async ({ x, y, button }: { x: number; y: number; button: string }) =>
      briefResult(`Clicked at ${x},${y}.`, await act("click", { x, y, button })),
  );

  reg.tool(
    "browser_type",
    "Type text into the field that is focused in the desktop browser. Click the field with browser_click first. The text itself is never echoed back, because this is the tool that types passwords.",
    { text: zText(2_000, "The text to type into the focused field.") },
    { editions: ["openclaw"], family: "browser", readOnly: false },
    async ({ text: value }: { text: string }) => {
      const reply = await act("type", { text: value });
      // Deliberately reports a COUNT, not the text: echoing it put passwords
      // and one-time codes into the model's context and the session transcript.
      return briefResult(`Typed ${value.length} characters into the page.`, reply);
    },
  );

  reg.tool(
    "browser_fill",
    "Set the value of a form field you can name by CSS selector — focus, clear and type in one call. Use this instead of clicking a field and typing, and instead of Tab-by-Tab navigation: it costs one step per field. The text itself is never echoed back.",
    {
      selector: zText(300, "CSS selector of the input, textarea or contenteditable, e.g. #name or input[name=phone]."),
      text: zText(2_000, "The value to set."),
    },
    { editions: ["openclaw"], family: "browser", readOnly: false },
    async ({ selector, text: value }: { selector: string; text: string }) => {
      const reply = await act("fill", { selector, text: value });
      return briefResult(`Filled ${selector.slice(0, 60)} with ${value.length} characters.`, reply);
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
    { editions: ["openclaw"], family: "browser", readOnly: false },
    async ({ key }: { key: string }) => briefResult(`Pressed ${key}.`, await act("keydown", { key })),
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
    { editions: ["openclaw"], family: "browser", readOnly: false },
    async ({ x, y, scroll_y, scroll_x }: { x: number; y: number; scroll_y: number; scroll_x: number }) =>
      briefResult(
        `Scrolled ${scroll_y >= 0 ? "down" : "up"} ${Math.abs(scroll_y)} pixels.`,
        await act("scroll", { x, y, deltaY: scroll_y, deltaX: scroll_x }),
      ),
  );
}
