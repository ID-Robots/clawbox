import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

/** Undo for the environment each case below rewrites. */
let restoreEnv: () => void = () => {};

/**
 * The Hermes chat turn, on the two things this branch added to it: an image can
 * ride along, and the exchange is written down where a refresh can find it.
 *
 * The argv assertions are the security-relevant half. Every path here becomes
 * an argv element for an agent that opens any readable absolute path it is
 * handed, so what the route REFUSES matters more than what it passes.
 */

const spawned: Array<{ bin: string; args: string[] }> = [];
let stderrBanner = "session_id: 20260810_221825_609d1e";
let stdoutReply = "hello back";
let exitCode = 0;

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: (bin: string, args: string[]) => {
    spawned.push({ bin, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (stdoutReply) child.stdout.emit("data", Buffer.from(stdoutReply));
      if (stderrBanner) child.stderr.emit("data", Buffer.from(stderrBanner));
      child.emit("close", exitCode);
    }, 0);
    return child;
  },
}));

// The catalogue is consulted only for pairing checks; a null payload makes the
// route fall through to its static allowlist, which is the plain case here.
vi.mock("@/lib/hermes-model-options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-model-options")>()),
  getModelOptions: async () => {
    throw new Error("catalogue unavailable");
  },
}));

let harness: "openclaw" | "hermes" = "hermes";
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => harness,
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));

let root: string;
let mediaRoot: string;

async function post(body: Record<string, unknown>) {
  vi.resetModules();
  const { POST } = await import("@/app/setup-api/hermes/chat/route");
  return POST(
    new Request("http://localhost/setup-api/hermes/chat", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

const transcript = () =>
  fs
    .readFileSync(path.join(root, "data", "chat-transcripts", "desktop.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const staged = (name: string) => path.join(mediaRoot, "chat-attachments", name);
// The last CHAT invocation, not merely the last spawn. The turn is no longer
// the only thing this route runs a `hermes` for — settling it also asks the
// config whether the box has a voice to speak the reply with — and a helper
// that just took the newest spawn started returning `config get` argv.
const lastArgs = () => {
  const chat = spawned.filter((s) => s.args.includes("-q"));
  return chat[chat.length - 1].args;
};

describe("POST /setup-api/hermes/chat", () => {
  beforeEach(() => {
    spawned.length = 0;
    exitCode = 0;
    stdoutReply = "hello back";
    stderrBanner = "session_id: 20260810_221825_609d1e";
    harness = "hermes";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hermeschat-"));
    restoreEnv = saveEnv("CLAWBOX_ROOT", "HOME", "OPENCLAW_HOME");
    process.env.CLAWBOX_ROOT = root;
    process.env.HOME = root;
    mediaRoot = path.join(root, "data", "chat-media");
    fs.mkdirSync(path.join(mediaRoot, "chat-attachments"), { recursive: true });
    for (const name of ["one.png", "two.png", "three.png"]) {
      fs.writeFileSync(staged(name), "png");
    }
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // ── Images ────────────────────────────────────────────────────────────────

  it("puts the first image on the flag the agent documents", async () => {
    // `--image IMAGE  Optional local image path to attach to a single query`,
    // verified against the checkout on the box (1091472, 2026-08-22).
    const res = await post({ message: "what is this", imagePaths: [staged("one.png")] });
    expect(res.status).toBe(200);
    const args = lastArgs();
    expect(args).toContain("--image");
    expect(args[args.indexOf("--image") + 1]).toBe(staged("one.png"));
  });

  it("sends the extra images the way the agent resolves them — as paths in the prompt", async () => {
    // `extract_image_refs()` scans the prompt for absolute picture paths that
    // exist on disk and dedupes against `--image`. One flag, then one bare path
    // per line, is exactly what that reads.
    await post({
      message: "compare these",
      imagePaths: [staged("one.png"), staged("two.png"), staged("three.png")],
    });
    const args = lastArgs();
    const prompt = args[args.indexOf("-q") + 1];
    expect(args[args.indexOf("--image") + 1]).toBe(staged("one.png"));
    expect(prompt).toContain(staged("two.png"));
    expect(prompt).toContain(staged("three.png"));
    // The first is on the flag; repeating it in the prompt would be redundant.
    expect(prompt.replace("compare these", "")).not.toContain(staged("one.png"));
  });

  it("adds no image flag at all to an ordinary turn", async () => {
    await post({ message: "hello" });
    expect(lastArgs()).not.toContain("--image");
  });

  it("refuses a path that escapes the staging tree", async () => {
    // The agent opens any readable absolute path. Escaping the tree hands it
    // the provider keys as a picture to describe.
    fs.writeFileSync(path.join(root, "secret.png"), "keys");
    await post({ message: "look", imagePaths: [path.join(root, "secret.png")] });
    const args = lastArgs();
    expect(args).not.toContain("--image");
    expect(args.join(" ")).not.toContain("secret.png");
  });

  it("drops an image that is gone rather than failing the whole turn", async () => {
    // The staging tree is swept on a retention schedule, so a file can age out
    // between being attached and being sent. `hermes --image` on a missing file
    // fails the run; the message itself is still worth delivering.
    const res = await post({ message: "still send this", imagePaths: [staged("vanished.png")] });
    expect(res.status).toBe(200);
    expect(lastArgs()).not.toContain("--image");
  });

  it("does not let a duplicate path be attached twice", async () => {
    await post({ message: "x", imagePaths: [staged("one.png"), staged("one.png")] });
    const args = lastArgs();
    const prompt = args[args.indexOf("-q") + 1];
    expect(prompt).toBe("x");
  });

  it("ignores non-strings in the image list", async () => {
    const res = await post({ message: "x", imagePaths: [42, null, { path: "/x.png" }] });
    expect(res.status).toBe(200);
    expect(lastArgs()).not.toContain("--image");
  });

  // ── The transcript ────────────────────────────────────────────────────────

  it("records the question before the child is spawned and the answer after", async () => {
    await post({ message: "remember 41" });
    expect(transcript()).toEqual([
      { role: "user", text: "remember 41", timestamp: expect.any(Number) },
      { role: "assistant", text: "hello back", timestamp: expect.any(Number) },
    ]);
  });

  it("leaves an unanswered question visibly unanswered when the turn dies", async () => {
    // Write order is what bounds the split brain: a lost turn shows a question
    // with no answer, rather than vanishing or leaving an answer to nothing.
    exitCode = 1;
    stdoutReply = "";
    stderrBanner = "HTTP 401: invalid api key";
    const res = await post({ message: "who are you" });
    expect(res.status).toBe(502);
    const rows = transcript();
    expect(rows[0]).toMatchObject({ role: "user", text: "who are you" });
    expect(rows[1]).toMatchObject({ role: "system", variant: "error" });
    expect(rows[1].text).toContain("401");
  });

  it("stores the picture as a picture, not as a MEDIA: line of text", async () => {
    // Written into the agent's OWN working directory, which is where an agent
    // with no image tool puts one. It is adopted into the chat media tree, and
    // what the transcript carries is a URL the browser can fetch — never the
    // directive, and never the device path the model wrote.
    const drawn = path.join(root, "pic.png");
    fs.writeFileSync(drawn, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    stdoutReply = `here you go\n\nMEDIA:${drawn}`;
    await post({ message: "draw" });
    const [, assistant] = transcript();
    expect(assistant.text).toBe("here you go");
    expect(assistant.media).toHaveLength(1);
    expect(assistant.media[0]).toContain("/setup-api/chat/media");
    // The COPY, under a name of ours — not the path the model named.
    expect(assistant.media[0]).toContain("chat-generated");
    expect(assistant.media[0]).not.toContain("pic.png");
  });

  it("drops the card when the picture cannot be served, and keeps the sentence", async () => {
    // The old behaviour lifted ANY absolute path the model uttered into a card,
    // with no containment check anywhere, so a file the chat cannot read became
    // a dead thumbnail over a download button that saved 21 bytes of
    // `{"error":"Not found"}` under a `.png` name. Measured on two live boxes,
    // one linked and one not, so it was never about the link.
    //
    // No card is the honest answer. The sentence is what the customer asked for
    // and it survives intact; the device path was machinery either way.
    stdoutReply = "here you go\n\nMEDIA:/home/clawbox/never-written.png";
    await post({ message: "draw" });
    const [, assistant] = transcript();
    expect(assistant.text).toBe("here you go");
    expect(assistant.media).toBeUndefined();
  });

  it("refuses to adopt a secret store dressed up as a picture", async () => {
    // Inside the browse root, so containment alone would pass it; the Files API
    // secret guard is what stops a copy of `~/.ssh` landing in a tree the
    // browser can read.
    const secret = path.join(root, ".ssh", "id_rsa.png");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    stdoutReply = `here you go\n\nMEDIA:${secret}`;
    await post({ message: "draw" });
    const [, assistant] = transcript();
    expect(assistant.text).toBe("here you go");
    expect(assistant.media).toBeUndefined();
  });

  it("records the user's own words, not the switch note written for the agent", async () => {
    await post({
      message: "[System note: switched model] two",
      displayText: "two",
    });
    expect(transcript()[0].text).toBe("two");
    // The agent still gets the note — only the transcript is narrowed.
    expect(lastArgs()[lastArgs().indexOf("-q") + 1]).toContain("[System note:");
  });

  it("records the attached picture against the question that carried it", async () => {
    await post({ message: "what is this", imagePaths: [staged("one.png")] });
    const [user] = transcript();
    expect(user.media).toHaveLength(1);
    expect(user.media[0]).toContain("/setup-api/chat/media");
  });

  // ── The CLI's reasoning panel ─────────────────────────────────────────────
  //
  // `display.show_reasoning` defaults to true, so `chat -q … -Q` prints the
  // model's internal monologue to STDOUT above the answer, framed in a
  // box-drawing panel. The route reads that whole stream as "the reply", so
  // every bubble opened with the monologue — and once the transcript landed,
  // every stored exchange did too.
  //
  // The frame is built in `HermesCLI.chat()` as `┌─{' Reasoning '}{'─'…}┐` /
  // `└{'─'…}┘` and printed through prompt_toolkit, which (piped) drops the ANSI
  // and ends every line with CRLF. That is what these fixtures are.

  /** Every line prompt_toolkit prints ends CRLF when the output is piped. */
  const CRLF = String.fromCharCode(13, 10);
  const PANEL_TOP = `┌─ Reasoning ${"─".repeat(45)}┐`;
  const PANEL_BOTTOM = `└${"─".repeat(58)}┘`;

  it("keeps the reasoning panel out of the reply and out of the record", async () => {
    stdoutReply = [
      PANEL_TOP,
      "The user wants the number. I should just say it.",
      PANEL_BOTTOM,
      "41.",
    ].join(CRLF);

    const res = await post({ message: "what was the number?" });
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("41.");

    const assistant = transcript().find((row) => row.role === "assistant");
    // Stripped ONCE, server-side, so the bubble and the stored record are the
    // same text. Cleaning it in the browser would have left the monologue in
    // the transcript for good.
    expect(assistant.text).toBe("41.");
    expect(assistant.text).not.toContain("Reasoning");
  });

  it("still records something when the whole reply was a panel", async () => {
    // An answer we cannot see. Showing the monologue is poor; storing an empty
    // assistant bubble is worse — it reads as the box having said nothing.
    stdoutReply = [PANEL_TOP, "Thinking, and nothing else made it out.", PANEL_BOTTOM].join(CRLF);

    const res = await post({ message: "hello" });
    expect(res.status).toBe(200);
    expect((await res.json()).text).not.toBe("");

    const assistant = transcript().find((row) => row.role === "assistant");
    expect(assistant.text).toContain("nothing else made it out");
  });
});
