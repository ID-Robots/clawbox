import { NextRequest, NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { UNKNOWN_FACTS, capabilitiesFor } from "@/lib/harness/capabilities";
import { ClawaiImageError, generateClawaiImage } from "@/lib/harness/clawai-images";
import { appendTranscript } from "@/lib/harness/transcript-store";
import { DESKTOP_TRANSCRIPT_KEY, transcriptKeyIsSafe } from "@/lib/harness/transcript-key";

export const dynamic = "force-dynamic";

// ── Drawing a picture on a harness that cannot draw one itself ──────────────
//
// POST /setup-api/chat/images
//   { "prompt": "a red maple leaf" }
// → 200 { ok: true, media: ["/setup-api/chat/media?path=…"] }
//
// The box calls the ClawBox AI images endpoint on the customer's behalf and
// writes the result into its own chat media tree, where `/setup-api/chat/media`
// can serve it back. `clawai-images.ts` holds the observed upstream contract
// and every decision about it; this file is the HTTP shell and the transcript.
//
// WHY THE DEVICE PROXIES rather than letting the page call the endpoint: the
// same reason voice input does. The ClawBox AI token is the DEVICE's
// credential, not the page's, and handing it to browser JavaScript would put it
// in every devtools network panel and in the memory of any script the chat
// surface ever loads. The browser talks to the box; only the box talks to the
// proxy.
//
// WHO IS ALLOWED TO CALL THIS is not decided here — it is decided by
// `capabilities.imageGenerationTrigger`, which is `'composer'` only on a
// harness whose agent has no image tool of its own. On OpenClaw the customer
// asks in plain words and the agent draws; this route is not in that path and
// nothing on that edition calls it.
//
// Session-gated by middleware, which lists /setup-api/chat among the surfaces
// that stay closed even during the pre-setup AP window.

/**
 * Long enough for a described scene, short enough that a runaway paste is not
 * sent upstream and billed. The proxy has its own limit; this one exists so a
 * caller learns about the problem from the box, instantly, rather than from a
 * 400 fifteen seconds later.
 */
const MAX_PROMPT_CHARS = 4000;

/**
 * Does THIS box replay its chat from the transcript on disk?
 *
 * The same question `/setup-api/chat/history` asks, in the same words, and
 * asked as a capability rather than as `harness === "hermes"` for the same
 * reason: a harness with a live transport has a store of its own to be replayed
 * from, and writing these two records into a file nothing reads would be a
 * quiet lie about where the conversation lives.
 *
 * Facts do not matter to it — no capability read here depends on a credential —
 * so the cautious defaults are enough and this stays a cheap call.
 */
async function transcriptLivesHere(): Promise<boolean> {
  const harness = await getActiveHarness();
  return !capabilitiesFor(harness, UNKNOWN_FACTS).hasLiveConnection;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const raw = (body as { prompt?: unknown } | null)?.prompt;
  const prompt = typeof raw === "string" ? raw.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "Describe the picture you want." }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json(
      { error: "That description is too long. Shorten it and try again." },
      { status: 400 },
    );
  }

  // The conversation the picture belongs to — the desktop thread unless the
  // surface named a tab. Validated for the reason the history route validates
  // it: the key becomes a filename.
  const rawKey = (body as { sessionKey?: unknown } | null)?.sessionKey;
  const sessionKey = typeof rawKey === "string" && rawKey ? rawKey : DESKTOP_TRANSCRIPT_KEY;
  if (!transcriptKeyIsSafe(sessionKey)) {
    return NextResponse.json({ error: "Invalid session key" }, { status: 400 });
  }

  const durable = await transcriptLivesHere();
  // The REQUEST is recorded before the upstream call, the same way the chat
  // route records a question before it spawns the agent: a generation that dies
  // half way — the service restarting under a 15-second call, the customer
  // closing the tab — then leaves a request with no picture, which is visibly
  // incomplete, rather than vanishing without trace.
  if (durable) {
    await appendTranscript({ role: "user", text: prompt, timestamp: Date.now() }, sessionKey);
  }

  let result;
  try {
    result = await generateClawaiImage(prompt, { signal: req.signal });
  } catch (err) {
    if (!(err instanceof ClawaiImageError)) {
      // Never the thrown message: an unexpected failure here is a filesystem or
      // runtime error, and those quote paths. The box's log keeps the detail.
      console.warn(
        "[chat/images] generation failed:",
        err instanceof Error ? err.message : "unknown error",
      );
      return NextResponse.json({ error: "Could not generate the picture." }, { status: 500 });
    }
    // A customer who hit Stop gets no error bubble and no transcript line — the
    // request they made is already recorded above, where an unanswered one
    // belongs. 499 is the status the chat route already uses for the same thing.
    if (err.status === 499) return new NextResponse(null, { status: 499 });
    // Every other failure IS recorded, for the reason the chat route records
    // its own: without this a refresh shows a request with nothing under it and
    // no hint that the box tried — the same screen a still-running generation
    // produces, which is the worse of the two to be wrong about.
    if (durable) {
      await appendTranscript({
        role: "system",
        text: `Error: ${err.message}`,
        timestamp: Date.now(),
        variant: "error",
      }, sessionKey);
    }
    return NextResponse.json({ error: err.message }, { status: err.status });
  }

  // The picture, as the bubble will hold it. Stored as the `/setup-api/chat/media`
  // ref rather than as the absolute path so that a replayed transcript is
  // byte-identical to the live conversation — the same rule the chat route
  // follows when it splits `MEDIA:` lines out of an answer.
  if (durable) {
    await appendTranscript({
      role: "assistant",
      text: "",
      timestamp: Date.now(),
      media: [result.media],
    }, sessionKey);
  }
  return NextResponse.json({ ok: true, media: [result.media] });
}
