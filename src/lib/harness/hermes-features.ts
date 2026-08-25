import { runHermesCli } from "@/lib/hermes-cli";
import { hermesConfigGet } from "@/lib/hermes-config-cache";

/**
 * What the INSTALLED `hermes` can do — asked, not assumed. SERVER ONLY.
 *
 * The Hermes agent is a git checkout of an upstream project that moves daily,
 * and this box's copy is whatever the last update pulled. Everything the chat
 * surface offers on top of it therefore has to be a probed fact rather than a
 * compile-time constant: a compiled-in `true` would put an attach button on a
 * box whose `hermes` ignores the flag, so the file would stage, the turn would
 * run, and the model would answer about a picture it never saw. A wrong `false`
 * only hides a working button; a wrong `true` silently loses the user's data.
 * So this fails CLOSED.
 */

/** Probing costs a Python interpreter start. Long enough for a busy Jetson. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Once per process, never per request.
 *
 * `hermes chat --help` starts a Python interpreter, which on this hardware is
 * seconds, not milliseconds — running it per request would put that on every
 * chat open. The cache is the in-flight PROMISE, not the resolved value, so
 * concurrent callers during boot share one probe instead of racing several.
 *
 * A process restart re-probes, which is exactly the granularity that matters:
 * an update replaces the checkout and restarts the web server, so the answer
 * cannot outlive the binary it describes.
 */
let probe: Promise<boolean> | null = null;

/**
 * Does this `hermes` take an image on a chat turn?
 *
 * Verified against the live checkout (`~/.hermes/hermes-agent` @ 1091472,
 * 2026-08-22): `hermes chat --help` lists
 *
 *   --image IMAGE   Optional local image path to attach to a single query
 *
 * The help text is the right thing to read rather than a version number: a
 * version says which commit is checked out, and only a flag list says what that
 * commit accepts. Matched on the flag as it appears in the options list, so a
 * mention in prose elsewhere in the help cannot answer yes on its own.
 */
export async function hermesSupportsImages(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const result = await runHermesCli(["chat", "--help"], { timeoutMs: PROBE_TIMEOUT_MS });
      if (result.code !== 0) return false;
      return /^\s*--image\b/m.test(`${result.stdout}\n${result.stderr}`);
    } catch {
      // Not installed, timed out, or the checkout is broken. All of them mean
      // the same thing to the composer: do not offer to attach a picture.
      return false;
    }
  })();
  return probe;
}

/** Test seam: forget the probe so the next call runs it again. */
export function resetHermesFeatureProbe(): void {
  probe = null;
}

/**
 * The config key that names the model an attached picture is actually LOOKED AT
 * with. Written by `applyClawaiToHermes`; empty on a box nobody has linked.
 */
const VISION_MODEL_KEY = "auxiliary.vision.model";

/**
 * Is there anywhere for an attached picture to be looked at?
 *
 * The `--image` flag above only says the turn will CARRY the file. Whether
 * anything then reads it is a second question with a second answer, and on an
 * unlinked box the answer is no: `agent/image_routing.py` runs in `auto` mode,
 * attaches the image natively only when the ACTIVE model reports
 * `supports_vision`, and otherwise routes it through `vision_analyze` using
 * whatever `auxiliary.vision` names. With nothing named there, the file reaches
 * the agent and no route exists — observed on the bench box as the model
 * reaching for a `vision_analyze` tool that was not there and finally
 * hand-writing pixel-scanning Python to answer at all.
 *
 * WHY THE CONFIG AND NOT THE CLAWBOX AI TOKEN. The token is what CAUSES the
 * vision keys to be written (`applyClawaiToHermes` writes them and nothing else
 * does), which makes it tempting as a proxy. It is the wrong fact in both
 * directions:
 *
 *   - a box can hold the token WITHOUT the config — `hasClawaiToken` also
 *     resolves OpenClaw's `openclaw.json`, so a dual box linked through the
 *     OpenClaw path has the credential and no Hermes vision keys, and an apply
 *     that failed part-way leaves the same state. That is the dangerous
 *     direction: an attach button over a route that does not exist;
 *   - a box can hold the config WITHOUT the token — a customer who pointed
 *     `auxiliary.vision` at their own provider. Reading the token would hide a
 *     working button.
 *
 * The config is also simply what the agent itself reads at turn time, so this
 * asks the same store the behaviour comes from rather than a thing correlated
 * with it.
 *
 * WHY `model` AND NOT "the block is present". Verified on the live box
 * (2026-08-22, unlinked): `hermes config get auxiliary` prints the whole block
 * from the schema defaults — `vision: {provider: auto, model: '', base_url: '',
 * api_key: '', …}` — so presence says nothing at all, and `provider` reads as
 * the literal string `auto` rather than as empty. The model id is the one field
 * that stays empty until something configures it.
 *
 * KNOWN AND ACCEPTED FALSE NEGATIVE: a box whose CHAT model is itself
 * vision-capable needs no auxiliary route, and this reports false there and
 * hides a button that would have worked. That is the same asymmetry the flag
 * probe above is built on — a wrong `false` costs a hidden control, a wrong
 * `true` costs the customer's file and an answer about a picture nobody looked
 * at. Reading `supports_vision` for the active model would be the refinement;
 * it needs a per-provider capability lookup that does not exist here yet.
 *
 * Not memoised in this module ON PURPOSE. `hermesConfigGet` keys its cache on
 * config.yaml's mtime, and linking ClawBox AI rewrites that file — so the
 * answer flips as soon as the customer links, which is exactly when the chat
 * re-asks (`use-harness-adapter` re-probes on the model-state event). A
 * process-lifetime cache like the flag probe's would keep the attach button
 * hidden until the next restart on a box that can now see.
 */
export async function hermesHasVisionRoute(): Promise<boolean> {
  try {
    return (await hermesConfigGet(VISION_MODEL_KEY)).trim().length > 0;
  } catch {
    // `hermesConfigGet` answers "" rather than throwing, so this is belt and
    // braces — and it fails closed for the same reason the probe above does.
    return false;
  }
}

/**
 * The config key that names the backend a drawing request is serviced BY.
 *
 * `image_gen.provider` is what `agent/image_gen_registry.get_active_provider()`
 * reads (v0.20.5, line 134) before it hands an `image_generate` call to a
 * registered backend. Written by `applyClawaiToHermes`; unset on a box nobody
 * has linked, where the tool has no backend at all.
 */
const IMAGE_PROVIDER_KEY = "image_gen.provider";

/**
 * Can the agent on this box actually draw?
 *
 * The Hermes shape of image generation is nothing like the ClawBox chat's: the
 * customer ASKS, in words, in whatever channel they are in, and the agent
 * reaches for its own `image_generate` tool. So the honest question is not
 * "does a route exist" — it is "is a backend selected", which is a fact about
 * this box's config and therefore a probe, exactly like `hermesHasVisionRoute`
 * next door.
 *
 * WHY THE CONFIG AND NOT THE TOKEN. Same asymmetry the vision probe documents,
 * and one more reason on top of it: linking is what WRITES this key, but the
 * write is fail-soft (see `applyClawaiToHermes`) — a box can hold a perfectly
 * good token and have no image backend because the plugin copy failed. Reading
 * the token would report `true` there and put a promise in front of a customer
 * that the next request cannot keep. A wrong `false` only hides an ability;
 * a wrong `true` is an apology.
 *
 * WHY `image_gen.provider` AND NOT "the block exists". Verified on the live box
 * (2026-08-24, before linking): `hermes config get image_gen` answers
 * `Config key not set: image_gen` — the section has no schema defaults at all,
 * unlike `auxiliary`, so on THIS key presence and configuration are the same
 * thing. Reading `provider` rather than the section keeps it that way if
 * upstream ever gives the block defaults.
 *
 * KNOWN AND ACCEPTED FALSE POSITIVE: a customer who selected some other backend
 * by hand (`hermes tools` → Image Generation → FAL) and never gave it a key
 * reads as `true` here and gets an error from the agent instead of a picture.
 * That error comes from upstream's own dispatcher and NAMES the missing
 * credential and the selection, which is a better outcome than this file
 * second-guessing a choice the customer made deliberately.
 *
 * Not memoised in this module ON PURPOSE, for the same reason the vision probe
 * is not: `hermesConfigGet` keys its cache on config.yaml's mtime, and linking
 * rewrites that file — so the answer flips as soon as the customer links rather
 * than at the next restart.
 */
export async function hermesAgentDrawsImages(): Promise<boolean> {
  try {
    return (await hermesConfigGet(IMAGE_PROVIDER_KEY)).trim().length > 0;
  } catch {
    // `hermesConfigGet` answers "" rather than throwing, so this is belt and
    // braces — and it fails closed for the same reason the rest of this file does.
    return false;
  }
}
