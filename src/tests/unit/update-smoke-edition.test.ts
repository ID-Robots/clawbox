import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
const start = installer.indexOf("step_update_smoke() {");
const smoke = installer.slice(start, installer.indexOf("\n}", start) + 2);
const editionHelper = installer.match(/^has_openclaw_harness\(\).*$/m)![0];

function runSmoke(edition: string, healthy: boolean) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-smoke-edition-"));
  try {
    if (healthy) {
      fs.mkdirSync(path.join(home, ".openclaw"));
      fs.writeFileSync(path.join(home, ".openclaw/openclaw.json"), JSON.stringify({
        gateway: { auth: { token: "fixture-token-not-a-real-secret-1234567890" } },
      }));
    }
    return execFileSync("bash", ["-c", [
      "set -euo pipefail",
      editionHelper,
      // No live network or device state: only the actual smoke's decisions run.
      'curl() { echo GATEWAY_PROBED >&2; printf "%s" "$FIXTURE_HTTP"; }',
      'as_clawbox() { echo CONFIG_PROBED >&2; "$@"; }',
      smoke,
      'if step_update_smoke; then echo RESULT=0; else echo RESULT=$?; fi',
    ].join("\n")], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, CLAWBOX_EDITION: edition, CLAWBOX_HOME: home,
        FIXTURE_HTTP: healthy ? "200" : "000", CLAWBOX_SMOKE_TELEGRAM_CHAT_ID: "" },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("post-update smoke checks the installed harness", () => {
  it("does not report a broken OpenClaw gateway on a Hermes-only box", () => {
    const output = runSmoke("hermes", false);
    expect(output).toContain("RESULT=0");
    expect(output).toContain("[skip]");
    expect(output).not.toContain("[WARN]");
  });

  it.each(["openclaw", "dual"])("still reports a broken gateway on %s", edition => {
    const output = runSmoke(edition, false);
    expect(output).toContain("RESULT=1");
    expect(output).toContain("gateway not reachable");
    expect(output).toContain("gateway auth token is weak/missing");
  });

  it.each(["openclaw", "dual"])("accepts a healthy %s box with no Telegram bot", edition => {
    const output = runSmoke(edition, true);
    expect(output).toContain("RESULT=0");
    expect(output).toContain("gateway reachable");
    expect(output).not.toContain("[WARN]");
  });
});
