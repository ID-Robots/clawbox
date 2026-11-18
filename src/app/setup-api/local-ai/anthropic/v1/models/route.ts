export const dynamic = "force-dynamic";

import { handleLocalModels } from "@/lib/local-anthropic-route";

/** The one model the box's engine serves local coding runs (src/lib/local-anthropic-route.ts). */
export async function GET(request: Request) {
  return await handleLocalModels(request);
}
