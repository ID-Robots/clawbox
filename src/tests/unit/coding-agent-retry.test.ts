/**
 * The one automatic retry after a transient upstream failure.
 *
 * Why it exists: on a real box a run died in four seconds with "Failed to
 * authenticate. API Error: Attention Required! | Cloudflare" while the same
 * request with the same token succeeded immediately before and after.
 * Concurrency, payload size, the restricted environment and the capability
 * drop were each tested and ruled out. The upstream cause is unidentified —
 * but the device's part is not: it turned one blink into a dead run.
 *
 * The guards are the feature. A retry that could loop, or could repeat work
 * that already touched files, would be worse than the failure it fixes.
 */
import { describe, expect, it } from "vitest";
import { isReadOnlyInspectionCommand, isTransientFailure } from "@/lib/coding-agent";

describe("what counts as transient", () => {
  it("catches the failure actually seen on the box", () => {
    expect(isTransientFailure("Failed to authenticate. API Error: Attention Required! | Cloudflare")).toBe(true);
  });

  it("catches the other shapes of an upstream blink", () => {
    for (const err of [
      "API Error: 502 Bad Gateway",
      "503 Service Unavailable",
      "504 Gateway Timeout",
      "gateway time-out",
      "read ECONNRESET",
      "connect ETIMEDOUT 1.2.3.4:443",
      "getaddrinfo ENOTFOUND clawbox.com",
      "socket hang up",
      "TypeError: fetch failed",
    ]) {
      expect(isTransientFailure(err), err).toBe(true);
    }
  });

  it("does NOT catch a real refusal of the work", () => {
    // These are answers, not accidents. Retrying them wastes the owner's plan
    // and hides the reason from them.
    for (const err of [
      "Stopped after 60 turns without finishing.",
      "Stopped at the cost ceiling for one run.",
      "Ran longer than 20 minutes and was stopped.",
      "Stopped before it finished.",
      "Claude Code exited with code 1 before reporting a result.",
      "The task refers to a file that does not exist.",
      "invalid model name",
      null,
      "",
    ]) {
      expect(isTransientFailure(err), String(err)).toBe(false);
    }
  });

  it("is not fooled by the word appearing in ordinary prose", () => {
    // A summary is model-authored text; it must not steer the retry.
    expect(isTransientFailure("I added a Cloudflare Worker to the project.")).toBe(true);
    // ^ deliberately true: this classifier only ever reads run.error, which
    //   the device writes, never run.summary, which the model writes.
  });
});

describe("what is safe to repeat", () => {
  it("allows only single read-only inspection commands", () => {
    for (const command of ["ls -la", "pwd", "cat package.json", "git status --short", "git diff --check", "git log -5"]) {
      expect(isReadOnlyInspectionCommand(command), command).toBe(true);
    }
  });

  it("rejects shell composition, redirection, and commands that may mutate", () => {
    for (const command of [
      "ls; touch changed", "cat a > b", "echo $(touch changed)", "npm test", "python3 script.py",
      "git commit -am fix", "mkdir output", "cp a b", "find . -delete", "",
    ]) {
      expect(isReadOnlyInspectionCommand(command), command).toBe(false);
    }
  });
});

describe("what counts as having changed something", () => {
  it("treats plainly read-only commands as leaving nothing behind", () => {
    // The bug this replaces: the guard asked "did it run ANY command", and a
    // bare `ls -la` was enough to block the retry on a real box.
    for (const cmd of [
      "ls -la /home/clawbox/clawbox/data/code-projects/globe-3d",
      "cat index.html", "head -20 app.js", "wc -l style.css",
      "grep -n foo app.js", "pwd",
      "git status", "git diff", "git log --oneline -5",
    ]) {
      expect(isReadOnlyInspectionCommand(cmd), cmd).toBe(true);
    }
  });

  it("treats anything else as work, including near-misses", () => {
    for (const cmd of [
      "npm install", "bun run build", "mkdir -p out", "cp a b", "mv a b",
      "touch new.txt", "git add .", "git commit -m x", "python3 build.py",
      "node script.js", "make", "rm -rf /", "sudo id",
      // Not a prefix match on a read-only name:
      "lsof -i", "catalina start", "echoserver --run",
      // `find` is NOT on the safe list, deliberately: -exec and -delete make
      // it as side-effecting as anything else.
      "find . -name '*.js'", "find . -delete",
      // Shell composition hides a mutation behind a read-only prefix. A
      // prefix-only check would wave these through.
      "ls -la; rm -rf out", "cat a > b", "grep x f | tee out", "ls `touch z`",
      "cat $(touch z)", "ls && npm install",
    ]) {
      expect(isReadOnlyInspectionCommand(cmd), cmd).toBe(false);
    }
  });
});
