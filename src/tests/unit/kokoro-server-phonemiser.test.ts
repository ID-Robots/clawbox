import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

/**
 * TASK-420 / TASK-686. `scripts/install-voice.sh` checks at INSTALL time that
 * this box can turn a word no lexicon holds into phonemes, and refuses
 * `KOKORO=ready` when it cannot. But the process that actually speaks —
 * `scripts/kokoro-server.py` — builds its own KPipeline later, in another
 * process, and said nothing about the phonemiser at all: `/health` answered
 * `{"status":"ok"}` regardless.
 *
 * So the install-time check was a PROBE-ONCE for the life of the box. A
 * `pip install --upgrade`, a wiped `~/.local` or a python minor bump can lose
 * espeakng-loader while the stamp, `import kokoro, torch` and this server's own
 * health all stay green — and every out-of-vocabulary word (a name, a brand,
 * "ClawBox" itself) is then dropped from every spoken reply, silently.
 *
 * kokoro builds the espeak fallback inside a try/except and degrades to
 * `logger.warning('EspeakFallback not Enabled: OOD words will be skipped')`
 * with `fallback=None`. Nothing downstream reads that warning.
 *
 * These EXECUTE the shipped script's own functions with a stand-in G2P, so the
 * test fails if the real file drifts. `kokoro` and `torch` are never imported:
 * the verdict and the health payload are pure.
 */

// Starts a real python3 process: vitest's 5 s default is not enough on a loaded
// CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SERVER = path.resolve(process.cwd(), "scripts/kokoro-server.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Pull the phonemiser verdict and the health payload out of the .sh's Python
 * sibling verbatim, without importing kokoro, torch or soundfile — none of
 * which exists on a CI runner and none of which the region under test touches.
 */
function extractRegion(): string {
  const src = readFileSync(SERVER, "utf-8");
  const start = src.indexOf("# Can THIS process turn a word it has never seen into phonemes?");
  const end = src.indexOf("def load_model():", start);
  if (start < 0 || end < 0) throw new Error("phonemiser region not found in kokoro-server.py");
  return src.slice(start, end);
}

const REGION = hasPython3 ? extractRegion() : "";

/** Run the region with a stand-in `g2p` and report the verdict and the health body. */
function verdictFor(g2pBody: string): { verdict: string; health: Record<string, unknown>; log: string } {
  const program = [
    "import json",
    REGION,
    `def g2p(word):\n${g2pBody}`,
    "verdict = phonemiser_verdict(g2p)",
    "phonemiser_state = verdict",
    // health_payload reads the module global, so rebind it the way load_model does.
    "globals()['phonemiser_state'] = verdict",
    "print(json.dumps({'verdict': verdict, 'health': health_payload()}))",
  ].join("\n");
  const lines = execFileSync("python3", ["-c", program], { encoding: "utf-8" }).trim().split("\n");
  const parsed = JSON.parse(lines[lines.length - 1]);
  return { ...parsed, log: lines.slice(0, -1).join("\n") };
}

describe.skipIf(!hasPython3)("kokoro-server.py — the phonemiser it actually has", () => {
  it("reports ok when out-of-vocabulary words phonemise", () => {
    const { verdict, health } = verdictFor("    return ('sɪmˈpleɪ', None)");

    expect(verdict).toBe("ok");
    expect(health).toMatchObject({ status: "ok", phonemiser: "ok" });
  });

  it("reports the engine DEGRADED when they come back as the unknown marker", () => {
    // misaki's unknown token, U+2753 — what it emits with no espeak fallback.
    const { verdict, health } = verdictFor("    return (chr(10067), None)");

    expect(verdict).toBe("absent");
    expect(health).toMatchObject({ status: "degraded", phonemiser: "absent" });
  });

  it("reports it degraded when they come back empty, which is the unk='' shape", () => {
    const { verdict, health } = verdictFor("    return ('', None)");

    expect(verdict).toBe("absent");
    expect(health.status).toBe("degraded");
  });

  it("still says degraded when only SOME words survive", () => {
    // A missing fallback does not blank a sentence — misaki keeps what it can
    // phonemise and drops the rest — so a line judged whole reads non-empty
    // once one of its words survives. One word at a time is the only honest
    // question.
    const { verdict } = verdictFor(
      "    return (('ˈzɔrblætɪk', None) if word == 'zorblattic' else ('', None))",
    );

    expect(verdict).toBe("absent");
  });

  it("does not grade a shape it cannot read", () => {
    // `kokoro` is installed unpinned. A check written against today's attribute
    // names would start failing WORKING boxes the day misaki renames one, and
    // "the box speaks badly" is a far worse thing to say wrongly than "we could
    // not tell".
    const { verdict, health, log } = verdictFor("    raise TypeError('g2p() takes 2 positional arguments')");

    expect(verdict).toBe("unknown");
    expect(health.status).toBe("ok");
    expect(log).toContain("not treating that as a verdict");
  });

  it("does not grade a missing g2p either", () => {
    const { verdict } = verdictFor("    raise AssertionError('unreachable')");
    expect(verdict).toBe("unknown");

    const program = [
      "import json",
      REGION,
      "print(json.dumps({'verdict': phonemiser_verdict(None)}))",
    ].join("\n");
    const out = execFileSync("python3", ["-c", program], { encoding: "utf-8" }).trim().split("\n");
    expect(JSON.parse(out[out.length - 1]).verdict).toBe("unknown");
  });

  it("probes with words no lexicon holds, and agrees with the installer about them", () => {
    // The install-time check and this one must mean the same thing by
    // "working", or a box can be refused at install and call itself healthy at
    // runtime.
    const installer = readFileSync(path.resolve(process.cwd(), "scripts/install-voice.sh"), "utf-8");
    const server = readFileSync(SERVER, "utf-8");
    for (const word of ["zorblattic", "frobnicator", "squibbled"]) {
      expect(installer).toContain(word);
      expect(server).toContain(word);
    }
  });

  it("keeps serving while degraded — silence is worse than a dropped name", () => {
    // The health body says degraded and the response is still a 200 with a
    // usable payload: a box whose only other engine is the cloud voice would go
    // quiet on a refusal.
    const { health } = verdictFor("    return ('', None)");

    expect(health.model).toBe("kokoro-82m");
    expect(readFileSync(SERVER, "utf-8")).toContain("json.dumps(health_payload())");
  });
});
