import { describe, expect, it, vi, beforeEach } from "vitest";
import * as childProcess from "child_process";
import { rootStepJournalArgs, rootStepUnit } from "@/lib/root-step-journal";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

const { mockStartRootStep, dispatch } = vi.hoisted(() => {
  const dispatch = { at: 0 };
  return {
    dispatch,
    // A root step takes a moment to start, as one does on a box: without that
    // a capture moved BELOW `startRootStep` still lands in the same instant
    // and the window looks correctly opened when it is not.
    mockStartRootStep: vi.fn(async () => {
      dispatch.at = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }),
  };
});
vi.mock("@/lib/root-step-runner", () => ({ startRootStep: mockStartRootStep }));

const mockExecFile = vi.mocked(childProcess.execFile);

/**
 * The journal of THIS run of a root step.
 *
 * `systemctl show clawbox-root-update@<step>.service -p InvocationID` answers
 * EMPTY on a box — the instance is started ad hoc, referenced by nothing, and
 * systemd collects it as it exits — so a reader bound to the invocation id
 * reads nothing, ever. What is left has to answer WHICH unit and WHICH run
 * without it.
 */
describe("rootStepJournalArgs", () => {
  it("reads by unit NAME, which outlives the unit", () => {
    const args = rootStepJournalArgs("post_update", { sinceMs: 1_700_000_000_000, lines: 500 });

    expect(args).toContain("-u");
    expect(args).toContain(rootStepUnit("post_update"));
    expect(rootStepUnit("post_update")).toBe("clawbox-root-update@post_update.service");
    // NOT the id: it is empty by the time anybody asks.
    expect(args.join(" ")).not.toContain("_SYSTEMD_INVOCATION_ID");
  });

  it("bounds the read to the run the caller dispatched", () => {
    // The journal is persistent, so an unbounded read answers with the last
    // update's failures over a clean one.
    const args = rootStepJournalArgs("post_update", { sinceMs: 1_700_000_000_500, lines: 500 });
    const since = args[args.indexOf("--since") + 1];

    expect(since).toBe("@1700000000.500");
  });

  it("keeps the millisecond, so a retry in the same second excludes the previous attempt", () => {
    // The one case a window floored to the second gets wrong: the failed
    // attempt's last line at .100 and this dispatch at .900 share a second, so
    // a floored bound opens BEFORE the line it exists to exclude. systemd.time
    // takes fractions to 1 us and journalctl really filters on them.
    const previousAttemptWroteAt = 1_700_000_000_100;
    const args = rootStepJournalArgs("post_update", { sinceMs: 1_700_000_000_900, lines: 40 });
    const since = Number(args[args.indexOf("--since") + 1].slice(1));

    expect(since * 1000).toBeGreaterThan(previousAttemptWroteAt);
    expect(args[args.indexOf("-n") + 1]).toBe("40");
  });
});

/**
 * The follow reads the SAME units, and read the same way: unbounded. Its first
 * poll happens before the unit has written anything, so what came back was the
 * PREVIOUS attempt's last line — shown to the owner as this install's live
 * progress, and taken as this install's failure reason.
 *
 * Two properties, because the bound has two halves: the read carries a window,
 * and that window opens BEFORE the step is started. A capture that slid below
 * `startRootStep` would keep every argv assertion green while reading the
 * previous attempt again.
 */
describe("followRootStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatch.at = 0;
    mockExecFile.mockImplementation(((
      cmd: string,
      args: string[],
      optsOrCallback?: unknown,
      maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = (typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback) as
        (error: Error | null, result: { stdout: string; stderr: string }) => void;
      let stdout = "";
      if (cmd.includes("systemctl")) {
        stdout = "ActiveState=failed\nResult=exit-code\n";
      } else if (cmd.includes("journalctl")) {
        // The OS, modelled: a window opened at or before this dispatch sees
        // only what THIS run wrote — nothing yet — while an unbounded read, or
        // one opened after the step started, still answers with the line the
        // last attempt left behind.
        const since = Number(/--since @([\d.]+)/.exec(args.join(" "))?.[1] ?? NaN);
        stdout = since * 1000 <= dispatch.at ? "" : "ERROR: kokoro model download failed";
      }
      callback?.(null, { stdout, stderr: "" });
      return undefined as unknown as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile);
  });

  it("never reports the previous attempt's line as this run's", async () => {
    const { followRootStep } = await import("@/lib/root-step-follow");
    const statuses: string[] = [];

    const result = await followRootStep("openclaw_tts", {
      timeoutMs: 5_000,
      label: "Voice install",
      onStatus: (line) => statuses.push(line),
    });

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("kokoro model download failed");
    expect(result.error).toContain("Voice install failed");
    expect(statuses).toEqual([]);
  });

  it("bounds every journal read it makes to this run", async () => {
    const { followRootStep } = await import("@/lib/root-step-follow");

    await followRootStep("embed_model", {
      timeoutMs: 5_000,
      label: "Embedder install",
      onStatus: () => {},
    });

    const journalReads = mockExecFile.mock.calls
      .filter(([cmd]) => String(cmd).includes("journalctl"))
      .map(([, args]) => (args as string[]).join(" "));

    expect(journalReads.length).toBeGreaterThan(0);
    for (const read of journalReads) {
      expect(read).toContain(`-u ${rootStepUnit("embed_model")}`);
      expect(read).toMatch(/--since @\d+\.\d{3}/);
    }
  });
});
