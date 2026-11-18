import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { readExternalEngine, readExternalEngineKey, type ExternalEngineRecord } from "@/lib/external-engine";
import { withLocalAiTransitionLock } from "@/lib/local-ai-transition-lock";
import {
  COLLECTOR_SCRIPT,
  ENGINE_CHANGING,
  ENGINE_DEADLINE_MS,
  FRESH_MS,
  MAX_PEERS,
  _resetClusterForTest,
  _setClusterDepsForTest,
  clusterAnswer,
  clusterEnabled,
  clusterMode,
  clusterPeers,
  failureOf,
  isLanAddress,
  lanRefusal,
  runScript,
  targetHost,
  type EngineTarget,
  type ScriptResult,
  type ScriptRunner,
} from "@/lib/cluster-view";
import { parseSparkOutput, type ClusterSnapshot } from "@/lib/cluster-shared";

// The collector script and `runScript` start real processes (`sh`), which on a loaded runner can take a while.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The saved engine's record and key file, for the one test that reads them the
// way the route does; every other test hands `readEngine` its answer.
vi.mock("@/lib/external-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/external-engine")>()),
  readExternalEngine: vi.fn(async () => null),
  readExternalEngineKey: vi.fn(() => null),
}));

/**
 * Settings → System → Cluster (TASK-2670), server half. Nothing here reads a real
 * machine except the two tests that say so: every Spark is a scripted answer,
 * the engine is a stubbed fetch, and the clock is a variable.
 */

const GOOD = (host: string, mem = "MemTotal: 125829120 kB\nMemAvailable: 25165824 kB") => [
  `CBX host ${host}`,
  "CBX cpu1 cpu  1000 0 500 8000 100 0 0 0",
  "CBX cpu2 cpu  1100 0 550 8050 100 0 0 0",
  "CBX up 5000.1 100.0",
  ...mem.split("\n").map((l) => `CBX mem ${l}`),
  "CBX gpu NVIDIA GB10, 0, 48, [N/A], [N/A]",
  "CBX disk /dev/nvme0n1p2 976762584 488381292 488381292 50% /",
  "CBX end",
  "",
].join("\n");

const ok = (stdout: string): ScriptResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const sshFailure = (stderr: string, code = 255): ScriptResult => ({ code, stdout: "", stderr, timedOut: false });

interface Call {
  command: string;
  args: string[];
  input: string;
  timeoutMs: number;
}

let clock = 1_000_000;
let calls: Call[];

/** A runner that answers by the ssh target (or "local" for `sh -s`). */
function runnerBy(answers: Record<string, ScriptResult | Promise<ScriptResult>>): ScriptRunner {
  return vi.fn(async (command, args, input, timeoutMs) => {
    calls.push({ command, args, input, timeoutMs });
    const key = command === "ssh" ? args[args.indexOf("--") + 1] : "local";
    const answer = answers[key];
    return answer ?? sshFailure("ssh: Could not resolve hostname", 255);
  });
}

const PEERS = "spark-b spark-c spark-d";

function setup(extra: Parameters<typeof _setClusterDepsForTest>[0] = {}) {
  _setClusterDepsForTest({
    env: { CLAWBOX_CLUSTER_PEERS: PEERS } as unknown as NodeJS.ProcessEnv,
    now: () => clock,
    isWorkstation: () => true,
    readEngine: async () => null,
    ...extra,
  });
}

beforeEach(() => {
  clock = 1_000_000;
  calls = [];
  _resetClusterForTest();
});

afterEach(() => {
  _resetClusterForTest();
  vi.restoreAllMocks();
});

describe("clusterPeers", () => {
  it("takes ssh targets separated by spaces, commas or newlines, once each", () => {
    const { targets, ignored } = clusterPeers({ CLAWBOX_CLUSTER_PEERS: "a.example, b\nc  a.example ops@d" } as unknown as NodeJS.ProcessEnv);
    expect(targets).toEqual(["a.example", "b", "c", "ops@d"]);
    expect(ignored).toBe(0);
  });

  it("reads a quoted value as .env loaders may leave it", () => {
    expect(clusterPeers({ CLAWBOX_CLUSTER_PEERS: '"b c"' } as unknown as NodeJS.ProcessEnv).targets).toEqual(["b", "c"]);
  });

  it("refuses anything that could be read as an ssh option or carry a shell character", () => {
    const bad = ["-oProxyCommand=touch", "-F/etc/passwd", "a;b", "$(id)", "`id`", "host:22", "a/b", "user@@host", "[::1]", "a&b", "x'y", "x\"y", "@host", "user@"];
    const { targets, ignored } = clusterPeers({ CLAWBOX_CLUSTER_PEERS: ["good", ...bad].join(" ") } as unknown as NodeJS.ProcessEnv);
    expect(targets).toEqual(["good"]);
    expect(ignored).toBe(bad.length);
  });

  it("stops at the cap, counting the rest as ignored", () => {
    const many = Array.from({ length: MAX_PEERS + 3 }, (_, i) => `h${i}`).join(" ");
    const { targets, ignored } = clusterPeers({ CLAWBOX_CLUSTER_PEERS: many } as unknown as NodeJS.ProcessEnv);
    expect(targets).toHaveLength(MAX_PEERS);
    expect(ignored).toBe(3);
  });

  it("is empty when unset", () => {
    expect(clusterPeers({} as unknown as NodeJS.ProcessEnv)).toEqual({ targets: [], ignored: 0 });
  });

  it("names an offline Spark by the host part of its target", () => {
    expect(targetHost("ops@spark-b")).toBe("spark-b");
    expect(targetHost("spark-b")).toBe("spark-b");
  });
});

describe("clusterMode and clusterEnabled", () => {
  it("reads the mode, and anything it does not know is auto", () => {
    const mode = (v?: string) => clusterMode({ CLAWBOX_CLUSTER_VIEW: v } as unknown as NodeJS.ProcessEnv);
    expect(mode()).toBe("auto");
    expect(mode("auto")).toBe("auto");
    expect(mode("ON")).toBe("on");
    expect(mode("1")).toBe("on");
    expect(mode("off")).toBe("off");
    expect(mode("false")).toBe("off");
    expect(mode("sometimes")).toBe("auto");
  });

  const enabled = (env: Record<string, string>, workstation: boolean) =>
    clusterEnabled({
      env: env as unknown as NodeJS.ProcessEnv,
      now: () => clock,
      run: runnerBy({}),
      isWorkstation: () => workstation,
      readEngine: async () => null,
      fetchImpl: fetch,
      lookup: async () => [],
    });

  it("shows on a Workstation that has peers", () => {
    expect(enabled({ CLAWBOX_CLUSTER_PEERS: "b" }, true)).toBe(true);
  });

  it("is hidden on a box that is not a Workstation, however many peers are listed", () => {
    expect(enabled({ CLAWBOX_CLUSTER_PEERS: "b c" }, false)).toBe(false);
  });

  it("is hidden on a Workstation with no peers, or only invalid ones", () => {
    expect(enabled({}, true)).toBe(false);
    expect(enabled({ CLAWBOX_CLUSTER_PEERS: "-oBad" }, true)).toBe(false);
  });

  it("'on' shows it on a box that is not a Workstation, but never without peers", () => {
    expect(enabled({ CLAWBOX_CLUSTER_VIEW: "on", CLAWBOX_CLUSTER_PEERS: "b" }, false)).toBe(true);
    expect(enabled({ CLAWBOX_CLUSTER_VIEW: "on" }, false)).toBe(false);
  });

  it("'off' hides it on a Workstation", () => {
    expect(enabled({ CLAWBOX_CLUSTER_VIEW: "off", CLAWBOX_CLUSTER_PEERS: "b" }, true)).toBe(false);
  });
});

describe("failureOf", () => {
  const f = (stderr: string, code: number | null = 255, timedOut = false) => failureOf({ code, stdout: "", stderr, timedOut });
  it("names why a Spark could not be read, from what ssh said", () => {
    expect(f("", null, true)).toBe("timeout");
    expect(f("ssh: connect to host x port 22: Connection timed out")).toBe("timeout");
    expect(f("ops@x: Permission denied (publickey).")).toBe("auth");
    expect(f("Host key verification failed.")).toBe("host_key");
    expect(f("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")).toBe("host_key");
    expect(f("ssh: connect to host x port 22: Connection refused")).toBe("unreachable");
    expect(f("ssh: connect to host x port 22: No route to host")).toBe("unreachable");
    expect(f("ssh: Could not resolve hostname x")).toBe("unreachable");
    expect(f("")).toBe("unreachable");
    expect(f("sh: 1: boom", 1)).toBe("failed");
    expect(f("", null)).toBe("failed");
  });
});

describe("the collector script", () => {
  it("is one brace group, so the shell has read all of it before any command can read the stream", () => {
    expect(COLLECTOR_SCRIPT.startsWith("{\n")).toBe(true);
    expect(COLLECTOR_SCRIPT.trimEnd().endsWith("}")).toBe(true);
  });

  it("only reads: no write redirection but to /dev/null, and none of the commands that change a machine", () => {
    const stripped = COLLECTOR_SCRIPT.replaceAll("2>/dev/null", "").replaceAll(">/dev/null", "").replaceAll("</dev/null", "").replaceAll("2>&1", "");
    expect(stripped).not.toMatch(/[<>]/);
    for (const verb of ["rm ", "mv ", "cp ", "tee ", "chmod", "chown", "kill", "systemctl", "apt", "pip", "curl", "wget", "sudo", "reboot", "ssh "]) {
      expect(COLLECTOR_SCRIPT, verb).not.toContain(verb);
    }
  });

  it("names the Spark from the kernel when there is no hostname program", () => {
    expect(COLLECTOR_SCRIPT).toContain("/proc/sys/kernel/hostname");
  });

  it("prints every figure under the collector's prefix", () => {
    for (const line of COLLECTOR_SCRIPT.split("\n").filter((l) => l.includes("echo "))) {
      expect(line, line).toContain('"CBX ');
    }
  });

  it.skipIf(process.platform !== "linux")("runs on this machine and reads back as a Spark (script and parser agree)", () => {
    const stdout = execFileSync("sh", ["-s"], { input: COLLECTOR_SCRIPT, encoding: "utf-8", timeout: 20_000 });
    const parsed = parseSparkOutput(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.hostname.length).toBeGreaterThan(0);
    expect(parsed!.figures.memory?.totalBytes ?? 0).toBeGreaterThan(0);
    expect(parsed!.figures.disk?.totalBytes ?? 0).toBeGreaterThan(0);
  });
});

describe("runScript", () => {
  it.skipIf(process.platform === "win32")("feeds the script on standard input and returns what it printed", async () => {
    const res = await runScript("sh", ["-s"], "echo hello\n", 5_000);
    expect(res).toMatchObject({ code: 0, stdout: "hello\n", timedOut: false });
  });

  it.skipIf(process.platform === "win32")("stops a child that does not finish, at the ceiling, and says it timed out", async () => {
    const started = Date.now();
    const res = await runScript("sh", ["-c", "sleep 30"], "", 300);
    expect(res.timedOut).toBe(true);
    expect(res.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it.skipIf(process.platform === "win32")("stops what the shell started too — a pipeline it waits on cannot outlive the deadline", async () => {
    // The shell waits on a pipeline, as the collector does on `df … | tail`; the
    // first stage prints its own pid so the test can look for it afterwards.
    const res = await runScript("sh", ["-s"], 'sh -c \'echo "$$"; exec sleep 30\' | cat\n', 500);
    expect(res.timedOut).toBe(true);
    const pid = Number(res.stdout.trim().split("\n")[0]);
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    const alive = () => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      // A killed process answers signal 0 until it is reaped: a zombie (state Z) is gone.
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 3_000;
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not hand the web server's own environment to what it runs", async () => {
    process.env.CLUSTER_TEST_SECRET = "must-not-leak";
    try {
      const res = await runScript("sh", ["-s"], 'echo "[${CLUSTER_TEST_SECRET:-absent}] [${LC_ALL:-none}] [${PATH:+path}]"\n', 5_000);
      expect(res.stdout.trim()).toBe("[absent] [C] [path]");
    } finally {
      delete process.env.CLUSTER_TEST_SECRET;
    }
  });

  it("answers, rather than throwing, for a program that is not there", async () => {
    const res = await runScript("definitely-not-a-program-clawbox", [], "", 2_000);
    expect(res.code).toBeNull();
    expect(res.timedOut).toBe(false);
  });
});

describe("clusterAnswer: the Sparks", () => {
  it("is { enabled: false } where there is no cluster, and reads nothing", async () => {
    const run = runnerBy({});
    setup({ run, isWorkstation: () => false });
    expect(await clusterAnswer()).toEqual({ enabled: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("reads this Spark with `sh -s` and every peer with a locked-down ssh, the same fixed script each", async () => {
    setup({
      run: runnerBy({
        local: ok(GOOD("spark-a")),
        "spark-b": ok(GOOD("spark-b")),
        "spark-c": ok(GOOD("spark-c")),
        "spark-d": ok(GOOD("spark-d")),
      }),
    });
    const answer = (await clusterAnswer()) as ClusterSnapshot;
    expect(answer.enabled).toBe(true);
    expect(answer.sparks.map((s) => [s.id, s.local, s.online, s.hostname])).toEqual([
      ["local", true, true, "spark-a"],
      ["peer-1", false, true, "spark-b"],
      ["peer-2", false, true, "spark-c"],
      ["peer-3", false, true, "spark-d"],
    ]);

    expect(calls).toHaveLength(4);
    const local = calls.find((c) => c.command === "sh")!;
    expect(local.args).toEqual(["-s"]);
    for (const c of calls) {
      expect(c.input).toBe(COLLECTOR_SCRIPT);
      expect(c.timeoutMs).toBeLessThanOrEqual(10_000);
    }
    for (const c of calls.filter((x) => x.command === "ssh")) {
      const dash = c.args.indexOf("--");
      // Every option before `--`, then the target, then the one fixed command.
      expect(c.args.slice(dash + 2)).toEqual(["sh", "-s"]);
      const options = c.args.slice(0, dash).join(" ");
      expect(options).toContain("BatchMode=yes");
      expect(options).toContain("ConnectTimeout=3");
      expect(options).toContain("StrictHostKeyChecking=yes");
      expect(options).toContain("PasswordAuthentication=no");
      expect(options).toContain("ForwardAgent=no");
      expect(options).toContain("IdentitiesOnly=yes");
    }
  });

  it("draws a GB10's N/A GPU memory as unified system memory", async () => {
    setup({ run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    const answer = (await clusterAnswer()) as ClusterSnapshot;
    const local = answer.sparks[0];
    expect(local.figures?.unifiedMemory).toBe(true);
    expect(local.figures?.memory?.percent).toBe(80);
  });

  it("marks a Spark that is down offline, names it by its configured host and says why — and still answers", async () => {
    setup({
      env: { CLAWBOX_CLUSTER_PEERS: "ops@spark-b spark-c spark-d spark-e spark-f" } as unknown as NodeJS.ProcessEnv,
      run: runnerBy({
        local: ok(GOOD("spark-a")),
        "ops@spark-b": ok(GOOD("spark-b")),
        "spark-c": sshFailure("ssh: connect to host spark-c port 22: Connection refused"),
        "spark-d": { code: null, stdout: "", stderr: "", timedOut: true },
        "spark-e": sshFailure("spark-e: Permission denied (publickey)."),
        "spark-f": sshFailure("Host key verification failed."),
      }),
    });
    const answer = (await clusterAnswer()) as ClusterSnapshot;
    const byId = Object.fromEntries(answer.sparks.map((s) => [s.id, s]));
    expect(byId["peer-1"]).toMatchObject({ online: true, hostname: "spark-b" });
    expect(byId["peer-2"]).toMatchObject({ online: false, hostname: "spark-c", failure: "unreachable" });
    expect(byId["peer-3"]).toMatchObject({ online: false, hostname: "spark-d", failure: "timeout" });
    expect(byId["peer-4"]).toMatchObject({ online: false, hostname: "spark-e", failure: "auth" });
    expect(byId["peer-5"]).toMatchObject({ online: false, hostname: "spark-f", failure: "host_key" });
    // An offline card carries no figures: nothing is drawn as zero.
    expect(byId["peer-2"].figures).toBeUndefined();
  });

  it("names this Spark by its own hostname when its collector does not answer", async () => {
    setup({ run: runnerBy({ local: { code: null, stdout: "", stderr: "", timedOut: true }, "spark-b": ok(GOOD("spark-b")) }) });
    const answer = (await clusterAnswer()) as ClusterSnapshot;
    expect(answer.sparks[0]).toMatchObject({ id: "local", local: true, online: false, failure: "timeout" });
    expect(answer.sparks[0].hostname).toBe(os.hostname().replace(/[^\x20-\x7e]/g, "").trim().slice(0, 253));
    expect(answer.sparks[0].hostname).not.toBe("");
  });

  it("calls a Spark whose answer is not the collector's 'failed', not online", async () => {
    setup({ run: runnerBy({ local: ok(GOOD("spark-a")), "spark-b": ok("some login shell greeting\n") }) });
    const answer = (await clusterAnswer()) as ClusterSnapshot;
    expect(answer.sparks[1]).toMatchObject({ online: false, failure: "failed" });
  });

  it("does not let a runner that throws take the page with it", async () => {
    const run: ScriptRunner = vi.fn(async (command) => {
      if (command === "ssh") throw new Error("spawn exploded");
      return ok(GOOD("spark-a"));
    });
    setup({ run });
    const answer = (await clusterAnswer()) as ClusterSnapshot;
    expect(answer.sparks[0].online).toBe(true);
    expect(answer.sparks.slice(1).every((s) => !s.online)).toBe(true);
  });
});

describe("clusterAnswer: remembering, and never blocking", () => {
  it("reads each Spark once however many ask within the fresh window, and again after it", async () => {
    const run = runnerBy({ local: ok(GOOD("spark-a")), "spark-b": ok(GOOD("spark-b")), "spark-c": ok(GOOD("spark-c")), "spark-d": ok(GOOD("spark-d")) });
    setup({ run });
    await Promise.all([clusterAnswer(), clusterAnswer(), clusterAnswer()]);
    expect(run).toHaveBeenCalledTimes(4);
    clock += FRESH_MS - 1;
    await clusterAnswer();
    expect(run).toHaveBeenCalledTimes(4);
    clock += 2;
    await clusterAnswer();
    expect(run).toHaveBeenCalledTimes(8);
  });

  it("answers from what it knows while a Spark that has stopped answering is being re-read", async () => {
    let hang = false;
    let release: (r: ScriptResult) => void = () => {};
    const run: ScriptRunner = vi.fn(async (command, args) => {
      if (command === "ssh" && hang && args.includes("spark-b")) {
        return new Promise<ScriptResult>((resolve) => {
          release = resolve;
        });
      }
      return ok(GOOD(command === "ssh" ? args[args.indexOf("--") + 1] : "spark-a"));
    });
    setup({ run, env: { CLAWBOX_CLUSTER_PEERS: "spark-b" } as unknown as NodeJS.ProcessEnv });
    const first = (await clusterAnswer()) as ClusterSnapshot;
    expect(first.sparks[1].online).toBe(true);

    hang = true;
    clock += FRESH_MS + 1_000;
    // The page gets the last good card at once; the new read is still running.
    const second = (await Promise.race([
      clusterAnswer(),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 500)),
    ])) as ClusterSnapshot | "blocked";
    expect(second).not.toBe("blocked");
    expect((second as ClusterSnapshot).sparks[1].online).toBe(true);

    // When the read ends, the page's next answer is what it found.
    release(sshFailure("ssh: connect to host spark-b port 22: Connection timed out"));
    await new Promise((r) => setTimeout(r, 20));
    expect(((await clusterAnswer()) as ClusterSnapshot).sparks[1]).toMatchObject({ online: false, failure: "timeout" });

    // The Spark comes back: the stale failure is shown once, the read behind it
    // fetches the figures, and the answer after that has them.
    hang = false;
    clock += FRESH_MS + 1_000;
    expect(((await clusterAnswer()) as ClusterSnapshot).sparks[1].online).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(((await clusterAnswer()) as ClusterSnapshot).sparks[1].online).toBe(true);
  });

  it("stamps the answer with its OLDEST card's read, not with the moment it was given", async () => {
    const run = runnerBy({ local: ok(GOOD("spark-a")), "spark-b": ok(GOOD("spark-b")) });
    setup({ run, env: { CLAWBOX_CLUSTER_PEERS: "spark-b" } as unknown as NodeJS.ProcessEnv });
    const first = (await clusterAnswer()) as ClusterSnapshot;
    expect(first.generatedAt).toBe(clock);
    // Past the fresh window: the cards go out from memory while a read runs behind them.
    clock += FRESH_MS + 2_000;
    const second = (await clusterAnswer()) as ClusterSnapshot;
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.generatedAt).toBeLessThan(clock);
  });

  it("remembers a failure for less time, so a Spark that came back shows soon", async () => {
    const answers: Record<string, ScriptResult> = { local: ok(GOOD("spark-a")), "spark-b": sshFailure("Connection refused") };
    const run = runnerBy(answers);
    setup({ run, env: { CLAWBOX_CLUSTER_PEERS: "spark-b" } as unknown as NodeJS.ProcessEnv });
    expect(((await clusterAnswer()) as ClusterSnapshot).sparks[1].online).toBe(false);
    answers["spark-b"] = ok(GOOD("spark-b"));
    clock += 4_100; // past the failure window, inside the success one
    // The stale failure goes out at once; the read behind it picks the Spark up…
    await clusterAnswer();
    await new Promise((r) => setTimeout(r, 20));
    clock += 4_100;
    // …and the next answer has it online.
    expect(((await clusterAnswer()) as ClusterSnapshot).sparks[1].online).toBe(true);
  });
});

describe("isLanAddress and lanRefusal", () => {
  it("is loopback, RFC 1918 and unique-local — and nothing else", () => {
    for (const a of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.9", "127.0.0.1", "::1", "fd00::1", "fc12::9", "::ffff:10.0.0.1", "[::1]"]) { // public-hygiene: allow RFC 1918 example address for the LAN rule
      expect(isLanAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "172.15.255.255", "169.254.169.254", "100.64.0.1", "2001:db8::1", "fe80::1", "::ffff:8.8.8.8", "not-an-address", ""]) { // public-hygiene: allow RFC 1918 example address for the LAN rule
      expect(isLanAddress(a), a).toBe(false);
    }
  });

  it("judges a name by EVERY address it resolves to, and leaves a name that does not resolve to the request", async () => {
    expect(await lanRefusal("engine.lan", async () => [{ address: "192.168.1.5" }])).toBeNull(); // public-hygiene: allow RFC 1918 example address for the LAN rule
    expect(await lanRefusal("engine.lan", async () => [{ address: "192.168.1.5" }, { address: "93.184.216.34" }])).not.toBeNull(); // public-hygiene: allow RFC 1918 example address for the LAN rule
    expect(await lanRefusal("nowhere.invalid", async () => { throw new Error("ENOTFOUND"); })).toBeNull();
    expect(await lanRefusal("93.184.216.34", async () => [])).not.toBeNull();
    expect(await lanRefusal("[fd00::5]", async () => [])).toBeNull(); // public-hygiene: allow RFC 1918 example address for the LAN rule
  });
});

describe("clusterAnswer: the engine", () => {
  const TARGET: EngineTarget = { baseUrl: "http://192.168.1.50:8000/v1", apiKey: "k-test-placeholder", modelId: "deepseek-test" }; // public-hygiene: allow RFC 1918 example address for the LAN rule

  const metricsText = (tokens: number) => [
    "# TYPE vllm:num_requests_running gauge",
    'vllm:num_requests_running{model_name="deepseek-test"} 3',
    'vllm:num_requests_waiting{model_name="deepseek-test"} 2',
    `vllm:generation_tokens_total{model_name="deepseek-test"} ${tokens}`,
    "",
  ].join("\n");

  function engineFetch(options: {
    models?: Response | Error;
    metrics?: Response | Error | ((url: string) => Response | Promise<Response>);
  }) {
    const seen: { url: string; auth: string | null; redirect: RequestRedirect | undefined }[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization"), redirect: init?.redirect });
      const pick = url.endsWith("/models") ? options.models : options.metrics;
      if (pick instanceof Error) throw pick;
      if (typeof pick === "function") return pick(url);
      return pick ?? new Response("not found", { status: 404 });
    });
    return { impl: impl as unknown as typeof fetch, seen };
  }

  const modelsOk = () => new Response(JSON.stringify({ data: [{ id: "deepseek-test" }] }), { status: 200 });
  const engineOf = async () => ((await clusterAnswer()) as ClusterSnapshot).engine;

  it("is `configured: false` with no engine, and makes no request", async () => {
    const { impl } = engineFetch({});
    setup({ fetchImpl: impl, run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    expect(await engineOf()).toEqual({ configured: false });
    expect(impl).not.toHaveBeenCalled();
  });

  it("reports the gate online and the engine's own load from its /metrics, with the key as a bearer to its own origin", async () => {
    const { impl, seen } = engineFetch({ models: modelsOk(), metrics: new Response(metricsText(1000), { status: 200 }) });
    setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    const engine = await engineOf();
    expect(engine.configured).toBe(true);
    expect(engine.model).toBe("deepseek-test");
    expect(engine.gate).toMatchObject({ online: true });
    // First read of a running total is no rate yet: n/a, not 0.
    expect(engine.metrics).toEqual({ available: true, active: 3, queued: 2, tokensPerSecond: null });
    expect(seen.map((s) => s.url).sort()).toEqual(["http://192.168.1.50:8000/metrics", "http://192.168.1.50:8000/v1/models"]); // public-hygiene: allow RFC 1918 example address for the LAN rule
    expect(seen.every((s) => s.auth === "Bearer k-test-placeholder")).toBe(true);
  });

  it("gives tokens per second from the change in the engine's token total between two reads", async () => {
    let tokens = 1_000;
    const { impl } = engineFetch({ models: modelsOk(), metrics: () => new Response(metricsText(tokens), { status: 200 }) });
    setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    await engineOf();
    clock += 10_000;
    tokens = 1_250;
    // A read behind a stale answer: let it land, then ask again.
    await engineOf();
    await new Promise((r) => setTimeout(r, 20));
    expect((await engineOf()).metrics?.tokensPerSecond).toBe(25);
  });

  it("gives no speed from a previous read that is too old to be 'now'", async () => {
    let tokens = 1_000;
    const { impl } = engineFetch({ models: modelsOk(), metrics: () => new Response(metricsText(tokens), { status: 200 }) });
    setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    await engineOf();
    // The owner went away for an hour and came back.
    clock += 3_600_000;
    tokens = 361_000;
    await engineOf();
    await new Promise((r) => setTimeout(r, 20));
    expect((await engineOf()).metrics?.tokensPerSecond).toBeNull();
  });

  it("shows n/a, never zero, for an engine with no metrics endpoint — and still reports the gate", async () => {
    const { impl } = engineFetch({ models: modelsOk(), metrics: new Response("not found", { status: 404 }) });
    setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    const engine = await engineOf();
    expect(engine.gate?.online).toBe(true);
    expect(engine.metrics).toEqual({ available: false, active: null, queued: null, tokensPerSecond: null });
  });

  it("treats metrics that carry none of the known names as unavailable", async () => {
    const { impl } = engineFetch({ models: modelsOk(), metrics: new Response("process_cpu_seconds_total 4\n", { status: 200 }) });
    setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    expect((await engineOf()).metrics?.available).toBe(false);
  });

  it("reports the gate offline when it does not answer, and the reason", async () => {
    const down = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const { impl } = engineFetch({ models: down, metrics: down });
    setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    const engine = await engineOf();
    expect(engine.gate).toEqual({ online: false, reason: "unreachable" });
    expect(engine.metrics?.available).toBe(false);
  });

  it("reports a refused key as the reason", async () => {
    const { impl } = engineFetch({ models: new Response("no", { status: 401 }), metrics: new Response("no", { status: 401 }) });
    setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    expect((await engineOf()).gate).toEqual({ online: false, reason: "unauthorized" });
  });

  it("keeps everything on the LAN: an engine outside it is never contacted", async () => {
    const { impl } = engineFetch({ models: modelsOk(), metrics: new Response(metricsText(1), { status: 200 }) });
    setup({
      fetchImpl: impl,
      readEngine: async () => ({ ...TARGET, baseUrl: "https://engine.example.com/v1" }),
      lookup: async () => [{ address: "93.184.216.34" }],
      run: runnerBy({ local: ok(GOOD("spark-a")) }),
    });
    const engine = await engineOf();
    expect(engine.gate).toEqual({ online: false, reason: "not_lan" });
    expect(engine.metrics).toEqual({ available: false, active: null, queued: null, tokensPerSecond: null });
    expect(impl).not.toHaveBeenCalled();
  });

  it("does not follow a redirect to somewhere else", async () => {
    const { impl, seen } = engineFetch({
      models: modelsOk(),
      metrics: new Response(null, { status: 302, headers: { location: "http://203.0.113.9/metrics" } }),
    });
    setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    const engine = await engineOf();
    expect(engine.metrics?.available).toBe(false);
    expect(seen.every((s) => s.url.startsWith("http://192.168.1.50:8000/"))).toBe(true); // public-hygiene: allow RFC 1918 example address for the LAN rule
    // Every request — the metrics' and the gate's — tells fetch not to follow one.
    const metricsRequests = seen.filter((s) => s.url.endsWith("/metrics"));
    expect(metricsRequests.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.redirect === "manual")).toBe(true);
  });

  it("compares token counts only between reads of the same metrics page", async () => {
    // The engine lives under a path: its own /team/metrics first, the origin's /metrics as the fallback.
    let teamUp = true;
    const { impl } = engineFetch({
      models: modelsOk(),
      metrics: (url) => url === "http://192.168.1.50:8000/team/metrics" // public-hygiene: allow RFC 1918 example address for the LAN rule
        ? (teamUp ? new Response(metricsText(1_000), { status: 200 }) : new Response("gone", { status: 503 }))
        : new Response(metricsText(9_000), { status: 200 }),
    });
    setup({
      fetchImpl: impl,
      readEngine: async () => ({ ...TARGET, baseUrl: "http://192.168.1.50:8000/team/v1" }), // public-hygiene: allow RFC 1918 example address for the LAN rule
      lookup: async () => [],
      run: runnerBy({ local: ok(GOOD("spark-a")) }),
    });
    expect((await engineOf()).metrics?.tokensPerSecond).toBeNull();
    // Ten seconds later only the fallback answers, for another backend: 9,000 vs 1,000 is no rate.
    teamUp = false;
    clock += 10_000;
    await engineOf();
    await new Promise((r) => setTimeout(r, 20));
    expect((await engineOf()).metrics).toMatchObject({ available: true, tokensPerSecond: null });
  });

  it("gives no rate across a counter series that was reset, even when the sum went up", async () => {
    let lines = ['vllm:generation_tokens_total{engine="0"} 1000', 'vllm:generation_tokens_total{engine="1"} 100'];
    const { impl } = engineFetch({ models: modelsOk(), metrics: () => new Response(`${lines.join("\n")}\n`, { status: 200 }) });
    setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    await engineOf();
    clock += 10_000;
    lines = ['vllm:generation_tokens_total{engine="0"} 5', 'vllm:generation_tokens_total{engine="1"} 1200'];
    await engineOf();
    await new Promise((r) => setTimeout(r, 20));
    expect((await engineOf()).metrics?.tokensPerSecond).toBeNull();
  });

  it("stamps the answer with the engine's reading too, when that is the older one", async () => {
    const { impl } = engineFetch({ models: modelsOk(), metrics: new Response(metricsText(1), { status: 200 }) });
    let engineCalls = 0;
    let release: (target: EngineTarget) => void = () => {};
    setup({
      fetchImpl: impl,
      readEngine: async () => {
        engineCalls += 1;
        // The second engine read is held: its old reading is what goes out meanwhile.
        if (engineCalls > 1) return new Promise<EngineTarget>((resolve) => { release = resolve; });
        return TARGET;
      },
      lookup: async () => [],
      run: runnerBy({ local: ok(GOOD("spark-a")), "spark-b": ok(GOOD("spark-b")), "spark-c": ok(GOOD("spark-c")), "spark-d": ok(GOOD("spark-d")) }),
    });
    const first = (await clusterAnswer()) as ClusterSnapshot;
    const engineReadAt = first.engine.checkedAt!;
    expect(engineReadAt).toBe(clock);
    // Past the fresh window: the Sparks are read again at once, the engine's old reading is served.
    clock += FRESH_MS + 1_000;
    await clusterAnswer();
    await new Promise((r) => setTimeout(r, 20));
    clock += 1_000;
    const second = (await clusterAnswer()) as ClusterSnapshot;
    expect(second.sparks[0].checkedAt).toBeGreaterThan(engineReadAt);
    expect(second.engine.checkedAt).toBe(engineReadAt);
    expect(second.generatedAt).toBe(engineReadAt);
    // Let the held read end inside this test.
    release(TARGET);
    await new Promise((r) => setTimeout(r, 20));
  });

  it("is bounded when a name lookup never answers: the gate is reported down at the deadline, the Sparks are not held up", async () => {
    vi.useFakeTimers();
    try {
      const { impl } = engineFetch({});
      setup({
        fetchImpl: impl,
        readEngine: async () => ({ ...TARGET, baseUrl: "http://engine.lan:8000/v1" }),
        lookup: () => new Promise(() => {}),
        run: runnerBy({ local: ok(GOOD("spark-a")) }),
      });
      const pending = clusterAnswer();
      await vi.advanceTimersByTimeAsync(ENGINE_DEADLINE_MS + 100);
      const answer = (await pending) as ClusterSnapshot;
      expect(answer.engine.gate).toEqual({ online: false, reason: "unreachable" });
      expect(answer.sparks[0].online).toBe(true);
      expect(impl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the engine record could not be read — not that none is set up — when reading it fails", async () => {
    const { impl } = engineFetch({});
    setup({
      fetchImpl: impl,
      readEngine: async () => {
        throw new Error("store unreadable");
      },
      run: runnerBy({ local: ok(GOOD("spark-a")) }),
    });
    expect(await engineOf()).toEqual({ configured: false, unread: "unreadable", checkedAt: clock });
    expect(impl).not.toHaveBeenCalled();
  });

  it("reads nothing while the AI settings are being changed, and says so", async () => {
    const { impl } = engineFetch({ models: modelsOk() });
    setup({ fetchImpl: impl, readEngine: async () => ENGINE_CHANGING, run: runnerBy({ local: ok(GOOD("spark-a")) }) });
    expect(await engineOf()).toEqual({ configured: true, unread: "changing", checkedAt: clock });
    expect(impl).not.toHaveBeenCalled();
  });

  it("a read that lost the deadline starts no request once its slow lookup ends", async () => {
    vi.useFakeTimers();
    try {
      let answerLookup: () => void = () => {};
      const { impl } = engineFetch({ models: modelsOk(), metrics: new Response(metricsText(1), { status: 200 }) });
      setup({
        fetchImpl: impl,
        readEngine: async () => ({ ...TARGET, baseUrl: "http://engine.lan:8000/v1" }),
        lookup: () => new Promise((resolve) => {
          answerLookup = () => resolve([{ address: "192.168.1.50" }]); // public-hygiene: allow RFC 1918 example address for the LAN rule
        }),
        run: runnerBy({ local: ok(GOOD("spark-a")) }),
      });
      const pending = clusterAnswer();
      await vi.advanceTimersByTimeAsync(ENGINE_DEADLINE_MS + 100);
      expect(((await pending) as ClusterSnapshot).engine.gate).toEqual({ online: false, reason: "unreachable" });
      // The lookup ends after the deadline: nothing is asked for an answer nobody waits for.
      answerLookup();
      await vi.advanceTimersByTimeAsync(50);
      expect(impl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a metrics answer that arrives after the deadline does not move the token baseline", async () => {
    vi.useFakeTimers();
    try {
      let tokens = 1_000;
      let slow = false;
      const { impl } = engineFetch({
        models: modelsOk(),
        metrics: () => (slow
          ? new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response(metricsText(tokens), { status: 200 })), ENGINE_DEADLINE_MS + 1_000);
          })
          : new Response(metricsText(tokens), { status: 200 })),
      });
      setup({ fetchImpl: impl, readEngine: async () => TARGET, lookup: async () => [], run: runnerBy({ local: ok(GOOD("spark-a")) }) });
      // The baseline: 1,000 tokens.
      await engineOf();

      // The next read's metrics answer only after the deadline, with 1,600.
      slow = true;
      tokens = 1_600;
      clock += FRESH_MS + 30_000; // past STALE_MS: the page waits for this read
      const pending = clusterAnswer();
      await vi.advanceTimersByTimeAsync(ENGINE_DEADLINE_MS + 100);
      expect(((await pending) as ClusterSnapshot).engine.gate).toEqual({ online: false, reason: "unreachable" });
      await vi.advanceTimersByTimeAsync(1_000); // the late answer lands now

      // Five seconds on, 2,100. Had the late 1,600 become the baseline this would
      // read 100 tok/s; against the real baseline (over 30 s old) it is no rate.
      slow = false;
      tokens = 2_100;
      clock += 5_000;
      await engineOf();
      await vi.advanceTimersByTimeAsync(20);
      expect((await engineOf()).metrics).toMatchObject({ available: true, tokensPerSecond: null });
    } finally {
      vi.useRealTimers();
    }
  });

  describe("the saved engine, read as the route reads it", () => {
    const RECORD = {
      baseUrl: "http://192.168.1.50:8000/v1", // public-hygiene: allow RFC 1918 example address for the LAN rule
      modelId: "deepseek-test",
    } as unknown as ExternalEngineRecord;

    function useSavedEngine(fetchImpl: typeof fetch) {
      // Every dependency but `readEngine`: the module's own reads the record and the key.
      _setClusterDepsForTest({
        env: { CLAWBOX_CLUSTER_PEERS: PEERS } as unknown as NodeJS.ProcessEnv,
        now: () => clock,
        isWorkstation: () => true,
        fetchImpl,
        lookup: async () => [],
        run: runnerBy({ local: ok(GOOD("spark-a")) }),
      });
    }

    afterEach(() => {
      vi.mocked(readExternalEngine).mockReset().mockImplementation(async () => null);
      vi.mocked(readExternalEngineKey).mockReset().mockImplementation(() => null);
    });

    it("sends the stored key to the saved engine when nothing is changing", async () => {
      vi.mocked(readExternalEngine).mockImplementation(async () => RECORD);
      vi.mocked(readExternalEngineKey).mockImplementation(() => "k-test-placeholder");
      const { impl, seen } = engineFetch({ models: modelsOk(), metrics: new Response(metricsText(1), { status: 200 }) });
      useSavedEngine(impl);
      expect((await engineOf()).gate?.online).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((s) => s.auth === "Bearer k-test-placeholder")).toBe(true);
    });

    it("never pairs a record and a key read across a change of the AI settings, and sends the key nowhere", async () => {
      let finishSave: () => void = () => {};
      let saving: Promise<void> | null = null;
      // A save starts between the record read and the key read: the key on file is the NEW engine's.
      vi.mocked(readExternalEngine).mockImplementation(async () => {
        saving = withLocalAiTransitionLock(() => new Promise<void>((resolve) => { finishSave = resolve; }));
        await Promise.resolve();
        return RECORD;
      });
      vi.mocked(readExternalEngineKey).mockImplementation(() => "k-of-the-new-engine");
      const { impl } = engineFetch({ models: modelsOk() });
      useSavedEngine(impl);
      expect(await engineOf()).toMatchObject({ configured: true, unread: "changing" });
      expect(impl).not.toHaveBeenCalled();

      // While the save still runs, nothing is read either.
      vi.mocked(readExternalEngine).mockImplementation(async () => RECORD);
      clock += FRESH_MS + 60_000;
      expect(await engineOf()).toMatchObject({ unread: "changing" });
      expect(impl).not.toHaveBeenCalled();

      finishSave();
      await saving;
    });
  });
});
