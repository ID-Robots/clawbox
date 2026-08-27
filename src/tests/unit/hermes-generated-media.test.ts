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
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function writeImage(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG_BYTES);
  return file;
}

function writeCachedImage(name: string): string {
  return writeImage(path.join(cacheDir(), name));
}

/**
 * A picture written where an IMPROVISING agent writes one: its own working
 * directory, which on the appliance is the home directory the Files API already
 * serves. This is literally what the owner's box did — `write_file` an SVG into
 * `/home/clawbox`, rasterise it with cairosvg — and the file it left behind is
 * the one that rendered as a dead card.
 */
function writeWorkspaceImage(name: string): string {
  return writeImage(path.join(home, name));
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

  it("refuses a secret store dressed up as a picture", async () => {
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
    const drawn = path.join(cacheDir(), "a.png");
    const out = reclaimImageMentions(`Here you go!\nMEDIA:${drawn}`);
    expect(out.sources).toEqual([drawn]);
    expect(out.text).toBe("Here you go!");
  });

  it("strips an [Image: …] aside but keeps the sentence around it", async () => {
    const { reclaimImageMentions } = await load();
    const drawn = path.join(cacheDir(), "b.png");
    const out = reclaimImageMentions(`Your red square: [Image: ${drawn}] — enjoy!`);
    expect(out.sources).toEqual([drawn]);
    expect(out.text).toBe("Your red square: — enjoy!");
  });

  it("leaves a path the chat can already serve exactly where the model put it", async () => {
    // The customer's own attachment, echoed back. `chat/media` serves that
    // tree, so lifting it into the adoption list — which refuses everything
    // outside the image cache — would drop a picture that worked before.
    const { reclaimImageMentions } = await load();
    const attached = path.join(home, "data", "chat-media", "chat-attachments", "one.png");
    const raw = `Got it.\nMEDIA:${attached}`;
    const out = reclaimImageMentions(raw, path.join(home, "data", "chat-media"));
    expect(out.sources).toEqual([]);
    expect(out.text).toBe(raw);
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
    const raw = "```\nMEDIA:" + path.join(cacheDir(), "example.png") + "\n```";
    const out = reclaimImageMentions(raw);
    expect(out.sources).toEqual([]);
    expect(out.text).toBe(raw);
  });

  it("stops after four pictures however many one turn names", async () => {
    // Every copy is made AFTER the sweep that was meant to make room, so an
    // unbounded batch is an unbounded overshoot of the retention budget — and
    // the sweep that corrects it next turn pays for it with someone's older
    // picture. The turn record already stops at four; the model's own mentions
    // stopped at nothing.
    const files = ["a", "b", "c", "d", "e", "f"].map((n) => writeCachedImage(`many_${n}.png`));
    const { adoptHermesGeneratedImages } = await load();
    const adopted = await adoptHermesGeneratedImages(files);
    expect(adopted).toHaveLength(4);
  });

  it("one generation, one card: the tool row and the model's mention name the same file, adopted once", async () => {
    const file = writeCachedImage("clawai_dup.png");
    const { adoptHermesGeneratedImages, reclaimImageMentions } = await load();
    const { sources } = reclaimImageMentions("Done!\nMEDIA:" + file);
    const adopted = await adoptHermesGeneratedImages([file, ...sources]);
    expect(adopted).toHaveLength(1);
  });

  // ── A picture the agent made ITSELF, outside the cache ──
  //
  // A box with no ClawBox AI link has no image tool, and the agent asked for a
  // picture anyway improvises: on the owner's box it wrote an SVG into its own
  // working directory and rasterised it. Before this, that file was refused by
  // adoption AND left in the caption, where `splitAssistantMedia` lifted it into
  // a card `chat/media` then answered 404 to — a dead thumbnail beside a
  // download button that saved the error body under a `.png` name.
  //
  // The rule these hold: RENDER IT, OR SHOW NO CARD. Never a card that 404s.

  /** What `settleTurn` does, in the order it does it. */
  async function settle(spoken: string, toolRows: string[] = []) {
    const { adoptHermesGeneratedImages, reclaimImageMentions } = await load();
    const mediaRoot = path.join(home, "data", "chat-media");
    const { text, sources } = reclaimImageMentions(spoken, mediaRoot);
    const drawn = await adoptHermesGeneratedImages([...toolRows, ...sources]);
    return { text, cards: drawn };
  }

  it("adopts a picture the agent wrote in its own working directory", async () => {
    const drawn = writeWorkspaceImage("crab_sword_space.png");
    const { text, cards } = await settle(`Here you go\u2014a cosmic crab!\nMEDIA:${drawn}`);
    // One card, and one that resolves: the copy lives in the tree `chat/media`
    // serves, under a name of ours rather than the model's.
    expect(cards).toHaveLength(1);
    expect(cards[0].startsWith(generatedDir() + path.sep)).toBe(true);
    expect(fs.existsSync(cards[0])).toBe(true);
    // The sentence survives; only the machinery line goes.
    expect(text).toBe("Here you go\u2014a cosmic crab!");
  });

  it("shows NO card when the picture cannot be adopted, and keeps the sentence", async () => {
    // Named but never written — the shape of every path the model invents.
    const { text, cards } = await settle(
      `Here you go!\nMEDIA:${path.join(home, "imaginary.png")}`,
    );
    expect(cards).toEqual([]);
    expect(text).toBe("Here you go!");
  });

  it("shows NO card for a relative mention either", async () => {
    // `MEDIA:crab.png` used to survive the caption and become a card resolving
    // to `?path=crab.png`, which is a 404 by a different route to the same
    // broken thumbnail.
    const { text, cards } = await settle("Done!\nMEDIA:crab.png");
    expect(cards).toEqual([]);
    expect(text).toBe("Done!");
  });

  it("refuses a credential store even when the model dresses it as a picture", async () => {
    // `~/.ssh` is inside the browse root, so containment alone would let this
    // through; the secret guard is what stops it. A copy here would publish the
    // customer's key material to anyone with the chat open.
    const secret = writeImage(path.join(home, ".ssh", "id_rsa.png"));
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages([secret])).toEqual([]);
    // And nothing in ~/.hermes either — the provider keys live there.
    const hermesSecret = writeImage(path.join(home, ".hermes", "auth.png"));
    expect(await adoptHermesGeneratedImages([hermesSecret])).toEqual([]);
  });

  it("refuses a path in no root at all", async () => {
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages(["/etc/shadow.png"])).toEqual([]);
  });

  it("still adopts from the image cache — the clawai path #482 fixed", async () => {
    // The regression that matters most: the working path on a LINKED box. The
    // cache lives under ~/.hermes, which the secret guard refuses wholesale, so
    // a fix that simply ran every root through the guard would have silently
    // broken every picture ClawBox AI has ever drawn.
    const drawn = writeCachedImage("clawai.png");
    const { text, cards } = await settle(`Here is your picture.\nMEDIA:${drawn}`, [drawn]);
    expect(cards).toHaveLength(1);
    expect(text).toBe("Here is your picture.");
  });

  it("still keeps a mention the chat can already serve where the model put it", async () => {
    const attached = path.join(home, "data", "chat-media", "chat-attachments", "one.png");
    const raw = `Got it.\nMEDIA:${attached}`;
    const { reclaimImageMentions } = await load();
    const out = reclaimImageMentions(raw, path.join(home, "data", "chat-media"));
    expect(out.sources).toEqual([]);
    expect(out.text).toBe(raw);
  });

  it("takes a file:// mention out of the caption instead of leaving it to 404", async () => {
    // `mediaUrl` strips the scheme and asks `chat/media` for the path beneath,
    // so a `file://` mention left in the caption is a dead card by a slightly
    // longer route. It is a local path; it is reclaimed as one, and then judged
    // by adoption like any other. (Asserted on the reclaim rather than on a
    // real file, because a `file://` URL of a Windows path is not a path this
    // test could then write to.)
    const { reclaimImageMentions } = await load();
    const out = reclaimImageMentions("Here.\nMEDIA:file:///home/clawbox/crab.png");
    expect(out.sources).toEqual(["/home/clawbox/crab.png"]);
    expect(out.text).toBe("Here.");
  });

  it("one card when the tool row and the sentence spell the same file differently", async () => {
    // The dedupe used to key on the raw string, and the model does not always
    // write the path back exactly as the tool gave it.
    const drawn = writeWorkspaceImage("same.png");
    const wordy = path.join(home, ".", "same.png");
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages([drawn, wordy])).toHaveLength(1);
  });

  it("does not lose an attachment echo when the media root cannot be exempted", async () => {
    // The exemption in `reclaimImageMentions` normally leaves this path in the
    // caption. If it ever misses — an unresolvable media root, a symlink the
    // lexical test cannot see — the mention IS reclaimed, and the DATA_DIR guard
    // would refuse it. The media root is an adoption root of its own so the
    // picture still renders instead of vanishing.
    const attached = writeImage(
      path.join(home, "data", "chat-media", "chat-attachments", "echo.png"),
    );
    const { adoptHermesGeneratedImages, reclaimImageMentions } = await load();
    // No media root passed: the exemption cannot fire.
    const { sources } = reclaimImageMentions(`Got it.
MEDIA:${attached}`);
    expect(sources).toEqual([attached]);
    expect(await adoptHermesGeneratedImages(sources)).toHaveLength(1);
  });

  it("adopts a child whose NAME begins with two dots", async () => {
    // `path.relative` returns a bare segment, so `..crab.png` inside the root
    // yields rel === "..crab.png". A `startsWith("..")` test reads that as a
    // traversal and refuses a file that is plainly inside the root.
    const drawn = writeWorkspaceImage("..crab.png");
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages([drawn])).toHaveLength(1);
  });

  it("still refuses a real traversal, which is `..` as a whole segment", async () => {
    const { adoptHermesGeneratedImages } = await load();
    const climbing = path.join(cacheDir(), "..", "..", "..", "escape.png");
    expect(await adoptHermesGeneratedImages([climbing])).toEqual([]);
  });

  it("bounds the WORK a turn can be made to do, not just the pictures it yields", async () => {
    // Nothing here can ever be adopted, so a cap counting successes never
    // trips and every invented path still pays for a realpath and a stat on
    // the box. The reply these come from is capped in megabytes, not lines.
    const invented = Array.from({ length: 500 }, (_, i) =>
      path.join(home, `invented_${i}.png`),
    );
    const { adoptHermesGeneratedImages } = await load();
    const before = Date.now();
    expect(await adoptHermesGeneratedImages(invented)).toEqual([]);
    // The bound is the assertion; the timing is only here to say why it exists.
    expect(Date.now() - before).toBeLessThan(4000);
  });

  it("still reaches a real picture that follows a run of misses", async () => {
    // The attempt cap must not be so tight that a reply with a few dead paths
    // in front of a real one loses the real one.
    const good = writeWorkspaceImage("after_misses.png");
    const misses = Array.from({ length: 8 }, (_, i) => path.join(home, `gone_${i}.png`));
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages([...misses, good])).toHaveLength(1);
  });

  it("still stops at four however many the agent wrote", async () => {
    const files = ["a", "b", "c", "d", "e", "f"].map((n) =>
      writeWorkspaceImage(`spam_${n}.png`),
    );
    const { adoptHermesGeneratedImages } = await load();
    expect(await adoptHermesGeneratedImages(files)).toHaveLength(4);
  });
});
