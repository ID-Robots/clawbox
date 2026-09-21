import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Installing a skill must not bounce the gateway.
//
// OpenClaw watches its own skill roots — `skills.load.watch` defaults to true
// and `<workspace>/skills` is one of the watched roots — so a skill written
// there is picked up by the running gateway on its own. The gateway's
// `skills.status` handler re-reads the workspace per call, so the App Store
// sees a new skill straight away.
//
// What the install path used to do instead was send SIGUSR1 to the gateway's
// MainPID. SIGUSR1 does not mean "reload" to OpenClaw, it means "restart", and
// OpenClaw serves a restart under a detected supervisor by exiting 0 and
// letting the supervisor start it again. These tests pin the pieces that keep
// that signal from coming back.

const REPO = process.cwd();
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf-8");

const OPENCLAW_CONFIG = read("src/lib/openclaw-config.ts");
const INSTALL_ROUTE = read("src/app/setup-api/apps/install/route.ts");
const UNINSTALL_ROUTE = read("src/app/setup-api/apps/uninstall/route.ts");
const PRE_START = read("scripts/gateway-pre-start.sh");

describe("skill install does not restart the gateway", () => {
  it("ships no reloadGateway helper to call", () => {
    expect(OPENCLAW_CONFIG).not.toMatch(/^export async function reloadGateway/m);
  });

  it("never signals the gateway from the skill library", () => {
    // restartGateway() still exists and is still correct — it goes through
    // `systemctl restart`, which systemd completes. Only the signal is banned,
    // so match the signalling argument rather than every `process.kill` call:
    // config-lock recovery legitimately probes owner liveness with signal 0.
    expect(OPENCLAW_CONFIG).not.toContain('"SIGUSR1"');
    expect(OPENCLAW_CONFIG).not.toMatch(/process\.kill\([^;\n]*SIGUSR1/);
  });

  it("installs and uninstalls skills without reloading anything", () => {
    for (const route of [INSTALL_ROUTE, UNINSTALL_ROUTE]) {
      expect(route).not.toContain("reloadGateway");
      expect(route).not.toContain("SIGUSR1");
    }
  });

  it("still writes skills where OpenClaw watches for them", () => {
    // `openclawSkillRoot()` resolves the workspace and appends `skills` — the
    // directory OpenClaw's watcher and `openclaw skills install` both target,
    // and the SAME expression the uninstall route deletes under. Two spellings
    // of one path is how a wrong-directory delete comes back (TASK-551).
    expect(INSTALL_ROUTE).toContain("openclawSkillRoot()");
    expect(INSTALL_ROUTE).toContain("fs.mkdir(skillRoot");
  });
});

describe("the skills watch root exists before the gateway starts", () => {
  it("pre-start creates <workspace>/skills", () => {
    // OpenClaw hands each configured skill root to its file watcher once, when
    // a turn first builds the skills snapshot. A root that does not exist at
    // that moment is never watched and is not re-attached later, because the
    // watch target list has not changed. Creating it up front means the first
    // skill a customer installs lands in an already-watched directory.
    expect(PRE_START).toMatch(/mkdir -p "\$CLAWBOX_WORKSPACE\/skills"/);
  });

  it("creates it from the same workspace the API resolves", () => {
    // Both sides must agree, or the watched root and the install target drift.
    expect(PRE_START).toContain("CLAWBOX_WORKSPACE=");
    expect(OPENCLAW_CONFIG).toContain("agents?.defaults?.workspace");
  });
});
