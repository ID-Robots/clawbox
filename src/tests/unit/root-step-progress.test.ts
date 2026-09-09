import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `watchRootStepProgress` — what a long root step is DOING, for a label that
 * cannot say it.
 *
 * "Applying system fixups" covers nineteen sub-phases on a Jetson, among them a
 * CUDA compile that ran for six silent minutes and several hundred-MB
 * downloads. Measured on hardware 2026-09-09: the step held those four words
 * for fifteen minutes while the box saturated four cores.
 *
 * The signal is install.sh's own two-space indent: the installer announces each
 * sub-phase that way, while the tools it drives (pip, apt) write flush left.
 * Matching the indent shows the box's account of itself instead of pip's.
 */

const execFileMock = vi.fn();

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    const result = execFileMock(cmd, args);
    if (result?.error) {
      cb(result.error as Error, { stdout: "", stderr: "" });
      return;
    }
    cb(null, { stdout: result?.stdout ?? "", stderr: "" });
  },
}));

/** One real journal window from the 2026-09-09 upgrade, indents preserved. */
const JOURNAL = [
  "  Installing CUDA-enabled PyTorch for Jetson (~300 MB)...",
  "Installing collected packages: nvidia-cusparselt-cu12",
  "Successfully installed av-17.1.0 coloredlogs-15.0.1 ctranslate2-4.8.2",
  "  Installing Kokoro TTS...",
  "WARNING: Defaulting repo_id to hexgrad/Kokoro-82M.",
  "  Building CTranslate2 with CUDA for sm_87...",
].join("\n");

async function load() {
  const mod = await import("@/lib/root-step-follow");
  return mod.watchRootStepProgress;
}

beforeEach(() => {
  vi.resetModules();
  execFileMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("install.sh's side of the contract", () => {
  // The two-space indent is now a UI contract and install.sh does not say so.
  // The fully-deep alternative — a `substep()` helper emitting an explicit
  // marker like the existing `[provision-status]` sentinels — means touching
  // hundreds of echo sites in the highest-risk file in the product for a
  // cosmetic feature, so it is deliberately not done. Pinning the convention
  // from the PRODUCER side is the cheap half: it fails if someone reformats the
  // announcements the watcher reads, which the consumer test above cannot see.
  it("announces sub-phases with the two-space indent the watcher matches", () => {
    const installSh = readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
    const announcements = installSh
      .split("\n")
      .map((l) => /^\s*echo "( +)(Installing|Building|Checking|Refreshing) /.exec(l))
      .filter((m): m is RegExpExecArray => m !== null);

    // Twelve at the time of writing, every one of them two-space indented.
    // The floor is what matters: enough that a reformat trips this rather than
    // a single edit, low enough that removing one sub-phase does not.
    expect(announcements.length).toBeGreaterThan(8);
    for (const m of announcements) {
      expect(m[1], `"${m[0].trim()}" must keep the two-space sub-phase indent`).toBe("  ");
    }

    // Deeper indents are a DIFFERENT thing and must stay excluded: install.sh
    // uses four or more spaces for continuation lines under an announcement
    // ("         Leaving messages.tts.provider unset rather than ..."), which
    // are detail, not the headline. HEADLINE_RE matches exactly two spaces, so
    // those are correctly ignored — this asserts they still exist rather than
    // having been flattened into the headline space.
    const continuations = installSh
      .split("\n")
      .filter((l) => /^\s*echo "    +[A-Z]/.test(l));
    expect(continuations.length).toBeGreaterThan(0);
  });
});

describe("watchRootStepProgress", () => {
  it("reports the installer's own headline, not the tool output under it", async () => {
    execFileMock.mockReturnValue({ stdout: JOURNAL });
    const watch = await load();
    const seen: string[] = [];
    const stop = watch("post_update", 1_000, (h) => seen.push(h));
    await vi.advanceTimersByTimeAsync(0);
    stop();

    // The NEWEST indented line wins — the compile, not the pip chatter that
    // came before it and not the flush-left lines in between.
    expect(seen).toEqual(["Building CTranslate2 with CUDA for sm_87..."]);
    expect(seen.join(" ")).not.toContain("Successfully installed");
    expect(seen.join(" ")).not.toContain("Installing collected packages");
  });

  it("reads only THIS run of the step", async () => {
    execFileMock.mockReturnValue({ stdout: JOURNAL });
    const watch = await load();
    const stop = watch("post_update", 4_242, () => {});
    await vi.advanceTimersByTimeAsync(0);
    stop();

    // The journal is persistent: unbounded, the first poll would hand the
    // PREVIOUS attempt's lines to a screen showing them as live progress.
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toContain("--since");
    expect(args.join(" ")).toContain("4.242");
  });

  it("says nothing when the step has not spoken, and never repeats itself", async () => {
    execFileMock.mockReturnValue({ stdout: "Installing collected packages: flatbuffers\n" });
    const watch = await load();
    const seen: string[] = [];
    const stop = watch("post_update", 1_000, (h) => seen.push(h));
    await vi.advanceTimersByTimeAsync(0);
    // A second poll over an unchanged journal must not re-announce.
    await vi.advanceTimersByTimeAsync(5000);
    stop();
    expect(seen).toEqual([]);
  });

  it("survives a journalctl that fails, and stops when told to", async () => {
    execFileMock.mockReturnValue({ error: new Error("journalctl: no such unit") });
    const watch = await load();
    const seen: string[] = [];
    const stop = watch("post_update", 1_000, (h) => seen.push(h));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    stop();
    const callsAtStop = execFileMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    // A stopped watch reads nothing further: the update's own steps are the
    // only thing that should be shelling out once a step has ended.
    expect(execFileMock.mock.calls.length).toBe(callsAtStop);
  });

  it("does not let a throwing listener end the watch", async () => {
    execFileMock.mockReturnValue({ stdout: JOURNAL });
    const watch = await load();
    const stop = watch("post_update", 1_000, () => { throw new Error("listener gone"); });
    await vi.advanceTimersByTimeAsync(0);
    // Still polling after the throw — the step it is watching runs on either
    // way, and losing the watch would leave the screen frozen on a stale line.
    const before = execFileMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(execFileMock.mock.calls.length).toBeGreaterThan(before);
    stop();
  });
});
