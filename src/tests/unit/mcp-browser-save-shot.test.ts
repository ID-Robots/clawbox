/**
 * The screenshot archive of a coding-agent run (saveShot in mcp/tools/browser.ts).
 *
 * Inside a run the capturing tools swap the inline image for a PNG in the
 * run's evidence folder plus a written description. Three promises about
 * that folder are pinned here: it is created the way the runner creates it
 * (0700 — a screenshot shows whatever page the run opened), a name the run
 * already used is stepped over rather than overwritten, and the archive is
 * capped — past the cap the model is told the frame was NOT kept, because a
 * model told "archived" every time would cite evidence the owner cannot find.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "../helpers/env";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock("../../../mcp/lib/api", () => ({
  apiPost,
  apiGet: vi.fn(),
  apiTry: async () => null,
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

/** PNG signature and an IHDR header: what the browser route hands back, base64. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const MAX_SHOTS_PER_RUN = 200;

let base: string;
let evidence: string;
let restore: () => void;

/** A fresh module each time: the shot counter is module state, as it is per run. */
async function browserTools(): Promise<CaptureHarness> {
  vi.resetModules();
  const { registerBrowserTools } = await import("../../../mcp/tools/browser");
  const h = captureRegistrar("openclaw");
  registerBrowserTools(h.reg);
  return h;
}

beforeEach(() => {
  restore = saveEnv("CLAWBOX_RUN_DIR", "CLAWBOX_RUN_ARTIFACTS_DIR");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shots-"));
  evidence = path.join(base, "coding-agent-artifacts", "run-abc12345");
  process.env.CLAWBOX_RUN_DIR = path.join(base, "work");
  process.env.CLAWBOX_RUN_ARTIFACTS_DIR = evidence;
  apiPost.mockImplementation(async (_route: string, body: { action: string }) => {
    if (body.action === "launch") return { sessionId: "browser-1" };
    if (body.action === "screenshot") {
      return { url: "https://example.test/", title: "Example", screenshot: PNG.toString("base64"), description: "A page." };
    }
    return {};
  });
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("saveShot", () => {
  it("archives the described frame into a folder only the box's own user can open", async () => {
    const h = await browserTools();
    const out = await h.call("browser_screenshot");
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("archived to this run's evidence folder as shot-001.png");
    expect(out.text).toContain("What the page shows: A page.");
    // No inline image inside a run: the model cannot read one.
    expect(out.result.content.every((part) => part.type === "text")).toBe(true);

    const file = path.join(evidence, "shot-001.png");
    expect(fs.readFileSync(file).equals(PNG)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    // The lazy mkdir decides the folder's mode when the runner did not get
    // there first — and it must decide the same way ensureArtifactsDir does.
    expect(fs.statSync(evidence).mode & 0o777).toBe(0o700);
  });

  it("steps over a name the run already used instead of overwriting it", async () => {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, "shot-001.png"), "the run's own file");
    const h = await browserTools();
    const out = await h.call("browser_screenshot");
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("as shot-002.png");
    expect(fs.readFileSync(path.join(evidence, "shot-001.png"), "utf8")).toBe("the run's own file");
    expect(fs.readFileSync(path.join(evidence, "shot-002.png")).equals(PNG)).toBe(true);
  });

  it("stops archiving at the cap, still describes the page, and says the frame was not kept", async () => {
    fs.mkdirSync(evidence, { recursive: true });
    for (let i = 1; i <= MAX_SHOTS_PER_RUN; i++) {
      fs.writeFileSync(path.join(evidence, `shot-${String(i).padStart(3, "0")}.png`), "kept");
    }
    const h = await browserTools();
    const out = await h.call("browser_screenshot");
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).not.toContain("archived to");
    expect(out.text).toContain("Screenshot not archived");
    expect(out.text).toContain("What the page shows: A page.");
    expect(fs.readdirSync(evidence)).toHaveLength(MAX_SHOTS_PER_RUN);
  });

  it("archives nothing outside a run", async () => {
    delete process.env.CLAWBOX_RUN_DIR;
    delete process.env.CLAWBOX_RUN_ARTIFACTS_DIR;
    const h = await browserTools();
    const out = await h.call("browser_screenshot");
    expect(out.isError).toBe(false);
    if (out.isError) return;
    // The assistant's own server: the picture goes inline, and no folder is made.
    expect(out.result.content.some((part) => part.type === "image")).toBe(true);
    expect(out.text).not.toContain("archived");
    expect(fs.existsSync(evidence)).toBe(false);
  });
});
