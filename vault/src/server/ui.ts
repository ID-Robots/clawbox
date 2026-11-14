// Desktop app assets: index.html and app.css from src/ui, app.ts bundled once
// in memory at startup, and the vault icon. Nothing is written to disk.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Asset {
  body: Uint8Array<ArrayBuffer> | string;
  type: string;
}

export class UiAssets {
  private assets = new Map<string, Asset>();

  static async build(repoDir: string): Promise<UiAssets> {
    const ui = new UiAssets();
    const dir = join(repoDir, "src/ui");
    const result = await Bun.build({
      entrypoints: [join(dir, "app.ts")],
      target: "browser",
      format: "esm",
      minify: true,
    });
    if (!result.success) {
      throw new Error(`UI build failed: ${result.logs.map((l) => l.message).join("; ")}`);
    }
    ui.assets.set("/app.js", { body: await result.outputs[0]!.text(), type: "text/javascript; charset=utf-8" });
    ui.assets.set("/app.css", { body: readFileSync(join(dir, "app.css"), "utf8"), type: "text/css; charset=utf-8" });
    const html = readFileSync(join(dir, "index.html"), "utf8");
    ui.assets.set("/", { body: html, type: "text/html; charset=utf-8" });
    ui.assets.set("/index.html", { body: html, type: "text/html; charset=utf-8" });
    ui.assets.set("/favicon.png", { body: new Uint8Array(readFileSync(join(repoDir, "extension/icons/vault.png"))), type: "image/png" });
    return ui;
  }

  get(path: string): Asset | null {
    return this.assets.get(path) ?? null;
  }
}
