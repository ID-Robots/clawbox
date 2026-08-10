export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { runHermesCli } from "@/lib/hermes-cli";

// Inference providers Hermes understands (mirrors the `model.provider` comment
// block in ~/.hermes/config.yaml). "auto" lets Hermes pick from whatever
// credentials are present. Anything outside this set is rejected so a POST
// can't smuggle an arbitrary value into the config.
const ALLOWED_PROVIDERS = new Set([
  "auto", "openrouter", "nous", "nous-api", "anthropic",
  "openai-codex", "copilot", "gemini", "zai", "kimi-coding",
]);

// Hermes keeps a curated model catalog + the user's default in its own config
// (Hermes manages providers itself — it does NOT use openclaw.json). Surface
// both so the desktop chat can offer a model picker in Hermes mode.
const HERMES_HOME = process.env.HERMES_HOME || path.join(process.env.HOME || "/home/clawbox", ".hermes");
const CATALOG_PATH = path.join(HERMES_HOME, "cache", "model_catalog.json");
const CONFIG_PATH = path.join(HERMES_HOME, "config.yaml");

// Cold-start fallback if the on-disk catalog isn't readable yet.
const FALLBACK_MODELS = [
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.5",
  "openai/gpt-4o-mini",
];

interface CatalogModel { id?: string; description?: string; default?: boolean }
interface Catalog { providers?: Record<string, { models?: CatalogModel[] }> }

const MODEL_ID_RE = /^[A-Za-z0-9_./:-]+$/;

async function readCatalogModels(): Promise<{ models: { id: string; description: string }[]; catalogDefault?: string }> {
  try {
    const raw = await fs.readFile(CATALOG_PATH, "utf8");
    const cat = JSON.parse(raw) as Catalog;
    const seen = new Set<string>();
    const models: { id: string; description: string }[] = [];
    let catalogDefault: string | undefined;
    for (const provider of Object.values(cat.providers ?? {})) {
      for (const m of provider.models ?? []) {
        const id = typeof m.id === "string" ? m.id.trim() : "";
        if (!id || !MODEL_ID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        models.push({ id, description: typeof m.description === "string" ? m.description : "" });
        if (m.default) catalogDefault = id;
      }
    }
    return { models, catalogDefault };
  } catch {
    return { models: FALLBACK_MODELS.map((id) => ({ id, description: "" })) };
  }
}

// Pull `model.default` out of config.yaml without a YAML dependency — it's the
// user's active default and should be pre-selected in the picker.
async function readConfiguredDefault(): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    // Match `default:` (or `model:`) under the `model:` block, ignoring comments.
    const m = raw.match(/^\s*(?:default|model)\s*:\s*["']?([A-Za-z0-9_./:-]+)["']?\s*$/m);
    return m && MODEL_ID_RE.test(m[1]) ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

export async function GET() {
  const [{ models, catalogDefault }, configured] = await Promise.all([
    readCatalogModels(),
    readConfiguredDefault(),
  ]);
  // Prefer the user's configured default; fall back to the catalog default,
  // then the first model. Make sure `current` is present in the list.
  let current = configured || catalogDefault || models[0]?.id || "";
  if (current && !models.some((m) => m.id === current)) {
    models.unshift({ id: current, description: "current" });
  }
  return NextResponse.json({ models, current });
}

// Set the Hermes default model and/or inference provider. Persists via
// `hermes config set` (the same store the GET above reads back), so the change
// survives restarts and applies to `hermes -z` chats. Both fields optional;
// at least one required.
export async function POST(request: Request) {
  let body: { model?: string; provider?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";

  if (!model && !provider) {
    return NextResponse.json({ error: "model or provider is required" }, { status: 400 });
  }
  // Reject flag-smuggling (a value starting with "-") and any charset the
  // config store shouldn't see. `runHermesCli` never uses a shell, but a
  // leading "-" could still be parsed by hermes as an option.
  if (model && (!MODEL_ID_RE.test(model) || model.startsWith("-"))) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  if (provider && !ALLOWED_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  try {
    if (model) {
      const r = await runHermesCli(["config", "set", "model.default", model]);
      if (r.code !== 0) {
        return NextResponse.json({ error: r.stderr || "Failed to set model" }, { status: 502 });
      }
    }
    if (provider) {
      const r = await runHermesCli(["config", "set", "model.provider", provider]);
      if (r.code !== 0) {
        return NextResponse.json({ error: r.stderr || "Failed to set provider" }, { status: 502 });
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "hermes config failed" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, model: model || undefined, provider: provider || undefined });
}
