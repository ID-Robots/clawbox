import { describe, expect, it } from "vitest";

import { OFFICIAL_CHANNEL_PLUGINS } from "@/lib/openclaw-channels";
import { CORE_PINNED_PLUGIN_PACKAGES, cliFailureCause, rebaseCorePinnedSpec } from "@/lib/plugin-repair-run";

// TASK-1088: the two pure halves of the shared repair — which spec a row that
// outlived its core should install, and how a refusal is written on the row.

describe("rebaseCorePinnedSpec — a row that outlived the core it was written against", () => {
  it("moves ClawBox's own core-pinned packages onto the core on the box", () => {
    expect(rebaseCorePinnedSpec("@openclaw/codex@2026.9.3", "2026.9.4")).toBe("@openclaw/codex@2026.9.4");
    expect(rebaseCorePinnedSpec("@openclaw/discord@2026.8.1", "2026.9.4")).toBe("@openclaw/discord@2026.9.4");
    expect(rebaseCorePinnedSpec("@openclaw/whatsapp@2026.9.3-2", "2026.9.4")).toBe("@openclaw/whatsapp@2026.9.4");
  });

  it("keeps a republish of the right release exactly as written", () => {
    // npm republishes a release under a build suffix; the boot script may have
    // chosen one on purpose, and it is the same runtime API.
    expect(rebaseCorePinnedSpec("@openclaw/codex@2026.9.4-1", "2026.9.4")).toBe("@openclaw/codex@2026.9.4-1");
    expect(rebaseCorePinnedSpec("@openclaw/codex@2026.9.4", "2026.9.4")).toBe("@openclaw/codex@2026.9.4");
  });

  it("leaves every other spec alone", () => {
    // The core's own unversioned npmSpec for a not-installed row, the ClawHub
    // DeepSeek spec (its own installer re-pins), a package ClawBox does not
    // pin, and an unpinned alias.
    expect(rebaseCorePinnedSpec("@openclaw/byteplus-provider", "2026.9.4")).toBe("@openclaw/byteplus-provider");
    expect(rebaseCorePinnedSpec("clawhub:@openclaw/deepseek-provider@2026.9.3", "2026.9.4"))
      .toBe("clawhub:@openclaw/deepseek-provider@2026.9.3");
    expect(rebaseCorePinnedSpec("@openclaw/byteplus-provider@2026.9.3", "2026.9.4"))
      .toBe("@openclaw/byteplus-provider@2026.9.3");
    expect(rebaseCorePinnedSpec("@openclaw/codex", "2026.9.4")).toBe("@openclaw/codex");
  });

  it("changes nothing when the core's release is not known", () => {
    expect(rebaseCorePinnedSpec("@openclaw/codex@2026.9.3", null)).toBe("@openclaw/codex@2026.9.3");
  });

  it("covers Codex and every channel the Settings panel installs, and nothing else", () => {
    // Not imported by the runner (that module reads the config store at load);
    // held to the same list here instead, so a channel added there cannot be
    // forgotten in the rebase.
    expect([...CORE_PINNED_PLUGIN_PACKAGES].sort()).toEqual(
      ["@openclaw/codex", ...Object.values(OFFICIAL_CHANNEL_PLUGINS)].sort(),
    );
  });
});

describe("cliFailureCause — the core's refusal as one line on the row", () => {
  it("names the verb, its exit code and the last line that reads like a refusal", () => {
    const err = Object.assign(new Error("Command failed"), {
      code: 1,
      stdout: "Resolving @openclaw/codex@2026.9.4…\n",
      stderr: "npm error code E404\nnpm error 404 Not Found\nnpm notice done in 3s",
    });
    expect(cliFailureCause("openclaw plugins install", err))
      .toBe(" openclaw plugins install exited 1: npm error 404 Not Found");
  });

  it("says a kill at the deadline is not the core saying no", () => {
    const err = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null });
    expect(cliFailureCause("openclaw plugins install", err))
      .toMatch(/^ openclaw plugins install was killed at its deadline/);
  });

  it("strips colour codes and control characters, and caps the line", () => {
    const err = Object.assign(new Error("x"), {
      code: 2,
      stderr: `\x1b[31mError:\x1b[0m state schema 17 is newer than this OpenClaw supports\x07 ${"x".repeat(300)}`,
    });
    const cause = cliFailureCause("openclaw plugins enable", err);
    expect(cause).toContain("exited 2: Error: state schema 17 is newer than this OpenClaw supports");
    expect(cause).not.toMatch(/\x1b|\x07/);
    expect(cause.length).toBeLessThanOrEqual(" openclaw plugins enable exited 2: ".length + 160);
    expect(cause.endsWith("…")).toBe(true);
  });

  it("says so when the verb said nothing at all", () => {
    expect(cliFailureCause("openclaw plugins enable", Object.assign(new Error(""), { code: 1, stdout: "", stderr: "" })))
      .toBe(" openclaw plugins enable exited 1 and said nothing.");
  });
});
