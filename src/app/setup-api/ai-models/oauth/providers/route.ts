import { NextResponse } from "next/server";
import { OAUTH_PROVIDERS, DEVICE_AUTH_PROVIDERS } from "@/lib/oauth-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const providers = new Set([
    ...Object.keys(OAUTH_PROVIDERS),
    ...Object.keys(DEVICE_AUTH_PROVIDERS),
  ]);
  return NextResponse.json({ providers: [...providers] });
}
