/**
 * Telling a live run something, against a FAKE claude-ds.
 *
 * Two deliveries, and the point of the suite is that BOTH are real:
 *
 *  - STREAMING — the runner spawns with `--input-format stream-json` and keeps
 *    stdin open, so a message queued at minute three arrives as the harness's
 *    next user turn, in the same session, while it works.
 *  - AT A BOUNDARY — on a box whose Claude Code refuses that flag, the same
 *    message rides out with the next spawn's continuation instead.
 *
 * And the two things a reviewer cannot see from the argv: that a streaming run
 * still ENDS (the box closes the pipe once the harness has reported, or the
 * CLI would sit waiting for input for ever), and that a harness which turns the
 * flag away is learned from rather than probed for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { decodeHarnessTurns } from "@/tests/helpers/fake-harness";

// Starts real processes, like the runner's own suite.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const announce = vi.hoisted(() => vi.fn<(run: unknown) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: announce }));
const memAvailable = vi.hoisted(() => vi.fn(async (): Promise<number | null> => 8000));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: memAvailable }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

type Lib = typeof import("@/lib/coding-agent");
type Messages = typeof import("@/lib/coding-run-messages");

let lib: Lib;
let messages: Messages;
let base: string;
let home: string;
let root: string;
let binDir: string;
let restore: () => void;

const turnsFile = () => path.join(base, "turns.txt");
const argvFile = () => path.join(base, "argv.txt");
/** One line per spawn, appended: argv.txt is overwritten and cannot tell one from two. */
const spawnArgvFile = () => path.join(base, "spawn-argv.txt");

const INIT = '{"type":"system","subtype":"init","session_id":"sess-msg-1","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "Done.",
  session_id: "sess-msg-1",
});

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

function installWrapper(body: string): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > "${argvFile()}"`,
      `printf '%s\\n' "$*" >> "${spawnArgvFile()}"`,
      body,
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** Reads the task, waits for ONE more turn, then reports success. */
const WAITS_FOR_A_MESSAGE = [
  `echo '${INIT}'`,
  `head -n 2 > "${"__TURNS__"}"`,
  `echo '${RESULT}'`,
  "exit 0",
].join("\n");

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

function ready(): void {
  writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true });
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-messages-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({});
  announce.mockClear();
  vi.resetModules();
  // Imported after the reset and before the runner, so both share ONE module
  // instance: the test's `noteStreamInputRefused` has to be the same memory the
  // spawn reads.
  messages = await import("@/lib/coding-run-messages");
  messages._resetStreamInputForTests();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const finished = async (id: string) => {
  const run = await lib.waitForRun(id, 20_000);
  if (!run) throw new Error("run vanished");
  return run;
};

const lastArgv = () => fs.readFileSync(argvFile(), "utf-8").split("\n");
const spawnArgvs = () => fs.readFileSync(spawnArgvFile(), "utf-8").split("\n").filter(Boolean);

describe("delivery while the run works (streaming input)", () => {
  beforeEach(() => {
    ready();
    installWrapper(WAITS_FOR_A_MESSAGE.replace("__TURNS__", turnsFile()));
    makeProject("site");
  });

  it("asks the harness for streaming input", async () => {
    const run = await lib.startRun({ task: "build it", projectId: "site", source: "owner" });
    // The wrapper is blocked on the second turn; unblock it so the run settles.
    await vi.waitFor(() => { expect(lib.getRun(run.id)?.progress.join("\n")).toContain("Started"); }, { timeout: 15_000 });
    lib.queueRunMessage(run.id, "use tabs");
    await finished(run.id);
    const argv = lastArgv();
    expect(argv[argv.indexOf("--input-format") + 1]).toBe("stream-json");
    // Still the same -p stream-json run it always was; only the INPUT changed.
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
  });

  it("writes the message as the harness's next user turn, in the same session", async () => {
    const run = await lib.startRun({ task: "build it", projectId: "site", source: "owner" });
    await vi.waitFor(() => { expect(lib.getRun(run.id)?.progress.join("\n")).toContain("Started"); }, { timeout: 15_000 });

    const answer = lib.queueRunMessage(run.id, "  use tabs, not spaces  ");
    expect(answer.delivered).toBe(true);

    const settled = await finished(run.id);
    const turns = decodeHarnessTurns(fs.readFileSync(turnsFile(), "utf-8"));
    expect(turns).toHaveLength(2);
    // The task first, unchanged…
    expect(turns[0]).toContain("build it");
    // …then the message, framed as guidance rather than as a fresh brief.
    expect(turns[1]).toContain("use tabs, not spaces");
    expect(turns[1]).toMatch(/do not start over/i);

    // The record says it went, and the feed shows it in the transcript.
    expect(settled.messages).toHaveLength(1);
    expect(settled.messages[0].text).toBe("use tabs, not spaces");
    expect(typeof settled.messages[0].deliveredAt).toBe("number");
    expect(settled.progress.join("\n")).toContain("Message to the run: use tabs, not spaces");
  });

  it("keeps the message on the record before it is delivered, so a restart cannot lose it", async () => {
    const run = await lib.startRun({ task: "build it", projectId: "site", source: "owner" });
    await vi.waitFor(() => { expect(lib.getRun(run.id)?.progress.join("\n")).toContain("Started"); }, { timeout: 15_000 });
    lib.queueRunMessage(run.id, "use tabs");
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8")) as
      { id: string; messages?: { text: string }[] }[];
    expect(onDisk.find((r) => r.id === run.id)?.messages?.[0]?.text).toBe("use tabs");
    await finished(run.id);
  });
});

describe("a streaming run still ends", () => {
  it("closes the harness's stdin once it has reported, or it would wait for input for ever", async () => {
    ready();
    // `cat` returns only on EOF: this wrapper exits only if the box closes the
    // pipe after the result. Nothing else in the run ever would.
    installWrapper([
      "head -n 1 > /dev/null",
      `echo '${INIT}'`,
      `echo '${RESULT}'`,
      "cat > /dev/null",
      "exit 0",
    ].join("\n"));
    makeProject("site");
    const run = await lib.startRun({ task: "build it", projectId: "site", source: "owner" });
    const settled = await finished(run.id);
    expect(settled.status).toBe("completed");
  });
});

describe("delivery at a boundary (a harness that takes no streaming input)", () => {
  beforeEach(() => {
    ready();
    makeProject("site");
    // What the box has LEARNED about this harness, from a spawn it turned away.
    messages.noteStreamInputRefused();
  });

  it("spawns without the flag and folds the queue into the next spawn's stdin", async () => {
    // `cat`, not `head`: with no streaming flag the runner writes plain text
    // and CLOSES the pipe, so reading to EOF is right — and is itself a proof
    // of the mode, because a streaming spawn would leave this waiting.
    installWrapper([`cat > "${turnsFile()}"`, `echo '${INIT}'`, `echo '${RESULT}'`, "exit 0"].join("\n"));
    const draft = await lib.createDraftRun({ task: "build it", projectId: "site", source: "owner" });
    const answer = lib.queueRunMessage(draft.id, "use tabs");
    // Nothing to write to yet — and the answer says so rather than claiming it.
    expect(answer.delivered).toBe(false);
    expect(answer.run.messages[0].deliveredAt).toBeNull();

    await lib.startDraftRun(draft.id);
    const settled = await finished(draft.id);

    expect(lastArgv()).not.toContain("--input-format");
    const turns = decodeHarnessTurns(fs.readFileSync(turnsFile(), "utf-8"));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain("build it");
    expect(turns[0]).toContain("use tabs");
    expect(typeof settled.messages[0].deliveredAt).toBe("number");
    expect(settled.progress.join("\n")).toContain("Message to the run: use tabs");
  });

  it("leaves a message queued while a run of this kind is still going", async () => {
    installWrapper([`head -n 1 > /dev/null`, `echo '${INIT}'`, `sleep 0.4`, `echo '${RESULT}'`, "exit 0"].join("\n"));
    const run = await lib.startRun({ task: "build it", projectId: "site", source: "owner" });
    const answer = lib.queueRunMessage(run.id, "use tabs");
    expect(answer.delivered).toBe(false);
    const settled = await finished(run.id);
    // Still waiting: this harness had no pipe to take it, and the run ended
    // before a boundary came. Nothing claims otherwise.
    expect(settled.messages[0].deliveredAt).toBeNull();
    expect(settled.progress.join("\n")).not.toContain("Message to the run");
  });
});

describe("learning that the harness refuses the flag", () => {
  it("retries the run once without it, and remembers", async () => {
    ready();
    makeProject("site");
    // Commander's own words for a flag it does not know — and nothing else:
    // the harness never speaks, which is the condition for reading it as a
    // refusal of the FLAG rather than a failure of the run.
    installWrapper([
      `if printf '%s' "$*" | grep -q -- '--input-format'; then`,
      "  echo \"error: unknown option '--input-format'\" >&2",
      "  exit 1",
      "fi",
      "head -n 1 > /dev/null",
      `echo '${INIT}'`,
      `echo '${RESULT}'`,
      "exit 0",
    ].join("\n"));

    const run = await lib.startRun({ task: "build it", projectId: "site", source: "owner" });
    const settled = await finished(run.id);

    // Two spawns: the first with the flag, the second without.
    const argvs = spawnArgvs();
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).toContain("--input-format");
    expect(argvs[1]).not.toContain("--input-format");
    expect(settled.status).toBe("completed");
    expect(settled.retries).toBe(1);
    // And it is remembered, so the next run does not spend a spawn learning it
    // again.
    expect(messages.streamInputAvailable()).toBe(false);
  });
});

describe("what queueRunMessage refuses", () => {
  beforeEach(() => {
    ready();
    installWrapper([`head -n 1 > /dev/null`, `echo '${INIT}'`, `echo '${RESULT}'`, "exit 0"].join("\n"));
    makeProject("site");
  });

  it("an id nothing on the box knows", () => {
    expect(() => lib.queueRunMessage("run-nope", "hi")).toThrow(/no coding run with that id/i);
  });

  it("a run that has finished — there is nothing left to tell it", async () => {
    const run = await lib.startRun({ task: "build it", projectId: "site", source: "owner" });
    const settled = await finished(run.id);
    expect(settled.status).toBe("completed");
    try {
      lib.queueRunMessage(run.id, "one more thing");
      throw new Error("should have refused");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("settled");
    }
  });

  it("but NOT a run that gave up: its session is intact and Resume is the button on its page", async () => {
    const run = await lib.startRun({ task: "build it", projectId: "site", source: "owner" });
    await finished(run.id);
    // The one settled status that still holds a resumable session. Written
    // straight onto the record, the way a deliverable gate would leave it.
    const file = path.join(root, "data", "coding-agent-runs.json");
    const list = JSON.parse(fs.readFileSync(file, "utf-8")) as { id: string; status: string }[];
    for (const r of list) if (r.id === run.id) r.status = "gave_up";
    fs.writeFileSync(file, JSON.stringify(list), "utf-8");
    // A fresh module, so the record is read back off disk rather than out of
    // the runner's own in-memory copy.
    await lib._resetCodingAgentStateForTests();
    vi.resetModules();
    messages = await import("@/lib/coding-run-messages");
    lib = await import("@/lib/coding-agent");

    const answer = lib.queueRunMessage(run.id, "the tests are in test/, not tests/");
    expect(answer.delivered).toBe(false);
    expect(answer.run.messages[0].deliveredAt).toBeNull();
  });

  it("a message this box will not carry, before anything is written", async () => {
    const draft = await lib.createDraftRun({ task: "build it", projectId: "site", source: "owner" });
    for (const [bad, code] of [["   ", "empty"], ["a b", "not_plain_text"], ["x".repeat(4_001), "too_long"]] as const) {
      try {
        lib.queueRunMessage(draft.id, bad);
        throw new Error(`should have refused ${code}`);
      } catch (err) {
        expect((err as { code?: string }).code).toBe(code);
      }
    }
    expect(lib.getRun(draft.id)?.messages).toEqual([]);
  });
});
