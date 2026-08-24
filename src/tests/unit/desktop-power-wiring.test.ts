import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * The system-side wiring for TASK-455: the units, the sudoers grants and the
 * install/update steps that make the two toggles reachable and keep them
 * reversible.
 *
 * These are file assertions rather than behaviour tests because the failure
 * mode they guard is silent. A missing sudoers line doesn't crash — it hangs on
 * a password prompt no one can answer. A `WantedBy` on the browser unit doesn't
 * error — it just costs a gigabyte on every boot. Neither shows up in a route
 * test.
 */

const REPO = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(REPO, ...p), "utf-8");

/**
 * Drop `#` comment lines.
 *
 * Every file here documents the behaviour it is REPLACING — the unit says why
 * it no longer runs jetson_clocks, the script says why it doesn't isolate the
 * target — so a naive `not.toContain` matches the explanation and fails on a
 * correct file. Assert against the executable lines only.
 */
const codeOnly = (raw: string) =>
  raw.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");

const LIBEXEC = "/usr/local/libexec/clawbox";

describe("clawbox-performance.service", () => {
  const unit = read("config", "clawbox-performance.service");

  it("delegates to the root-owned power script instead of pinning inline", () => {
    expect(unit).toContain(`ExecStart=${LIBEXEC}/clawbox-power-mode.sh --apply`);
    expect(unit).toContain(`ExecStop=${LIBEXEC}/clawbox-power-mode.sh --restore`);
  });

  it("no longer runs jetson_clocks unconditionally at boot", () => {
    // The finding: MAXN_SUPER + jetson_clocks at every boot left the board at
    // 1,728 MHz x6 / 1,020 MHz GPU under 4% load — 7.21 W and ~58 C at idle.
    expect(codeOnly(unit)).not.toContain("jetson_clocks");
    expect(codeOnly(unit)).not.toMatch(/ExecStart=.*nvpmodel/);
  });
});

describe("the power script's default", () => {
  const script = read("scripts", "clawbox-power-mode.sh");

  it("is balanced, so an unconfigured or corrupted state file stays cool", () => {
    expect(script).toContain('DEFAULT_MODE="balanced"');
  });

  it("persists the choice root-owned, next to the edition lock", () => {
    // /home/clawbox/clawbox is clawbox-writable and this script runs as root,
    // so the file it acts on at boot must live somewhere clawbox cannot write.
    expect(script).toContain('STATE_DIR="${CLAWBOX_STATE_DIR:-/etc/clawbox}"');
  });

  it("re-enables the cpuidle states jetson_clocks turns off", () => {
    // nvpmodel alone does not put them back, so without this the cores never
    // reach C7 again and the idle-power win never lands.
    expect(script).toContain("enable_cpuidle");
    expect(script).toContain("cpuidle/state*/disable");
  });
});

describe("the desktop script", () => {
  const script = read("scripts", "clawbox-desktop-mode.sh");

  it("switches the boot target rather than isolating it under a live session", () => {
    expect(script).toContain("systemctl set-default");
    expect(codeOnly(script)).not.toContain("systemctl isolate");
  });

  it("uninstalls nothing — headless is a setting, not a separate image", () => {
    // Krasi's ruling, 2026-08-24: do not strip GNOME/gdm/snapd from the image.
    for (const forbidden of ["apt-get remove", "apt remove", "apt-get purge", "snap remove"]) {
      expect(codeOnly(script), forbidden).not.toContain(forbidden);
    }
  });

  it("stops the on-demand browser when the desktop goes away", () => {
    // Without a desktop there is no X display for Chromium to draw on, and
    // leaving ~1 GB resident would defeat the point of the toggle.
    expect(script).toContain("systemctl stop clawbox-browser.service");
  });
});

describe("sudoers grants", () => {
  const sudoers = read("config", "clawbox-sudoers");

  it("cover exactly the four mutating invocations", () => {
    const granted = sudoers
      .split("\n")
      .filter((l) => l.startsWith("clawbox ") && l.includes(LIBEXEC))
      .map((l) => l.slice(l.indexOf(LIBEXEC)).trim());
    expect(granted.sort()).toEqual([
      `${LIBEXEC}/clawbox-desktop-mode.sh --disable`,
      `${LIBEXEC}/clawbox-desktop-mode.sh --enable`,
      `${LIBEXEC}/clawbox-power-mode.sh --balanced`,
      `${LIBEXEC}/clawbox-power-mode.sh --performance`,
    ]);
  });

  it("grant no wildcard on either script", () => {
    // A trailing `*` would hand over every mode these scripts ever grow.
    for (const line of sudoers.split("\n")) {
      if (!line.startsWith("clawbox ") || !line.includes(LIBEXEC)) continue;
      expect(line, line).not.toContain("*");
    }
  });

  it("never point at the clawbox-writable copies in the project tree", () => {
    expect(sudoers).not.toContain("/home/clawbox/clawbox/scripts/");
  });
});

describe("install.sh", () => {
  const install = read("install.sh");

  it("installs every root-invoked script root-owned outside the clawbox tree", () => {
    for (const script of [
      "optimize-ollama.sh",
      "clawbox-desktop-mode.sh",
      "clawbox-power-mode.sh",
      "clawbox-resource-limits.sh",
    ]) {
      expect(install, script).toContain(script);
    }
    expect(install).toContain('install -o root -g root -m 0755 "$PROJECT_DIR/scripts/$src"');
  });

  it("re-applies the memory guards on update, not only on a fresh install", () => {
    const postUpdate = install.slice(install.indexOf("step_post_update() {"));
    expect(postUpdate.slice(0, postUpdate.indexOf("\n}\n"))).toContain("step_resource_limits");
  });

  it("never flips the desktop toggle on install or update", () => {
    // The owner's choice must survive a `git pull`. step_desktop_mode exists so
    // an operator can inspect the state, and reports only.
    const step = install.slice(install.indexOf("step_desktop_mode() {"));
    const body = step.slice(0, step.indexOf("\n}\n"));
    expect(body).toContain("--check");
    expect(body).not.toContain("--enable");
    expect(body).not.toContain("--disable");
    expect(body).not.toContain("set-default");
    const postUpdate = install.slice(install.indexOf("step_post_update() {"));
    expect(codeOnly(postUpdate.slice(0, postUpdate.indexOf("\n}\n"))))
      .not.toContain("step_desktop_mode");
  });

  it("registers the new steps for --step dispatch", () => {
    const list = install.slice(install.indexOf("DISPATCH_STEPS=("));
    const body = list.slice(0, list.indexOf(")"));
    expect(body).toContain("resource_limits");
    expect(body).toContain("desktop_mode");
  });

  it("has a function for every dispatchable step", () => {
    const list = install.slice(install.indexOf("DISPATCH_STEPS=("));
    const body = list.slice(0, list.indexOf(")"));
    const steps = body
      .split("\n")
      .slice(1)
      .flatMap((l) => l.replace(/#.*/, "").trim().split(/\s+/))
      .filter(Boolean);
    expect(steps.length).toBeGreaterThan(20);
    for (const step of steps) {
      expect(install, `step_${step} is dispatchable but not defined`)
        .toContain(`step_${step}()`);
    }
  });
});

describe("optimize-ollama.sh", () => {
  const script = read("scripts", "optimize-ollama.sh");

  it("no longer hardcodes the serialising NUM_PARALLEL=1", () => {
    expect(script).not.toContain("OLLAMA_NUM_PARALLEL=1");
    expect(script).toContain("OLLAMA_NUM_PARALLEL=${NUM_PARALLEL}");
  });

  it("pins a context length so the cost of the extra slot is predictable", () => {
    expect(script).toContain("OLLAMA_CONTEXT_LENGTH=${CONTEXT_LENGTH}");
  });

  it("parses the limits file rather than sourcing it", () => {
    // The fallback copy lives in the clawbox-writable tree while this runs as
    // root, so `source` would be a one-step local root.
    expect(script).not.toMatch(/^\s*(\.|source)\s+/m);
  });
});

describe("the browser stays on-demand", () => {
  const unit = read("config", "clawbox-browser.service");

  it("has no [Install] section at all, so it can never be enabled at boot", () => {
    expect(unit).not.toContain("[Install]");
    expect(unit).not.toContain("WantedBy=");
  });

  it("accounts its memory so the cgroup guard can bite", () => {
    expect(unit).toContain("MemoryAccounting=yes");
  });
});
