/**
 * The Whisper engine's disk preflight measures the home the ROOT STEP installs
 * into. That home is a literal in install.sh, never the web server's
 * `CLAWBOX_HOME`, which can come from a `.env` the root step's unit does not
 * load. If either literal moves, the preflight would measure a filesystem the
 * files do not land on, so the two are pinned together.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("the Whisper engine preflight's home", () => {
  it("is install.sh's fixed installer home, not an environment override", () => {
    const installHome = /^CLAWBOX_HOME="([^"]+)"$/m.exec(read("install.sh"))?.[1];
    expect(installHome).toBe("/home/clawbox");
    const route = read("src/app/setup-api/whisper/route.ts");
    expect(route).toContain(`const INSTALLER_HOME = "${installHome}";`);
    expect(route).not.toMatch(/process\.env\.CLAWBOX_HOME/);
  });
});
