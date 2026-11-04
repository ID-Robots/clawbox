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
    // The preflight lives with the install's task now (a route may export only
    // its handlers), and the queue's disk needs measure the same home.
    for (const file of ["src/lib/whisper-install-tasks.ts", "src/lib/local-ai-install-queue.ts"]) {
      const source = read(file);
      expect(source).toContain(`const INSTALLER_HOME = "${installHome}";`);
      expect(source).not.toMatch(/process\.env\.CLAWBOX_HOME/);
    }
  });
});
