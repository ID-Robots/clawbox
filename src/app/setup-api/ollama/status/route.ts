export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const OLLAMA_BASE = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

export async function GET() {
  try {
    // Check if Ollama is running
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return NextResponse.json({ running: false, models: [] });
    }
    const data = await res.json();
    const models = (data.models ?? []).map((m: { name: string; size: number; modified_at: string }) => ({
      name: m.name,
      size: m.size,
      modified_at: m.modified_at,
    }));
    return NextResponse.json({ running: true, models });
  } catch {
    return NextResponse.json({ running: false, models: [] });
  }
}
