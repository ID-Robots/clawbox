import { afterEach, describe, expect, it } from "vitest";
import {
  DOCTOR_RETRY_PAUSE_ENV,
  DOCTOR_TAIL_CHARS,
  doctorFailureIsRetryable,
  doctorFailureTail,
  doctorRetryPauseMs,
  pauseBeforeDoctorRetry,
} from "@/lib/openclaw-doctor-recovery";

/**
 * SUP-1023 — the pure rules the sign-in save uses when `doctor --fix` exits
 * non-zero (src/lib/openclaw-doctor-recovery.ts). The route's own behaviour is
 * `routes/ai-models/configure.test.ts`'s; these are the decisions it asks.
 */

const ambient = process.env[DOCTOR_RETRY_PAUSE_ENV];
afterEach(() => {
  if (ambient === undefined) delete process.env[DOCTOR_RETRY_PAUSE_ENV];
  else process.env[DOCTOR_RETRY_PAUSE_ENV] = ambient;
});

describe("doctorRetryPauseMs", () => {
  it("is three seconds unless told otherwise — long enough for a colliding writer to finish", () => {
    delete process.env[DOCTOR_RETRY_PAUSE_ENV];
    expect(doctorRetryPauseMs()).toBe(3000);
  });

  it("takes a number of milliseconds, 0 included (the suites' own setting)", () => {
    process.env[DOCTOR_RETRY_PAUSE_ENV] = "0";
    expect(doctorRetryPauseMs()).toBe(0);
    process.env[DOCTOR_RETRY_PAUSE_ENV] = "1500";
    expect(doctorRetryPauseMs()).toBe(1500);
  });

  it.each(["", "  ", "soon", "NaN", "-5", "Infinity"])("falls back to the default for %j rather than making it a budget", (raw) => {
    process.env[DOCTOR_RETRY_PAUSE_ENV] = raw;
    expect(doctorRetryPauseMs()).toBe(3000);
  });

  it("never lets a typo hold the owner for minutes", () => {
    process.env[DOCTOR_RETRY_PAUSE_ENV] = "9999999";
    expect(doctorRetryPauseMs()).toBe(30_000);
  });

  it("does not wait at all at 0, and waits at least what it was told otherwise", async () => {
    process.env[DOCTOR_RETRY_PAUSE_ENV] = "0";
    const startedAt = Date.now();
    await pauseBeforeDoctorRetry();
    expect(Date.now() - startedAt).toBeLessThan(50);

    process.env[DOCTOR_RETRY_PAUSE_ENV] = "40";
    const second = Date.now();
    await pauseBeforeDoctorRetry();
    expect(Date.now() - second).toBeGreaterThanOrEqual(35);
  });
});

describe("doctorFailureIsRetryable", () => {
  it.each([
    ["a refused config write", "Doctor finished, but config fixes were not applied."],
    ["a doctor that could not finish maintenance", "Config unavailable; using environment and default agent directory settings.\nDoctor could not complete maintenance."],
    ["a locked store", "database is locked"],
    ["an exit with nothing said", "openclaw doctor --fix exited with code 1"],
  ])("runs again after %s", (_what, message) => {
    expect(doctorFailureIsRetryable(new Error(message))).toBe(true);
  });

  it("runs again after something that is not an Error at all", () => {
    expect(doctorFailureIsRetryable("boom")).toBe(true);
  });

  it("does not run again after a run killed at its budget — that would double a wait that already failed", () => {
    const killed = Object.assign(new Error("openclaw doctor timed out after 180000ms"), { name: "OpenclawSpawnTimeoutError" });
    expect(doctorFailureIsRetryable(killed)).toBe(false);
  });

  it.each(["ENOENT", "EACCES"])("does not run again when the CLI cannot be run (%s)", (code) => {
    expect(doctorFailureIsRetryable(Object.assign(new Error(`spawn openclaw ${code}`), { code }))).toBe(false);
  });

  it("does not run again over a config doctor cannot parse: a second run reads the same bytes", () => {
    expect(doctorFailureIsRetryable(new Error(
      "Config at /opt/box/.openclaw/openclaw.json is not parseable and cannot be repaired automatically. The file remains unchanged.",
    ))).toBe(false);
  });
});

describe("doctorFailureTail", () => {
  it("keeps the END — the verdict — and drops the banner", () => {
    const message = `(node:1) DeprecationWarning: ${"w".repeat(3000)}\n│\n└  Doctor finished, but config fixes were not applied.`;
    const tail = doctorFailureTail(new Error(message));
    expect(tail.length).toBeLessThanOrEqual(DOCTOR_TAIL_CHARS + 1);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("Doctor finished, but config fixes were not applied.")).toBe(true);
    expect(tail).not.toContain("DeprecationWarning");
  });

  it("takes the frame off doctor's boxes and collapses the whitespace they leave", () => {
    const tail = doctorFailureTail(new Error("◇  Doctor warnings ───────╮\n│  The config changed after Doctor prepared these repairs.  │\n├──────────╯"));
    expect(tail).toBe("Doctor warnings The config changed after Doctor prepared these repairs.");
  });

  it("returns a short message whole, and says something for a non-Error", () => {
    expect(doctorFailureTail(new Error("doctor exploded"))).toBe("doctor exploded");
    expect(doctorFailureTail("boom")).toBe("boom");
  });

  it("honours a narrower bound", () => {
    expect(doctorFailureTail(new Error("a".repeat(100)), 10)).toBe(`…${"a".repeat(10)}`);
  });
});
