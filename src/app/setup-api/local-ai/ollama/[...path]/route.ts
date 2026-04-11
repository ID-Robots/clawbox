export const dynamic = "force-dynamic";

import { proxyLocalAiRequest } from "@/lib/local-ai-proxy";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

async function handle(request: Request, context: RouteContext) {
  const { path } = await context.params;
  return await proxyLocalAiRequest(request, "ollama", path);
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
