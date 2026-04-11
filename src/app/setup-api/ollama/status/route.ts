export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getLocalAiRuntimeSnapshot, getOllamaBaseUrl } from "@/lib/local-ai-runtime";

const OLLAMA_BASE = getOllamaBaseUrl();

export async function GET() {
  const runtime = getLocalAiRuntimeSnapshot("ollama");
  try {
    // Check if Ollama is running
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return NextResponse.json({
        running: false,
        models: [],
        standbyEnabled: runtime.idleTimeoutMs > 0,
        idleTimeoutMs: runtime.idleTimeoutMs,
        proxyBaseUrl: runtime.proxyBaseUrl,
      });
    }
    const data = await res.json();
    const models = (data.models ?? []).map((m: { name: string; size: number; modified_at: string }) => ({
      name: m.name,
      size: m.size,
      modified_at: m.modified_at,
    }));
    return NextResponse.json({ running: true, models, standbyEnabled: runtime.idleTimeoutMs > 0, idleTimeoutMs: runtime.idleTimeoutMs, proxyBaseUrl: runtime.proxyBaseUrl }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ running: false, models: [], standbyEnabled: runtime.idleTimeoutMs > 0, idleTimeoutMs: runtime.idleTimeoutMs, proxyBaseUrl: runtime.proxyBaseUrl }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}
