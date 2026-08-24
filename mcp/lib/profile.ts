// Which tool profile to register: the SIZE half of the decision that
// mcp/lib/edition.ts makes for the EDITION half.
//
// Both are made ONCE, before server.connect(), for the same reason: Hermes
// builds tools/list from what this process registers, and a tool that appears
// and then misbehaves takes every ClawBox tool offline through the per-server
// circuit breaker. Registration is the only lever.
//
// WHY SIZE MATTERS AT ALL. Measured on a Hermes device with `hermes prompt-size
// --platform cli --json` plus a live tools/list over stdio: a turn ships 30,472
// chars of system text, 19 built-in tools (56,275 B of schema) and — before
// this — 42 ClawBox tools (26,358 B). ~113 KB before the customer's first word.
// The device's default local model is Gemma 4 E2B with a 64k configured window,
// and it spends that budget describing tools instead of answering. The `core`
// profile drops the ClawBox half to the tools a chat window actually needs.
//
// WHY NOT JUST SET THE ENV IN scripts/register-mcp.sh. The profile has to
// follow the MODEL, and the model changes from Settings without anything
// re-writing ~/.hermes/config.yaml. Resolving it here means switching from the
// on-device model to a cloud provider restores the full tool set on the next
// agent run, with no provisioning step and nothing to keep in sync.
//
// WHY `auto` IS OPT-IN AND NOT THE DEFAULT. This half of the slim profile
// cannot be made per-turn correct, and shipping it on would be a regression.
// The chat route decides its `-t` narrowing from the PER-TURN provider
// (`effectiveProvider` — the chat header's `--provider`/`-m` override), but
// this process can only see the PERSISTED pairing, because the header override
// is client-local: ChatPopup writes localStorage and puts provider/model in the
// POST body, and only Settings ever POSTs /setup-api/hermes/models.
//
// The obvious repair — have the chat route export CLAWBOX_MCP_PROFILE for the
// turn — does not work, and that was VERIFIED rather than assumed. Hermes
// builds the stdio child's environment with `_build_safe_env`
// (tools/mcp_tool.py), which does not inherit os.environ: it copies only an
// allowlist (`_SAFE_ENV_KEYS`), `XDG_*`, secret-source variables, and the
// `env:` block from ~/.hermes/config.yaml. A ClawBox-specific name set by the
// chat route is filtered out before the MCP server ever starts.
//
// So on a device whose persisted provider is the on-device one, auto-selection
// would drop a chat-header-selected CLOUD turn from 38 tools to 14 — tools that
// work today. Default `full` keeps beta's behaviour exactly; `auto` exists so
// the on-device bake-off can measure the win, and so this rule ships with the
// per-turn `-t` narrowing (which IS correct) rather than as a separate change.

import { apiTry } from "./api";
import type { Profile } from "./register";
import { isSmallLocalModel, slimLocalProfileEnabled } from "../../src/lib/local-model-profile";
import { HERMES_LOCAL_REASONING_PROVIDER } from "../../src/lib/hermes-reasoning";

/** The shape of /setup-api/hermes/models this decision needs. */
export interface ActiveModel {
  /** The device's configured provider (`hermes config get model.provider`). */
  provider?: string;
  /** The device's configured model id. */
  current?: string;
}

/**
 * What `CLAWBOX_MCP_PROFILE` asks for: a pinned set, `auto` to follow the
 * model, or null when it says nothing (in which case the answer is `full`,
 * exactly as before this rule existed).
 */
type ProfileRequest = Profile | "auto";

function envProfile(env: NodeJS.ProcessEnv): ProfileRequest | null {
  const raw = (env.CLAWBOX_MCP_PROFILE || "").trim().toLowerCase();
  if (raw === "core") return "core";
  if (raw === "full") return "full";
  if (raw === "auto") return "auto";
  return null;
}

/**
 * The profile for a device whose active model is `model`.
 *
 * Pure, so the rule is testable without a device. Unset env answers `full` —
 * see the header for why following the model is opt-in. Under `auto` the gate
 * is the PROVIDER first: only a turn that runs on the on-device model can be
 * slimmed, and a cloud provider keeps every tool no matter how the id is
 * spelled.
 */
export function profileForActiveModel(
  model: ActiveModel | null,
  env: NodeJS.ProcessEnv = process.env,
): Profile {
  const requested = envProfile(env);
  if (requested !== "auto") return requested ?? "full";
  if (!slimLocalProfileEnabled(env)) return "full";
  if (!model || (model.provider || "").trim() !== HERMES_LOCAL_REASONING_PROVIDER) return "full";
  return isSmallLocalModel({ modelId: model.current || "" }) ? "core" : "full";
}

/**
 * Ask the device what it is running, then decide.
 *
 * A failed read answers "full": the larger set is what every device had before
 * this existed, and quietly withholding two thirds of the agent's tools because
 * one loopback GET timed out at boot is the worse failure. (Contrast
 * mcp/lib/edition.ts, where an unreadable lock resolves to the SMALLER set —
 * there the risk is registering a shell on a device deliberately built without
 * one, which is a different kind of wrong.)
 */
export async function resolveProfile(edition: "openclaw" | "hermes"): Promise<{
  profile: Profile;
  model: ActiveModel | null;
}> {
  const requested = envProfile(process.env);
  // Anything but `auto` is decided already — don't spend a round trip
  // discovering something we will ignore. This is also the default path, so a
  // device that has not opted in keeps the startup it had before. (The context
  // builder makes its own call for the provider list either way.)
  if (requested !== "auto") return { profile: requested ?? "full", model: null };
  if (edition !== "hermes") return { profile: "full", model: null };

  const model = await apiTry<ActiveModel>("/setup-api/hermes/models", { timeoutMs: 3_000 });
  return { profile: profileForActiveModel(model), model };
}
