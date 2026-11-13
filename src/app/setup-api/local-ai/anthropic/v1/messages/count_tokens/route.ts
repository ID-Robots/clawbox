export const dynamic = "force-dynamic";

import { handleLocalCountTokens } from "@/lib/local-anthropic-route";

/** An estimate of a request's input tokens, for local coding runs (src/lib/local-anthropic-route.ts). */
export async function POST(request: Request) {
  return await handleLocalCountTokens(request);
}
