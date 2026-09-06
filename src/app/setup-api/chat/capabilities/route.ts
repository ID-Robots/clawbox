import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { hasClawaiToken } from "@/lib/harness/credentials";
import type { HarnessFacts } from "@/lib/harness/capabilities";
import {
  HERMES_FACT_RETRY_MS,
  hermesAgentDrawsImages,
  hermesFeatureProbePending,
  hermesHasVisionRoute,
  hermesImageBackendPending,
  hermesSupportsImages,
  hermesVisionRoutePending,
} from "@/lib/harness/hermes-features";
import { clawaiImageRouteReachable } from "@/lib/harness/clawai-images";
import { hermesCanStreamTurns } from "@/lib/hermes-dashboard-turn";
import { hermesSpeaksReplies, hermesVoiceProbePending } from "@/lib/hermes-tts";

export const dynamic = "force-dynamic";

/**
 * What this box can actually do in chat, as facts rather than as answers.
 *
 * The chat surface turns these into capability flags with `capabilitiesFor`, a
 * pure function both the browser and the server can call, so a control is
 * never shown by one rule and served by another.
 *
 * Facts, not the values behind them: `hasClawaiToken` is a boolean precisely so
 * the device credential never travels to a browser. A page needs to know
 * whether the microphone can work, not what the token is.
 *
 * Session-gated by middleware along with the rest of `/setup-api/chat`.
 */
export async function GET() {
  const harness = await getActiveHarness();
  const linked = await hasClawaiToken();
  // The five Hermes facts are asked TOGETHER, and only on a Hermes box.
  //
  // Together, because nothing in this list feeds the next entry, and on a cold
  // cache each one is a real wait: `hermesSupportsImages` and the two config
  // reads each start a Python interpreter (0.9-1.3 s on a Jetson), the
  // streaming probe mints a ticket, and the image-route probe leaves the
  // device. Awaited one after another they added up to 2.5-4 s of chat with no
  // attach button on every mount while the memos were cold — and every
  // `hermes config set` bumps config.yaml's mtime and cools two of them again.
  // Asked at once, the wait is the slowest probe rather than the sum. Safe to
  // gather with `Promise.all`: every probe fails CLOSED and never rejects, and
  // each memoises its in-flight promise so concurrent callers share one spawn.
  //
  // Only on Hermes, because `hermes` may not be installed on an OpenClaw box
  // at all, and no OpenClaw capability reads any of these: it has its own
  // socket and its own streaming, makes pictures through its own bundled
  // plugin, and reads the credential instead. Spending a spawn (and a failure)
  // there would compute facts nobody consumes.
  const onHermes = harness === "hermes";
  const [supportsImages, hasVisionRoute, streamsTurns, hasImageRoute, drawsImages, speaksReplies] =
    await Promise.all([
      // Whether the installed `hermes` understands `chat --image` — PROBED,
      // once per process. An attach button shown on a guess would stage files
      // into a turn that ignores them, which is worse than no button at all.
      onHermes ? hermesSupportsImages() : false,
      // The second half of the same question: whether anything on this box
      // would LOOK at the picture the flag above lets the turn carry. Read
      // from `auxiliary.vision.model`, which is the store the agent's own image
      // routing reads, through the mtime-keyed config memo — so linking ClawBox
      // AI flips it on the next re-probe rather than on the next restart.
      onHermes ? hermesHasVisionRoute() : false,
      // Whether a turn can go through the running dashboard and stream back,
      // rather than spawning a CLI whose answer only exists once it exits.
      // Probed by minting a WebSocket ticket — cheap, local, and the same door
      // the turn itself will use, so a yes here is a yes for the real thing.
      onHermes ? hermesCanStreamTurns() : false,
      // Whether the ClawBox AI proxy is up and still serving the image model
      // this box would ask for. The one fact here that leaves the device, so
      // it is asked only where the answer can matter — on Hermes, whose
      // picture button is the thing it gates, and only once there is a
      // credential to spend on a picture at all. An unlinked box is already
      // `canGenerateImages: false` and would be spending a network round trip
      // to stay that way.
      //
      // Cheap and cached (0.32 s measured, 10 minutes on a yes), so a chat
      // opened twice pays for it once. It is a plain metadata read: no
      // generation is started and no daily allowance is spent.
      onHermes && linked ? clawaiImageRouteReachable() : false,
      // Whether the agent has an image backend selected — the Hermes spelling
      // of "can this box draw". Read from `image_gen.provider` through the same
      // mtime-keyed memo as the vision route, so it flips on the model-state
      // event the moment ClawBox AI is linked rather than at the next restart.
      onHermes ? hermesAgentDrawsImages() : false,
      // Whether the box has a VOICE selected — the same shape as the image
      // backend above, read from `tts.provider` through the same mtime-keyed
      // memo, so a selection made in Settings -> Voice reaches the chat on the
      // next re-probe rather than at the next restart.
      onHermes ? hermesSpeaksReplies() : false,
    ]);
  const facts: HarnessFacts = {
    // A boolean precisely so the device credential never travels to a browser.
    hasClawaiToken: linked,
    hermesSupportsImages: supportsImages,
    hermesHasVisionRoute: hasVisionRoute,
    hermesStreamsTurns: streamsTurns,
    hermesSpeaksReplies: speaksReplies,
    hasClawaiImageRoute: hasImageRoute,
    hermesAgentDrawsImages: drawsImages,
  };
  // Which of those `false`s is an ANSWER, and which is a placeholder the server
  // has already undertaken to replace by itself.
  //
  // Every Hermes fact above fails closed, so "this box cannot" and "this box
  // could not say" leave by the same door — correct for the composer, because a
  // wrong `true` stages the customer's file into a turn that ignores it, but it
  // stranded the browser. `use-harness-adapter` fetches this once on mount and
  // re-asks only on an explicit provider change, on no timer, so one probe
  // timeout during chat open hid the attach button for the entire page session
  // while the memos behind these facts recovered a minute later. Saying so lets
  // the page come back for the real answer instead of waiting for a reload.
  //
  // Asked ONLY on Hermes, and only after the awaits above: these accessors read
  // the memos without touching them, so on an OpenClaw box — where none of the
  // probes ran — an entry left over from an earlier harness must not put that
  // page on a timer for a fact no OpenClaw capability reads.
  //
  // `hasClawaiImageRoute` is deliberately NOT counted. Its probe caches a plain
  // `false` for a minute whether the proxy answered "no" or did not answer at
  // all — it draws no answer/failure distinction to report — so folding it in
  // would mean claiming a precision that module does not have. (It answers
  // false for a third reason too: the proxy has named this device's credential
  // invalid, remembered for fifteen minutes. That one is not pending either —
  // it is settled until the device is re-linked.)
  const factsPending =
    harness === "hermes" &&
    (hermesFeatureProbePending()
      || hermesVisionRoutePending()
      || hermesImageBackendPending()
      || hermesVoiceProbePending());
  return NextResponse.json({
    harness,
    facts,
    factsPending,
    // Published rather than duplicated in the browser, so the wait and the
    // backoff it is waiting on cannot drift apart.
    factsRetryAfterMs: HERMES_FACT_RETRY_MS,
  });
}
