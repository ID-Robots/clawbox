export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDefaultLlamaCppModel, getLlamaCppBaseUrl } from "@/lib/llamacpp";
import { getLocalAiRuntimeSnapshot } from "@/lib/local-ai-runtime";
import { getLlamaCppProvisioningStatus } from "@/lib/llamacpp-server";
import { externalEngineSummary, readExternalEngine } from "@/lib/external-engine";

interface LlamaCppModelResponse {
  id?: string;
  owned_by?: string;
}

export async function GET() {
  const baseUrl = getLlamaCppBaseUrl();
  const defaultModel = getDefaultLlamaCppModel();
  const provisioning = await getLlamaCppProvisioningStatus(defaultModel);
  const runtime = getLocalAiRuntimeSnapshot("llamacpp");
  // While an external engine holds the Local AI slot (TASK-2376) llama.cpp is
  // not started for chat; this says which engine answers instead.
  const externalEngine = externalEngineSummary(await readExternalEngine());

  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return NextResponse.json({
        running: false,
        baseUrl,
        models: [],
        installed: provisioning.installed,
        binaryInstalled: provisioning.binaryAvailable,
        modelAvailable: provisioning.modelAvailable,
        defaultModel,
        standbyEnabled: runtime.idleTimeoutMs > 0,
        idleTimeoutMs: runtime.idleTimeoutMs,
        proxyBaseUrl: runtime.proxyBaseUrl,
        externalEngine,
      });
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

    return NextResponse.json({
      running: true,
      baseUrl,
      models,
      installed: provisioning.installed,
      binaryInstalled: provisioning.binaryAvailable,
      modelAvailable: provisioning.modelAvailable,
      defaultModel,
      standbyEnabled: runtime.idleTimeoutMs > 0,
      idleTimeoutMs: runtime.idleTimeoutMs,
      proxyBaseUrl: runtime.proxyBaseUrl,
      externalEngine,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({
      running: false,
      baseUrl,
      models: [],
      installed: provisioning.installed,
      binaryInstalled: provisioning.binaryAvailable,
      modelAvailable: provisioning.modelAvailable,
      defaultModel,
      standbyEnabled: runtime.idleTimeoutMs > 0,
      idleTimeoutMs: runtime.idleTimeoutMs,
      proxyBaseUrl: runtime.proxyBaseUrl,
      externalEngine,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}
