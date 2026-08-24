import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Regressions caught by the TASK-455 hardware pass on box .71 (2026-08-24).
 *
 * Both bugs here were invisible to every existing test because both scripts
 * behaved correctly in isolation and reported success afterwards. They only
 * appear on a real Jetson, one reboot later:
 *
 *   1. `--disable` ran `systemctl disable` over the display managers.
 *      `systemctl disable gdm.service` removes EVERY symlink pointing at that
 *      unit, and one of them is /etc/systemd/system/display-manager.service —
 *      what graphical.target pulls in via Wants=. `enable` could not recreate
 *      it (a static unit has no [Install]/Alias=), so the desktop never came
 *      back and the API still answered {"enabled":true}.
 *   2. `--balanced` after `--performance` left the EMC rate locked at
 *      3,199 MHz: +1,161 mW at idle (5,992 mW vs 4,831 mW), held until reboot.
 *
 * File assertions, like the sibling desktop-power-wiring suite, and for the
 * same reason: the failure mode is silent success, so there is no thrown error
 * for a behaviour test to catch.
 */

const REPO = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(REPO, ...p), "utf-8");

/**
 * Drop `#` comment lines. Both scripts document the behaviour they replace, so
 * a naive `not.toContain` matches the explanation and fails a correct file.
 */
const codeOnly = (raw: string) =>
  raw.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");

describe("clawbox-desktop-mode.sh — the desktop toggle is reversible", () => {
  const script = read("scripts", "clawbox-desktop-mode.sh");
  const code = codeOnly(script);

  it("only enables/disables display managers whose [Install] symlinks are ours", () => {
    // The whole bug in one line: `systemctl disable gdm.service` removes every
    // symlink that enables the unit, display-manager.service included, so the
    // old unguarded loop destroyed the desktop.
    //
    // A WHITELIST, deliberately. Measured on hardware: with the symlink present
    // `is-enabled gdm.service` is `indirect`; only once the symlink is gone does
    // it become `static`. A blacklist written from a post-damage probe therefore
    // misses the one state that matters — which is how this regressed twice.
    expect(code).toMatch(/enabled\|enabled-runtime\|disabled\)\s*return 0/);
    expect(code).not.toMatch(/indirect\)\s*return 0/);
    // The guard has to be consulted by the loop, not merely defined.
    expect(code).toMatch(/if ! dm_is_installable "\$dm"/);
  });

  it("does not let is-enabled's non-zero exit corrupt the captured state", () => {
    // `systemctl is-enabled` prints the state but exits non-zero for several of
    // them, so `$(... || echo unknown)` captures "static\nunknown" and matches
    // no arm — the exact way the first attempt at this fix still deleted the
    // symlink on hardware.
    expect(code).not.toMatch(/is-enabled "\$1" 2>\/dev\/null \|\| echo/);
    expect(code).toMatch(/state="\$\(systemctl is-enabled "\$1" 2>\/dev\/null\)" \|\| true/);
  });

  it("repairs a deleted display-manager.service alias on --enable", () => {
    // Required for devices already shipped with the bug: set-default alone
    // leaves them booting into a graphical.target with nothing under it.
    expect(code).toContain("repair_display_manager_alias");
    expect(code).toMatch(/--enable\)[\s\S]{0,400}repair_display_manager_alias/);
    expect(code).toContain("/etc/systemd/system/display-manager.service");
  });

  it("only repairs when graphical.target actually pulls the alias in", () => {
    // Never invent the symlink on an image that legitimately has no display
    // manager.
    // Wants, not Requires: graphical.target has Requires=multi-user.target and
    // pulls the display manager in through Wants=. Checking Requires alone made
    // the repair a silent no-op on the box it was written for.
    expect(code).toMatch(/-p Wants -p Requires/);
    expect(code).toMatch(/-p Wants -p Requires[\s\S]{0,200}display-manager/);
  });

  it("resolves the alias to a real unit file rather than another symlink", () => {
    expect(code).toMatch(/FragmentPath/);
  });

  it("reports a missing alias so --check can tell 'off' from 'broken'", () => {
    // `is-enabled` answers "alias"/"static" whether or not the symlink
    // survives, so the pre-fix JSON was byte-identical on a healthy box and a
    // bricked one.
    expect(code).toContain("missing-alias");
  });

  it("still lets the boot target carry the change", () => {
    expect(code).toContain("systemctl set-default");
    // And still refuses to isolate the target out from under a live session.
    expect(code).not.toContain("systemctl isolate");
  });
});

describe("clawbox-power-mode.sh — leaving performance mode gives the clocks back", () => {
  const script = read("scripts", "clawbox-power-mode.sh");
  const code = codeOnly(script);

  it("snapshots the unpinned clock state before pinning", () => {
    expect(code).toContain("jetson_clocks --store");
    expect(code).toMatch(/store_clock_state[\s\S]{0,200}jetson_clocks >/);
  });

  it("never overwrites a pristine snapshot with an already-pinned one", () => {
    // A second --performance must not capture the pinned state as "the state
    // to restore", or --balanced would restore the pinning.
    expect(code).toMatch(/\[ -e "\$CLOCK_SNAPSHOT" \] && return 0/);
  });

  it("restores the clocks when switching back to balanced", () => {
    expect(code).toContain("jetson_clocks --restore");
    expect(code).toMatch(/apply_balanced\(\)[\s\S]{0,300}restore_clock_state/);
  });

  it("restores before nvpmodel so the mode's own caps are the last word", () => {
    const balanced = code.slice(code.indexOf("apply_balanced()"));
    expect(balanced.indexOf("restore_clock_state")).toBeGreaterThanOrEqual(0);
    expect(balanced.indexOf("restore_clock_state")).toBeLessThan(balanced.indexOf("nvpmodel -m"));
  });

  it("falls back to clearing the EMC lock on boxes with no snapshot", () => {
    // Devices already pinned when this build lands have nothing stored.
    expect(code).toContain("mrq_rate_locked");
  });

  it("consumes the snapshot so the next pin captures a fresh one", () => {
    expect(code).toMatch(/rm -f "\$CLOCK_SNAPSHOT"/);
  });

  it("still does not run jetson_clocks in the balanced profile", () => {
    const balanced = code.slice(
      code.indexOf("apply_balanced()"),
      code.indexOf("apply_performance()"),
    );
    // --restore is a restore, not a pin; a bare `jetson_clocks` here would be.
    expect(balanced).not.toMatch(/^\s*jetson_clocks\s*(>|$)/m);
  });
});
