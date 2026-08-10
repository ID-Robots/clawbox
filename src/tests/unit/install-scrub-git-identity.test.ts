import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A device image captures whatever was in ~/.gitconfig on the machine it was
 * built from, so units flashed from it shipped with a real person's name and
 * email baked in. Nothing on a device commits — the updater only fetches,
 * checks out and resets — so the identity is pure leakage.
 *
 * These drive the shell function itself rather than asserting on the text of
 * install.sh, so a rename or a refactor of the surrounding step cannot leave
 * the guarantee passing while the behaviour is gone.
 */
const INSTALL_SH = path.join(process.cwd(), "install.sh");


describe("install.sh scrubs the build machine's git identity", () => {
  let tmp: string;
  let userHome: string;
  const USER = "clawbox";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-git-"));
    // The function reads /home/$CLAWBOX_USER/.gitconfig, so mirror that shape.
    userHome = path.join(tmp, "home", USER);
    fs.mkdirSync(userHome, { recursive: true });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** The function hardcodes /home/<user>; run it with that path redirected. */
  function runAgainst(configBody: string | null): string {
    const cfg = path.join(userHome, ".gitconfig");
    if (configBody !== null) fs.writeFileSync(cfg, configBody);
    execFileSync("bash", [
      "-c",
      `sed -n '/^step_scrub_git_identity() {/,/^}/p' "$1" \
         | sed "s#/home/\\$CLAWBOX_USER#$2#" > /tmp/fn2.$$.sh
       . /tmp/fn2.$$.sh
       CLAWBOX_USER=nobody
       step_scrub_git_identity
       rm -f /tmp/fn2.$$.sh`,
      "bash",
      INSTALL_SH,
      userHome,
    ], { encoding: "utf8" });
    return configBody === null || !fs.existsSync(cfg) ? "" : fs.readFileSync(cfg, "utf8");
  }

  it("removes a name and email inherited from the build machine", () => {
    const after = runAgainst("[user]\n\tname = someone\n\temail = someone@example.com\n");
    expect(after).not.toMatch(/someone/);
    expect(after).not.toMatch(/example\.com/);
    expect(after).not.toMatch(/\[user\]/);
  });

  it("does not substitute a placeholder identity", () => {
    // A placeholder is still an identity; git should simply have none.
    const after = runAgainst("[user]\n\tname = someone\n\temail = someone@example.com\n");
    expect(after).not.toMatch(/name\s*=/);
    expect(after).not.toMatch(/email\s*=/);
  });

  it("preserves unrelated git settings", () => {
    const after = runAgainst(
      "[user]\n\tname = someone\n\temail = someone@example.com\n[core]\n\tautocrlf = false\n",
    );
    expect(after).toMatch(/\[core\]/);
    expect(after).toMatch(/autocrlf/);
  });

  it("is a no-op when there is no gitconfig at all (a clean image)", () => {
    expect(() => runAgainst(null)).not.toThrow();
  });

  it("is idempotent — a second run over a clean config changes nothing", () => {
    const first = runAgainst("[user]\n\tname = someone\n\temail = someone@example.com\n");
    const cfg = path.join(userHome, ".gitconfig");
    const before = fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : "";
    runAgainst(before || null);
    const after = fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : "";
    expect(after).toBe(before);
    expect(first).not.toMatch(/someone/);
  });
});

describe("the scrub runs on updates, not only fresh installs", () => {
  it("is called from step_post_update", () => {
    // Units already in the field will never be reflashed, so the updater is the
    // only path that can clean them.
    const src = fs.readFileSync(INSTALL_SH, "utf8");
    const post = src.slice(src.indexOf("step_post_update() {"));
    expect(post.slice(0, post.indexOf("\n}"))).toContain("step_scrub_git_identity");
  });
});
