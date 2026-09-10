/**
 * What the box is actually RUNNING after install.sh, checked on the container
 * install.sh provisioned. TASK-788.
 *
 * This is the check that makes the Node 22 → 24 migration provable in CI rather
 * than merely attempted. The e2e-install image is deliberately left on Node 22
 * (`e2e-install/Dockerfile`, `setup_22.x`) so install.sh has to perform the major
 * upgrade here the way it does on every field unit — and a job that only EXECUTES
 * that transaction proves nothing: a lost apt lock, a rewritten channel, or a
 * host apt cannot move leaves the step reporting its own success while the box
 * keeps the runtime the pinned core refuses.
 *
 * So both halves are asserted against the container's real filesystem:
 *
 *   * the Node on PATH is the major the pinned core's `engines.node` demands, and
 *     at or above its floor — not merely "not 22";
 *   * the core that is installed is the pinned one, read back from the CLI that
 *     has to run under that Node to answer at all. Its exit status is the second
 *     assertion: under a Node it refuses, `openclaw --version` prints a
 *     requirement banner and exits 1, so a zero exit with the right version is
 *     the runtime and the pin proved together.
 *
 * Read-only, and placed at NN=07 — after the sudoers audit, before the wizard
 * mutates anything.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dockerExec } from "./helpers/container";

/** The version the repo pins, read where install.sh reads it. */
const PINNED_CORE = readFileSync(
  path.join(__dirname, "..", "config", "openclaw-target.txt"),
  "utf-8",
).trim();

/**
 * The engine range that pin declares, as a floor per major.
 *
 * Kept beside the pin rather than hard-coded: the assertion is "the box is on a
 * Node this core accepts", and when the pin moves again that is still the
 * question. A major absent from this table is a pin whose engines changed
 * without this spec being looked at, which the last case fails on deliberately.
 */
const ENGINE_FLOORS: Record<string, string> = { "24": "24.16.0", "26": "26.1.0" };

function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

test.describe("the runtime and the core the install actually left behind", () => {
  test("runs a Node the pinned core accepts, not the one the image started on", async () => {
    // `node -v`, as the units see it: /usr/bin/node is what clawbox-setup.service
    // and the auth mirror execute, and what `npm install -g` ran the core under.
    const raw = (await dockerExec(["/usr/bin/node", "-v"])).trim();
    expect(raw, `node -v answered ${JSON.stringify(raw)}`).toMatch(/^v\d+\.\d+\.\d+/);
    const version = raw.replace(/^v/, "");
    const major = version.split(".")[0];

    // The image ships Node 22 on purpose; install.sh must have moved it.
    expect(major, `still on the image's Node (${raw})`).not.toBe("22");
    const floor = ENGINE_FLOORS[major];
    expect(
      floor,
      `Node ${raw} is a major the pinned core ${PINNED_CORE} does not accept`,
    ).toBeDefined();
    expect(atLeast(version, floor), `Node ${raw} is below the ${floor} floor`).toBe(true);
  });

  test("has the pinned core installed, and it runs under that Node", async () => {
    // Not `|| true`: the exit status IS the runtime check. A core on a Node it
    // refuses prints "Node.js >=24.16.0 <25, or >=26.1.0 is required (current: …)"
    // and exits 1, which dockerExec surfaces as a failure rather than an empty
    // string that a `toContain` could read past.
    const out = (await dockerExec(
      ["bash", "-lc", "/home/clawbox/.npm-global/bin/openclaw --version"],
      { user: "clawbox", timeoutMs: 120_000 },
    )).trim();

    // The WHOLE version token, not a substring: `toContain("2026.9.3")` is also
    // satisfied by `2026.9.30`, and a pin is the one place a prefix match must
    // not pass. Taken the way install.sh itself takes it — the field that looks
    // like a version out of `OpenClaw <version> (<hash>)` — so a prerelease pin
    // (`2026.5.24-beta.2`, a documented QA override) is compared whole rather
    // than clipped by a three-number regex.
    const reported = out.split(/\s+/).find((field) => /^\d+\.\d+\.\d+/.test(field)) ?? "";
    expect(reported, `openclaw --version answered ${JSON.stringify(out)}`).toBe(PINNED_CORE);
    // …and nothing of the refusal, in case a future CLI reports it on stdout
    // with a zero exit.
    expect(out).not.toContain("is required (current:");
  });

  test("records that same core as the build's pin", async () => {
    // The pin file as it sits on the box — the value `install.sh --step
    // openclaw_install` reads on the next run and the UI's "Latest" column
    // reports. A box whose checkout says one thing and whose runtime says
    // another is the drift this whole task exists to avoid, and on the upgrade
    // spec further down this file set the checkout is rewritten by a real
    // `git reset --hard`, so asking the box rather than the repo is the point.
    const onBox = (await dockerExec(
      ["cat", "/home/clawbox/clawbox/config/openclaw-target.txt"],
    )).trim();
    expect(onBox).toBe(PINNED_CORE);
  });
});
