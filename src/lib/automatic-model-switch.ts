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
