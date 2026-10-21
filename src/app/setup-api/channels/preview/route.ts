import { NextResponse } from "next/server";
import { enabledPreviewChannels } from "@/lib/channel-preview";

export const dynamic = "force-dynamic";

/** The preview channels this box has switched on (CLAWBOX_PREVIEW_CHANNELS). */
export async function GET() {
  return NextResponse.json({ channels: enabledPreviewChannels() });
}
