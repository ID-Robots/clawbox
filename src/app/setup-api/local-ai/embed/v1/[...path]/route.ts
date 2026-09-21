export const dynamic = "force-dynamic";

import { proxyLocalAiRequest } from "@/lib/local-ai-proxy";

// The memory-search embedder's proxy: what OpenClaw's `memory.search.remote`
// points at. Every request wakes clawbox-embed.service if it is asleep and
// re-arms its idle stop; `v1/embeddings` bodies also get the qwen3 query
// instruction restored (src/lib/embed-query-instruction.ts). Bearer-only, no
// session — see src/lib/local-ai-proxy.ts.

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

async function handle(request: Request, context: RouteContext) {
  const { path } = await context.params;
  return await proxyLocalAiRequest(request, "embed", path);
}

export async function GET(request: Request, context: RouteContext) {
  return await handle(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return await handle(request, context);
}

export async function PUT(request: Request, context: RouteContext) {
  return await handle(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
  return await handle(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return await handle(request, context);
}

export async function HEAD(request: Request, context: RouteContext) {
  return await handle(request, context);
}
