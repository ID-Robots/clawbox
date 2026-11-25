import { describe, expect, it } from "vitest";
import { atPinRelease, describeRefresh } from "../../../e2e-install/helpers/openclaw-plugin-migration";

/**
 * Two readers the upgrade spec (e2e-install/90-upgrade-main-to-beta.spec.ts)
 * relies on, pinned here because the spec itself needs a container.
 *
 * `atPinRelease` is install.sh's rule for a managed plugin's version: the pin
 * itself, or a correction pin's base (a trailing numeric -N or +N removed),
 * and nothing looser: a pre-release is not the stable pin.
 *
 * `describeRefresh` reads the plugin refresh's rows out of the openclaw_install
 * journal. A bare row is printed BEFORE the CLI runs, so it is an attempt; the
 * line under it says how it ended. The lines below are written by hand;
 * install-openclaw-fast-path.test.ts also runs it over the lines install.sh
 * prints, so a change to the installer's words fails there.
 */

const at = (messages: string[]) => messages.map((message, i) => ({ atUs: i, message }));

describe("atPinRelease", () => {
  it.each([
    ["2026.11.5", "2026.11.5", true],
    ["2026.11.5", "2026.11.5-2", true],
    ["2026.11.5", "2026.11.5+1", true],
    ["2026.11.5-2", "2026.11.5-2", true],
    ["2026.11.5-beta.1", "2026.11.5", false],
    ["2026.11.5-1", "2026.11.5", false],
    ["2026.11.4", "2026.11.5", false],
    ["2026.11.5", "2026.11.5-beta.1", false],
  ])("plugin %s under pin %s: %s", (version, pin, expected) => {
    expect(atPinRelease(version, pin)).toBe(expected);
  });
});

describe("describeRefresh", () => {
  const head = "  Refreshing OpenClaw plugins to match core 2026.11.5:";

  it("tells a plugin left at the release from one reinstalled, one that failed and one with no outcome", () => {
    expect(describeRefresh(at([
      "  openclaw doctor --fix pass 1 ended with exit 0, 200s into the step",
      head,
      "    - @openclaw/codex@2026.11.5 (already at 2026.11.5)",
      "    - @openclaw/voice-call@2026.11.5",
      "      (not a ClawBox-managed plugin: refreshed without accepting new capabilities)",
      "      updated",
      "    - @openclaw/irc@2026.11.5",
      "      (not a ClawBox-managed plugin: refreshed without accepting new capabilities)",
      "      WARN: not updated (non-fatal; the next update that moves OpenClaw retries it). The OpenClaw plugin install exited 1: no",
      "    - clawbox-email-directives (ClawBox's own plugin: the gateway start installs it from the checkout)",
      "    - @openclaw/signal@2026.11.5",
    ]))).toBe("codex left: @openclaw/codex@2026.11.5 (already at 2026.11.5); 5 rows: 1 already at the release, "
      + "1 reinstalled, 1 failed, 1 with no outcome printed");
  });

  it.each([
    ["reinstalled", ["    - @openclaw/codex@2026.11.5", "      updated"], "codex reinstalled: @openclaw/codex@2026.11.5"],
    ["failed", ["    - @openclaw/codex@2026.11.5", "      WARN: not updated (non-fatal; gateway-pre-start retries it). x"], "codex failed: @openclaw/codex@2026.11.5"],
    ["only attempted", ["    - @openclaw/codex@2026.11.5"], "codex attempted, no outcome printed: @openclaw/codex@2026.11.5"],
  ])("calls codex %s only on the journal's word", (_what, rows, said) => {
    expect(describeRefresh(at([head, ...rows]))).toMatch(new RegExp(`^${said.replace(/[.()]/g, "\\$&")};`));
  });

  it("says when there is no refresh to read", () => {
    expect(describeRefresh(at(["  openclaw doctor --fix pass 1 ended with exit 0"]))).toBe("no refresh rows in the journal");
    expect(describeRefresh(at(["  No external plugins to refresh"]))).toBe("No external plugins to refresh");
  });
});
