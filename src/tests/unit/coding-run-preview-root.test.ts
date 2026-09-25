/**
 * The coding-agent run page builds its terminal command in the BROWSER, so
 * `livePreviewCommand` reads the appliance root from the build-time inlined
 * NEXT_PUBLIC_CLAWBOX_ROOT rather than a runtime process.env.
 *
 * The regression this guards: the root was hardcoded to /home/clawbox/clawbox,
 * so on any box whose app lives elsewhere (a dev machine) the Live terminal
 * spawned a path that does not exist and died with "Permission denied" while
 * the run itself was perfectly healthy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = process.env.NEXT_PUBLIC_CLAWBOX_ROOT;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_CLAWBOX_ROOT;
  else process.env.NEXT_PUBLIC_CLAWBOX_ROOT = ORIGINAL;
  vi.resetModules();
});

/** Load the module fresh so its module-level root constant is re-evaluated. */
async function load() {
  vi.resetModules();
  return await import("../../lib/coding-run-preview");
}

describe("livePreviewCommand root", () => {
  it("uses the inlined NEXT_PUBLIC_CLAWBOX_ROOT when the app is not at the default path", async () => {
    process.env.NEXT_PUBLIC_CLAWBOX_ROOT = "/home/nexus0/clawbox";
    const { livePreviewCommand } = await load();
    const cmd = livePreviewCommand({
      transcriptPath: "/tmp/run.jsonl",
      sessionId: null,
      directory: null,
      live: true,
    });
    expect(cmd).toBe("/home/nexus0/clawbox/scripts/coding-run-preview '/tmp/run.jsonl'");
    expect(cmd).not.toContain("/home/clawbox/clawbox");
  });

  it("falls back to the shipped appliance path when the variable is unset", async () => {
    delete process.env.NEXT_PUBLIC_CLAWBOX_ROOT;
    const { livePreviewCommand } = await load();
    const cmd = livePreviewCommand({
      transcriptPath: "/tmp/run.jsonl",
      sessionId: null,
      directory: null,
      live: true,
    });
    expect(cmd).toContain("/home/clawbox/clawbox/scripts/coding-run-preview");
  });

  it("still resumes a settled run by session id, without needing the root", async () => {
    delete process.env.NEXT_PUBLIC_CLAWBOX_ROOT;
    const { livePreviewCommand } = await load();
    const cmd = livePreviewCommand({
      transcriptPath: null,
      sessionId: "61400ab6-0da9-4feb-8ad5-b547239c1367",
      directory: "/home/nexus0/Projects/x",
      live: false,
    });
    expect(cmd).toBe("cd '/home/nexus0/Projects/x' && claude-ds --resume '61400ab6-0da9-4feb-8ad5-b547239c1367'");
  });
});

describe("resuming a settled run on its own provider", () => {
  const settled = { transcriptPath: null, sessionId: "1dd8db8b-5c1e-4f0a-9d2b-3e4f5a6b7c8d", directory: "/home/nexus0/Projects/x", live: false };

  it("tells the wrapper an Anthropic run is one, so it opens ~/.claude where the session is", async () => {
    const { livePreviewCommand } = await load();
    expect(livePreviewCommand({ ...settled, provider: "anthropic" }))
      .toBe("cd '/home/nexus0/Projects/x' && CLAUDE_DS_PROVIDER=anthropic claude-ds --resume '1dd8db8b-5c1e-4f0a-9d2b-3e4f5a6b7c8d'");
  });

  it("leaves a ClawBox AI run, or one whose record names no provider, on the wrapper's default", async () => {
    const { livePreviewCommand } = await load();
    const plain = "cd '/home/nexus0/Projects/x' && claude-ds --resume '1dd8db8b-5c1e-4f0a-9d2b-3e4f5a6b7c8d'";
    expect(livePreviewCommand({ ...settled, provider: "clawbox-ai" })).toBe(plain);
    expect(livePreviewCommand({ ...settled, provider: null })).toBe(plain);
    expect(livePreviewCommand(settled)).toBe(plain);
  });

  it("never types the provider field itself into the shell", async () => {
    const { livePreviewCommand } = await load();
    const cmd = livePreviewCommand({ ...settled, provider: "anthropic; rm -rf ~" });
    expect(cmd).not.toContain("rm -rf");
    expect(cmd).not.toContain("CLAUDE_DS_PROVIDER");
  });

  it("tails a live run's transcript whatever its provider — the path already names the folder", async () => {
    delete process.env.NEXT_PUBLIC_CLAWBOX_ROOT;
    const { livePreviewCommand } = await load();
    expect(livePreviewCommand({ ...settled, transcriptPath: "/home/nexus0/.claude/projects/-x/s.jsonl", live: true, provider: "anthropic" }))
      .toBe("/home/clawbox/clawbox/scripts/coding-run-preview '/home/nexus0/.claude/projects/-x/s.jsonl'");
  });
});
