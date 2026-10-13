import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Starts real processes (bash and a stand-in binary): not a 5 s job on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Chrome for Testing — the Playwright build the box's browser prefers — draws a
 * "only for automated testing… Download Chrome" banner over every window the
 * owner sees in the Agent Browser. scripts/launch-browser.sh adds the switch
 * that suppresses it, and only for that build. The detection is run here for
 * real, against stand-in binaries that answer `--version` the way each build does.
 */
const script = fs.readFileSync(path.resolve(__dirname, "../../../scripts/launch-browser.sh"), "utf8");
const detect = script.match(/^is_chrome_for_testing\(\) \{[\s\S]*?^\}$/m)?.[0];
const flags = script.split("\n").filter((l) => /^\s+"?(--|\$\{)/.test(l)).map((l) => l.trim().replace(/ \\$/, ""));

function isCft(versionLine: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cft-"));
  const bin = path.join(dir, "chrome");
  fs.writeFileSync(bin, `#!/bin/sh\necho '${versionLine}'\n`, { mode: 0o755 });
  try {
    execFileSync("bash", ["-c", `${detect}\nis_chrome_for_testing "$1"`, "_", bin]);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("the Chrome for Testing banner", () => {
  it("is suppressed with --test-type=gpu, passed in the launch line", () => {
    expect(script).toMatch(/BUILD_FLAGS=\(--test-type=gpu\)/);
    expect(flags).toContain('"${BUILD_FLAGS[@]}"');
  });

  it("is detected from the build's own version line, and only for that build", () => {
    expect(detect).toBeTruthy();
    expect(isCft("Google Chrome for Testing 153.0.8010.12")).toBe(true);
    expect(isCft("Chromium 146.0.7680.0 snap")).toBe(false);
    expect(isCft("Google Chrome 153.0.8010.12")).toBe(false);
  });
});
