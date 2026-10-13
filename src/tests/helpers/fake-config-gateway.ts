import crypto from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { GatewayRpcError } from "@/lib/openclaw-gateway-ws";

/**
 * The pinned core's `config.get` / `config.patch` over a REAL openclaw.json on
 * disk, for the suites that test how ClawBox writes config through the gateway
 * (TASK-1535).
 *
 * Ported from the core's own code (`src/config/merge-patch.ts`,
 * `src/config/patch-replace-paths.ts`, `src/gateway/server-methods/config.ts`
 * in openclaw 2026.10.2) rather than written to agree with ClawBox: the patch
 * planner is only proven if the merge it is run against is the core's. What
 * is kept: the base-hash conflict, the RFC-7396 merge with `null` deleting,
 * blocked prototype keys skipped, id-keyed arrays merged BY ID unless their
 * path is in `replacePaths`, the destructive-array refusal, and `noop` for a
 * merge that changes nothing. What is not: schema validation, SecretRef
 * resolution, model-ref normalisation and the runtime defaults the real
 * gateway checks its array guard against — suites that need a refusal stage
 * one with {@link FakeConfigGateway.refuseNext}.
 */
export class FakeConfigGateway {
  /** Every call, in order: `config.get` and `config.patch` with their params. */
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  private refusals: Error[] = [];
  /** Answer `config.patch` with success but write nothing — a gateway the read-back must catch. */
  lie = false;
  /** Validation stand-in: refuse a patch this answers an error for (its schema check, say). */
  refuseIf: ((patch: Record<string, unknown>) => Error | null) | null = null;
  /**
   * What the RUNTIME config holds beside the file — defaults the core applies
   * on load. The real gateway checks its array guard against that config, not
   * the file, so an array that is only a default still has to be named.
   */
  runtimeDefaults: Record<string, unknown> | null = null;

  constructor(readonly file: string) {}

  /** The next `config.patch` throws this instead of writing. */
  refuseNext(err: Error): void {
    this.refusals.push(err);
  }

  get patches(): { raw: Record<string, unknown>; replacePaths: string[] }[] {
    return this.calls
      .filter((call) => call.method === "config.patch")
      .map((call) => ({
        raw: JSON.parse(String(call.params.raw)) as Record<string, unknown>,
        replacePaths: (call.params.replacePaths as string[] | undefined) ?? [],
      }));
  }

  private hash(): string | null {
    if (!fs.existsSync(this.file)) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(this.file)).digest("hex");
  }

  /** `gatewayWsCall`: `config.get` answers the file's hash; nothing else is served. */
  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params });
    if (method === "config.get") return { hash: this.hash() };
    throw new GatewayRpcError(`unknown method: ${method}`, "INVALID_REQUEST");
  }

  /** `gatewayWsPatchConfig`. */
  async patch(
    patch: Record<string, unknown>,
    options: { baseHash: string; replacePaths?: string[] },
  ): Promise<{ noop: boolean; changedPaths: string[] }> {
    this.calls.push({
      method: "config.patch",
      params: {
        baseHash: options.baseHash,
        raw: JSON.stringify(patch),
        ...(options.replacePaths?.length ? { replacePaths: options.replacePaths } : {}),
      },
    });
    const refusal = this.refusals.shift() ?? this.refuseIf?.(patch) ?? null;
    if (refusal) throw refusal;
    if (options.baseHash !== this.hash()) {
      throw new GatewayRpcError("config changed since last load; re-run config.get and retry", "INVALID_REQUEST");
    }
    const source = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Record<string, unknown>;
    const replacePaths = new Set(
      (options.replacePaths ?? []).map((p) => p.trim().replace(/\[\]$/, "").replace(/\[\d+\](?=\.)/g, "[]")),
    );
    const merged = applyMergePatch(source, patch, { mergeObjectArraysById: true, replaceArrayPaths: replacePaths });
    // The guard's base is the runtime config: the file over its defaults.
    const runtime = this.runtimeDefaults ? applyMergePatch(structuredClone(this.runtimeDefaults), source) : source;
    const runtimeMerged = this.runtimeDefaults ? applyMergePatch(runtime, patch, { replaceArrayPaths: replacePaths }) : merged;
    const unconfirmed = collectDestructiveArrayPatchPaths({ base: runtime, patch, merged: runtimeMerged })
      .filter((path) => !replacePaths.has(path));
    if (unconfirmed.length > 0) {
      throw new GatewayRpcError(
        `config.patch would remove entries from array path(s): ${unconfirmed.join(", ")}. Pass replacePaths with the exact path(s) when this is intentional, or use config.apply for full-config replacement.`,
        "INVALID_REQUEST",
      );
    }
    if (isDeepStrictEqual(merged, source)) return { noop: true, changedPaths: [] };
    if (!this.lie) fs.writeFileSync(this.file, JSON.stringify(merged, null, 2));
    return { noop: false, changedPaths: [] };
  }
}

/**
 * What `openclaw config set` / `config set --batch-json` / `config unset` do to
 * the same file, for a suite whose spawn mock has to leave the config the way
 * the CLI would: a set REPLACES the value at its path (making missing parents),
 * a batch applies its `{path, value}` entries in order, an unset of a path
 * that is not there exits 1 with the CLI's sentence. `refuse` answers the
 * stderr of a CLI that refuses this argv, or null.
 */
export function runFakeOpenclawCli(
  file: string,
  argv: readonly string[],
  refuse?: (argv: readonly string[]) => string | null,
): { code: number; stderr: string } {
  const refusal = refuse?.(argv) ?? null;
  if (refusal !== null) return { code: 1, stderr: refusal };
  if (argv[0] !== "config") return { code: 0, stderr: "" };
  const config = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {}) as Json;
  if (argv[1] === "set" && argv[2] === "--batch-json") {
    for (const entry of JSON.parse(argv[3]) as { path: string; value: unknown }[]) setAt(config, splitPath(entry.path), entry.value);
  } else if (argv[1] === "set") {
    const [configPath, raw] = argv.slice(2).filter((arg) => !arg.startsWith("--"));
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // value mode: the raw string
    }
    setAt(config, splitPath(configPath), value);
  } else if (argv[1] === "unset") {
    const segments = splitPath(argv[2]);
    let node: unknown = config;
    for (const segment of segments.slice(0, -1)) node = isPlainObject(node) ? node[segment] : undefined;
    const last = segments[segments.length - 1];
    if (!isPlainObject(node) || !Object.hasOwn(node, last)) {
      return { code: 1, stderr: `Config path not found: ${argv[2]}. Nothing was changed.` };
    }
    delete node[last];
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return { code: 0, stderr: "" };
}

function splitPath(configPath: string): string[] {
  const segments: string[] = [];
  const re = /\[["']([^"']*)["']\]|([^.[\]]+)/g;
  for (let match = re.exec(configPath); match; match = re.exec(configPath)) segments.push(match[1] ?? match[2]);
  return segments;
}

function setAt(config: Json, segments: string[], value: unknown): void {
  let node = config;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(node[segment])) node[segment] = {};
    node = node[segment] as Json;
  }
  node[segments[segments.length - 1]] = value;
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

function formatPath(parent: string | undefined, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function isObjectWithStringId(value: unknown): value is Json & { id: string } {
  return isPlainObject(value) && typeof value.id === "string" && value.id.length > 0;
}

interface MergeOptions {
  path?: string;
  mergeObjectArraysById?: boolean;
  replaceArrayPaths?: Set<string>;
}

function mergeObjectArraysById(base: unknown[], patch: unknown[], options: MergeOptions, arrayPath: string): unknown[] | undefined {
  const merged = [...base];
  const indexById = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    if (!isObjectWithStringId(entry)) return undefined;
    indexById.set(entry.id, index);
  }
  for (const patchEntry of patch) {
    if (!isObjectWithStringId(patchEntry)) {
      merged.push(structuredClone(patchEntry));
      continue;
    }
    const existingIndex = indexById.get(patchEntry.id);
    if (existingIndex === undefined) {
      merged.push(structuredClone(patchEntry));
      indexById.set(patchEntry.id, merged.length - 1);
      continue;
    }
    merged[existingIndex] = applyMergePatch(merged[existingIndex], patchEntry, { ...options, path: `${arrayPath}[]` });
  }
  return merged;
}

function applyMergePatch(base: unknown, patch: unknown, options: MergeOptions = {}): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Json = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    const path = formatPath(options.path, key);
    if (BLOCKED.has(key)) continue;
    if (value === null) {
      delete result[key];
      continue;
    }
    if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
      if (options.replaceArrayPaths?.has(path)) {
        result[key] = value;
        continue;
      }
      const mergedArray = mergeObjectArraysById(result[key] as unknown[], value, options, path);
      if (mergedArray) {
        result[key] = mergedArray;
        continue;
      }
    }
    if (isPlainObject(value)) {
      result[key] = applyMergePatch(result[key], value, { ...options, path });
      continue;
    }
    result[key] = value;
  }
  return result;
}

function collectBaseArrayPaths(base: unknown, path: string): string[] {
  if (Array.isArray(base)) return [path];
  if (!isPlainObject(base)) return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    if (BLOCKED.has(key)) continue;
    paths.push(...collectBaseArrayPaths(value, formatPath(path, key)));
  }
  return paths;
}

function idKeyedArrayPreservesBaseIds(base: unknown[], merged: unknown[]): boolean {
  const mergedIds = new Set(merged.filter(isObjectWithStringId).map((entry) => entry.id));
  return base.every((entry) => isObjectWithStringId(entry) && mergedIds.has(entry.id));
}

function arrayPreservesBaseEntries(base: unknown[], merged: unknown[]): boolean {
  const unmatched = [...merged];
  for (const baseEntry of base) {
    const index = unmatched.findIndex((entry) => isDeepStrictEqual(entry, baseEntry));
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

function collectDestructiveIdKeyedArrayEntryPatchPaths(params: { base: unknown[]; patch: unknown[]; merged: unknown[]; path: string }): string[] {
  const baseById = new Map(params.base.filter(isObjectWithStringId).map((entry) => [entry.id, entry]));
  const mergedById = new Map(params.merged.filter(isObjectWithStringId).map((entry) => [entry.id, entry]));
  const paths: string[] = [];
  for (const patchEntry of params.patch) {
    if (!isObjectWithStringId(patchEntry)) continue;
    const baseEntry = baseById.get(patchEntry.id);
    const mergedEntry = mergedById.get(patchEntry.id);
    if (!baseEntry || !mergedEntry) continue;
    paths.push(...collectDestructiveArrayPatchPaths({ base: baseEntry, patch: patchEntry, merged: mergedEntry, path: `${params.path}[]` }));
  }
  return paths;
}

function collectDestructiveArrayPatchPaths(params: { base: unknown; patch: unknown; merged: unknown; path?: string }): string[] {
  if (!isPlainObject(params.patch) || !isPlainObject(params.base)) return [];
  const merged = isPlainObject(params.merged) ? params.merged : {};
  const paths: string[] = [];
  for (const [key, patchValue] of Object.entries(params.patch)) {
    const path = formatPath(params.path, key);
    if (BLOCKED.has(key)) continue;
    const baseValue = params.base[key];
    const mergedValue = merged[key];
    if (Array.isArray(baseValue)) {
      if (patchValue === null || !Array.isArray(patchValue)) {
        paths.push(path);
        continue;
      }
      if (Array.isArray(mergedValue)) {
        if (baseValue.every(isObjectWithStringId)) {
          if (!idKeyedArrayPreservesBaseIds(baseValue, mergedValue)) {
            paths.push(path);
            continue;
          }
          paths.push(...collectDestructiveIdKeyedArrayEntryPatchPaths({ base: baseValue, patch: patchValue, merged: mergedValue, path }));
        } else if (!arrayPreservesBaseEntries(baseValue, mergedValue)) {
          paths.push(path);
          continue;
        }
      }
    } else if (isPlainObject(baseValue) && !isPlainObject(patchValue)) {
      paths.push(...collectBaseArrayPaths(baseValue, path));
      continue;
    }
    if (isPlainObject(patchValue)) {
      paths.push(...collectDestructiveArrayPatchPaths({ base: baseValue, patch: patchValue, merged: mergedValue, path }));
    }
  }
  return paths;
}
