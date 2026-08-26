/**
 * GitHub for the coding agent (src/lib/coding-github.ts).
 *
 * The pieces worth pinning are the ones that decide what leaves the house:
 * a repository is always private, and a push only ever happens from a folder
 * that is its own repository — the same rule as the per-run commit, and for
 * the same reason (a code project sits inside the ClawBox checkout).
 */
import { describe, expect, it } from "vitest";
import { GH_LOGIN_COMMAND, parseLogin, repoNameFor } from "@/lib/coding-github";

describe("reading the connection", () => {
  it("finds the account in gh's own wording", () => {
    // gh writes this to STDERR; the real line from this box:
    const real = "github.com\n  ✓ Logged in to github.com as yalexx (/home/clawbox/.config/gh/hosts.yml)\n  ✓ Git operations for github.com configured to use https protocol.";
    expect(parseLogin(real)).toBe("yalexx");
  });

  it("reports nobody when gh is not logged in", () => {
    expect(parseLogin("You are not logged into any GitHub hosts. Run gh auth login to authenticate.")).toBeNull();
    expect(parseLogin("")).toBeNull();
  });

  it("offers a login command that runs the device flow, not a token prompt", () => {
    // The owner enters a code on github.com; no token is ever typed on the box.
    expect(GH_LOGIN_COMMAND).toContain("gh auth login");
    expect(GH_LOGIN_COMMAND).toContain("--hostname github.com");
    expect(GH_LOGIN_COMMAND).not.toContain("--with-token");
  });
});

describe("naming the repository", () => {
  it("uses the folder name", () => {
    expect(repoNameFor("/home/clawbox/Projects/my-app")).toBe("my-app");
  });

  it("strips what GitHub will not accept", () => {
    // Inner runs collapse to dashes; leading and trailing ones are trimmed.
    expect(repoNameFor("/home/clawbox/Projects/my app (v2)!")).toBe("my-app--v2");
    expect(repoNameFor("/home/clawbox/Projects/--weird--")).toBe("weird");
  });

  it("never produces an empty name", () => {
    expect(repoNameFor("/home/clawbox/Projects/!!!")).toBe("clawbox-project");
  });

  it("stays inside GitHub's length limit", () => {
    expect(repoNameFor(`/x/${"a".repeat(200)}`).length).toBeLessThanOrEqual(90);
  });
});
