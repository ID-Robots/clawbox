import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * b10, live on a QA box on 2026-08-24: ONE "save local model" in the ClawBox UI
 * took ~/.hermes/config.yaml from 3175 bytes with 36 comment lines to 1505 with
 * none, and the following disable took it to 1325. The deleted lines are the
 * only in-product documentation for secret redaction, tirith pre-exec scanning
 * and provider failover, and nothing puts them back.
 *
 * The fixture is that exact file, byte for byte, with the dashboard password
 * hash and session secret swapped for same-length placeholders — so it is still
 * 3175 bytes and still 36 comment lines.
 */

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));

const FIXTURE = path.join(__dirname, "../fixtures/hermes-config-3175.yaml");

let home: string;
let configPath: string;
let original: string;

async function loadModule() {
  vi.resetModules();
  return await import("@/lib/hermes-config-yaml");
}

function commentLines(text: string): number {
  return text.split("\n").filter((l) => l.startsWith("#")).length;
}

beforeEach(async () => {
  cliMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-config-"));
  process.env.HERMES_HOME = home;
  configPath = path.join(home, "config.yaml");
  original = await fs.readFile(FIXTURE, "utf-8");
  await fs.writeFile(configPath, original, { mode: 0o600 });
});

afterEach(async () => {
  delete process.env.HERMES_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe("patchHermesConfig on the real 3175-byte Hermes config", () => {
  it("is a fixture of the shape the finding reported", () => {
    expect(Buffer.byteLength(original)).toBe(3175);
    expect(commentLines(original)).toBe(36);
  });

  it("registers the local provider without deleting a single comment", async () => {
    const { patchHermesConfig } = await loadModule();

    const result = await patchHermesConfig({
      set: {
        "providers.clawlocal.base_url": "http://127.0.0.1/setup-api/local-ai/ollama/v1",
        "providers.clawlocal.api_key": "local-token-xyz",
        "providers.clawlocal.api_mode": "openai",
        "model.provider": "clawlocal",
        "model.default": "qwen2.5:3b",
      },
    });

    const after = await fs.readFile(configPath, "utf-8");
    expect(result.mode).toBe("merge");
    expect(commentLines(after)).toBe(36);
    // It GREW. The whole symptom was a config that shrank on every save.
    expect(Buffer.byteLength(after)).toBeGreaterThan(3175);
    // Every line of the original is still there, in order.
    const before = original.split("\n");
    const remaining = after.split("\n");
    let cursor = 0;
    for (const line of before) {
      const found = remaining.indexOf(line, cursor);
      expect(found, `lost line: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
      cursor = found + 1;
    }
    // …including the two documentation blocks by name.
    expect(after).toContain("# ── Security ──");
    expect(after).toContain("# ── Fallback Model ──");
    expect(after).toContain("#   tirith_fail_open: true");
    // …and the data that is not ours: mcp_servers, toolsets, dashboard auth.
    expect(after).toContain("_config_version: 38");
    expect(after).toContain("      CLAWBOX_API_BASE: http://127.0.0.1:80");
    expect(after).toContain("    - yuanbao");

    expect(after).toContain("providers:\n  clawlocal:\n");
    expect(after).toContain("model:\n  provider: clawlocal\n  default: qwen2.5:3b");
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("keeps the previous revision as config.yaml.bak", async () => {
    const { patchHermesConfig } = await loadModule();
    const result = await patchHermesConfig({ set: { "model.provider": "clawlocal" } });
    expect(result.backupPath).toBe(`${configPath}.bak`);
    expect(await fs.readFile(`${configPath}.bak`, "utf-8")).toBe(original);
  });

  it("round-trips: enable then disable returns the file to what it was", async () => {
    const { patchHermesConfig } = await loadModule();
    await patchHermesConfig({
      set: {
        "providers.clawlocal.base_url": "http://127.0.0.1/setup-api/local-ai/ollama/v1",
        "providers.clawlocal.api_key": "local-token-xyz",
        "providers.clawlocal.api_mode": "openai",
        "model.provider": "clawlocal",
        "model.default": "qwen2.5:3b",
      },
    });
    await patchHermesConfig({
      unset: [
        "providers.clawlocal.base_url",
        "providers.clawlocal.api_key",
        "providers.clawlocal.api_mode",
        "model.provider",
        "model.default",
      ],
    });

    const after = await fs.readFile(configPath, "utf-8");
    expect(after).toBe(original);
    expect(Buffer.byteLength(after)).toBe(3175);
    expect(commentLines(after)).toBe(36);
  });

  it("preserves the file mode", async () => {
    const { patchHermesConfig } = await loadModule();
    await patchHermesConfig({ set: { "model.provider": "clawlocal" } });
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("reads a key back without spawning the CLI", async () => {
    const { patchHermesConfig, readHermesConfigValue } = await loadModule();
    await patchHermesConfig({ set: { "model.provider": "clawlocal" } });
    expect(await readHermesConfigValue("model.provider")).toBe("clawlocal");
    expect(await readHermesConfigValue("model.default")).toBeNull();
    expect(await readHermesConfigValue("dashboard.basic_auth.username")).toBe("clawbox");
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("creates the file on a device that has none yet", async () => {
    await fs.rm(configPath);
    const { patchHermesConfig } = await loadModule();
    const result = await patchHermesConfig({ set: { "model.provider": "clawlocal" } });
    expect(result.mode).toBe("merge");
    expect(result.backupPath).toBeNull();
    expect(await fs.readFile(configPath, "utf-8")).toContain("provider: clawlocal");
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("falls back to the CLI — and leaves the file alone — on a shape it cannot edit", async () => {
    // Flow style on the very key we are asked to patch. Losing the comments is
    // bad; writing a config we half-understand is worse.
    const odd = "model: {provider: openrouter}\n";
    await fs.writeFile(configPath, odd, { mode: 0o600 });
    const { patchHermesConfig } = await loadModule();

    const result = await patchHermesConfig({ set: { "model.provider": "clawlocal" } });

    expect(result.mode).toBe("cli");
    expect(await fs.readFile(configPath, "utf-8")).toBe(odd);
    expect(cliMock.mock.calls[0][0]).toEqual(["config", "set", "model.provider", "clawlocal"]);
  });

  it("surfaces a CLI failure on the fallback path instead of reporting success", async () => {
    await fs.writeFile(configPath, "model: {provider: openrouter}\n", { mode: 0o600 });
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "hermes: nope" });
    const { patchHermesConfig, HermesConfigWriteError } = await loadModule();
    await expect(patchHermesConfig({ set: { "model.provider": "x" } })).rejects.toBeInstanceOf(
      HermesConfigWriteError,
    );
  });

  it("serialises concurrent writes rather than losing one", async () => {
    const { patchHermesConfig } = await loadModule();
    await Promise.all([
      patchHermesConfig({ set: { "providers.clawlocal.base_url": "http://a/v1" } }),
      patchHermesConfig({ set: { "providers.clawlocal.api_key": "k" } }),
      patchHermesConfig({ set: { "providers.clawlocal.api_mode": "openai" } }),
    ]);
    const after = await fs.readFile(configPath, "utf-8");
    expect(after).toContain("base_url: http://a/v1");
    expect(after).toContain("api_key: k");
    expect(after).toContain("api_mode: openai");
    expect(commentLines(after)).toBe(36);
  });
});

/**
 * The two shapes the read-back proof has to answer for, and got wrong.
 *
 * An EMPTY MAPPING is written `{}` by PyYAML — the loader `hermes config`
 * re-serialises this file with (measured on a Hermes box, PyYAML 5.4.1:
 * `safe_dump({"providers": {}})` → `providers: {}\n`) — and Hermes' own shipped
 * `cli-config.yaml.example` carries two of them. Our reader THREW on one
 * anywhere along the path, so `providers: {}` made `providers.clawlocal.base_url`
 * "we could not look" instead of the plain "not there" the file was stating,
 * and a removal that had landed was answered "could not be confirmed" — for
 * ever, because the retry reads the same file. (The pinned 0.20.5 `unset` does
 * prune a container it empties, `hermes_cli/config.py:1157-1174`, so this is
 * not what a COMPLETE unset leaves — it is what any other writer of an empty
 * mapping leaves.)
 *
 * The same reader was blind in the other direction: a `models:` catalogue
 * written as a block or a list — the shape Hermes' own discovery produces — is
 * a `providers.clawlocal` entry Hermes still renders as a picker row, and it
 * read as "not there".
 */
describe("resolveHermesConfigValue over the shapes a removal leaves behind", () => {
  async function readBack(text: string, key: string) {
    await fs.writeFile(configPath, text, { mode: 0o600 });
    const { resolveHermesConfigValue } = await loadModule();
    return await resolveHermesConfigValue(key);
  }

  it("reads a key under an empty {} mapping as gone, not as unreadable", async () => {
    expect(
      await readBack("providers:\n  clawlocal: {}\nmodel:\n  provider: openrouter\n",
        "providers.clawlocal.base_url"),
    ).toEqual({ state: "absent" });
  });

  it("reads a key under an empty providers block as gone", async () => {
    expect(await readBack("providers: {}\n", "providers.clawlocal.models")).toEqual({ state: "absent" });
  });

  it("does not read a block-form models catalogue as removed", async () => {
    expect(
      await readBack("providers:\n  clawlocal:\n    models:\n      gemma4:\n        ctx: 4096\n",
        "providers.clawlocal.models"),
    ).toEqual({ state: "present" });
  });

  it("does not read a list-form models catalogue as removed", async () => {
    expect(
      await readBack("providers:\n  clawlocal:\n    models:\n      - gemma4\n",
        "providers.clawlocal.models"),
    ).toEqual({ state: "present" });
  });

  it("still answers a scalar with its value and a missing key with absent", async () => {
    const text = "providers:\n  clawlocal:\n    base_url: http://127.0.0.1/v1\n";
    expect(await readBack(text, "providers.clawlocal.base_url")).toEqual({
      state: "value",
      value: "http://127.0.0.1/v1",
    });
    expect(await readBack(text, "providers.clawlocal.models")).toEqual({ state: "absent" });
  });

  it("still says unreadable for an inline value it cannot descend into", async () => {
    // Not an empty collection: `clawlocal` may well hold the key, and this
    // reader cannot say. "We could not look" is the honest answer.
    expect(
      await readBack("providers:\n  clawlocal: {base_url: http://x/v1}\n", "providers.clawlocal.base_url"),
    ).toEqual({ state: "unreadable" });
  });

  /**
   * A block this reader cannot INDEX must never answer "the key is not there".
   *
   * The walk descends two columns per level and skips every line deeper than
   * the level it is scanning, so a block written at any other indent yields no
   * entries at all — and "I found no lines I could classify" was being returned
   * as the positive fact "the key is absent". That is the worst possible
   * direction here, because it is the SAME blind spot that makes the writer a
   * silent no-op on that file: `unsetYamlPath` changes nothing, `patchText`'s
   * own verification passes, no CLI fallback is entered, and the read-back then
   * confirms the write it cannot see. The removal answers 200 with
   * `providers.clawlocal` intact.
   *
   * config.yaml is hand-edited by design — the comment-preserving writer exists
   * because owners edit it — so this is a shape the file really takes.
   */
  it.each([
    ["four-space children", "providers:\n    clawlocal:\n        base_url: http://127.0.0.1/v1\n"],
    ["three-space children", "providers:\n   clawlocal:\n      base_url: http://127.0.0.1/v1\n"],
    ["a deeper grandchild", "providers:\n  clawlocal:\n      base_url: http://127.0.0.1/v1\n"],
    ["an indented root", "  providers:\n    clawlocal:\n      base_url: http://127.0.0.1/v1\n"],
  ])("says unreadable, never absent, for %s", async (_name, text) => {
    expect(await readBack(text, "providers.clawlocal.base_url")).toEqual({ state: "unreadable" });
  });

  it("still calls a genuinely empty block absent", async () => {
    // The other side of the same test: a parent that opens NO block at all, and
    // one holding only a comment, are both real answers and must stay `absent`
    // or every removal on a normal box would go to the CLI for nothing.
    expect(await readBack("providers:\nmodel:\n  provider: openrouter\n", "providers.clawlocal"))
      .toEqual({ state: "absent" });
    expect(await readBack("providers:\n  # nothing yet\nmodel:\n  provider: openrouter\n", "providers.clawlocal"))
      .toEqual({ state: "absent" });
    expect(await readBack("", "providers.clawlocal.base_url")).toEqual({ state: "absent" });
  });

  it("says unreadable for a document PyYAML itself refuses", async () => {
    // The whole-file fact that IS evidence about every key: Hermes' bridge and
    // `hermes config get` both load config.yaml with PyYAML, so when PyYAML
    // raises, nothing in the file is in effect and no line in it describes what
    // the gateway is running. The module already implements that doctrine for
    // the top-level reader; this one answered a confident `absent` — which,
    // over a removal, is a 200 "it is gone" about a file nobody can load. The
    // damage is deliberately somewhere ELSE than the path being read.
    const tab = "providers:\n  openrouter:\n    api_key:\tsk-x\nmodel:\n  provider: openrouter\n";
    expect(await readBack(tab, "providers.clawlocal.base_url")).toEqual({ state: "unreadable" });

    const unterminated = 'providers:\n  openrouter:\n    api_key: "sk-x\nmodel:\n  provider: openrouter\n';
    expect(await readBack(unterminated, "providers.clawlocal.base_url")).toEqual({ state: "unreadable" });
  });

  it("keeps readHermesConfigValue's two-state contract", async () => {
    await fs.writeFile(configPath, "providers:\n  clawlocal:\n    models:\n      - gemma4\n", { mode: 0o600 });
    const { readHermesConfigValue } = await loadModule();
    // A block is not a scalar, so the scalar reader still answers null — the
    // signature every other caller reads.
    expect(await readHermesConfigValue("providers.clawlocal.models")).toBeNull();
  });
});

/**
 * The false-failure direction, on the file this module was measured against.
 *
 * The reader refuses a block it cannot index, and every refusal costs a
 * `hermes config get` spawn on the removal path. This pins that an ORDINARY
 * config — the real 3175-byte fixture with a provider block written into it —
 * still answers every removal key without a single throw, before and after the
 * unset, so a later change to the walk cannot quietly add six CLI spawns to
 * every normal "turn Local AI off".
 */
describe("an ordinary config still reads without asking the CLI", () => {
  const KEYS = [
    "providers.clawlocal.base_url",
    "providers.clawlocal.api_key",
    "providers.clawlocal.api_mode",
    "providers.clawlocal.models",
    "model.provider",
    "model.default",
  ];

  it("answers every removal key before and after the unset", async () => {
    const { patchHermesConfig, resolveHermesConfigValue } = await loadModule();
    await patchHermesConfig({
      set: {
        "providers.clawlocal.base_url": "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
        "providers.clawlocal.api_key": "local-token-xyz",
        "providers.clawlocal.api_mode": "openai",
        "providers.clawlocal.models": "gemma4-e2b-it-q4_0",
        "model.provider": "clawlocal",
        "model.default": "gemma4-e2b-it-q4_0",
      },
    });

    for (const key of KEYS) {
      expect((await resolveHermesConfigValue(key)).state, key).toBe("value");
    }

    const result = await patchHermesConfig({ unset: KEYS });
    expect(result.mode).toBe("merge");

    for (const key of KEYS) {
      expect((await resolveHermesConfigValue(key)).state, key).toBe("absent");
    }
    // The comment banner the whole module exists to protect is still there.
    expect(commentLines(await fs.readFile(configPath, "utf-8"))).toBe(36);
    expect(cliMock).not.toHaveBeenCalled();
  });
});

/**
 * A file the line editor cannot INDEX must reach the CLI, which can do the job.
 *
 * `unsetYamlPath` changed nothing on such a file and `patchText`'s own
 * verification passed on the same blind spot, so `patchHermesConfig` reported a
 * successful merge over a file it never touched — and the read-back, refusing
 * the same shape, then answered "still registered" for ever. The removal has to
 * fall through to `hermes config unset`, which loads with PyYAML and does not
 * care how the file is indented.
 */
describe("patchHermesConfig on a config the line editor cannot index", () => {
  const FOUR_SPACE = "providers:\n    clawlocal:\n        base_url: http://127.0.0.1/v1\n";

  it("sends the unset to the CLI instead of reporting a merge that did nothing", async () => {
    await fs.writeFile(configPath, FOUR_SPACE, { mode: 0o600 });
    const { patchHermesConfig } = await loadModule();

    const result = await patchHermesConfig({ unset: ["providers.clawlocal.base_url"] });

    expect(result.mode).toBe("cli");
    expect(cliMock).toHaveBeenCalledWith(
      ["config", "unset", "providers.clawlocal.base_url"],
      expect.anything(),
    );
    expect(await fs.readFile(configPath, "utf-8")).toBe(FOUR_SPACE);
  });

  it("sends the set to the CLI instead of writing a duplicate key", async () => {
    await fs.writeFile(configPath, FOUR_SPACE, { mode: 0o600 });
    const { patchHermesConfig } = await loadModule();

    const result = await patchHermesConfig({ set: { "providers.clawlocal.api_key": "sk-new" } });

    expect(result.mode).toBe("cli");
    const after = await fs.readFile(configPath, "utf-8");
    expect(after).toBe(FOUR_SPACE);
    // The shape that used to be written into the credential file.
    expect(after.match(/clawlocal:/g)?.length).toBe(1);
  });
});
