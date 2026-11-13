export const dynamic = "force-dynamic";

import { handleLocalMessages } from "@/lib/local-anthropic-route";

/** Anthropic's Messages API on the box's own engine, for local coding runs (src/lib/local-anthropic-route.ts). */
export async function POST(request: Request) {
  return await handleLocalMessages(request);
}
