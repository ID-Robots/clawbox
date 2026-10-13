import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VNC_RESOLUTION,
  VNC_RESOLUTIONS,
  isVncResolution,
  normalizeVncResolution,
  vncResolutionEnvPath,
  writeVncResolutionEnv,
} from "@/lib/vnc-resolution";
import { validatePreference } from "@/lib/preference-schema";

const SCRIPT = fs.readFileSync(path.join(process.cwd(), "scripts", "start-vnc.sh"), "utf8");

/** Pull one shell function (name() { ... }) out of start-vnc.sh. */
function shellFunction(name: string): string {
  const match = SCRIPT.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m"));
  if (!match) throw new Error(`function ${name} not found in start-vnc.sh`);
  return match[0];
}

function runShell(body: string): string {
  const prelude = SCRIPT.match(/^VNC_RESOLUTIONS=.*$/m)![0] + "\n"
    + SCRIPT.match(/^DEFAULT_VNC_RESOLUTION=.*$/m)![0] + "\n"
    + shellFunction("read_vnc_resolution") + "\n"
    + shellFunction("xvfb_action") + "\n";
  const r = spawnSync("bash", ["-c", prelude + body], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

describe("VNC resolution validation", () => {
  it("offers exactly the three presets with 720p as default", () => {
    expect([...VNC_RESOLUTIONS]).toEqual(["1280x720", "1600x900", "1920x1080"]);
    expect(DEFAULT_VNC_RESOLUTION).toBe("1280x720");
  });

  it("accepts presets and falls back to the default for anything else", () => {
    for (const r of VNC_RESOLUTIONS) {
      expect(isVncResolution(r)).toBe(true);
      expect(normalizeVncResolution(r)).toBe(r);
    }
    for (const bad of ["3840x2160", "1280x720x24", "", " 1600x900", "1600x900; rm -rf /", null, 1080, {}]) {
      expect(isVncResolution(bad)).toBe(false);
      expect(normalizeVncResolution(bad)).toBe("1280x720");
    }
  });

  it("is a closed preference domain in the shared preference schema", () => {
    expect(validatePreference("desktop_vnc_resolution", "1920x1080").ok).toBe(true);
    expect(validatePreference("desktop_vnc_resolution", "4000x4000").ok).toBe(false);
  });

  it("writes the env file the start script reads", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vnc-res-"));
    await writeVncResolutionEnv("1600x900", home);
    expect(fs.readFileSync(vncResolutionEnvPath(home), "utf8")).toBe("CLAWBOX_VNC_RESOLUTION=1600x900\n");
  });

  it("keeps the shell allowlist in sync with the TypeScript one", () => {
    expect(SCRIPT).toContain(`VNC_RESOLUTIONS="${VNC_RESOLUTIONS.join(" ")}"`);
    expect(SCRIPT).toContain(`DEFAULT_VNC_RESOLUTION="${DEFAULT_VNC_RESOLUTION}"`);
  });
});

describe("start-vnc.sh resolution handling", () => {
  it("reads a saved preset and rejects anything off the allowlist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vnc-res-sh-"));
    const f = path.join(dir, "vnc-resolution.env");
    const read = () => runShell(`read_vnc_resolution "${f}"`);

    expect(read()).toBe("1280x720"); // no file
    fs.writeFileSync(f, "CLAWBOX_VNC_RESOLUTION=1920x1080\n");
    expect(read()).toBe("1920x1080");
    fs.writeFileSync(f, "CLAWBOX_VNC_RESOLUTION=3840x2160\n");
    expect(read()).toBe("1280x720");
    fs.writeFileSync(f, "CLAWBOX_VNC_RESOLUTION=1600x900 -ac\n");
    expect(read()).toBe("1280x720");
    fs.writeFileSync(f, "CLAWBOX_VNC_RESOLUTION=\n");
    expect(read()).toBe("1280x720");
  });

  it("restarts Xvfb only when the running geometry differs from the saved one", () => {
    expect(runShell("xvfb_action 1280x720 1280x720")).toBe("keep");
    expect(runShell("xvfb_action '' 1920x1080")).toBe("keep");
    expect(runShell("xvfb_action 1280x720 1920x1080")).toBe("restart");
  });

  it("starts Xvfb with the chosen resolution at depth 24 and records it", () => {
    expect(SCRIPT).toContain('-screen 0 "${VNC_RESOLUTION}x24"');
    expect(SCRIPT).not.toContain("1280x720x24");
    expect(SCRIPT).toContain("CLAWBOX_VNC_GEOMETRY=");
  });

  it("applies the setting only on the virtual :99 path, after the :0 mirror exec", () => {
    const mirrorExec = SCRIPT.indexOf('exec x11vnc -display :0');
    const readSetting = SCRIPT.indexOf('VNC_RESOLUTION="$(read_vnc_resolution');
    expect(mirrorExec).toBeGreaterThan(0);
    expect(readSetting).toBeGreaterThan(mirrorExec);
  });
});

describe("VNC resolution route restart", () => {
  it("restarts clawbox-vnc without sudo (no new sudoers grant)", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "src/app/setup-api/vnc/resolution/route.ts"), "utf8");
    expect(route).not.toContain("sudo\"");
    expect(route).toContain('"MainPID"');
    expect(route).toContain('process.kill(pid, "SIGKILL")');
  });
});
