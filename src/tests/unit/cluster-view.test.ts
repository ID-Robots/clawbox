import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  COLLECTOR_SCRIPT,
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
  "CBX gpu 0, 48, [N/A], [N/A]",
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
    env: { CLAWBOX_CLUSTER_PEERS: PEERS } as NodeJS.ProcessEnv,
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
    const { targets, ignored } = clusterPeers({ CLAWBOX_CLUSTER_PEERS: "a.example, b\nc  a.example ops@d" } as NodeJS.ProcessEnv);
    expect(targets).toEqual(["a.example", "b", "c", "ops@d"]);
    expect(ignored).toBe(0);
  });

  it("reads a quoted value as .env loaders may leave it", () => {
    expect(clusterPeers({ CLAWBOX_CLUSTER_PEERS: '"b c"' } as NodeJS.ProcessEnv).targets).toEqual(["b", "c"]);
  });

  it("refuses anything that could be read as an ssh option or carry a shell character", () => {
    const bad = ["-oProxyCommand=touch", "-F/etc/passwd", "a;b", "$(id)", "`id`", "host:22", "a/b", "user@@host", "[::1]", "a&b", "x'y", "x\"y", "@host", "user@"];
    const { targets, ignored } = clusterPeers({ CLAWBOX_CLUSTER_PEERS: ["good", ...bad].join(" ") } as NodeJS.ProcessEnv);
    expect(targets).toEqual(["good"]);
    expect(ignored).toBe(bad.length);
  });

  it("stops at the cap, counting the rest as ignored", () => {
    const many = Array.from({ length: MAX_PEERS + 3 }, (_, i) => `h${i}`).join(" ");
    const { targets, ignored } = clusterPeers({ CLAWBOX_CLUSTER_PEERS: many } as NodeJS.ProcessEnv);
    expect(targets).toHaveLength(MAX_PEERS);
    expect(ignored).toBe(3);
  });

  it("is empty when unset", () => {
    expect(clusterPeers({} as NodeJS.ProcessEnv)).toEqual({ targets: [], ignored: 0 });
  });

  it("names an offline Spark by the host part of its target", () => {
    expect(targetHost("ops@spark-b")).toBe("spark-b");
    expect(targetHost("spark-b")).toBe("spark-b");
  });
});

describe("clusterMode and clusterEnabled", () => {
  it("reads the mode, and anything it does not know is auto", () => {
    const mode = (v?: string) => clusterMode({ CLAWBOX_CLUSTER_VIEW: v } as NodeJS.ProcessEnv);
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
      env: env as NodeJS.ProcessEnv,
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
      env: { CLAWBOX_CLUSTER_PEERS: "ops@spark-b spark-c spark-d spark-e spark-f" } as NodeJS.ProcessEnv,
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
    setup({ run, env: { CLAWBOX_CLUSTER_PEERS: "spark-b" } as NodeJS.ProcessEnv });
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

  it("remembers a failure for less time, so a Spark that came back shows soon", async () => {
    const answers: Record<string, ScriptResult> = { local: ok(GOOD("spark-a")), "spark-b": sshFailure("Connection refused") };
    const run = runnerBy(answers);
    setup({ run, env: { CLAWBOX_CLUSTER_PEERS: "spark-b" } as NodeJS.ProcessEnv });
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
    for (const a of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.9", "127.0.0.1", "::1", "fd00::1", "fc12::9", "::ffff:10.0.0.1", "[::1]"]) {
      expect(isLanAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "172.15.255.255", "169.254.169.254", "100.64.0.1", "2001:db8::1", "fe80::1", "::ffff:8.8.8.8", "not-an-address", ""]) {
      expect(isLanAddress(a), a).toBe(false);
    }
  });

  it("judges a name by EVERY address it resolves to, and leaves a name that does not resolve to the request", async () => {
    expect(await lanRefusal("engine.lan", async () => [{ address: "192.168.1.5" }])).toBeNull();
    expect(await lanRefusal("engine.lan", async () => [{ address: "192.168.1.5" }, { address: "93.184.216.34" }])).not.toBeNull();
    expect(await lanRefusal("nowhere.invalid", async () => { throw new Error("ENOTFOUND"); })).toBeNull();
    expect(await lanRefusal("93.184.216.34", async () => [])).not.toBeNull();
    expect(await lanRefusal("[fd00::5]", async () => [])).toBeNull();
  });
});

describe("clusterAnswer: the engine", () => {
  const TARGET: EngineTarget = { baseUrl: "http://192.168.1.50:8000/v1", apiKey: "k-test-placeholder", modelId: "deepseek-test" };

  const metricsText = (tokens: number) => [
    "# TYPE vllm:num_requests_running gauge",
    'vllm:num_requests_running{model_name="deepseek-test"} 3',
    'vllm:num_requests_waiting{model_name="deepseek-test"} 2',
    `vllm:generation_tokens_total{model_name="deepseek-test"} ${tokens}`,
    "",
  ].join("\n");

  function engineFetch(options: { models?: Response | Error; metrics?: Response | Error | (() => Response) }) {
    const seen: { url: string; auth: string | null }[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization") });
      const pick = url.endsWith("/models") ? options.models : options.metrics;
      if (pick instanceof Error) throw pick;
      if (typeof pick === "function") return pick();
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
    expect(seen.map((s) => s.url).sort()).toEqual(["http://192.168.1.50:8000/metrics", "http://192.168.1.50:8000/v1/models"]);
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
    expect(seen.every((s) => s.url.startsWith("http://192.168.1.50:8000/"))).toBe(true);
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

  it("is a gate that is down, not an error, when the engine record cannot be read", async () => {
    setup({
      readEngine: async () => {
        throw new Error("store unreadable");
      },
      run: runnerBy({ local: ok(GOOD("spark-a")) }),
    });
    expect(await engineOf()).toEqual({ configured: false });
  });
});
