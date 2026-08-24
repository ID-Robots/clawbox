import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";
import fs from "fs";
import os from "os";
import path from "path";

/** Undo for the environment each case below rewrites. */
let restoreEnv: () => void = () => {};

/**
 * Where chat's files live, per edition — and the guard that stands between a
 * caller-supplied path and the Hermes CLI's argv.
 *
 * The rooting half is a no-op on OpenClaw by design: if it were not, this
 * change would be a rewrite of the path every existing customer is on rather
 * than a fix for the edition that had none.
 */

let harness: "openclaw" | "hermes" = "openclaw";
let root: string;

vi.mock("@/lib/harness", () => ({
  getActiveHarness: async () => harness,
}));

async function load() {
  vi.resetModules();
  return import("@/lib/harness/media-root");
}

describe("chat media root", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mediaroot-"));
    restoreEnv = saveEnv("CLAWBOX_ROOT", "HOME", "OPENCLAW_HOME");
    process.env.CLAWBOX_ROOT = root;
    process.env.HOME = root;
    process.env.OPENCLAW_HOME = path.join(root, ".openclaw");
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the OpenClaw tree exactly where it was", async () => {
    // The harness maintains a fixed allowlist of media roots and
    // `<stateDir>/media` is on it. Move a staged file off that list and the
    // agent answers "Local media path is not under an allowed directory".
    harness = "openclaw";
    const { chatMediaRoot, chatAttachmentDir } = await load();
    expect(await chatMediaRoot()).toBe(path.join(root, ".openclaw", "media"));
    expect(await chatAttachmentDir()).toBe(
      path.join(root, ".openclaw", "media", "chat-attachments"),
    );
  });

  it("puts Hermes' files where a Hermes box actually has a directory", async () => {
    // `~/.openclaw` on a Hermes SKU holds `openclaw.json` and nothing else
    // (verified on the live box), so the old constant named a tree that did not
    // exist — staging wrote nowhere and the reader read nothing.
    harness = "hermes";
    const { chatMediaRoot, chatGeneratedImageDir } = await load();
    expect(await chatMediaRoot()).toBe(path.join(root, "data", "chat-media"));
    expect(await chatGeneratedImageDir()).toBe(
      path.join(root, "data", "chat-media", "chat-generated"),
    );
  });
});

describe("resolveInMediaRoot", () => {
  let mediaRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mediaguard-"));
    restoreEnv = saveEnv("CLAWBOX_ROOT", "HOME", "OPENCLAW_HOME");
    process.env.CLAWBOX_ROOT = root;
    process.env.HOME = root;
    process.env.OPENCLAW_HOME = path.join(root, ".openclaw");
    harness = "hermes";
    mediaRoot = path.join(root, "data", "chat-media");
    fs.mkdirSync(path.join(mediaRoot, "chat-attachments"), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, "chat-attachments", "cat.png"), "png");
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const staged = (name: string) => path.join(mediaRoot, "chat-attachments", name);

  it("accepts a file that really is in the staging tree", async () => {
    const { resolveInMediaRoot } = await load();
    expect(await resolveInMediaRoot(staged("cat.png"))).toBe(staged("cat.png"));
  });

  it("refuses a path that climbs out of it", async () => {
    // The agent opens any readable absolute path it is handed. Escaping the
    // staging tree hands it `~/.hermes/.env` — every provider key on the box —
    // as a "picture" to look at and describe back.
    fs.writeFileSync(path.join(root, "secret.png"), "not yours");
    const { resolveInMediaRoot } = await load();
    expect(await resolveInMediaRoot(path.join(mediaRoot, "..", "..", "secret.png"))).toBeNull();
  });

  it("refuses an absolute path from somewhere else entirely", async () => {
    const { resolveInMediaRoot } = await load();
    expect(await resolveInMediaRoot("/etc/passwd")).toBeNull();
  });

  it("refuses a symlink planted inside the tree that points out of it", async () => {
    // The lexical check cannot see this one (CWE-59): the path is textually
    // contained and still an escape.
    const secret = path.join(root, "provider-keys.png");
    fs.writeFileSync(secret, "keys");
    try {
      fs.symlinkSync(secret, staged("innocent.png"));
    } catch {
      return; // no symlink privilege here; the realpath check is covered above
    }
    const { resolveInMediaRoot } = await load();
    expect(await resolveInMediaRoot(staged("innocent.png"))).toBeNull();
  });

  it("refuses a relative path, which could not be argv anyway", async () => {
    const { resolveInMediaRoot } = await load();
    expect(await resolveInMediaRoot("chat-attachments/cat.png")).toBeNull();
    expect(await resolveInMediaRoot("")).toBeNull();
  });

  it("refuses a value the CLI would read as a flag", async () => {
    // Not injection — spawn takes an array — but argv position is still
    // meaningful, and a file called `--yolo` would be a flag.
    const { resolveInMediaRoot } = await load();
    expect(await resolveInMediaRoot("--yolo")).toBeNull();
  });

  it("refuses a file that is not there", async () => {
    // For the argv case this MUST be a refusal rather than a pass-through:
    // `hermes --image` on a missing file fails the whole turn.
    const { resolveInMediaRoot } = await load();
    expect(await resolveInMediaRoot(staged("gone.png"))).toBeNull();
  });

  it("refuses a directory", async () => {
    const { resolveInMediaRoot } = await load();
    expect(await resolveInMediaRoot(path.join(mediaRoot, "chat-attachments"))).toBeNull();
  });

  it("answers null rather than throwing when the tree does not exist yet", async () => {
    fs.rmSync(mediaRoot, { recursive: true, force: true });
    const { resolveInMediaRoot } = await load();
    expect(await resolveInMediaRoot(staged("cat.png"))).toBeNull();
  });
});
