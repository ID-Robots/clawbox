import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * That the transcript sweep is actually ARMED.
 *
 * This exists because the sweep was written, documented as running "on the next
 * boot", and unit-tested against a real disk — but never called. Every one of
 * those signals said the 30-day retention was real while nothing on the box
 * would ever have run it, and no behavioural test could have noticed: a
 * retention policy that is never invoked fails silently and indefinitely, and
 * the only symptom is a customer's conversations still being there a year
 * later.
 *
 * It reads the boot file rather than calling `register()` because that function
 * pulls its dependencies in through `require()` specifically to keep Node APIs
 * out of Next's Edge bundle, and none of the other things wired there
 * (the ClawKeep and memory schedulers) are covered at that level either. What
 * regressed was the WIRING, so the wiring is what this pins.
 *
 * The sweep's own behaviour — what it deletes, what it leaves, that it never
 * throws — is covered next door in `harness-transcript-store.test.ts`.
 */

const BOOT_FILE = path.join(process.cwd(), "src", "instrumentation.ts");
const source = fs.readFileSync(BOOT_FILE, "utf8");

describe("boot arms the chat transcript sweep", () => {
  it("reaches for the transcript store", () => {
    expect(source).toContain("harness/transcript-store");
    expect(source).toContain("sweepTranscripts");
  });

  it("calls it, rather than only importing it", () => {
    expect(source).toMatch(/sweepTranscripts\s*\(/);
  });

  it("keeps it behind the Node-runtime guard", () => {
    // `register` runs in both runtimes. The sweep touches `fs`, so it has to
    // sit after the edge early-return or the edge bundle pulls the disk in.
    const guard = source.indexOf("NEXT_RUNTIME === 'edge'");
    const call = source.search(/sweepTranscripts\s*\(/);
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
  });

  it("does not let a failed sweep stop the box booting", () => {
    // Retention is housekeeping. A device that would not start because it could
    // not tidy up old chat logs is a far worse failure than the logs.
    const call = source.search(/sweepTranscripts\s*\(/);
    const after = source.slice(call, call + 600);
    expect(after).toMatch(/\.catch\(/);
  });
});
