export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  buildLocalModelInventory,
  setEngineEnabled,
  unitForEngine,
  type InventoryProbes,
} from "@/lib/local-models";
import { getDefaultLlamaCppModel, getLlamaCppBaseUrl } from "@/lib/llamacpp";
import { getLlamaCppProvisioningStatus } from "@/lib/llamacpp-server";
import { getOllamaBaseUrl } from "@/lib/local-ai-runtime";
import { getMemoryStatus } from "@/lib/clawkeep-memory";

/** Is llama.cpp answering right now? Same probe the llamacpp status route uses. */
async function llamaCppRunning(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    const first = Array.isArray(data?.data) ? data.data[0] : null;
    return typeof first?.id === "string" ? first.id : "";
  } catch {
    return null;
  }
}

async function probes(): Promise<InventoryProbes> {
  const llamaBase = getLlamaCppBaseUrl();
  const alias = getDefaultLlamaCppModel();
  // Each probe is independently guarded: an engine that cannot be reached must
  // cost only its own row, never the whole inventory.
  const [provisioning, servedModel, memory] = await Promise.all([
    getLlamaCppProvisioningStatus(alias).catch(() => null),
    llamaCppRunning(llamaBase),
    getMemoryStatus().catch(() => null),
  ]);
  return {
    ollamaBaseUrl: getOllamaBaseUrl(),
    llamacpp: {
      installed: !!provisioning?.installed,
      running: servedModel !== null,
      model: servedModel || alias || null,
    },
    embeddings: {
      available: !!memory?.available,
      provider: memory?.provider || null,
      model: memory?.model || null,
      local: memory?.location === "local",
    },
  };
}

export async function GET() {
  const snapshot = await buildLocalModelInventory(await probes());
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const id = (body as { id?: unknown })?.id;
  const enabled = (body as { enabled?: unknown })?.enabled;
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return NextResponse.json({ error: "Expected an engine id and an enabled flag." }, { status: 400 });
  }

  const target = unitForEngine(id);
  if (!target) {
    return NextResponse.json({ error: "That model cannot be turned on or off here." }, { status: 400 });
  }

  // Refuse to act on an engine that is not installed rather than creating an
  // enabled-but-absent unit: the acceptance line is that a missing model reads
  // as missing, not as an option.
  const before = await buildLocalModelInventory(await probes());
  const entry = before.models.find(m => m.id === id);
  if (!entry || !entry.installed) {
    return NextResponse.json({ error: "That model is not installed on this box." }, { status: 409 });
  }

  const result = await setEngineEnabled(target.unit, target.scope, enabled);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Could not change the service." }, { status: 500 });
  }

  const after = await buildLocalModelInventory(await probes());
  return NextResponse.json(
    { ok: true, models: after.models, unavailable: after.unavailable },
    { headers: { "Cache-Control": "no-store" } },
  );
}
