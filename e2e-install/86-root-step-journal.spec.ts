/**
 * Why a failed root step failed, read the way the product reads it: through
 * this container's real journalctl, which is Ubuntu 22.04's systemd 249, the
 * version JetPack 6 boxes run.
 *
 * On 249, `journalctl --since T -n N` seeks to T and reads FORWARD, so it
 * answers the FIRST N entries of the window, not the last N. A failed update
 * once showed the owner npm's "npm notice" banner from the start of the step
 * instead of the installer's `Error:` line at its end. The unit suites check
 * the readers against a model of journalctl (src/tests/helpers/journalctl-model.ts);
 * this spec checks them against the binary.
 *
 * The probe is a real instance of the root-step template with only its
 * ExecStart replaced by a runtime drop-in: the shipped reader takes a step
 * name, not a unit, so the probe is the unit that name stands for. It prints
 * N lines, then an `Error:` line on stderr as install.sh does, and exits 1.
 *
 * Numbered late on purpose: it reloads systemd and writes 20,000 journal
 * lines, which the setup wizard and the UI specs should not run right after.
 *
 * `readRootStepFailure` is private to updater.ts, so
 * the reader script loads a copy of the shipped file with one export line
 * added, written beside it so every import resolves as it does in the product,
 * and deletes it once loaded. Nothing in the product changes for the test.
 *
 * It reads as root: in this container the clawbox user is in neither `adm`
 * nor `systemd-journal` (e2e-install/Dockerfile), and which user reads does
 * not change the order journalctl answers in.
 */
import { test, expect } from "@playwright/test";
import { dockerExec } from "./helpers/container";

const PROJECT_DIR = "/home/clawbox/clawbox";
const LIB_DIR = `${PROJECT_DIR}/src/lib`;
const BUN = "/home/clawbox/.bun/bin/bun";
const STEP = "e2e_journal_probe";
const UNIT = `clawbox-root-update@${STEP}.service`;
const DROP_IN_DIR = `/run/systemd/system/${UNIT}.d`;
const PROBE_SCRIPT = "/run/clawbox-e2e-journal-probe.sh";
const UPDATER_COPY = `${LIB_DIR}/.e2e-journal-probe-updater.ts`;
const RESULT_MARK = "E2E_JOURNAL_PROBE ";
/** Each probe's `Error:` line names its length, so no window can pass off another probe's line as its own. */
const errorLine = (lines: number) => `Error: the probe step failed after ${lines} lines of output`;

/** Installs the probe instance, runs it once, and reports how it ended. The body arrives as `$1`. */
const START_PROBE = [
  `mkdir -p ${DROP_IN_DIR}`,
  `printf '%s\\n' "$1" > ${PROBE_SCRIPT}`,
  `printf '[Service]\\nExecStart=\\nExecStart=/bin/bash ${PROBE_SCRIPT}\\n' > ${DROP_IN_DIR}/50-e2e-probe.conf`,
  "systemctl daemon-reload",
  `systemctl reset-failed ${UNIT} 2>/dev/null`,
  `echo "journalctl=$(journalctl --version | head -n 1)"`,
  // The window opens here, as the updater opens it when it dispatches a step.
  `echo "since=$(date +%s%3N)"`,
  `systemctl start ${UNIT}; echo "start=$?"`,
  "journalctl --sync",
  `systemctl show -p Result -p ExecMainStatus ${UNIT}`,
].join("\n");

const field = (out: string, name: string): string | undefined =>
  new RegExp(`^${name}=(.*)$`, "m").exec(out)?.[1]?.trim();

/** Runs the probe with `lines` ordinary lines before its `Error:` line; answers the window's start in ms. */
async function runProbe(lines: number): Promise<number> {
  const body = [
    `for i in $(seq 1 ${lines}); do echo "probe line $i"; done`,
    `echo "${errorLine(lines)}" >&2`,
    "exit 1",
  ].join("\n");
  const out = await dockerExec(["bash", "-c", START_PROBE, "probe", body], { user: "root", timeoutMs: 120_000 });
  console.log(`[root-step journal] ${field(out, "journalctl")}; probe of ${lines} lines`);
  const sinceMs = Number(field(out, "since"));
  expect(Number.isFinite(sinceMs), "fixture: no start time was recorded").toBe(true);
  expect(field(out, "start"), "fixture: the probe step should fail").not.toBe("0");
  expect(field(out, "Result"), "fixture: systemd should record the probe's own exit").toBe("exit-code");
  expect(field(out, "ExecMainStatus"), "fixture: the probe exits 1").toBe("1");
  return sinceMs;
}

/** Runs in the container under bun, against the tree the container installed. */
function readerScript(sinceMs: number, error: string): string {
  return `
(async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const run = promisify(execFile);
  const step = ${JSON.stringify(STEP)};
  const sinceMs = ${sinceMs};
  const journal = await import(${JSON.stringify(`${LIB_DIR}/root-step-journal.ts`)});
  const entries = (text) => String(text).split("\\n").filter((line) => line !== "");

  // journald takes a unit's output from a stream, so the run's last line can
  // land after systemctl returned. Wait for it on the whole window, read
  // through the shipped args, before the read under test.
  const started = Date.now();
  let whole = [];
  for (;;) {
    const { stdout } = await run("/usr/bin/journalctl", journal.rootStepJournalArgs(step, { sinceMs }), {
      timeout: 10000,
      maxBuffer: 16 << 20,
    });
    whole = entries(stdout);
    if (whole.includes(${JSON.stringify(error)}) || Date.now() - started > 30000) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const waitedMs = Date.now() - started;

  // The read the updater makes of a failed step: the window's newest 40 entries.
  const read = entries(await journal.readRootStepJournalTail(step, { sinceMs, lines: 40, timeoutMs: 10000 }));

  writeFileSync(${JSON.stringify(UPDATER_COPY)}, readFileSync(${JSON.stringify(`${LIB_DIR}/updater.ts`)}, "utf8")
    + "\\nexport { readRootStepFailure as e2eReport };\\n");
  let updater;
  try {
    updater = await import(${JSON.stringify(UPDATER_COPY)});
  } finally {
    rmSync(${JSON.stringify(UPDATER_COPY)}, { force: true });
  }

  console.log(${JSON.stringify(RESULT_MARK)} + JSON.stringify({
    waitedMs,
    whole,
    read: { count: read.length, first: read[0] ?? null, last: read.at(-1) ?? null },
    reported: await updater.e2eReport(step, sinceMs),
  }));
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
`;
}

interface ReadSummary {
  count: number;
  first: string | null;
  last: string | null;
}

interface UpdaterRead {
  waitedMs: number;
  whole: string[];
  read: ReadSummary;
  reported: string | null;
}

/** The gateway pre-start's reader (`journal_lines`), loaded from the shipped script and run on the probe unit. */
const PRESTART_READ = [
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('db_maintenance', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "lines = module.journal_lines(sys.argv[2], float(sys.argv[3]))",
  "print(json.dumps({'count': len(lines), 'first': lines[0][1] if lines else None,"
  + " 'last': lines[-1][1] if lines else None}))",
].join("\n");

test.describe("a failed root step, read through the real journalctl", () => {
  test.afterAll(async () => {
    const cleanup = `systemctl reset-failed ${UNIT} 2>/dev/null; `
      + `rm -rf ${DROP_IN_DIR} ${PROBE_SCRIPT} ${UPDATER_COPY}; systemctl daemon-reload`;
    await dockerExec(["bash", "-c", cleanup], { user: "root", timeoutMs: 60_000 });
  });

  test("the updater reports the step's Error: line, not a line from the start of its output", async () => {
    const lines = 120;
    const error = errorLine(lines);
    const sinceMs = await runProbe(lines);

    const out = await dockerExec(
      ["bash", "-c", `cd ${PROJECT_DIR} && exec ${BUN} -e "$0"`, readerScript(sinceMs, error)],
      { user: "root", timeoutMs: 180_000 },
    );
    const line = out.split("\n").find((l) => l.startsWith(RESULT_MARK));
    expect(line, "fixture: the reader script printed no result").toBeDefined();
    const probe = JSON.parse((line ?? "").slice(RESULT_MARK.length)) as UpdaterRead;

    console.log(`[root-step journal] whole window: ${probe.whole.length} entries, waited ${probe.waitedMs} ms`);
    console.log(
      `[root-step journal] the updater's read: ${probe.read.count} entries, first ${JSON.stringify(probe.read.first)}, `
      + `last ${JSON.stringify(probe.read.last)}`,
    );
    console.log(`[root-step journal] readRootStepFailure: ${JSON.stringify(probe.reported)}`);

    for (const want of ["probe line 1", `probe line ${lines}`, error]) {
      expect(probe.whole, `fixture: the whole window should hold "${want}"`).toContain(want);
    }
    expect(probe.reported, "fixture: readRootStepFailure answered nothing, so the journal was not read").not.toBeNull();
    expect(probe.reported, "the line the updater reports for the failed step").toBe(error);
  });

  test("the gateway pre-start's journal reader returns the window's newest entries", async () => {
    // journal_lines reads at most 20000 entries; the probe's Error: line is entry 20101.
    const lines = 20_100;
    const error = errorLine(lines);
    const sinceMs = await runProbe(lines);

    const held = await dockerExec(
      ["bash", "-c",
        `for _ in $(seq 1 60); do journalctl -u ${UNIT} --since @${(sinceMs / 1000).toFixed(3)} -o cat --no-pager`
        + ` | grep -qxF "$1" && { echo held; exit 0; }; sleep 0.5; done; echo missing`, "wait", error],
      { user: "root", timeoutMs: 120_000 },
    );
    expect(held.trim(), "fixture: the journal should hold the probe's Error: line").toBe("held");

    const script = `${PROJECT_DIR}/scripts/openclaw-db-maintenance.py`;
    const out = await dockerExec(
      // -B: an import as root must not leave a compiled copy beside the shipped script.
      ["python3", "-I", "-B", "-c", PRESTART_READ, script, UNIT, String(sinceMs / 1000)],
      { user: "root", timeoutMs: 120_000 },
    );
    const read = JSON.parse(out.trim().split("\n").pop() ?? "{}") as ReadSummary;
    console.log(
      `[root-step journal] journal_lines: ${read.count} entries, `
      + `first ${JSON.stringify(read.first)}, last ${JSON.stringify(read.last)}`,
    );
    expect(read.count, "fixture: journal_lines read nothing").toBeGreaterThan(0);
    expect(read.last, "the newest line journal_lines returns").toBe(error);
  });
});
