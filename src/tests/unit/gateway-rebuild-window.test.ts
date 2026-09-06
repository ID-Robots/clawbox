import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TASK-728 — a gateway (re)start must not pull the dashboard up mid-rebuild.
 *
 * `config/clawbox-gateway.service` carried `Wants=clawbox-setup.service`, so
 * every gateway start started the web-server unit that `install.sh`'s
 * `do_rebuild` had just stopped. Measured in e2e-install run 33971129750: the
 * dashboard came back FOUR SECONDS after the stop, while `bun install` was
 * still running, because the gateway was crash-looping on plugin consent and
 * restarting every five seconds against a multi-minute build.
 *
 * That one line broke three things at once:
 *
 *  1. The updater resumed on the PRE-UPDATE build — the remaining steps ran
 *     from the old tree and `post_update` died on a polkit denial
 *     ("Interactive authentication required") it could not have hit on the new
 *     one. PR #672's guard covers only the window after the park, not this.
 *  2. `free_memory_for_build`'s memory hold was void: the gateway reaches
 *     ollama and llama.cpp through the web server's own proxy, so a model could
 *     be pulled in behind the build — the OOM that produced TASK-709.
 *  3. It is what pulled the web server onto the PARKED build, plus the
 *     crash-loop cost the #672 guard now carries (clawbox-setup restarting
 *     every ~3.5 s for the length of the build, each start fire-and-forgetting
 *     scripts/register-mcp.sh, which runs `hermes plugins doctor` on the
 *     hermes/dual SKUs).
 *
 * Removing the window beats guarding it — but the ORDERING the `Wants=` was
 * mixed up with is real and has to survive, so the invariant it rested on is
 * pinned here too.
 */

const REPO = process.cwd();
const CONFIG_DIR = path.join(REPO, "config");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf-8");

const GATEWAY_UNIT = read("config/clawbox-gateway.service");
const SETUP_UNIT = read("config/clawbox-setup.service");
const INSTALL_SH = read("install.sh");

/** The value of a unit-file directive, with comments and blank lines gone. */
function directive(unit: string, key: string): string[] {
  return unit
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .filter((l) => l.startsWith(`${key}=`))
    .map((l) => l.slice(key.length + 1).trim());
}

describe("the gateway is ordered after the web server without starting it", () => {
  it("still orders itself after clawbox-setup", () => {
    // The race this ordering exists for is real and unrelated to the defect:
    // memory search reaches its embedder through the web server's local-AI
    // proxy, and OpenClaw's embedding client gives a refused connection three
    // attempts inside two seconds before answering keyword-only and leaving the
    // index dirty.
    expect(directive(GATEWAY_UNIT, "After").join(" ")).toContain("clawbox-setup.service");
  });

  it("does not pull it up", () => {
    // Wants, Requires and BindsTo all START the other unit. Any of them here
    // re-opens the rebuild window.
    for (const key of ["Wants", "Requires", "BindsTo", "Requisite", "PartOf"]) {
      expect(
        directive(GATEWAY_UNIT, key).join(" "),
        `${key}= must not name clawbox-setup.service — it would start the unit do_rebuild stopped`,
      ).not.toContain("clawbox-setup");
    }
  });

  it("keeps network-online, which is a different question", () => {
    // The line carried two things; only one of them was the defect.
    expect(directive(GATEWAY_UNIT, "Wants").join(" ")).toContain("network-online.target");
  });

  it("no unit ships a start dependency on the web server", () => {
    // The house style already, for the same web server: clawbox-tunnel,
    // clawbox-heartbeat and clawbox-hermes-dashboard-proxy all order themselves
    // After= it and none of them Wants= it. Asserted over the whole directory so
    // a unit added later cannot quietly re-introduce the pull.
    const offenders = readdirSync(CONFIG_DIR)
      .filter((f) => f.endsWith(".service") || f.endsWith(".timer"))
      .filter((f) => f !== "clawbox-setup.service")
      .filter((f) => {
        const unit = readFileSync(path.join(CONFIG_DIR, f), "utf-8");
        return ["Wants", "Requires", "BindsTo", "Requisite"].some((k) =>
          directive(unit, k).join(" ").includes("clawbox-setup"),
        );
      });
    expect(offenders).toEqual([]);
  });
});

describe("the ordering the removed Wants= was resting on", () => {
  /**
   * `After=` only orders units that are already IN the transaction. Dropping the
   * `Wants=` is safe precisely because clawbox-setup.service is in every boot
   * transaction on its own — and that is the invariant this PR now depends on,
   * so it is pinned rather than assumed.
   */
  it("clawbox-setup is pulled into the boot transaction by its own Install section", () => {
    expect(SETUP_UNIT).toMatch(/\[Install\]/);
    expect(directive(SETUP_UNIT, "WantedBy").join(" ")).toContain("multi-user.target");
  });

  it("and install.sh enables it rather than skipping it", () => {
    // The enable loop skips several units by name (browser, embed, tunnel, the
    // timer-driven one-shots). clawbox-setup must not join that list, or the
    // gateway would be ordered after a unit nothing starts.
    //
    // Anchored on the loop that ENABLES, not the earlier one that copies: there
    // are two `for svc in "${ALL_SERVICES[@]}"` loops, and slicing from the
    // first would drag 38 unrelated lines into a negative assertion — which
    // would then fail the day anyone wrote a comment naming this unit in them.
    const enableLoopStart = INSTALL_SH.indexOf(
      'for svc in "${ALL_SERVICES[@]}"; do',
      INSTALL_SH.indexOf('systemctl daemon-reload'),
    );
    const loop = INSTALL_SH.slice(
      enableLoopStart,
      INSTALL_SH.indexOf("systemctl enable --now clawbox-heartbeat.timer"),
    );
    expect(enableLoopStart).toBeGreaterThan(-1);
    expect(loop).toContain('systemctl enable "$svc"');
    // Only the SKIP lines are the question, so only they are read.
    const skipped = loop
      .split("\n")
      .filter((line) => line.includes("&& continue"))
      .join("\n");
    expect(skipped).not.toContain("clawbox-setup");
    expect(INSTALL_SH).toMatch(/EXPECTED_ACTIVE_SERVICES=\([^)]*clawbox-setup\.service/);
  });
});

describe("every rebuild-ending restart clears a latched start limit", () => {
  /**
   * A latched StartLimitBurst turns the restart that ENDS a rebuild into a
   * failure over a build that is fine. With no start dependency left nothing
   * starts clawbox-setup DURING a rebuild any more, so it can no longer
   * crash-loop on the missing standalone entry from that source — but an
   * operator, or the sudoers `systemctl restart clawbox-setup` grant, can still
   * land inside the window and latch the unit's inherited 5-in-10 s limit. Two
   * of the three restarts got `reset-failed` in 5e268479; the test-mode branch
   * of step_rebuild_reboot — the one e2e-install takes, and bare under
   * `set -euo pipefail` — did not.
   */
  function shellFn(name: string): string {
    const start = INSTALL_SH.indexOf(`${name}() {`);
    expect(start, `${name} not found in install.sh`).toBeGreaterThan(-1);
    const end = INSTALL_SH.indexOf("\n}", start);
    return INSTALL_SH.slice(start, end);
  }

  it.each(["step_rebuild", "step_rebuild_reboot", "restore_previous_build"])(
    "%s resets the limit before restarting",
    (fn) => {
      // restore_previous_build is the THIRD rebuild-ending restart — the
      // rollback path — and it got its `reset-failed` in 5e268479 with the
      // others. Left out of this list, a regression there would pass.
      const body = shellFn(fn);
      const reset = body.indexOf("systemctl reset-failed clawbox-setup.service");
      const restart = body.indexOf("systemctl restart clawbox-setup.service");
      expect(reset, `${fn} restarts clawbox-setup without clearing a latched start limit`).toBeGreaterThan(-1);
      expect(restart).toBeGreaterThan(reset);
    },
  );
});
