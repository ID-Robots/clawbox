// The two facts a model change the BOX makes needs, and the one way it makes it.
//
// Shared by the follow-newest pass (src/lib/provider-follow-newest.ts) and the
// fallback off a model the account cannot run (src/lib/provider-model-fallback.ts):
// both move the chat for the owner, and both must move it exactly the way the
// header picker does — plugin gate, primary, session sweep, catalogue notice —
// rather than through a second, thinner write that skips half of that.

import { readConfig } from "@/lib/openclaw-config";

/** `agents.defaults.model.primary` as written, or null when there is none to read. */
export async function readPrimaryModelRef(): Promise<string | null> {
  const config = await readConfig();
  const model = config.agents?.defaults?.model as unknown;
  if (typeof model === "string") return model;
  const primary = (model as { primary?: unknown } | undefined)?.primary;
  return typeof primary === "string" ? primary : null;
}

/**
 * Switch the chat to `ref` through `/setup-api/chat/model`, flagged `automatic`
 * because the box chose it, not the owner — so no explicit pick is recorded
 * (TASK-713; `/setup-api/providers/default` posts the same way). Imported when
 * it is needed: that route's module graph is large and this is asked rarely.
 * True when the switch landed.
 */
export async function switchChatModelAutomatically(ref: string): Promise<boolean> {
  const { POST } = await import("@/app/setup-api/chat/model/route");
  const res = await POST(new Request("http://localhost/setup-api/chat/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: ref, automatic: true }),
  }));
  if (res.ok) return true;
  // A 502 carrying a warning is a switch that landed while the gateway settles
  // (`/setup-api/providers/default` reads the same answer the same way).
  const data = await res.json().catch(() => ({})) as { warning?: unknown };
  return res.status === 502 && typeof data.warning === "string" && data.warning !== "";
}

/** One row of `/setup-api/chat/model`'s picker, as much of it as a switch needs. */
interface PickerRow {
  label?: unknown;
  model?: unknown;
  provider?: unknown;
  available?: unknown;
  isLocal?: unknown;
}

/**
 * Another provider the chat's own picker can switch to right now — any row but
 * `provider`'s that is set up and has a model — for the one-click switch when
 * `provider` has no model left on this account (src/lib/provider-model-fallback.ts).
 * A cloud provider first, then the box's local model. Read through the same
 * route the header picker reads, so the row it names is one the picker offers;
 * null when there is none, or the route cannot answer.
 */
export async function readAlternativeChatProvider(provider: string): Promise<{ model: string; label: string; provider: string | null } | null> {
  const failed = provider.trim().toLowerCase();
  try {
    const { GET } = await import("@/app/setup-api/chat/model/route");
    const res = await GET();
    if (!res.ok) return null;
    const data = await res.json() as { options?: unknown };
    const rows = Array.isArray(data.options) ? data.options as PickerRow[] : [];
    const usable = rows.filter((row) => {
      if (row?.available !== true || typeof row.model !== "string" || !row.model) return false;
      const rowProvider = typeof row.provider === "string" ? row.provider.toLowerCase() : "";
      const refProvider = row.model.includes("/") ? row.model.slice(0, row.model.indexOf("/")).toLowerCase() : "";
      return rowProvider !== failed && refProvider !== failed;
    });
    const pick = usable.find((row) => row.isLocal !== true) ?? usable[0];
    if (!pick || typeof pick.model !== "string") return null;
    return {
      model: pick.model,
      label: typeof pick.label === "string" && pick.label ? pick.label : pick.model,
      provider: typeof pick.provider === "string" && pick.provider ? pick.provider : null,
    };
  } catch {
    return null;
  }
}
