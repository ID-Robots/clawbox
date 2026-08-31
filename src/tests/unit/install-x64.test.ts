import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INSTALLER = path.resolve(process.cwd(), "install-x64.sh");
const SOURCE = readFileSync(INSTALLER, "utf8");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function v2SeedProgram(): string {
  const start = SOURCE.indexOf("import json, os, re, secrets, tempfile");
  const end = SOURCE.indexOf("\nPY", start);
  if (start < 0 || end < 0) throw new Error("OpenClaw 2 seed block not found");
  return SOURCE.slice(start, end);
}

describe("install-x64.sh safety contracts", () => {
  it("refuses an unresolved or explicit root service user", () => {
    expect(SOURCE).toContain('[ -z "$CLAWBOX_USER" ] || [ "$CLAWBOX_USER" = "root" ]');
    expect(SOURCE).toContain("could not resolve an unprivileged install user");
  });

  it("refuses to overlay the managed Node symlink onto a real directory", () => {
    expect(SOURCE.match(/\[ -e "\$NODE_DIST_ROOT" \] && \[ ! -L "\$NODE_DIST_ROOT" \]/g)).toHaveLength(2);
  });

  it("downloads NodeSource before executing it and quotes the project directory", () => {
    expect(SOURCE).not.toMatch(/setup_22\.x\s*\|\s*bash/);
    expect(SOURCE).toContain('curl -fsSL -o "$nodesource_script"');
    expect(SOURCE).toContain(String.raw`cd \"$PROJECT_DIR\" && \"$BUN\" install`);
    expect(SOURCE).toContain(String.raw`PLAYWRIGHT_BROWSERS_PATH=\"$PLAYWRIGHT_PATH\" \"$BUN\" x playwright install chromium`);
  });
});

describe.skipIf(!hasPython3)("install-x64.sh OpenClaw 2 token seeding", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clawbox-x64-seed-"));
    configPath = path.join(dir, "openclaw.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seed(token: unknown): unknown {
    writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token } } }));
    execFileSync("python3", ["-c", v2SeedProgram()], {
      env: { ...process.env, OPENCLAW_CONFIG: configPath, CLAWBOX_PORT: "3005" },
    });
    return JSON.parse(readFileSync(configPath, "utf8")).gateway.auth.token;
  }

  it("preserves environment interpolation", () => {
    expect(seed("${GW}")).toBe("${GW}");
  });

  it("preserves canonical SecretRef objects", () => {
    const ref = { source: "file", provider: "default", id: "gateway-token" };
    expect(seed(ref)).toEqual(ref);
  });

  it("rotates the public legacy literal", () => {
    expect(seed("clawbox")).toMatch(/^[a-f0-9]{64}$/);
  });
});
