import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Bringing a picture the agent drew into the tree the chat can serve from.
 *
 * The copy is the easy half. The half worth testing is what is REFUSED: the
 * path comes out of the agent's database, i.e. out of a tool result the model's
 * own arguments shaped, and the destination is a directory a browser session
 * can read. A link planted in the image cache pointing at `~/.hermes/.env` —
 * the file with every provider key on the box in it — is textually inside the
 * cache and is still an escape (CWE-59), and copying it would publish the
 * customer's credentials to anyone with the chat open.
 */

let restoreEnv: () => void = () => {};
let home: string;

vi.mock("@/lib/harness", () => ({ getActiveHarness: async () => "hermes" }));

async function load() {
  vi.resetModules();
  return import("@/lib/harness/hermes-generated-media");
}

/** The chat media tree this edition serves from. */
function generatedDir(): string {
  return path.join(home, "data", "chat-media", "chat-generated");
}

function cacheDir(): string {
  return path.join(home, ".hermes", "cache", "images");
}

/** A real, if tiny, PNG — enough that the size and file checks are honest. */
function writeCachedImage(name: string): string {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const file = path.join(cacheDir(), name);
  fs.writeFileSync(file, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  return file;
}

describe("adopting a picture the agent drew", () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-drawn-"));
    restoreEnv = saveEnv("HOME", "HERMES_HOME", "CLAWBOX_ROOT", "OPENCLAW_HOME");
    process.env.HOME = home;
    process.env.HERMES_HOME = path.join(home, ".hermes");
    process.env.CLAWBOX_ROOT = home;
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("copies it into the chat media tree under a name of ours", async () => {
    const source = writeCachedImage("clawai_20260824_212225_23c1c095.png");
    const { adoptHermesGeneratedImages } = await load();

    const [adopted] = await adoptHermesGeneratedImages([source]);
    expect(adopted).toBeTruthy();
    expect(path.dirname(adopted)).toBe(fs.realpathSync(generatedDir()));
    // The model had a hand in the source's name; the copy's name is a uuid.
    expect(path.basename(adopted)).toMatch(/^agent-[0-9a-f-]{36}\.png$/);
    expect(fs.readFileSync(adopted)).toEqual(fs.readFileSync(source));
    // The original is left where the agent's own session still refers to it.
    expect(fs.existsSync(source)).toBe(true);
  });

  it("refuses a symlink that points out of the image cache", async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const secret = path.join(home, ".hermes", ".env");
    fs.writeFileSync(secret, "CLAWBOX_AI_TOKEN=claw_secret\n");
    const link = path.join(cacheDir(), "innocent.png");
    try {
      fs.symlinkSync(secret, link);
    } catch {
      // Windows without developer mode cannot make one. The lexical and
      // realpath checks are the same code either way; skip rather than fail.
      return;
    }
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages([link])).toEqual([]);
    expect(fs.existsSync(generatedDir())).toBe(false);
  });

  it("refuses a path outside the image cache entirely", async () => {
    const outside = path.join(home, ".hermes", "elsewhere.png");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "not in the cache");
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages([outside])).toEqual([]);
  });

  it("refuses a traversal dressed as a cache path", async () => {
    writeCachedImage("real.png");
    const { adoptHermesGeneratedImages } = await load();
    const climbing = path.join(cacheDir(), "..", "..", ".env");
    expect(await adoptHermesGeneratedImages([climbing])).toEqual([]);
  });

  it("refuses a name the media route would not serve", async () => {
    // `chat/media` keys its Content-Type off the extension and has no entry for
    // these, so a copy would land in the tree and 415 on every read.
    const svg = writeCachedImage("drawing.svg");
    const json = writeCachedImage("state.json");
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages([svg, json])).toEqual([]);
  });

  it("skips what it cannot take and keeps what it can", async () => {
    const good = writeCachedImage("good.png");
    const { adoptHermesGeneratedImages } = await load();
    const adopted = await adoptHermesGeneratedImages([
      path.join(cacheDir(), "missing.png"),
      good,
    ]);
    // One picture failing must never cost the reply it arrived with, nor the
    // other pictures in the same turn.
    expect(adopted).toHaveLength(1);
  });

  it("answers with nothing when the box has never drawn anything", async () => {
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages(["/home/clawbox/.hermes/cache/images/x.png"]))
      .toEqual([]);
  });

  it("is a no-op for a turn that drew nothing", async () => {
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages([])).toEqual([]);
  });

  // ── The model's own mentions of what it drew ──
  //
  // One generation must render exactly one card: the mention comes out of the
  // caption and into the adoption list, never onto the screen as a dead path.

  it("lifts a MEDIA: cache path out of the caption and hands it back as a source", async () => {
    const { reclaimImageMentions } = await load();
    const out = reclaimImageMentions("Here you go!\nMEDIA:/home/clawbox/.hermes/cache/images/a.png");
    expect(out.sources).toEqual(["/home/clawbox/.hermes/cache/images/a.png"]);
    expect(out.text).toBe("Here you go!");
  });

  it("strips an [Image: …] aside but keeps the sentence around it", async () => {
    const { reclaimImageMentions } = await load();
    const out = reclaimImageMentions(
      "Your red square: [Image: /home/clawbox/.hermes/cache/images/b.png] — enjoy!",
    );
    expect(out.sources).toEqual(["/home/clawbox/.hermes/cache/images/b.png"]);
    expect(out.text).toBe("Your red square: — enjoy!");
  });

  it("leaves remote URLs and audio directives untouched", async () => {
    const { reclaimImageMentions } = await load();
    const raw = "MEDIA:https://cdn.example/pic.png\nMEDIA:/home/clawbox/voice.wav\nCaption.";
    const out = reclaimImageMentions(raw);
    expect(out.sources).toEqual([]);
    expect(out.text).toBe(raw);
  });

  it("keeps fenced examples as text", async () => {
    const { reclaimImageMentions } = await load();
    const raw = "```\nMEDIA:/home/clawbox/.hermes/cache/images/example.png\n```";
    const out = reclaimImageMentions(raw);
    expect(out.sources).toEqual([]);
    expect(out.text).toBe(raw);
  });

  it("one generation, one card: the tool row and the model's mention name the same file, adopted once", async () => {
    const file = writeCachedImage("clawai_dup.png");
    const { adoptHermesGeneratedImages, reclaimImageMentions } = await load();
    const { sources } = reclaimImageMentions("Done!\nMEDIA:" + file);
    const adopted = await adoptHermesGeneratedImages([file, ...sources]);
    expect(adopted).toHaveLength(1);
  });
});
