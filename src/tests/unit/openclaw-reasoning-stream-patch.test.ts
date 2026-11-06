import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { PATCH_MARKER, VERIFIED_VERSIONS, patchOpenClawRoot, patchTransportSource } from "../../../scripts/openclaw-reasoning-stream-patch.mjs";

/**
 * TASK-2228: on OpenClaw 2026.10.9 a reasoning model's answer reached the chat
 * in one piece, after it was complete. The core's openai-completions transport
 * (`@openclaw/ai`) stamps the message `textPhaseRequiresTerminal` and forces its
 * reasoning-tag partitioner strict on the first `reasoning_content` chunk; a
 * strict partitioner releases no visible text before the stream ends, and the
 * core's handler drops live text for any stamped message.
 * scripts/openclaw-reasoning-stream-patch.mjs back-ports upstream's 2026.10.10
 * fix. The excerpts below are the transport's own lines, tabs included.
 */

/** @openclaw/ai 2026.10.9, openai-completions-transport: beginReasoning. */
const BEGIN_REASONING_10_9 = [
  "\tconst beginReasoning = (hasFollowingVisibleText, forceStrict = false) => {",
  "\t\tif (!output.openclawDelivery?.textPhaseRequiresTerminal) output.openclawDelivery = {",
  "\t\t\t...output.openclawDelivery,",
  "\t\t\ttextPhaseRequiresTerminal: true",
  "\t\t};",
  "\t\tif (forceStrict || reasoningTagTextPartitioner.hasPending()) reasoningTagTextPartitioner.markStrict();",
  "\t\tif (!hasFollowingVisibleText || !reasoningTagTextPartitioner.hasPendingSyntax()) sealTextBeforeReasoning();",
  "\t};",
].join("\n");

/** Same file, the per-chunk routing of reasoning and visible text. */
const CHUNK_ROUTING_10_9 = [
  "\t\t\tif (hasReasoningThinking) {",
  "\t\t\t\tbeginReasoning(hasSameChunkVisibleText, true);",
  "\t\t\t\tappendReasoningDeltas(reasoningDeltas);",
  "\t\t\t}",
  '\t\t\tfor (const [contentDeltaIndex, contentDelta] of contentDeltas.entries()) if (contentDelta.kind === "text") {',
  "\t\t\t\tconst parts = gemmaToolCallRecoverer?.push(contentDelta.text) ?? [contentDelta];",
  "\t\t\t\tfor (const part of parts) {",
  "\t\t\t\t\tconst routedDeltas = hasReasoningThinking ? reasoningTagTextPartitioner.push(part.text) : reasoningTagTextPartitioner.pushVisible(part.text);",
  "\t\t\t\t\tfor (const routedDelta of routedDeltas) appendPartitionedVisibleDelta(routedDelta);",
  "\t\t\t\t}",
  "\t\t\t}",
].join("\n");

/** @openclaw/ai 2026.10.10: what upstream ships after its fix. */
const TRANSPORT_10_10 = [
  "\tconst beginReasoning = (hasFollowingVisibleText) => {",
  "\t\tsawReasoning = true;",
  "\t\tif (!hasFollowingVisibleText || !reasoningTagTextPartitioner.hasPendingSyntax()) sealTextBeforeReasoning();",
  "\t};",
  "\t\t\tif (hasReasoningThinking) {",
  "\t\t\t\tbeginReasoning(hasSameChunkVisibleText);",
  "\t\t\t\tappendReasoningDeltas(reasoningDeltas);",
  "\t\t\t}",
  "\t\t\t\tfor (const part of parts) for (const routedDelta of reasoningTagTextPartitioner.pushVisible(part.text)) appendPartitionedVisibleDelta(routedDelta);",
].join("\n");

const TRANSPORT_10_9 = `${BEGIN_REASONING_10_9}\n${CHUNK_ROUTING_10_9}\n`;

interface Chunk { reasoning?: string; text?: string }
interface Turn { visible: string[]; stamped: boolean; strict: boolean }

/**
 * Drive the transport's own lines over a ClawBox AI turn's chunks. The
 * partitioner stands in for the real one, which in strict mode releases
 * nothing before the stream ends (measured on 2026.10.9's own partitioner:
 * 0 of 44 chunks released strict, 44 of 44 not).
 */
function runTurn(transport: string, chunks: Chunk[]): Turn {
  const body = `
    const output = { content: [] };
    const reasoningTagTextPartitioner = {
      strict: false,
      markStrict() { this.strict = true; },
      hasPending() { return false; },
      hasPendingSyntax() { return false; },
      push(text) { this.strict = true; return []; },
      pushVisible(text) { return this.strict ? [] : [{ kind: "text", text }]; },
    };
    const sealTextBeforeReasoning = () => {};
    const gemmaToolCallRecoverer = null;
    const appendReasoningDeltas = () => {};
    const visible = [];
    const appendPartitionedVisibleDelta = (delta) => visible.push(delta.text);
    ${transport.slice(0, transport.indexOf("\t\t\tif (hasReasoningThinking)"))}
    for (const chunk of chunks) {
      const hasReasoningThinking = chunk.reasoning !== undefined;
      const reasoningDeltas = hasReasoningThinking ? [{ kind: "thinking", text: chunk.reasoning }] : [];
      const contentDeltas = chunk.text !== undefined ? [{ kind: "text", text: chunk.text }] : [];
      const hasSameChunkVisibleText = contentDeltas.length > 0;
      ${transport.slice(transport.indexOf("\t\t\tif (hasReasoningThinking)"))}
    }
    return { visible, stamped: output.openclawDelivery?.textPhaseRequiresTerminal === true, strict: reasoningTagTextPartitioner.strict };
  `;
  return new Function("chunks", body)(chunks) as Turn;
}

/** DeepSeek's order: reasoning first, then the answer, a few characters a chunk. */
const TURN: Chunk[] = [
  { reasoning: "The user" }, { reasoning: " wants an essay." },
  { text: "**Морето**" }, { text: "\n\nМорето" }, { text: " не е просто" }, { text: " вода." },
];

describe("patchTransportSource — the 2026.10.9 transport", () => {
  it("holds a reasoning answer until the end, as shipped", () => {
    const turn = runTurn(TRANSPORT_10_9, TURN);
    expect(turn.visible).toEqual([]);
    expect(turn.stamped).toBe(true);
    expect(turn.strict).toBe(true);
  });

  it("streams it chunk by chunk once patched, without the stamp the core drops live text for", () => {
    const patched = patchTransportSource(TRANSPORT_10_9);
    expect(patched.verdict).toBe("patch");
    const turn = runTurn(patched.source, TURN);
    expect(turn.visible).toEqual(["**Морето**", "\n\nМорето", " не е просто", " вода."]);
    expect(turn.stamped).toBe(false);
    expect(turn.strict).toBe(false);
  });

  it("leaves the rest of the lines as they were", () => {
    const { source } = patchTransportSource(TRANSPORT_10_9);
    expect(source).toContain(PATCH_MARKER);
    expect(source).not.toContain("textPhaseRequiresTerminal");
    expect(source).not.toContain("markStrict");
    expect(source).toContain("const routedDeltas = reasoningTagTextPartitioner.pushVisible(part.text);");
    expect(source).toContain("if (!hasFollowingVisibleText || !reasoningTagTextPartitioner.hasPendingSyntax()) sealTextBeforeReasoning();");
    expect(source).toContain("beginReasoning(hasSameChunkVisibleText, true);");
    expect(source.split("\n").length).toBe(TRANSPORT_10_9.split("\n").length - 4);
  });

  it("knows a file it already patched", () => {
    const once = patchTransportSource(TRANSPORT_10_9).source;
    expect(patchTransportSource(once)).toEqual({ verdict: "patched", source: once });
  });

  it("finds nothing to do in upstream's fixed transport, or in any other file", () => {
    expect(patchTransportSource(TRANSPORT_10_10).verdict).toBe("absent");
    expect(patchTransportSource("export const x = 1;\n").verdict).toBe("absent");
  });

  it("touches nothing that has only part of the shape, or more than one of it", () => {
    expect(patchTransportSource(BEGIN_REASONING_10_9).verdict).toBe("mismatch");
    expect(patchTransportSource(CHUNK_ROUTING_10_9).verdict).toBe("mismatch");
    expect(patchTransportSource(TRANSPORT_10_9 + TRANSPORT_10_9).verdict).toBe("mismatch");
    // A marker with a hold back beside it is not "already patched".
    expect(patchTransportSource(`${PATCH_MARKER}\n${CHUNK_ROUTING_10_9}`).verdict).toBe("mismatch");
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An OpenClaw package root as npm installs it, with @openclaw/ai under it. */
function openclawRoot(version: string | null, files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "clawbox-oc-stream-"));
  roots.push(root);
  const ai = path.join(root, "node_modules", "@openclaw", "ai");
  mkdirSync(path.join(ai, "dist"), { recursive: true });
  if (version) writeFileSync(path.join(ai, "package.json"), JSON.stringify({ name: "@openclaw/ai", version }));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(ai, "dist", name), text);
  return root;
}

const transportFile = (root: string) =>
  path.join(root, "node_modules", "@openclaw", "ai", "dist", "openai-completions-transport-DGXeWM4f.mjs");

describe("patchOpenClawRoot — the installed core", () => {
  it("patches the pinned core's transport once, keeping its mode, and says so on a rerun", () => {
    const root = openclawRoot("2026.10.9", {
      "openai-completions-transport-DGXeWM4f.mjs": TRANSPORT_10_9,
      "reasoning-tag-text-partitioner-CpOy9-IQ.mjs": "export {};\n",
    });
    chmodSync(transportFile(root), 0o664);
    expect(VERIFIED_VERSIONS).toContain("2026.10.9");

    const first = patchOpenClawRoot(root);
    expect(first.result).toBe("patched");
    expect(first.files).toEqual([path.join("node_modules", "@openclaw", "ai", "dist", "openai-completions-transport-DGXeWM4f.mjs")]);
    expect(readFileSync(transportFile(root), "utf8")).toContain(PATCH_MARKER);
    expect(statSync(transportFile(root)).mode & 0o777).toBe(0o664);

    expect(patchOpenClawRoot(root).result).toBe("already");
  });

  it("leaves a core that streams on its own alone", () => {
    const root = openclawRoot("2026.10.10", { "openai-completions-transport-DLrm5EWi.mjs": TRANSPORT_10_10 });
    expect(patchOpenClawRoot(root).result).toBe("not-needed");
  });

  it("does not patch a version it was never verified on, even with the hold in it", () => {
    const root = openclawRoot("2026.9.4", { "openai-completions-transport-DGXeWM4f.mjs": TRANSPORT_10_9 });
    expect(patchOpenClawRoot(root).result).toBe("unverified");
    expect(readFileSync(transportFile(root), "utf8")).toBe(TRANSPORT_10_9);
  });

  it("calls an unverified version with only part of the shape unverified, not a mismatch", () => {
    const root = openclawRoot("2026.11.9", { "openai-completions-transport-X.mjs": BEGIN_REASONING_10_9 });
    expect(patchOpenClawRoot(root).result).toBe("unverified");
  });

  it("patches the file a symlink points at and leaves the link a link", () => {
    const root = openclawRoot("2026.10.9", {});
    const real = path.join(root, "real-transport.mjs");
    writeFileSync(real, TRANSPORT_10_9);
    symlinkSync(real, transportFile(root));
    expect(patchOpenClawRoot(root).result).toBe("patched");
    expect(lstatSync(transportFile(root)).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain(PATCH_MARKER);
  });

  it.skipIf(process.getuid?.() === 0)("leaves no temporary file and the transport as it was when it cannot write", () => {
    const root = openclawRoot("2026.10.9", { "openai-completions-transport-DGXeWM4f.mjs": TRANSPORT_10_9 });
    const dist = path.dirname(transportFile(root));
    chmodSync(dist, 0o555);
    try {
      expect(() => patchOpenClawRoot(root)).toThrow();
      expect(readdirSync(dist)).toEqual(["openai-completions-transport-DGXeWM4f.mjs"]);
      expect(readFileSync(transportFile(root), "utf8")).toBe(TRANSPORT_10_9);
    } finally {
      chmodSync(dist, 0o755);
    }
  });

  it("calls a verified version without the expected lines a mismatch and writes nothing", () => {
    const missing = openclawRoot("2026.10.9", { "openai-completions-transport-DGXeWM4f.mjs": TRANSPORT_10_10 });
    expect(patchOpenClawRoot(missing).result).toBe("mismatch");
    const half = openclawRoot("2026.10.9", { "openai-completions-transport-DGXeWM4f.mjs": BEGIN_REASONING_10_9 });
    expect(patchOpenClawRoot(half).result).toBe("mismatch");
    expect(readFileSync(transportFile(half), "utf8")).toBe(BEGIN_REASONING_10_9);
  });

  it("has nothing to patch where no @openclaw/ai is installed (a v1 core)", () => {
    const root = openclawRoot(null, {});
    expect(patchOpenClawRoot(root).result).toBe("no-transport");
    expect(patchOpenClawRoot(path.join(root, "nowhere")).result).toBe("no-transport");
  });
});

const SCRIPT = path.resolve("scripts/openclaw-reasoning-stream-patch.mjs");

describe("the script as the installer runs it", () => {
  it("prints what it did and exits 0, also when there is nothing to do", () => {
    const root = openclawRoot("2026.10.9", { "openai-completions-transport-DGXeWM4f.mjs": TRANSPORT_10_9 });
    const first = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/Reasoning stream patch \(@openclaw\/ai 2026\.10\.9\): applied \[/);
    const again = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already applied");
  });

  it("exits 1 on a mismatch, so the step can say the patch is missing", () => {
    const root = openclawRoot("2026.10.9", { "openai-completions-transport-DGXeWM4f.mjs": BEGIN_REASONING_10_9 });
    const run = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("NOT applied");
  });

  it("runs when the path the installer gives goes through a symlink", () => {
    const root = openclawRoot("2026.10.9", { "openai-completions-transport-DGXeWM4f.mjs": TRANSPORT_10_9 });
    const linked = path.join(root, "project-link");
    symlinkSync(path.dirname(path.dirname(SCRIPT)), linked);
    const run = spawnSync(process.execPath, [path.join(linked, "scripts", path.basename(SCRIPT)), root], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("applied");
  });

  it("exits 2 without a root", () => {
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status).toBe(2);
  });
});

/** One shell function out of an installer, sliced so the test cannot drift from it. */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return source.slice(start + 1, source.indexOf("\n}", start) + 2);
}

describe("install.sh's openclaw_patch step runs it", () => {
  const source = readFileSync("install.sh", "utf8");

  function runStep(opts: { hermes?: boolean; scriptFails?: boolean; withScript?: boolean } = {}) {
    const project = mkdtempSync(path.join(tmpdir(), "clawbox-oc-step-"));
    roots.push(project);
    if (opts.withScript !== false) {
      mkdirSync(path.join(project, "scripts"));
      writeFileSync(path.join(project, "scripts", "openclaw-reasoning-stream-patch.mjs"), "");
    }
    const script = [
      `is_hermes_edition() { return ${opts.hermes ? 0 : 1}; }`,
      "openclaw_is_v2() { return 0; }",
      `as_clawbox() { echo "as_clawbox $*"; return ${opts.scriptFails ? 1 : 0}; }`,
      shellFunction(source, "openclaw_reasoning_stream_patch"),
      shellFunction(source, "step_openclaw_patch"),
      "step_openclaw_patch; echo \"rc=$?\"",
    ].join("\n");
    return execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PROJECT_DIR: project, GATEWAY_DIST: "/opt/npm-global/lib/node_modules/openclaw/dist" },
    }).replaceAll(project, "<project>");
  }

  it("on OpenClaw 2, before the step's own early return, against the core's package root", () => {
    const out = runStep();
    expect(out).toContain("as_clawbox node <project>/scripts/openclaw-reasoning-stream-patch.mjs /opt/npm-global/lib/node_modules/openclaw\n");
    expect(out).toContain("not needed on OpenClaw 2");
    expect(out.trim().endsWith("rc=0")).toBe(true);
  });

  it("never fails the step when the patch does not apply", () => {
    const out = runStep({ scriptFails: true });
    expect(out).toContain("WARNING: reasoning stream patch not applied");
    expect(out.trim().endsWith("rc=0")).toBe(true);
  });

  it("says so and carries on when the script is not in the checkout", () => {
    const out = runStep({ withScript: false });
    expect(out).toContain("Reasoning stream patch: <project>/scripts/openclaw-reasoning-stream-patch.mjs not found, skipping");
    expect(out).not.toContain("as_clawbox node");
    expect(out.trim().endsWith("rc=0")).toBe(true);
  });

  it("does nothing on a Hermes box", () => {
    expect(runStep({ hermes: true }).trim()).toBe("rc=0");
  });
});

describe("install-x64.sh's openclaw_patch step runs it", () => {
  const source = readFileSync("install-x64.sh", "utf8");

  it("as the owner, before the OpenClaw 2 early return, and never fails on it", () => {
    for (const fails of [false, true]) {
      const project = mkdtempSync(path.join(tmpdir(), "clawbox-oc-x64-"));
      roots.push(project);
      mkdirSync(path.join(project, "scripts"));
      writeFileSync(path.join(project, "scripts", "openclaw-reasoning-stream-patch.mjs"), "");
      const out = execFileSync("bash", ["-c", [
        "openclaw_is_v2() { return 0; }",
        `as_user_runtime() { echo "as_user_runtime $*"; return ${fails ? 1 : 0}; }`,
        shellFunction(source, "step_openclaw_patch"),
        "step_openclaw_patch; echo \"rc=$?\"",
      ].join("\n")], {
        encoding: "utf8",
        env: { ...process.env, PROJECT_DIR: project, OPENCLAW_BIN: "/bin/true", GATEWAY_DIST: "/opt/npm/lib/node_modules/openclaw/dist" },
      }).replaceAll(project, "<project>");
      expect(out).toContain("as_user_runtime node <project>/scripts/openclaw-reasoning-stream-patch.mjs /opt/npm/lib/node_modules/openclaw\n");
      expect(out).toContain(fails ? "WARNING: reasoning stream patch not applied" : "not needed on OpenClaw 2");
      expect(out.trim().endsWith("rc=0")).toBe(true);
    }
  });
});
