import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import { startRootStep } from "@/lib/root-step-runner";
import { rootStepUnit } from "@/lib/root-step-journal";

/**
 * POST /setup-api/install/run-step — the desktop panels' "run this install
 * step as root" button (VNCApp, RemoteControlPanel).
 *
 * Pinned here: the journal tail it returns as the evidence for a failure is
 * THIS run's. The journal on a box is persistent and a failed unit stays
 * loaded, so a 60-line tail of a step the owner has already retried runs back
 * through the previous attempt and offers its output as the reason this one
 * failed.
 */

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));

const { mockStartRootStep } = vi.hoisted(() => ({ mockStartRootStep: vi.fn(async () => {}) }));
vi.mock("@/lib/root-step-runner", () => ({ startRootStep: mockStartRootStep }));

const mockExecFile = vi.mocked(childProcess.execFile);
const STEP = "vnc_install";
const PREVIOUS_ATTEMPT = "Error: the previous attempt could not reach the package mirror";
const THIS_ATTEMPT = "Setting up tigervnc-standalone-server...";

function post(step: string) {
  return new Request("http://box/setup-api/install/run-step", {
    method: "POST",
    body: JSON.stringify({ step }),
  });
}

describe("POST /setup-api/install/run-step", () => {
  let dispatchedAt = 0;
  let journalReads: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dispatchedAt = 0;
    journalReads = [];

    // The dispatch takes a moment, as a root step does, so a window opened
    // AFTER it — the regression that would quietly restore the unbounded read
    // — is visible to the millisecond bound.
    vi.mocked(startRootStep).mockImplementation(async () => {
      dispatchedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("Job for clawbox-root-update@vnc_install.service failed");
    });

    mockExecFile.mockImplementation(((
      cmd: string,
      args: string[],
      optsOrCallback?: unknown,
      maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = (typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback) as
        (error: Error | null, result: { stdout: string; stderr: string }) => void;
      const key = `${cmd} ${args.join(" ")}`;
      let stdout = "";
      if (key.includes("journalctl")) {
        journalReads.push(key);
        // The OS: an unbounded read still answers with what the last attempt
        // left behind; a window opened at or before this dispatch does not.
        const since = Number(/--since @([\d.]+)/.exec(key)?.[1] ?? NaN);
        stdout = since * 1000 <= dispatchedAt
          ? THIS_ATTEMPT
          : [PREVIOUS_ATTEMPT, THIS_ATTEMPT].join(String.fromCharCode(10));
      }
      callback?.(null, { stdout, stderr: "" });
      return undefined as unknown as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile);
  });

  it("returns THIS run's journal as the evidence, not the attempt before it", async () => {
    const { POST } = await import("@/app/setup-api/install/run-step/route");

    const res = await POST(post(STEP));
    const body = await res.json() as { ok: boolean; step: string; journalTail: string };

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.journalTail).toContain(THIS_ATTEMPT);
    expect(body.journalTail).not.toContain("previous attempt");
  });

  it("reads by unit name, bounded to this run", async () => {
    const { POST } = await import("@/app/setup-api/install/run-step/route");

    await POST(post(STEP));

    expect(journalReads.length).toBeGreaterThan(0);
    for (const read of journalReads) {
      // By NAME, which outlives an instance systemd has collected — the id is
      // empty by the time anyone asks for it.
      expect(read).toContain(`-u ${rootStepUnit(STEP)}`);
      expect(read).toMatch(/--since @\d+\.\d{3}/);
    }
  });

  it("refuses a step the UI is not allowed to start", async () => {
    const { POST } = await import("@/app/setup-api/install/run-step/route");

    const res = await POST(post("rebuild_reboot"));

    expect(res.status).toBe(400);
    expect(mockStartRootStep).not.toHaveBeenCalled();
  });
});
