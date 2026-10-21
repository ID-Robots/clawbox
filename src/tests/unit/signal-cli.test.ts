import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cancelSignalLink,
  findSignalCli,
  isE164,
  listSignalAccounts,
  readSignalLink,
  resetSignalLinkForTests,
  signalDaemonReachable,
  startSignalLink,
} from "@/lib/signal-cli";

// Starts real processes (a fake signal-cli written per test), so the spawn,
// the stdout parsing and the exit handling are the real code paths.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const NUMBER = "+15550000001";
let dir: string;

function fakeCli(body: string): string {
  const file = path.join(dir, "signal-cli");
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

async function until(predicate: () => boolean, ms = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "signal-cli-"));
  resetSignalLinkForTests();
});

afterEach(() => {
  resetSignalLinkForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("isE164", () => {
  it("accepts international numbers only", () => {
    expect(isE164(NUMBER)).toBe(true);
    for (const bad of ["15550000001", "+0555000000", "+1 555 000", "+1555", "+1234567890123456", "--help"]) {
      expect(isE164(bad)).toBe(false);
    }
  });
});

describe("findSignalCli", () => {
  it("finds an executable on PATH", async () => {
    const cli = fakeCli("exit 0");
    expect(await findSignalCli({ PATH: dir, HOME: dir })).toBe(cli);
  });

  it("ignores a file that is not executable, and relative PATH entries", async () => {
    const cli = fakeCli("exit 0");
    chmodSync(cli, 0o644);
    const found = await findSignalCli({ PATH: `relative:${dir}`, HOME: dir });
    expect(found).not.toBe(cli);
  });
});

describe("listSignalAccounts", () => {
  it("reads the numbers signal-cli holds", async () => {
    const cli = fakeCli(`[ "$1" = listAccounts ] && echo "Number: ${NUMBER}" && echo "Number: ${NUMBER}"`);
    expect(await listSignalAccounts(cli)).toEqual([NUMBER]);
  });

  it("is null when signal-cli fails", async () => {
    const cli = fakeCli("exit 3");
    expect(await listSignalAccounts(cli)).toBeNull();
  });
});

describe("linking", () => {
  it("shows the provisioning URI, then reports the number once signal-cli exits", async () => {
    const cli = fakeCli(`
[ "$1" = link ] || exit 2
[ "$2" = -n ] || exit 2
[ "$3" = ClawBox ] || exit 2
echo "sgnl://linkdevice?uuid=abc&pub_key=def"
sleep 0.5
echo "Associated with: ${NUMBER}"
sleep 0.2
exit 0`);
    expect(startSignalLink(cli, "ClawBox")).toMatchObject({ state: "waiting", uri: null });
    await until(() => {
      const s = readSignalLink();
      return s.state === "waiting" && s.uri !== null;
    });
    expect(readSignalLink()).toMatchObject({ state: "waiting", uri: "sgnl://linkdevice?uuid=abc&pub_key=def" });
    await until(() => readSignalLink().state === "linked");
    expect(readSignalLink()).toEqual({ state: "linked", account: NUMBER });
  });

  it("does not start a second attempt while one is running", async () => {
    const cli = fakeCli(`echo "tsdevice:/?uuid=old"; sleep 5`);
    startSignalLink(cli, "ClawBox");
    await until(() => {
      const s = readSignalLink();
      return s.state === "waiting" && s.uri !== null;
    });
    expect(startSignalLink(cli, "ClawBox")).toMatchObject({ state: "waiting", uri: "tsdevice:/?uuid=old" });
  });

  it("reports a failed link", async () => {
    const cli = fakeCli(`echo "sgnl://linkdevice?uuid=x"; exit 1`);
    startSignalLink(cli, "ClawBox");
    await until(() => readSignalLink().state === "failed");
    expect(readSignalLink()).toEqual({ state: "failed", reason: "error" });
  });

  it("cancels: the process is stopped and the attempt says so", async () => {
    const cli = fakeCli(`echo "sgnl://linkdevice?uuid=x"; sleep 30`);
    startSignalLink(cli, "ClawBox");
    expect(cancelSignalLink()).toEqual({ state: "failed", reason: "cancelled" });
    expect(readSignalLink()).toEqual({ state: "failed", reason: "cancelled" });
  });

  it("is idle before any attempt", () => {
    expect(readSignalLink()).toEqual({ state: "idle" });
  });
});

describe("signalDaemonReachable", () => {
  it("asks the daemon's health check", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await signalDaemonReachable("http://127.0.0.1:8080")).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8080/api/v1/check");
    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));
    expect(await signalDaemonReachable()).toBe(false);
    vi.unstubAllGlobals();
  });
});
