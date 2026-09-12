/**
 * Looking to see whether the deliverable is actually there — against a real
 * folder and a real child process, because that is the only way the two
 * properties that matter can be proved.
 *
 * The first is that a check which cannot be made is NOT a pass. A `checkDeliverable`
 * that swallowed an error into `ok: true` would put back exactly the lie the
 * feature removes: a tick over a question nobody answered.
 *
 * The second is the SANDBOX. A deliverable command runs outside Claude Code's
 * permission layer, so the capability drop is the only thing between it and the
 * web server's ambient CAP_NET_ADMIN / CAP_NET_RAW. It is passed in rather than
 * imported precisely so this file can prove the prefix is used and that a box
 * without it runs nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { checkDeliverable, type DeliverableSandbox } from "@/lib/coding-deliverable-check";
import type { PrState } from "@/lib/coding-pr-state";

// A command deliverable spawns a real shell; the rest is stat work.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let dir: string;

/**
 * The harness's own prefix, stood in for by `env` — which takes the same shape
 * (its own arguments, then the program and ITS arguments) and needs no
 * privileges to run on a test runner, unlike `setpriv`. What is being proved is
 * that the checker runs the command THROUGH the prefix it is handed, which a
 * substitutable sandbox is the only way to see.
 *
 * No `--` here, unlike the real `CAPABILITY_DROP_ARGS`: GNU env has no option
 * terminator and reads it as the program's name. The position under test — the
 * prefix comes first, `/bin/bash -lc <command>` after it — is the same either
 * way, and `setpriv`'s own flags are pinned by the contract test that owns them.
 */
function sandbox(over: Partial<DeliverableSandbox> = {}): DeliverableSandbox {
  return {
    bin: "/usr/bin/env",
    args: ["CLAWBOX_DELIVERABLE_SANDBOX=1"],
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    ...over,
  };
}

function pr(over: Partial<PrState> = {}): PrState {
  return {
    phase: "blocked",
    number: null,
    url: null,
    branch: "clawbox/run-x",
    base: "beta",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    detail: null,
    startedAt: 1,
    endedAt: null,
    reviewOk: true,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-deliverable-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the pr deliverable", () => {
  it("passes once a pull request has a number", async () => {
    const verdict = await checkDeliverable({ directory: dir, pr: pr({ phase: "review", number: 12 }) }, { kind: "pr" }, null);
    expect(verdict).toMatchObject({ ok: true, missing: null });
  });

  it("fails with the record's OWN diagnosis when none was opened", async () => {
    // "Nothing was committed, so there is no pull request to open" is exactly
    // the diagnosis, and better than anything the checker could compose.
    const verdict = await checkDeliverable(
      { directory: dir, pr: pr({ detail: "Nothing was committed, so there is no pull request to open." }) },
      { kind: "pr" },
      null,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain("Nothing was committed");
  });

  it("fails, with its own sentence, when there is no pull request record at all", async () => {
    const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "pr" }, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toMatch(/No pull request was opened/);
  });
});

describe("the paths deliverable", () => {
  it("passes when every named file is there with something in it", async () => {
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "app.js"), "export {}");
    const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "paths", paths: ["index.html", "src/app.js"] }, null);
    expect(verdict).toMatchObject({ ok: true, missing: null });
  });

  it("names the first file that is not there", async () => {
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
    const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "paths", paths: ["index.html", "src/app.js"] }, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toBe("src/app.js was not created.");
  });

  it("treats an EMPTY file as not delivered", async () => {
    // The shape a run leaves when it created the file it was told to create and
    // then ran out of turns. Size is part of the test, not a refinement of it.
    fs.writeFileSync(path.join(dir, "app.js"), "");
    const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "paths", paths: ["app.js"] }, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toBe("app.js is empty.");
  });

  it("refuses a folder standing in for a file", async () => {
    fs.mkdirSync(path.join(dir, "app.js"));
    const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "paths", paths: ["app.js"] }, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toMatch(/folder, not a file/);
  });

  it("refuses a SYMLINK, even one pointing at a real file in the folder", async () => {
    // A link satisfies a deliverable by pointing at something the run did not
    // write — including something outside the folder altogether, which is how a
    // path check becomes a way to ask the box whether a file it guards exists.
    fs.writeFileSync(path.join(dir, "real.js"), "export {}");
    fs.symlinkSync(path.join(dir, "real.js"), path.join(dir, "app.js"));
    const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "paths", paths: ["app.js"] }, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toMatch(/is a link/);
  });

  it("refuses a file reached THROUGH a folder symlink out of the working folder", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "coding-deliverable-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "x");
      fs.symlinkSync(outside, path.join(dir, "away"));
      const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "paths", paths: ["away/secret.txt"] }, null);
      expect(verdict.ok).toBe(false);
      expect(verdict.missing).toMatch(/not inside the run's folder/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the command deliverable", () => {
  it("passes on exit 0, in the run's own folder", async () => {
    fs.writeFileSync(path.join(dir, "marker"), "here");
    const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "command", command: "test -f marker" }, sandbox());
    expect(verdict).toMatchObject({ ok: true, missing: null });
  });

  it("runs THROUGH the sandbox prefix it was handed", async () => {
    // The capability drop is the only thing between a deliverable command and
    // the web server's ambient network capabilities, so the prefix must actually
    // be in the argv rather than merely available.
    const verdict = await checkDeliverable(
      { directory: dir, pr: null },
      { kind: "command", command: 'test "$CLAWBOX_DELIVERABLE_SANDBOX" = 1' },
      sandbox(),
    );
    expect(verdict.ok).toBe(true);
  });

  it("runs with the environment it was handed and nothing else", async () => {
    // An explicit environment, like the run's own: no session secret, no device
    // bearer. `SESSION_SECRET` is set on this process and must not be inherited
    // — stubbed rather than assigned, so the worker this file shares with other
    // suites does not keep the value after the test.
    vi.stubEnv("SESSION_SECRET", "the-web-servers-secret");
    const verdict = await checkDeliverable(
      { directory: dir, pr: null },
      { kind: "command", command: 'test -z "$SESSION_SECRET"' },
      sandbox(),
    );
    expect(verdict.ok).toBe(true);
  });

  it("fails on a non-zero exit, quoting the last thing the command said", async () => {
    // The tail is the reason the owner reads and the nudge quotes: a test runner
    // names the failing test there.
    const verdict = await checkDeliverable(
      { directory: dir, pr: null },
      { kind: "command", command: 'echo "2 tests failed" >&2; exit 3' },
      sandbox(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain("exited 3");
    expect(verdict.missing).toContain("2 tests failed");
  });

  it("runs NOTHING when the box has no sandbox to run it in", async () => {
    // Same condition that refuses a run outright. Running it anyway would hand
    // it capabilities the harness itself is denied, and calling it a pass would
    // be the lie this feature removes.
    const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "command", command: "true" }, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toMatch(/setpriv/);
  });

  it("fails rather than throwing when the sandbox binary is not there", async () => {
    const verdict = await checkDeliverable(
      { directory: dir, pr: null },
      { kind: "command", command: "true" },
      sandbox({ bin: path.join(dir, "no-such-binary") }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toMatch(/could not be run/);
  });

  it("fails rather than throwing when the folder is gone", async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const verdict = await checkDeliverable({ directory: dir, pr: null }, { kind: "command", command: "true" }, sandbox());
    expect(verdict.ok).toBe(false);
    // The point is only that the answer is a verdict, never a throw on the
    // settle path — the wording belongs to whatever Node reported.
    expect(verdict.missing).toBeTruthy();
    // Re-made for the teardown.
    fs.mkdirSync(dir, { recursive: true });
  });
});

describe("what a finished check leaves behind", () => {
  it("ends the process GROUP, not just the command", async () => {
    // A command that starts a descendant and exits settles through `close` with
    // that descendant still in the detached group, and nothing later reaps it —
    // so repeated checks would leak processes and hold ports, with nothing on any
    // surface to explain it. The run's OWN group is deliberately left alone (the
    // guide tells a run to leave its app's server listening, and the owner is told
    // through `leftover`); a deliverable check is not that, and nobody is told.
    const pidFile = path.join(dir, "bg.pid");
    const verdict = await checkDeliverable(
      { directory: dir, pr: null },
      { kind: "command", command: `sleep 120 & echo $! > ${JSON.stringify(pidFile)}; exit 0` },
      sandbox(),
    );
    expect(verdict.ok).toBe(true);

    const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    expect(Number.isInteger(pid)).toBe(true);
    // SIGKILL delivery and reaping are asynchronous, so this polls rather than
    // asserting on the instant the promise resolved.
    await vi.waitFor(() => {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }, { timeout: 5_000, interval: 50 });
  });
});
