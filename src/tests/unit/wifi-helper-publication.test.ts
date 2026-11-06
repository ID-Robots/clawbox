import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("WiFi helper publication dependency (independent review injection)", () => {
  it.each(["missing", "failed", "stale", "success"])("preserves dependent entrypoints when helper publication is %s", (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "wifi-publication-"));
    try {
      const source = path.join(root, "source");
      const installed = path.join(root, "installed");
      mkdirSync(path.join(source, "scripts"), { recursive: true });
      mkdirSync(path.join(source, "config"));
      mkdirSync(installed);
      const names = ["wifi-radio.sh", "wifi-failover.sh", "start-ap.sh", "stop-ap.sh", "ap-watchdog.sh"];
      for (const name of names) {
        if (name !== "wifi-radio.sh" || mode !== "missing") {
          writeFileSync(path.join(source, "scripts", name), readFileSync(path.join("scripts", name)));
        }
        if (name !== "wifi-radio.sh" || mode === "stale") {
          writeFileSync(path.join(installed, name), `#!/bin/bash\nprintf 'old ${name}\\n'\n`);
        }
      }
      const installer = readFileSync("install.sh", "utf-8");
      const start = installer.indexOf("install_root_libexec() {");
      const body = installer.slice(start, installer.indexOf("\n}", start) + 2);
      // Same extracted function + copy-only failure as correction-review-checks.py.
      // Old executable sentinels keep the test independent of git history/shallow CI.
      const result = spawnSync("bash", ["-c", `set -u
SRC_DIR="$1"; ROOT_LIBEXEC_DIR="$2"; mode="$3"
install() { return 0; }
write_root_exec_manifest() { printf manifest > "$ROOT_LIBEXEC_DIR/manifest"; }
record_provision_failure() { printf 'recorded failure: %s\\n' "$*"; }
install_root_file() {
  if [[ "$1" == */wifi-radio.sh ]] && [ "$mode" != success ]; then return 1; fi
  cp -- "$1" "$2"
}
${body}
install_root_libexec
`, "test", source, installed, mode], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(mode === "success" ? 0 : 1);
      expect(existsSync(path.join(installed, "manifest"))).toBe(true);
      expect(readFileSync(path.join(installed, "ap-watchdog.sh"))).toEqual(readFileSync("scripts/ap-watchdog.sh"));
      if (mode !== "success") expect(result.stdout).toContain("recorded failure: root_libexec");
      for (const name of ["wifi-failover.sh", "start-ap.sh", "stop-ap.sh"]) {
        if (mode === "success") {
          expect(readFileSync(path.join(installed, name))).toEqual(readFileSync(path.join("scripts", name)));
        } else {
          expect(readFileSync(path.join(installed, name), "utf-8")).toBe(`#!/bin/bash\nprintf 'old ${name}\\n'\n`);
          const old = spawnSync("bash", [path.join(installed, name)], { encoding: "utf-8", timeout: 1000 });
          expect(old.status).toBe(0);
          expect(old.stdout).toBe(`old ${name}\n`);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
