/**
 * `runChild`'s optional stdout cap.
 *
 * Without it stdout is accumulated whole, which is right for every caller that
 * reads a JSON answer or a sha and wrong for the one that asks GitHub for a
 * workflow log: `gh run view --log-failed` on a failing matrix prints
 * megabytes, and slicing the tail off after the child has resolved bounds what
 * is KEPT without ever bounding what was HELD — on a Jetson with one long-lived
 * web server on it.
 *
 * What is pinned: the cap keeps the END of the stream (an error is at the end
 * of a log), it never engages for a caller that did not ask for it, and it does
 * not truncate output that fits.
 */
import { describe, expect, it } from "vitest";
import { runChild } from "@/lib/child-run";

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" };

/** Print `n` lines of a known shape, so the tail can be identified exactly. */
function printer(n: number): string[] {
  return ["-e", `for (let i = 0; i < ${n}; i++) process.stdout.write(\`line\${i}\\n\`);`];
}

describe("runChild's stdout cap", () => {
  it("keeps the TAIL, because that is where a failing log's error is", async () => {
    const result = await runChild(process.execPath, printer(20_000), {
      timeoutMs: 30_000,
      env: ENV,
      maxStdoutChars: 200,
    });
    expect(result.code).toBe(0);
    // Bounded — plus at most one chunk's worth, since the slice happens after
    // the append rather than inside the stream.
    expect(result.stdout.length).toBeLessThan(200_000);
    expect(result.stdout).toContain("line19999");
    expect(result.stdout).not.toContain("line0\n");
  });

  it("leaves short output alone", async () => {
    const result = await runChild(process.execPath, printer(3), {
      timeoutMs: 30_000,
      env: ENV,
      maxStdoutChars: 1_000,
    });
    expect(result.stdout).toBe("line0\nline1\nline2");
  });

  it("accumulates everything for a caller that asked for no cap", async () => {
    // The JSON readers depend on this: an answer that arrived truncated would
    // be worse than one that cost memory.
    const result = await runChild(process.execPath, printer(5_000), { timeoutMs: 30_000, env: ENV });
    expect(result.stdout).toContain("line0\n");
    expect(result.stdout).toContain("line4999");
  });
});
