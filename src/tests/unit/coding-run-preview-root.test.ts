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
