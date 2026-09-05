export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  buildLocalModelInventory,
  ENGINE_IDS,
  setEngineEnabled,
  unitForEngine,
  type InventoryProbes,
} from "@/lib/local-models";
import { getDefaultLlamaCppModel, getLlamaCppBaseUrl } from "@/lib/llamacpp";
import { getLlamaCppProvisioningStatus, resolveConfiguredLlamaCppAlias } from "@/lib/llamacpp-server";
import { getEmbedProvisioningStatus } from "@/lib/embed-server";
import { peekMemoryStatus } from "@/lib/clawkeep-memory";
import { openclawIsAbsent } from "@/lib/openclaw-config";

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
  // The memory index belongs to OpenClaw and is read by spawning its CLI. On
  // the Hermes SKU that binary does not exist, so the call could only fail —
  // and the failure was swallowed into a probe indistinguishable from "the
  // embedding provider is down", which is the wrong thing to tell a customer
  // whose box was never sold with one. Don't ask; report the edition instead.
  const embeddingsSupported = !openclawIsAbsent();
  // Each probe is independently guarded: an engine that cannot be reached must
  // cost only its own row, never the whole inventory.
  // The memory reading is PEEKED, never awaited: it costs an OpenClaw process
  // boot, and this route is polled every five seconds by a panel that must
  // open at once. A cold peek starts that probe and answers null.
  const memory = embeddingsSupported ? peekMemoryStatus() : null;
  const [provisioning, servedModel, configuredAlias, embedProvisioning] = await Promise.all([
    getLlamaCppProvisioningStatus(alias).catch(() => null),
    llamaCppRunning(llamaBase),
    // The same resolution the wake path uses, so "starts when needed" is
    // claimed exactly when the proxy would in fact start it.
    resolveConfiguredLlamaCppAlias().catch(() => null),
    // Two stats: the binary and the GGUF. The unit itself is read by the row.
    embeddingsSupported ? getEmbedProvisioningStatus().catch(() => null) : Promise.resolve(null),
  ]);
  return {
    llamacpp: {
      installed: !!provisioning?.installed,
      running: servedModel !== null,
      model: servedModel || alias || null,
      configured: configuredAlias !== null,
    },
    embeddings: {
      supported: embeddingsSupported,
      ready: memory !== null,
      available: !!memory?.available,
      provider: memory?.provider || null,
      model: memory?.model || null,
      local: memory?.location === "local",
      engine: {
        installed: !!embedProvisioning?.installed,
        modelBytes: embedProvisioning?.modelBytes ?? null,
      },
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

  // Two refusals, because they mean different things: an id the inventory has
  // never heard of, and a real engine that simply has no switch here.
  if (!ENGINE_IDS.has(id)) {
    return NextResponse.json({ error: "Unknown model." }, { status: 404 });
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
