import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Scheduled-job alerts (TASK-2179): "If a scheduled job dies quietly, nothing
// raises an alarm." What has to hold, and what a regression would look like
// to the owner:
//
//   * a failing job is told ONCE — not every two minutes while it stays broken;
//   * its recovery is told once, and only when the failure was;
//   * a job flapping every few minutes costs two messages per cooldown, and a
//     job that KEEPS failing after its cooldown is told again rather than left
//     looking recovered;
//   * a dead scheduler closes no incident, and its jobs go overdue on the
//     schedule it last reported;
//   * twenty jobs going bad at once is one message;
//   * the switch is read at every check, and off means nothing is read or sent.

const DAY = 24 * 60 * 60_000;
const MIN = 60_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");

let dataDir: string;
const configValues = new Map<string, unknown>();

vi.mock("@/lib/config-store", () => ({
  get DATA_DIR() { return dataDir; },
  get: vi.fn(async (key: string) => configValues.get(key)),
  set: vi.fn(async (key: string, value: unknown) => { configValues.set(key, value); }),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/job-alerts-sources", () => ({ readJobs: vi.fn() }));
vi.mock("@/lib/email-notify", () => ({ notifyOwner: vi.fn(async () => undefined) }));
vi.mock("@/lib/owner-telegram", () => ({ notifyOwnerTelegram: vi.fn(async () => undefined) }));

import {
  advanceJobAlerts,
  buildAlertText,
  buildRecoveryText,
  checkScheduledJobs,
  emptyJobAlertsState,
  judgeJob,
  jobAlertsOff,
  readJobAlertsStatus,
  translatorFor,
  OVERDUE_GRACE_MS,
  REALERT_COOLDOWN_MS,
  type JobAlertsState,
  type NoticeItem,
} from "@/lib/job-alerts";
import type { JobSource, WatchedJob } from "@/lib/job-alerts-sources";
import { readJobs } from "@/lib/job-alerts-sources";
import { notifyOwner } from "@/lib/email-notify";
import { notifyOwnerTelegram } from "@/lib/owner-telegram";
import { getActiveHarness } from "@/lib/harness";
import { jobAlertsEn } from "@/lib/edition-translations/en-job-alerts";

function job(over: Partial<WatchedJob> = {}): WatchedJob {
  return {
    id: "daily-report",
    name: "Daily report",
    timed: true,
    lastStatus: "ok",
    lastRunAtMs: NOW - 10 * MIN,
    nextRunAtMs: NOW + DAY,
    running: false,
    consecutiveErrors: 0,
    consecutiveSkipped: 0,
    stopped: false,
    error: null,
    ...over,
  };
}

function src(jobs: WatchedJob[], over: Partial<JobSource> = {}): JobSource {
  return { runtime: "openclaw", reachable: true, jobs, ...over };
}

const en = translatorFor(jobAlertsEn);

describe("judgeJob", () => {
  it("a job that ran fine and runs again later is fine", () => {
    expect(judgeJob(job(), NOW).problem).toBeNull();
  });

  it("a daily job is reported on its FIRST failure — the next try is a day away", () => {
    expect(judgeJob(job({ lastStatus: "error", consecutiveErrors: 1 }), NOW))
      .toEqual({ problem: "failing", count: 1 });
  });

  it("a job retrying within the hour gets that try first, and is reported on the second failure", () => {
    const soon = { lastStatus: "error" as const, nextRunAtMs: NOW + 2 * MIN };
    expect(judgeJob(job({ ...soon, consecutiveErrors: 1 }), NOW).problem).toBeNull();
    expect(judgeJob(job({ ...soon, consecutiveErrors: 2 }), NOW)).toEqual({ problem: "failing", count: 2 });
  });

  it("a one-shot that failed (no next run) is reported at once", () => {
    expect(judgeJob(job({ lastStatus: "error", consecutiveErrors: 1, nextRunAtMs: null }), NOW).problem).toBe("failing");
  });

  it("an error with no count from the scheduler counts as one", () => {
    expect(judgeJob(job({ lastStatus: "error", consecutiveErrors: null }), NOW)).toEqual({ problem: "failing", count: 1 });
  });

  it("one or two skips are by design; three in a row are a problem", () => {
    expect(judgeJob(job({ lastStatus: "skipped", consecutiveSkipped: 2 }), NOW).problem).toBeNull();
    expect(judgeJob(job({ lastStatus: "skipped", consecutiveSkipped: 3 }), NOW)).toEqual({ problem: "skipping", count: 3 });
  });

  it("a skip after failures has not recovered the job", () => {
    expect(judgeJob(job({ lastStatus: "skipped", consecutiveErrors: 3, consecutiveSkipped: 1 }), NOW))
      .toEqual({ problem: "failing", count: 3 });
  });

  it("a job past its due time beyond the grace, and not running, is overdue", () => {
    const due = NOW - OVERDUE_GRACE_MS - MIN;
    expect(judgeJob(job({ nextRunAtMs: due }), NOW).problem).toBe("overdue");
    expect(judgeJob(job({ nextRunAtMs: NOW - OVERDUE_GRACE_MS + MIN }), NOW).problem).toBeNull();
    expect(judgeJob(job({ nextRunAtMs: due, running: true }), NOW).problem).toBeNull();
    // An event-driven job has no due time to be late for.
    expect(judgeJob(job({ nextRunAtMs: due, timed: false }), NOW).problem).toBeNull();
  });

  it("a job the scheduler switched off is reported as stopped, whatever else it says", () => {
    expect(judgeJob(job({ stopped: true, consecutiveErrors: 10, lastStatus: "error" }), NOW))
      .toEqual({ problem: "stopped", count: 10 });
  });
});

describe("advanceJobAlerts", () => {
  const failing = job({ lastStatus: "error", consecutiveErrors: 1, error: "exit code 1" });

  it("alerts once when a job goes bad, and not again while it stays bad", () => {
    const first = advanceJobAlerts(emptyJobAlertsState(), src([failing]), NOW);
    expect(first.alerts).toEqual([{ id: "daily-report", name: "Daily report", problem: "failing", count: 1 }]);
    expect(first.state.jobs["daily-report"]).toMatchObject({ problem: "failing", alerted: true, since: NOW, error: "exit code 1" });

    const second = advanceJobAlerts(first.state, src([job({ ...failing, consecutiveErrors: 2 })]), NOW + 2 * MIN);
    expect(second.alerts).toEqual([]);
    expect(second.recoveries).toEqual([]);
    expect(second.state.jobs["daily-report"]).toMatchObject({ problem: "failing", count: 2, since: NOW });
  });

  it("an incident that changes kind (overdue, then failing) is still one incident", () => {
    const late = job({ nextRunAtMs: NOW - OVERDUE_GRACE_MS - MIN });
    const first = advanceJobAlerts(emptyJobAlertsState(), src([late]), NOW);
    expect(first.alerts.map((a) => a.problem)).toEqual(["overdue"]);
    const second = advanceJobAlerts(first.state, src([failing]), NOW + MIN);
    expect(second.alerts).toEqual([]);
    expect(second.state.jobs["daily-report"].problem).toBe("failing");
  });

  it("tells the recovery once, then forgets the incident", () => {
    const bad = advanceJobAlerts(emptyJobAlertsState(), src([failing]), NOW);
    const good = advanceJobAlerts(bad.state, src([job()]), NOW + 2 * MIN);
    expect(good.recoveries).toEqual([{ id: "daily-report", name: "Daily report", problem: "failing", count: 1 }]);
    expect(good.state.jobs["daily-report"]).toMatchObject({ problem: null, lastAlertAt: NOW });
    const again = advanceJobAlerts(good.state, src([job()]), NOW + 4 * MIN);
    expect(again.recoveries).toEqual([]);
    expect(again.alerts).toEqual([]);
  });

  it("a flapping job is held back by the cooldown, and its unannounced recovery is not announced", () => {
    let s: JobAlertsState = emptyJobAlertsState();
    const sent: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const step = advanceJobAlerts(s, src([i % 2 === 0 ? failing : job()]), NOW + i * 5 * MIN);
      sent.push(...step.alerts.map(() => "alert"), ...step.recoveries.map(() => "recovered"));
      s = step.state;
    }
    expect(sent).toEqual(["alert", "recovered"]);
  });

  it("a job that keeps failing past its cooldown is told again rather than left looking recovered", () => {
    const bad = advanceJobAlerts(emptyJobAlertsState(), src([failing]), NOW);
    const ok = advanceJobAlerts(bad.state, src([job()]), NOW + 5 * MIN);
    const badAgain = advanceJobAlerts(ok.state, src([failing]), NOW + 10 * MIN);
    expect(badAgain.alerts).toEqual([]);
    expect(badAgain.state.jobs["daily-report"]).toMatchObject({ problem: "failing", alerted: false });
    const later = advanceJobAlerts(badAgain.state, src([failing]), NOW + REALERT_COOLDOWN_MS + MIN);
    expect(later.alerts.map((a) => a.id)).toEqual(["daily-report"]);
    expect(later.state.jobs["daily-report"]).toMatchObject({ alerted: true, since: NOW + 10 * MIN });
  });

  it("everything that goes bad in one check is one notice", () => {
    const jobs = Array.from({ length: 20 }, (_, i) => job({ id: `j${i}`, name: `Job ${i}`, lastStatus: "error", consecutiveErrors: 1 }));
    const step = advanceJobAlerts(emptyJobAlertsState(), src(jobs), NOW);
    expect(step.alerts).toHaveLength(20);
    expect(buildAlertText(step.alerts, en)).toBe("20 scheduled jobs need attention: “Job 0”, “Job 1”, “Job 2” +17.");
  });

  it("an unreachable scheduler recovers nothing, and its jobs go overdue on the schedule it last gave", () => {
    const other = job({ id: "hourly", name: "Hourly sync", nextRunAtMs: NOW + 30 * MIN });
    const first = advanceJobAlerts(emptyJobAlertsState(), src([failing, other]), NOW);
    expect(first.alerts.map((a) => a.id)).toEqual(["daily-report"]);

    const down = advanceJobAlerts(first.state, src([], { reachable: false }), NOW + 10 * MIN);
    expect(down.recoveries).toEqual([]);
    expect(down.alerts).toEqual([]);
    expect(down.state.reachable).toBe(false);
    expect(down.state.jobs["daily-report"].problem).toBe("failing");
    expect(down.state.watched).toBe(2);

    const stillDown = advanceJobAlerts(down.state, src([], { reachable: false }), NOW + 30 * MIN + OVERDUE_GRACE_MS + MIN);
    expect(stillDown.alerts).toEqual([{ id: "hourly", name: "Hourly sync", problem: "overdue", count: 0 }]);
    expect(stillDown.state.known.hourly).toBeTruthy();
  });

  it("in the warm-up after a start nothing is called late, and an open 'overdue' is not closed", () => {
    const late = job({ nextRunAtMs: NOW - 3 * 60 * MIN });
    const warm = advanceJobAlerts(emptyJobAlertsState(), src([late]), NOW, { lateness: false });
    expect(warm.alerts).toEqual([]);
    // Failures are judged as ever.
    expect(advanceJobAlerts(emptyJobAlertsState(), src([job({ lastStatus: "error", consecutiveErrors: 1 })]), NOW, { lateness: false }).alerts).toHaveLength(1);
    // An overdue incident from before the restart stays open through the warm-up…
    const before = advanceJobAlerts(emptyJobAlertsState(), src([late]), NOW);
    const during = advanceJobAlerts(before.state, src([late]), NOW + 2 * MIN, { lateness: false });
    expect(during.recoveries).toEqual([]);
    expect(during.state.jobs["daily-report"].problem).toBe("overdue");
    // …and closes once the job has run.
    expect(advanceJobAlerts(during.state, src([job()]), NOW + 4 * MIN, { lateness: false }).recoveries).toHaveLength(1);
  });

  it("a job that disappears (deleted, paused) is forgotten without a word", () => {
    const bad = advanceJobAlerts(emptyJobAlertsState(), src([failing]), NOW);
    const gone = advanceJobAlerts(bad.state, src([]), NOW + 2 * MIN);
    expect(gone.recoveries).toEqual([]);
    expect(gone.state.jobs).toEqual({});
  });

  it("after a harness swap the other harness's incidents are not recovered or carried", () => {
    const bad = advanceJobAlerts(emptyJobAlertsState(), src([failing]), NOW);
    const swapped = advanceJobAlerts(bad.state, src([job()], { runtime: "hermes" }), NOW + 2 * MIN);
    expect(swapped.recoveries).toEqual([]);
    expect(swapped.state.runtime).toBe("hermes");
    expect(swapped.state.jobs).toEqual({});
  });

  it("a fresh box with a job already broken is told once", () => {
    const step = advanceJobAlerts(emptyJobAlertsState(), src([job({ stopped: true })]), NOW);
    expect(step.alerts.map((a) => a.problem)).toEqual(["stopped"]);
  });
});

describe("the words", () => {
  const item = (over: Partial<NoticeItem>): NoticeItem => ({ id: "x", name: "Backup", problem: "failing", count: 1, ...over });

  it("one job is one sentence naming it and what went wrong", () => {
    expect(buildAlertText([item({})], en)).toBe("Scheduled job “Backup” failed.");
    expect(buildAlertText([item({ count: 3 })], en)).toBe("Scheduled job “Backup” failed 3 times in a row.");
    expect(buildAlertText([item({ problem: "skipping", count: 3 })], en)).toBe("Scheduled job “Backup” was skipped 3 times in a row.");
    expect(buildAlertText([item({ problem: "overdue", count: 0 })], en)).toBe("Scheduled job “Backup” did not run when it was due.");
    expect(buildAlertText([item({ problem: "stopped" })], en)).toBe("Scheduled job “Backup” failed and is now switched off.");
    expect(buildRecoveryText([item({})], en)).toBe("Scheduled job “Backup” is running normally again.");
    expect(buildRecoveryText([item({}), item({ id: "y", name: "Sync" })], en)).toBe("2 scheduled jobs are running normally again: “Backup”, “Sync”.");
  });

  it("is worded in the box's language from the generated table", async () => {
    const { default: de } = await import("@/lib/translations-generated/de");
    const t = translatorFor(de);
    expect(buildAlertText([item({ count: 2 })], t)).toBe("Geplante Aufgabe „Backup“ ist 2-mal in Folge fehlgeschlagen.");
    expect(t("jobAlerts.notice.where", { section: t("settings.harness") })).toBe("Details: Einstellungen → Harness.");
  });
});

describe("checkScheduledJobs", () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-alerts-"));
    configValues.clear();
    vi.mocked(readJobs).mockReset();
    vi.mocked(notifyOwner).mockClear();
    vi.mocked(notifyOwnerTelegram).mockClear();
    vi.mocked(getActiveHarness).mockResolvedValue("openclaw");
    delete process.env.CLAWBOX_JOB_ALERTS;
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.CLAWBOX_JOB_ALERTS;
  });

  it("sends the alert once on both legs, then the recovery once, across checks and restarts", async () => {
    const failing = job({ lastStatus: "error", consecutiveErrors: 2, nextRunAtMs: NOW + 2 * MIN });
    vi.mocked(readJobs).mockResolvedValue(src([failing]));

    const status = await checkScheduledJobs(NOW);
    expect(status).toMatchObject({ enabled: true, runtime: "openclaw", reachable: true, watched: 1 });
    expect(status.problems).toEqual([expect.objectContaining({ id: "daily-report", problem: "failing", count: 2 })]);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledWith(
      "⚠️ Scheduled job “Daily report” failed 2 times in a row.",
      { open: "settings", section: "harness", focus: "jobAlerts" },
    );
    expect(notifyOwnerTelegram).toHaveBeenCalledWith(
      "⚠️ Scheduled job “Daily report” failed 2 times in a row. Details: Settings → Harness.",
      "job-alerts",
    );

    // The state is on disk: a second check — a restarted server's included — sends nothing.
    await checkScheduledJobs(NOW + 2 * MIN);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "job-alerts.json"), "utf8")).jobs["daily-report"].alerted).toBe(true);

    vi.mocked(readJobs).mockResolvedValue(src([job()]));
    const healed = await checkScheduledJobs(NOW + 4 * MIN);
    expect(healed.problems).toEqual([]);
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    expect(vi.mocked(notifyOwnerTelegram).mock.calls[1][0]).toBe(
      "✅ Scheduled job “Daily report” is running normally again. Details: Settings → Harness.",
    );
    await checkScheduledJobs(NOW + 6 * MIN);
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });

  it("speaks the box's language", async () => {
    configValues.set("pref:ui_language", "de");
    vi.mocked(readJobs).mockResolvedValue(src([job({ lastStatus: "error", consecutiveErrors: 1 })]));
    await checkScheduledJobs(NOW);
    expect(notifyOwner).toHaveBeenCalledWith("⚠️ Geplante Aufgabe „Daily report“ ist fehlgeschlagen.", expect.anything());
  });

  it("switched off by the owner: nothing is read and nothing is sent", async () => {
    configValues.set("pref:ui_job_alerts", false);
    const status = await checkScheduledJobs(NOW);
    expect(status).toMatchObject({ enabled: false, off: "pref" });
    expect(readJobs).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("the operator's environment wins over the preference", async () => {
    process.env.CLAWBOX_JOB_ALERTS = "off";
    configValues.set("pref:ui_job_alerts", true);
    expect(await jobAlertsOff()).toBe("env");
    expect((await readJobAlertsStatus()).enabled).toBe(false);
  });

  it("an unset or unreadable switch is ON", async () => {
    expect(await jobAlertsOff()).toBeNull();
    configValues.set("pref:ui_job_alerts", "maybe");
    expect(await jobAlertsOff()).toBeNull();
  });

  it("two checks at once are one check — never two alerts", async () => {
    vi.mocked(readJobs).mockResolvedValue(src([job({ lastStatus: "error", consecutiveErrors: 1 })]));
    await Promise.all([checkScheduledJobs(NOW), checkScheduledJobs(NOW)]);
    expect(readJobs).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("a damaged state file is a fresh start, not a crash", async () => {
    fs.writeFileSync(path.join(dataDir, "job-alerts.json"), "{not json");
    vi.mocked(readJobs).mockResolvedValue(src([job()]));
    await expect(checkScheduledJobs(NOW)).resolves.toMatchObject({ watched: 1, problems: [] });
  });

  it("a failing leg does not stop the other", async () => {
    vi.mocked(notifyOwner).mockRejectedValueOnce(new Error("kv down"));
    vi.mocked(readJobs).mockResolvedValue(src([job({ lastStatus: "error", consecutiveErrors: 1 })]));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await checkScheduledJobs(NOW);
    expect(notifyOwnerTelegram).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
