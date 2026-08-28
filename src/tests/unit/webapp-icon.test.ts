import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * An icon for a web app that was created without one (src/lib/webapp-icon.ts).
 *
 * What these pin is the set of promises the module makes to the code that
 * fires it and forgets it: it never rejects, it never overwrites, it writes
 * nothing but a PNG where the icon route serves `image/png`, it leaves no copy
 * behind in the chat media tree, it spends no generation on an unlinked box or
 * an id the icon route would refuse, it pays for one picture per app and draws
 * one at a time, it leaves an uninstalled app uninstalled — and `deployWebapp`
 * answers before any of it has happened.
 *
 * The proxy and the credential are mocked at the module boundary; the file
 * system is real, under a per-test CLAWBOX_ROOT, because the atomic write and
 * the no-clobber link are the thing under test.
 */

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  hasToken: vi.fn(),
  kvSet: vi.fn(),
  register: vi.fn(),
}));

vi.mock("@/lib/harness/clawai-images", () => ({ generateClawaiImage: mocks.generate }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: mocks.hasToken }));
vi.mock("@/lib/kv-store", () => ({ kvSet: mocks.kvSet }));
// deployWebapp's durable registration is config-store IO covered elsewhere.
vi.mock("@/lib/webapp-registry", () => ({ registerWebappInPreferences: mocks.register }));

/**
 * A real PNG, drawn by sharp — the module sniffs the magic bytes AND resizes
 * through libvips, which rejects a hand-typed header-only "PNG" as
 * "unsupported image format" and would leave the original bytes in place.
 */
const PNG: Buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#f97316" } }).png().toBuffer();
/** JPEG magic followed by nothing in particular. */
const JPEG = Buffer.from("ffd8ffe000104a46494600", "hex");

let tmpRoot: string;
let originalRoot: string | undefined;
let warn: ReturnType<typeof vi.spyOn>;

type IconModule = typeof import("@/lib/webapp-icon");
let mod: IconModule;

function iconPath(appId: string): string {
  return path.join(tmpRoot, "data", "icons", `${appId}.png`);
}

function webappDir(appId: string): string {
  return path.join(tmpRoot, "data", "webapps", appId);
}

/** What `deployWebapp` leaves on disk: the module checks for this meta.json. */
function installApp(appId: string): void {
  fs.mkdirSync(webappDir(appId), { recursive: true });
  fs.writeFileSync(path.join(webappDir(appId), "meta.json"), JSON.stringify({ name: appId, color: "#f97316", icon: "" }));
}

/** What the uninstall route does: the directory, the icon, the registration. */
function uninstallApp(appId: string): void {
  fs.rmSync(webappDir(appId), { recursive: true, force: true });
  fs.rmSync(iconPath(appId), { force: true });
}

/** Stand in for the proxy: drop `bytes` into a "media tree" file and hand back its path. */
function generationOf(bytes: Buffer) {
  const dir = path.join(tmpRoot, "data", "chat-media", "chat-generated");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(file, bytes);
  return { path: file, media: `/setup-api/chat/media?path=${encodeURIComponent(file)}` };
}

/** A generation that finishes when the test says so. */
function deferredGeneration() {
  let finish!: (value: { path: string; media: string }) => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<{ path: string; media: string }>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { promise, finish, fail };
}

/** The error shape `generateClawaiImage` throws: a status and a sentence. */
function proxyError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

beforeEach(async () => {
  vi.resetModules();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-icon-"));
  originalRoot = process.env.CLAWBOX_ROOT;
  process.env.CLAWBOX_ROOT = tmpRoot;
  mocks.hasToken.mockResolvedValue(true);
  mocks.register.mockResolvedValue(undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mod = await import("@/lib/webapp-icon");
  installApp("todo-list");
});

afterEach(() => {
  vi.useRealTimers();
  if (originalRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = originalRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ensureWebappIcon", () => {
  it("generates: writes the PNG to data/icons/<id>.png, removes the media copy, nudges the desktop", async () => {
    const generated = generationOf(PNG);
    mocks.generate.mockResolvedValue(generated);

    await expect(
      mod.ensureWebappIcon("todo-list", { name: "Todo List", color: "#2563eb", description: "A to-do list" }),
    ).resolves.toBe("generated");

    const written = fs.readFileSync(iconPath("todo-list"));
    // Not the proxy's 1024² picture: brought down to icon size (the IHDR
    // width and height live at bytes 16–24 of a PNG).
    expect(written.subarray(0, 8).equals(PNG.subarray(0, 8))).toBe(true);
    expect(written.readUInt32BE(16)).toBe(256);
    expect(written.readUInt32BE(20)).toBe(256);
    // Public asset: readable by the web server whatever the umask was.
    expect(fs.statSync(iconPath("todo-list")).mode & 0o777).toBe(0o644);
    // Not a chat picture — it must not linger in the transcript's tree.
    expect(fs.existsSync(generated.path)).toBe(false);
    // No temp file left behind.
    expect(fs.readdirSync(path.dirname(iconPath("todo-list")))).toEqual(["todo-list.png"]);

    // The desktop is told through the same action the MCP tool pushes, with a
    // NEW iconUrl so the icon component's props actually change.
    expect(mocks.kvSet).toHaveBeenCalledTimes(1);
    const [key, value] = mocks.kvSet.mock.calls[0] as [string, string];
    expect(key).toBe("ui:pending-action");
    const action = JSON.parse(value);
    expect(action).toMatchObject({
      type: "register_webapp",
      appId: "todo-list",
      name: "Todo List",
      color: "#2563eb",
      url: "/setup-api/webapps?app=todo-list",
    });
    expect(action.iconUrl).toMatch(/^\/setup-api\/apps\/icon\/todo-list\?v=\d+$/);
    expect(typeof action.ts).toBe("number");
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks for a desktop icon, not a picture", async () => {
    mocks.generate.mockResolvedValue(generationOf(PNG));
    await mod.ensureWebappIcon("todo-list", { name: "Todo List", color: "#2563eb", description: "A to-do list" });
    const prompt = mocks.generate.mock.calls[0][0] as string;
    expect(prompt).toContain('"Todo List"');
    expect(prompt).toContain("A to-do list");
    expect(prompt).toContain("#2563eb");
    expect(prompt).toContain("1024x1024");
    expect(prompt).toMatch(/no text/i);
  });

  it("keeps an icon that already exists and spends no generation on it", async () => {
    fs.mkdirSync(path.dirname(iconPath("todo-list")), { recursive: true });
    fs.writeFileSync(iconPath("todo-list"), Buffer.from("the store's icon"));

    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("kept");

    expect(fs.readFileSync(iconPath("todo-list"), "utf8")).toBe("the store's icon");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.kvSet).not.toHaveBeenCalled();
  });

  it("never overwrites an icon that appeared while the picture was being drawn", async () => {
    // The icon route caches the store's copy on a fire-and-forget write; that
    // can land between this module's existence check and its own write.
    mocks.generate.mockImplementation(async () => {
      fs.mkdirSync(path.dirname(iconPath("todo-list")), { recursive: true });
      fs.writeFileSync(iconPath("todo-list"), Buffer.from("the store's icon"));
      return generationOf(PNG);
    });

    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("kept");

    expect(fs.readFileSync(iconPath("todo-list"), "utf8")).toBe("the store's icon");
    expect(fs.readdirSync(path.dirname(iconPath("todo-list")))).toEqual(["todo-list.png"]);
    expect(mocks.kvSet).not.toHaveBeenCalled();
  });

  it("skips silently on a box with no ClawBox AI token", async () => {
    mocks.hasToken.mockResolvedValue(false);

    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("skipped");

    expect(mocks.generate).not.toHaveBeenCalled();
    expect(fs.existsSync(iconPath("todo-list"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips when the picture is not a PNG, writing nothing", async () => {
    // The icon route serves `image/png` unconditionally; a JPEG under that
    // Content-Type is a broken image on every desktop.
    const generated = generationOf(JPEG);
    mocks.generate.mockResolvedValue(generated);

    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("skipped");

    expect(fs.existsSync(iconPath("todo-list"))).toBe(false);
    expect(fs.existsSync(path.dirname(iconPath("todo-list")))).toBe(false);
    expect(fs.existsSync(generated.path)).toBe(false);
    expect(mocks.kvSet).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips when generation throws, and never rejects", async () => {
    mocks.generate.mockRejectedValue(new Error("You have used up today's ClawBox AI pictures."));

    await expect(
      mod.ensureWebappIcon("todo-list", { name: "Secret Project Name", description: "secret description" }),
    ).resolves.toBe("skipped");

    expect(fs.existsSync(iconPath("todo-list"))).toBe(false);
    expect(mocks.kvSet).not.toHaveBeenCalled();
    // One line, with the app id and the reason and NOT the prompt.
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].join(" ");
    expect(line).toContain("todo-list");
    expect(line).toContain("used up today's ClawBox AI pictures");
    expect(line).not.toContain("Secret Project Name");
    expect(line).not.toContain("secret description");
  });

  it("skips when the written picture cannot be read", async () => {
    mocks.generate.mockResolvedValue({ path: path.join(tmpRoot, "nowhere.png"), media: "" });

    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("skipped");

    expect(fs.existsSync(iconPath("todo-list"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses an id the icon route would refuse, before touching the credential or the disk", async () => {
    for (const bad of ["../etc", "../x", "..", "a/b", "", "x".repeat(65), "todo list", "todo.png", "tödo", "a\u0000b"]) {
      await expect(mod.ensureWebappIcon(bad, { name: "Bad" })).resolves.toBe("skipped");
    }
    expect(mocks.hasToken).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.kvSet).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpRoot, "data", "icons"))).toBe(false);
    // Nothing was created anywhere: data/ still holds only the deployed app.
    expect(fs.readdirSync(path.join(tmpRoot, "data"))).toEqual(["webapps"]);
    expect(fs.readdirSync(path.join(tmpRoot, "data", "webapps"))).toEqual(["todo-list"]);
    expect(fs.existsSync(path.join(tmpRoot, "x"))).toBe(false);
  });

  it("pays for one picture when the same app is asked for twice while it is being drawn", async () => {
    // `code_project_build` fires this on every rebuild of an app that has no
    // icon yet; two builds inside the 5–15 s window must not cost two pictures.
    const generation = deferredGeneration();
    mocks.generate.mockReturnValue(generation.promise);

    const first = mod.ensureWebappIcon("todo-list", { name: "Todo List" });
    const second = mod.ensureWebappIcon("todo-list", { name: "Todo List" });
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));

    generation.finish(generationOf(PNG));
    await expect(first).resolves.toBe("generated");
    await expect(second).resolves.toBe("generated");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.kvSet).toHaveBeenCalledTimes(1);
    // A call AFTER the picture landed is a plain stat, not another picture.
    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("kept");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("draws one picture at a time: a second app waits for the first", async () => {
    // A loop creating N apps must open one upstream request, not N, each
    // holding a 120 s timeout and a multi-megabyte buffer on the Jetson.
    installApp("notes");
    const first = deferredGeneration();
    const second = deferredGeneration();
    mocks.generate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = mod.ensureWebappIcon("todo-list", { name: "Todo List" });
    const b = mod.ensureWebappIcon("notes", { name: "Notes" });
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    // Give the second every chance to have jumped the queue.
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0][0]).toContain('"Todo List"');

    first.finish(generationOf(PNG));
    await expect(a).resolves.toBe("generated");
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    expect(mocks.generate.mock.calls[1][0]).toContain('"Notes"');

    second.finish(generationOf(PNG));
    await expect(b).resolves.toBe("generated");
    expect(fs.existsSync(iconPath("todo-list"))).toBe(true);
    expect(fs.existsSync(iconPath("notes"))).toBe(true);
  });

  it("releases the slot when a generation fails, so the next app is still drawn", async () => {
    installApp("notes");
    mocks.generate
      .mockRejectedValueOnce(new Error("Generating the picture failed (upstream 502)."))
      .mockResolvedValueOnce(generationOf(PNG));

    const [a, b] = await Promise.all([
      mod.ensureWebappIcon("todo-list", { name: "Todo List" }),
      mod.ensureWebappIcon("notes", { name: "Notes" }),
    ]);
    expect(a).toBe("skipped");
    expect(b).toBe("generated");
    expect(fs.existsSync(iconPath("notes"))).toBe(true);
  });

  it("does not retry an app whose generation failed until the pause is over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.generate.mockRejectedValue(new Error("Generating the picture failed (upstream 502)."));

    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("skipped");
    // The rebuild a few seconds later: no second call to the proxy.
    vi.setSystemTime(Date.now() + 30 * 1000);
    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("skipped");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // The pause is per app: a different app is still tried.
    installApp("notes");
    mocks.generate.mockResolvedValueOnce(generationOf(PNG));
    await expect(mod.ensureWebappIcon("notes", { name: "Notes" })).resolves.toBe("generated");

    // And it ends: a rebuild after the pause asks again.
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    mocks.generate.mockResolvedValueOnce(generationOf(PNG));
    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("generated");
  });

  it("pauses every app when the proxy refuses the box itself (credential or allowance)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    installApp("notes");
    mocks.generate.mockRejectedValueOnce(
      proxyError(429, "You have used up today's ClawBox AI pictures. The allowance resets at midnight UTC."),
    );

    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("skipped");
    // A different app, a minute later: the allowance has not come back.
    vi.setSystemTime(Date.now() + 60 * 1000);
    await expect(mod.ensureWebappIcon("notes", { name: "Notes" })).resolves.toBe("skipped");
    expect(mocks.generate).toHaveBeenCalledTimes(1);

    // Same for a refused credential.
    vi.setSystemTime(Date.now() + 20 * 60 * 1000);
    mocks.generate.mockRejectedValueOnce(proxyError(503, "ClawBox AI rejected this device's credentials."));
    await expect(mod.ensureWebappIcon("notes", { name: "Notes" })).resolves.toBe("skipped");
    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("skipped");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it("leaves an app uninstalled while its picture was being drawn uninstalled", async () => {
    // `app_uninstall` inside the generation window removes the directory, the
    // icon and the desktop entry. Writing the icon anyway would orphan a PNG
    // nothing cleans up, and the nudge would put the app back on the desktop.
    const generated = generationOf(PNG);
    mocks.generate.mockImplementation(async () => {
      uninstallApp("todo-list");
      return generated;
    });

    await expect(mod.ensureWebappIcon("todo-list", { name: "Todo List" })).resolves.toBe("skipped");

    expect(fs.existsSync(iconPath("todo-list"))).toBe(false);
    expect(fs.existsSync(generated.path)).toBe(false);
    expect(mocks.kvSet).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("spends nothing on an app that is not deployed", async () => {
    await expect(mod.ensureWebappIcon("never-deployed", { name: "Nothing" })).resolves.toBe("skipped");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(fs.existsSync(iconPath("never-deployed"))).toBe(false);
  });
});

describe("buildIconPrompt", () => {
  it("falls back to the desktop's default colour for anything but #rrggbb", () => {
    expect(mod.buildIconPrompt({ name: "X", color: "red" })).toContain("#f97316");
    expect(mod.buildIconPrompt({ name: "X", color: "#fff" })).toContain("#f97316");
    expect(mod.buildIconPrompt({ name: "X" })).toContain("#f97316");
    expect(mod.buildIconPrompt({ name: "X", color: "#00AAff" })).toContain("#00AAff");
  });

  it("keeps the prompt to one bounded paragraph", () => {
    const prompt = mod.buildIconPrompt({
      name: "  Todo\n\nList  ",
      description: "line one\nline two " + "x".repeat(500),
    });
    expect(prompt).toContain('"Todo List"');
    expect(prompt).toContain("line one line two");
    expect(prompt).not.toContain("\n");
    expect(prompt.length).toBeLessThan(700);
  });

  it("leaves the description out when there is none", () => {
    expect(mod.buildIconPrompt({ name: "Todo", description: "   " })).not.toContain("The app:");
    expect(mod.buildIconPrompt({ name: "Todo" })).not.toContain("The app:");
  });
});

describe("safeAppId", () => {
  it("accepts exactly what the icon route and code-projects accept, and hands back a fresh copy", async () => {
    const { APP_ID_RE } = await import("@/lib/code-projects");
    for (const id of ["a", "todo-list", "Todo_List-2", "x".repeat(64)]) {
      expect(APP_ID_RE.test(id)).toBe(true);
      expect(mod.safeAppId(id)).toBe(id);
    }
    for (const id of ["", "..", "../x", "a/b", "a\\b", "a b", "a.png", "x".repeat(65), "tödo", "a\nb", "a\u0000b", "a\tb", "😀", 42, null, undefined]) {
      expect(typeof id === "string" && APP_ID_RE.test(id)).toBe(false);
      expect(mod.safeAppId(id)).toBeNull();
    }
  });
});

describe("htmlHint", () => {
  it("prefers the title, then the first h1, then nothing", () => {
    expect(mod.htmlHint("<html><head><title> Pomodoro &amp; Breaks </title></head><body><h1>Other</h1></body></html>"))
      .toBe("Pomodoro & Breaks");
    expect(mod.htmlHint("<body><h1 class=\"x\">Hello <em>world</em></h1></body>")).toBe("Hello world");
    expect(mod.htmlHint("<body><p>no heading</p></body>")).toBe("");
    expect(mod.htmlHint("<title>   </title><h1>Fallback</h1>")).toBe("Fallback");
    expect(mod.htmlHint("<TITLE lang=\"en\">Shouted</TITLE >")).toBe("Shouted");
    // `<titlebar>` is not a title; `<h10>` is not an h1.
    expect(mod.htmlHint("<titlebar>x</titlebar><h10>y</h10><h1>Real</h1>")).toBe("Real");
    expect(mod.htmlHint("")).toBe("");
  });

  it("decodes each entity once: &amp;lt; is the text &lt;, never a tag", () => {
    expect(mod.htmlHint("<title>a &amp;lt;b&amp;gt; c</title>")).toBe("a &lt;b&gt; c");
    expect(mod.htmlHint("<title>Tom &amp; Jerry&#39;s &quot;show&quot;&nbsp;&apos;live&apos;</title>"))
      .toBe("Tom & Jerry's \"show\" 'live'");
    // A tag runs to the next `>`, as it always did; a `<` nothing closes is text.
    expect(mod.htmlHint("<h1>Broken <b tag <i>inside</i></h1>")).toBe("Broken inside");
    expect(mod.htmlHint("<h1>1 < 2 and 3</h1>")).toBe("1 < 2 and 3");
  });

  it("answers a pathological page in bounded time", () => {
    // 5 MB of openings with no close. The lazy `[\s\S]*?` this replaced
    // rescanned to the end of the page from every one of them, which is
    // 650 000 × 5 MB of work — minutes, on the request path of every create.
    for (const page of [
      "<title>a".repeat(650_000),
      "<h1>a".repeat(1_000_000),
      "<title".repeat(700_000),
      `<title>${"<".repeat(5_000_000)}</title>`,
      `<h1>${"&amp;".repeat(1_000_000)}`,
    ]) {
      const started = performance.now();
      const hint = mod.htmlHint(page);
      const elapsed = performance.now() - started;
      expect(typeof hint).toBe("string");
      expect(elapsed).toBeLessThan(250);
    }
  });

  it("looks only at the head of the page: a title past the window is no title", () => {
    const late = `<!-- ${"x".repeat(70_000)} --><title>Late</title>`;
    expect(mod.htmlHint(late)).toBe("");
    const early = `<title>Early</title><!-- ${"x".repeat(70_000)} -->`;
    expect(mod.htmlHint(early)).toBe("Early");
  });
});

describe("deployWebapp", () => {
  it("answers before the icon exists; the icon lands when generation finishes", async () => {
    const generation = deferredGeneration();
    mocks.generate.mockReturnValue(generation.promise);
    const { deployWebapp } = await import("@/lib/code-projects");

    await deployWebapp("pomodoro", "<html><head><title>Pomodoro Timer</title></head></html>", {
      name: "Pomodoro",
      color: "#dc2626",
    });

    // The create is complete and registered, and nothing has waited for the picture.
    expect(mocks.register).toHaveBeenCalledWith("pomodoro", "Pomodoro", expect.objectContaining({ color: "#dc2626" }));
    expect(fs.existsSync(iconPath("pomodoro"))).toBe(false);
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    // The page's own title stood in for the description it did not carry.
    expect(mocks.generate.mock.calls[0][0]).toContain("Pomodoro Timer");

    generation.finish(generationOf(PNG));
    await vi.waitFor(() => expect(fs.existsSync(iconPath("pomodoro"))).toBe(true));
    // What landed is the picture brought down to icon size, not the raw bytes.
    const written = fs.readFileSync(iconPath("pomodoro"));
    expect(written.subarray(0, 8).equals(PNG.subarray(0, 8))).toBe(true);
    expect(written.readUInt32BE(16)).toBe(256);
  });

  it("leaves an app that brought its own icon alone", async () => {
    const { deployWebapp } = await import("@/lib/code-projects");
    await deployWebapp("pomodoro", "<html></html>", { name: "Pomodoro", icon: "https://example.test/i.png" });
    // Give a stray fire-and-forget every chance to have started.
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.hasToken).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
