export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getLlamaCppBaseUrl } from "@/lib/llamacpp";

interface LlamaCppModelResponse {
  id?: string;
  owned_by?: string;
}

export async function GET() {
  const baseUrl = getLlamaCppBaseUrl();

  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return NextResponse.json({ running: false, baseUrl, models: [] });
    }

    const data = await res.json();
    const models = Array.isArray(data?.data)
      ? data.data
        .filter((model: LlamaCppModelResponse) => typeof model?.id === "string" && model.id.length > 0)
        .map((model: LlamaCppModelResponse) => ({
          id: model.id as string,
          owned_by: model.owned_by ?? "llama.cpp",
        }))
      : [];

    return NextResponse.json({ running: true, baseUrl, models }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ running: false, baseUrl, models: [] }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}
