/**
 * Discover (or provision) the Google Cloud Code Assist project ID.
 * Replicates the flow from OpenClaw's google-gemini-cli-auth plugin:
 *   1. loadCodeAssist → if currentTier exists, extract projectId
 *   2. Otherwise onboardUser (free-tier) → poll LRO → extract projectId
 */

const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED" as const,
  platform: "PLATFORM_UNSPECIFIED" as const,
  pluginType: "GEMINI" as const,
};
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";

export async function discoverGoogleProject(accessToken: string): Promise<string | undefined> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "gl-node/openclaw",
  };

  // Step 1: loadCodeAssist
  const loadBody = { metadata: CODE_ASSIST_METADATA };

  const loadRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify(loadBody),
    signal: AbortSignal.timeout(30_000),
  });

  if (!loadRes.ok) {
    const errText = await loadRes.text().catch(() => "");
    console.error("[google-project] loadCodeAssist failed:", loadRes.status, errText);
    throw new Error(`loadCodeAssist failed: ${loadRes.status}`);
  }

  const data = await loadRes.json() as {
    currentTier?: { id?: string };
    cloudaicompanionProject?: string | { id?: string };
    allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
  };

  // If already onboarded, extract projectId from response
  if (data.currentTier) {
    const project = data.cloudaicompanionProject;
    if (typeof project === "string" && project) return project;
    if (typeof project === "object" && project?.id) return project.id;
    console.warn("[google-project] currentTier exists but no projectId in response");
    return undefined;
  }

  // Step 2: Not onboarded yet — call onboardUser
  console.log("[google-project] No currentTier, onboarding user to free-tier...");
  const defaultTier = data.allowedTiers?.find((t) => t.isDefault);
  const tierId = defaultTier?.id || TIER_FREE;

  // Only free-tier can be provisioned without an existing project
  if (tierId !== TIER_FREE && tierId !== TIER_LEGACY) {
    console.warn("[google-project] Non-free tier requires existing project, skipping onboard");
    return undefined;
  }

  const onboardBody = { tierId, metadata: CODE_ASSIST_METADATA };

  const onboardRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify(onboardBody),
    signal: AbortSignal.timeout(30_000),
  });

  if (!onboardRes.ok) {
    const errText = await onboardRes.text().catch(() => "");
    console.error("[google-project] onboardUser failed:", onboardRes.status, errText);
    throw new Error(`onboardUser failed: ${onboardRes.status}`);
  }

  let lro = await onboardRes.json() as {
    done?: boolean;
    name?: string;
    response?: { cloudaicompanionProject?: { id?: string } };
  };

  // Step 3: Poll LRO if not immediately done (max 2 minutes total)
  if (!lro.done && lro.name) {
    console.log("[google-project] Polling onboard LRO:", lro.name);
    const deadline = Date.now() + 120_000;
    for (let attempt = 0; attempt < 24 && Date.now() < deadline; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${lro.name}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!pollRes.ok) continue;
      const pollData = await pollRes.json() as typeof lro;
      if (pollData.done) {
        lro = pollData;
        break;
      }
    }
  }

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (projectId) {
    console.log("[google-project] Onboarded successfully, projectId:", projectId);
    return projectId;
  }

  console.warn("[google-project] Onboard completed but no projectId in response");
  return undefined;
}
