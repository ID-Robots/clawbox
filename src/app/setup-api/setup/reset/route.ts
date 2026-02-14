import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const CONFIG_ROOT = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const CONFIG_PATH = path.join(CONFIG_ROOT, "data", "config.json");

export async function POST() {
  try {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    const tmpPath = CONFIG_PATH + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify({}, null, 2));
    await fs.rename(tmpPath, CONFIG_PATH);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to reset",
      },
      { status: 500 }
    );
  }
}
