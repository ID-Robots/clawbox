// Drawing a picture and speaking a line, for a delegated coding run.
//
// These are the only tools on this server that make the DEVICE spend something
// on the agent's behalf — a ClawBox AI picture out of a per-UTC-day allowance,
// a cloud voice billed per character — so three things are true of both:
//
//   1. They exist only inside a run (mcp/lib/run-context.ts) AND only where the
//      owner's switch says so (CLAWBOX_RUN_MEDIA). A tool that existed and
//      always answered "switched off" is a refusal a small model argues with,
//      and on Hermes a candidate for the per-server circuit breaker.
//   2. The path fence here is a COURTESY for a mistyped path. The real one is
//      in the route (src/lib/coding-agent-media.ts): this process holds the
//      device bearer, and so does a prompt-injected run.
//   3. Every refusal is worded so the model's next step is obvious. A spent
//      allowance and a busy voice are not faults and must not be retried —
//      "carry on without" is the answer, and the reply says so.
//
// No "@/" imports: this process is stdio and alias-free (mcp/lib/guard.ts), so
// the generator and the voice are reached through their routes, never directly.

import path from "path";
import { isInside } from "../../src/lib/file-guard";
import { apiPost } from "../lib/api";
import { ToolError, type ErrorRule } from "../lib/errors";
import { text, type Registrar } from "../lib/register";
import { runContext, runMedia } from "../lib/run-context";
import { zEnumOf, zText } from "../lib/schema";

/**
 * Both calls wait on something slower than a normal API call, and the client's
 * budget must sit ABOVE the backend's — a client that gives up first pays for
 * an answer it discards and then asks the same question again (the double-fire
 * describe_image had at apiPost's 8 s default).
 *
 * The picture: 120 s upstream in src/lib/harness/clawai-images.ts, plus the
 * queue behind the one generation slot. The voice: 90 s for the local engine,
 * 60 s for the cloud one, plus its own box-wide queue. The backend constants
 * cannot be imported here (their modules carry the "@/" alias), so
 * src/tests/unit/mcp-media-tools.test.ts pins these against them instead.
 */
export const IMAGE_CALL_TIMEOUT_MS = 180_000;
export const AUDIO_CALL_TIMEOUT_MS = 150_000;

/** The device's answers, turned into a next step. Order matters: first match wins. */
const MEDIA_RULES: ErrorRule[] = [
  {
    status: 429,
    code: "CONFLICT",
    message: "This ClawBox has spent what it can spend on this right now — today's picture allowance, or a voice that is already speaking.",
    next: "Do not retry this call. Finish the task without it and say in your report which asset is missing.",
  },
  {
    status: 503,
    code: "ENDPOINT_DOWN",
    message: "This ClawBox is not linked to ClawBox AI, so it cannot generate media.",
    next: "Do not call this tool again in this run. Carry on and note in your report that the device cannot generate media.",
  },
  {
    status: 403,
    code: "BLOCKED_PATH",
    message: "That path is outside your working folder and your evidence folder.",
    next: "Pass a path inside the folder you were started in, e.g. assets/hero.png; do not retry that path.",
  },
  {
    status: 409,
    code: "CONFLICT",
    message: "The device refused: the owner has this switched off, this run has had its allotted files, or that name is taken.",
    next: "Do not retry with the same arguments. Try one different file name at most, then carry on without it.",
  },
  {
    status: 502,
    code: "ENDPOINT_DOWN",
    message: "The device could not produce that file.",
    next: "Try once more at most, then finish the task without it.",
  },
  {
    status: 400,
    code: "BAD_ARGUMENT",
    message: "The device refused those arguments.",
    next: "Check the file name's extension and that the text or prompt is not empty, then call once more.",
  },
];

interface MediaReply {
  path?: string;
  bytes?: number;
  used?: number;
  cap?: number;
  engine?: string | null;
  /** The size the device actually produced — absent when it could not resize. */
  size?: number | null;
}

/** Kilobytes, so a reply says something a person and a model both read at a glance. */
function kb(bytes: number | undefined): string {
  return typeof bytes === "number" ? `${Math.max(1, Math.round(bytes / 1024))} KB` : "unknown size";
}

/**
 * The reply, ending in the count.
 *
 * The budget is stated on every success on purpose: a model that cannot see
 * how much it has spent keeps asking until the cap answers for it, and the cap
 * is a refusal where this is a fact it can plan around.
 */
function wrote(what: string, given: string, reply: MediaReply, extra = ""): string {
  const used = typeof reply.used === "number" && typeof reply.cap === "number"
    ? ` ${reply.used} of ${reply.cap} ${what} used in this run.`
    : "";
  return `Wrote ${given} (${kb(reply.bytes)}${extra}).${used}`;
}

/**
 * Where a relative path lands, and the early refusal for one that cannot
 * possibly be allowed. The route decides for real, realpath'd, against the
 * ACTIVE run — this only turns a typo into a clear message instead of a
 * backend refusal the model has to interpret.
 */
function resolveInRun(given: string, run: { workingDir: string; artifactsDir: string }): string {
  const abs = path.isAbsolute(given) ? given : path.join(run.workingDir, given);
  if (!isInside(abs, run.workingDir) && !isInside(abs, run.artifactsDir)) {
    throw new ToolError(
      "BLOCKED_PATH",
      "That file is outside this run's folders.",
      "Pass a path inside the working folder or the evidence folder, e.g. assets/hero.png.",
    );
  }
  return abs;
}

export function registerMediaTools(reg: Registrar): void {
  const run = runContext();
  if (!run) return;
  const media = runMedia();

  if (media.images) {
    reg.tool(
      "generate_image",
      "Draw a picture with this device's own image model and save it as a PNG in your project — hero art, a sprite, a background, a texture, a logo. Describe what you want in the prompt; you cannot see the result, so describe it fully. Each picture is paid for out of the owner's daily allowance, so spend them on the few that carry the project. Do not use it for the project's icon or favicon: those are drawn for you.",
      {
        prompt: zText(2_000, "What the picture should show, in plain words. Say the subject, the style and the background."),
        path: zText(512, "Where to save it, relative to your working folder, e.g. assets/hero.png. Must end in .png."),
        size: zEnumOf(["1024", "512", "256"], "Width and height in pixels; square.").default("1024"),
      },
      { editions: ["openclaw", "hermes"], family: "browser", readOnly: false, openWorld: true, maxChars: 2_000 },
      async ({ prompt, path: given, size }: { prompt: string; path: string; size: string }) => {
        const abs = resolveInRun(given, run);
        const reply = await apiPost<MediaReply>(
          "/setup-api/coding-agent/media/image",
          { path: abs, prompt, size },
          { timeoutMs: IMAGE_CALL_TIMEOUT_MS, rules: MEDIA_RULES },
        );
        // The DEVICE's size, not the argument: a box whose sharp will not load
        // writes the picture at whatever the proxy drew, and a run told
        // "256x256" would lay its page out around a number nothing produced.
        const drawn = typeof reply.size === "number" ? `, ${reply.size}x${reply.size}` : "";
        return text(wrote("pictures", given, reply, drawn));
      },
    );
  }

  if (media.audio) {
    reg.tool(
      "generate_audio",
      "Speak a line of text in this device's own voice and save it as a WAV in your project — narration, a greeting, a spoken cue. Keep clips short and few: the device has one voice and the chat shares it, so a refusal that names memory or says it is busy means try once more later and then carry on without sound.",
      {
        text: zText(4_000, "What to say. Plain sentences; formatting marks are stripped before it is spoken."),
        path: zText(512, "Where to save it, relative to your working folder, e.g. audio/intro.wav. Must end in .wav, .mp3 or .ogg, and the box only writes it when the voice really answered in that format."),
      },
      { editions: ["openclaw", "hermes"], family: "browser", readOnly: false, maxChars: 2_000 },
      async ({ text: line, path: given }: { text: string; path: string }) => {
        const abs = resolveInRun(given, run);
        const reply = await apiPost<MediaReply>(
          "/setup-api/coding-agent/media/audio",
          { path: abs, text: line },
          { timeoutMs: AUDIO_CALL_TIMEOUT_MS, rules: MEDIA_RULES },
        );
        return text(wrote("clips", given, reply, reply.engine ? `, spoken by the ${reply.engine} voice` : ""));
      },
    );
  }
}
