export const dynamic = "force-dynamic";

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { POST as disableLocalAi } from "@/app/setup-api/local-ai/route";
import { openclawIsAbsent, readConfig } from "@/lib/openclaw-config";
import { checkInstallDisk, diskRefusal } from "@/lib/install-disk";
import { getLlamaCppLaunchSpec, resolveConfiguredLlamaCppAlias } from "@/lib/llamacpp-server";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { safeGgufName, safeHfRepo } from "@/lib/local-install";
import { hasOwnerSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { dirBytes } from "@/lib/install-disk";

/**
 * /setup-api/llamacpp/models — the GGUF library on this box.
 *
 * The blessed Gemma 4 build arrives with the device and is installed by the
 * row above this one. This is the other half of the owner's 2026-09-14
 * decision: any other GGUF is a click away too, named by its Hugging Face repo
 * and file, with what it costs shown BEFORE the download starts.
 *
 * WHAT THIS DOES NOT DO. It does not repoint the runtime. `llama-server` is
 * started from one model path resolved out of the environment at process
 * start (`getLlamaCppLaunchSpec`), and moving that is a change to the chat
 * path rather than to an install button — so a file fetched here sits in the
 * library until the box is configured to serve it. The panel says so rather
 * than implying otherwise.
 *
 * OWNER ONLY for the writes, and same-origin with them: an unbounded download
 * onto the owner's disk, named by whoever asked, is not something the MCP
 * bearer may start.
 */

const encoder = new TextEncoder();
/** A multi-GB GGUF on a slow link; systemd is not involved, so this stream owns the kill. */
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PROGRESS_POLL_MS = 1500;
/** How long the Hub gets to answer "how big is that file". */
const PROBE_TIMEOUT_MS = 10_000;

function emit(controller: ReadableStreamDefaultController<Uint8Array>, payload: Record<string, unknown>) {
  try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); } catch { /* client gone */ }
}

/** One download at a time: two would write the same directory and race the disk check. */
let inFlight = false;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the Hub says that file weighs.
 *
 * `lfs.size` first: a GGUF is an LFS object, and the tree's plain `size` for
 * one is the pointer file's few hundred bytes — which as a disk check would
 * wave a 5 GB download straight through.
 */
async function probeSize(repo: string, file: string): Promise<{ bytes: number | null; error?: string }> {
  try {
    // The repo id goes into the PATH unencoded, and that is deliberate: the
    // Hub's route is `/api/models/{owner}/{name}/tree/...`, so a `%2F` in place
    // of the slash is a different path and answers 404. It is safe to
    // interpolate because `isHfRepo` has already rebuilt it from an alphabet
    // with no `%`, no `?`, no `#` and no `..` segment — the same reasoning
    // `require_safe_hf_ref` applies before install.sh hands one to `hf`.
    const res = await fetch(
      `https://huggingface.co/api/models/${repo}/tree/main?recursive=1`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (res.status === 404) return { bytes: null, error: "not_found" };
    if (!res.ok) return { bytes: null, error: "unreachable" };
    const tree = await res.json();
    if (!Array.isArray(tree)) return { bytes: null, error: "unreachable" };
    const entry = tree.find((e: unknown) => (e as { path?: unknown })?.path === file) as
      { size?: unknown; lfs?: { size?: unknown } } | undefined;
    if (!entry) return { bytes: null, error: "no_such_file" };
    const lfs = entry.lfs?.size;
    const plain = entry.size;
    const bytes = typeof lfs === "number" ? lfs : typeof plain === "number" ? plain : null;
    return { bytes };
  } catch {
    return { bytes: null, error: "unreachable" };
  }
}

/** Every `.gguf` in the model directory, with the one the runtime serves marked. */
async function listLibrary(modelDir: string, defaultFile: string) {
  let names: string[];
  try {
    names = await fs.readdir(modelDir);
  } catch {
    return [];
  }
  const files = names.filter((n) => /\.gguf$/i.test(n));
  return Promise.all(files.map(async (name) => {
    let bytes: number | null = null;
    try {
      bytes = (await fs.stat(path.join(modelDir, name))).size;
    } catch {
      /* vanished between readdir and stat */
    }
    return { name, bytes, inUse: name === path.basename(defaultFile) };
  }));
}

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const spec = getLlamaCppLaunchSpec();
  const params = new URL(request.url).searchParams;
  const askedRepo = params.get("repo");
  const askedFile = params.get("file");

  // The "how big is it" probe the panel makes before it offers Download.
  //
  // OWNER ONLY, unlike the listing beside it: this one reaches OUT, to a
  // repository path the caller named. The listing reports what is already on
  // the box and is fine for anything middleware admits; a request this box
  // makes to the internet on someone else's word is the person's, and the MCP
  // bearer is the party the install gates exist for.
  if (askedRepo !== null || askedFile !== null) {
    if (!(await hasOwnerSession(request))) {
      return NextResponse.json({ error: "Checking a model's size needs a signed-in browser session.", code: "owner_only" }, { status: 403 });
    }
    // Rebuilt, not tested: from here on the caller's own strings are out of
    // play and only these two are used — in a path, and in a URL this box
    // fetches.
    const repo = safeHfRepo(askedRepo);
    const file = safeGgufName(askedFile);
    if (repo === null || file === null) {
      return NextResponse.json({ error: "That is not a Hugging Face repository and GGUF file.", code: "invalid" }, { status: 400 });
    }
    const probed = await probeSize(repo, file);
    const disk = await checkInstallDisk(spec.modelDir, probed.bytes ?? 0);
    return NextResponse.json(
      {
        repo,
        file,
        bytes: probed.bytes,
        // A Hub that would not answer is not a refusal; it is a size the panel
        // cannot show, and the download still checks the disk as it goes.
        probe: probed.error ?? "ok",
        alreadyHere: await exists(path.join(spec.modelDir, file)),
        freeBytes: disk.freeBytes,
        reserveBytes: disk.reserveBytes,
        fits: probed.bytes === null ? null : disk.ok,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const [files, disk, cliPresent] = await Promise.all([
    listLibrary(spec.modelDir, spec.hfFile),
    checkInstallDisk(spec.modelDir, 0),
    exists(spec.hfBinPath),
  ]);
  return NextResponse.json(
    {
      files,
      defaultRepo: spec.hfRepo,
      defaultFile: spec.hfFile,
      // Without the Hugging Face CLI there is nothing to download with, and the
      // panel must say that rather than offer a button that cannot work.
      downloaderReady: cliPresent,
      freeBytes: disk.freeBytes,
      reserveBytes: disk.reserveBytes,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function guard(req: Request, verb: string): Promise<NextResponse | null> {
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ error: `${verb} needs a signed-in browser session.`, code: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: `${verb} only works from this ClawBox's own pages.`, code: "cross_origin" }, { status: 403 });
  }
  return null;
}

export async function POST(req: Request) {
  const refused = await guard(req, "Downloading a model");
  if (refused) return refused;

  let body: { repo?: unknown; file?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "invalid" }, { status: 400 });
  }
  // Rebuilt from the alphabet, so what reaches `path.join`, `fetch` and
  // `execFile` below is made of those characters and nothing the caller sent.
  const repo = safeHfRepo(body.repo);
  const file = safeGgufName(body.file);
  if (repo === null || file === null) {
    return NextResponse.json(
      { error: "Name the model as a Hugging Face repository and a .gguf file inside it.", code: "invalid" },
      { status: 400 },
    );
  }

  const spec = getLlamaCppLaunchSpec();
  if (!(await exists(spec.hfBinPath))) {
    return NextResponse.json(
      { error: "The Hugging Face downloader is not on this box yet. Install the local model first.", code: "no_downloader" },
      { status: 409 },
    );
  }
  // One path segment, so what lands is a file `listLibrary` shows and `DELETE`
  // can take away — see `safeGgufName`.
  const target = path.join(spec.modelDir, file);
  if (await exists(target)) {
    return NextResponse.json({ error: "That file is already in this box's model library.", code: "already_here" }, { status: 409 });
  }

  // Before a byte is fetched. A Hub that would not say how big the file is
  // cannot be checked against — that is reported as `probe`, never as a pass
  // dressed up as a measurement.
  const probed = await probeSize(repo, file);
  if (probed.error === "not_found") {
    return NextResponse.json({ error: "Hugging Face has no such repository.", code: "not_found" }, { status: 404 });
  }
  if (probed.error === "no_such_file") {
    return NextResponse.json({ error: "That repository has no such file.", code: "no_such_file" }, { status: 404 });
  }
  if (probed.bytes !== null) {
    const disk = await checkInstallDisk(spec.modelDir, probed.bytes);
    if (!disk.ok) return diskRefusal(disk);
  }

  if (inFlight) {
    return NextResponse.json({ error: "A model is already being downloaded.", code: "busy" }, { status: 409 });
  }
  inFlight = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let timer: ReturnType<typeof setInterval> | null = null;
      try {
        await fs.mkdir(spec.modelDir, { recursive: true });
        const baseline = (await dirBytes(spec.modelDir)) ?? 0;
        const total = probed.bytes ?? undefined;
        emit(controller, { status: `Downloading ${file}…`, completed: 0, ...(total ? { total } : {}) });
        timer = setInterval(() => {
          void dirBytes(spec.modelDir).then((bytes) => {
            if (bytes === null) return;
            // The delta, not the directory: the library already holds the
            // box's own Gemma build, and counting it would open the bar at 100%.
            emit(controller, { completed: Math.max(0, bytes - baseline), ...(total ? { total } : {}) });
          });
        }, PROGRESS_POLL_MS);

        const downloaded = await runDownload(spec.hfBinPath, repo, file, spec.modelDir,
          (line) => emit(controller, { status: line }));
        if (timer) { clearInterval(timer); timer = null; }
        if (!downloaded.ok) {
          // Nothing half-written is left claiming to be a model: whatever the
          // downloader put at the target path goes with the failure, so a retry
          // starts from a clean directory rather than from a truncated GGUF
          // that llama-server would load and crash on.
          await fs.rm(target, { force: true }).catch(() => {});
          emit(controller, { error: downloaded.error });
          return;
        }
        if (!(await exists(target))) {
          emit(controller, { error: "The download finished but the file is not in the library." });
          return;
        }
        let bytes: number | null = null;
        try { bytes = (await fs.stat(target)).size; } catch { /* reported as null */ }
        emit(controller, { success: true, file, bytes, status: `${file} is on this box.` });
      } catch (err) {
        emit(controller, { error: err instanceof Error ? err.message : "The model download failed." });
      } finally {
        if (timer) clearInterval(timer);
        inFlight = false;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}

export async function DELETE(req: Request) {
  const refused = await guard(req, "Removing a model");
  if (refused) return refused;

  const params = new URL(req.url).searchParams;
  if (params.get("engine") === "1") return uninstallEngine();

  // The plain file name only. Rebuilt from the alphabet rather than tested and
  // passed through, so no caller's string ever reaches `path.join` — the rule
  // `safeAppId` and `safeSkillName` keep for the same reason.
  const name = safeGgufName(new URL(req.url).searchParams.get("file"));
  if (name === null) {
    return NextResponse.json({ error: "That is not a model file in this box's library.", code: "invalid" }, { status: 400 });
  }
  const spec = getLlamaCppLaunchSpec();
  if (name === path.basename(spec.hfFile)) {
    return NextResponse.json(
      { error: "That is the model this box answers with. It cannot be removed here.", code: "in_use" },
      { status: 409 },
    );
  }
  const target = path.join(spec.modelDir, name);
  let freedBytes: number | null = null;
  try {
    freedBytes = (await fs.stat(target)).size;
  } catch {
    return NextResponse.json({ error: "That model is not in this box's library.", code: "not_found" }, { status: 404 });
  }
  try {
    await fs.unlink(target);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not remove that model.", code: "remove_failed" },
      { status: 500 },
    );
  }
  const files = await listLibrary(spec.modelDir, spec.hfFile);
  const disk = await checkInstallDisk(spec.modelDir, 0);
  return NextResponse.json({ ok: true, freedBytes, files, freeBytes: disk.freeBytes, reserveBytes: disk.reserveBytes });
}

/**
 * `DELETE ?engine=1` — the model the box answers with, which the plain form
 * refuses as `in_use`. Settings → Local AI's Uninstall on the Gemma row.
 *
 * The blessed GGUF is what makes the local model "installed" (the binary is
 * install.sh's and stays), so this is the whole uninstall. Local AI wired to
 * it is turned OFF first, through the route the panel's own Disable posts —
 * the stop, the flag clear, OpenClaw's fallback list, Hermes' provider block,
 * the gateway restart — because a fallback list that still names a model
 * whose file is gone sends the next turn that falls back to an endpoint with
 * nothing behind it. A refusal there leaves the file in place: half an
 * uninstall is the state nothing can retry from. An unwired model only needs
 * its runtime stopped, since llama-server holds the file open.
 *
 * Refused 409 `in_use` while Gemma is the PRIMARY model (local-only mode
 * included): uninstalling the model a box answers with is a change of default
 * first, and the panel offers that gesture.
 *
 * The next system update puts Gemma back — it is the one model install.sh
 * caches on every box — and the panel's dialog says so.
 */
async function uninstallEngine(): Promise<NextResponse> {
  if (inFlight) {
    return NextResponse.json({ error: "A model is being downloaded right now.", code: "busy" }, { status: 409 });
  }
  const spec = getLlamaCppLaunchSpec();
  const target = path.join(spec.modelDir, spec.hfFile);
  let freedBytes: number | null = null;
  try {
    freedBytes = (await fs.stat(target)).size;
  } catch {
    return NextResponse.json({ error: "The local model is not on this box.", code: "not_found" }, { status: 404 });
  }
  // Refused while Gemma is the model the box ANSWERS with — its primary, which
  // is also what local-only mode sets. The Disable below only clears the
  // fallback list, so the next turn would still route to llamacpp/… and the
  // runtime would download again the file this is about to delete. The owner
  // moves the default first ("Use as fallback", or local-only off).
  if (!openclawIsAbsent()) {
    const config = await readConfig().catch(() => null);
    const primary = config?.agents?.defaults?.model?.primary?.trim() ?? "";
    if (primary.startsWith("llamacpp/")) {
      return NextResponse.json(
        { error: "Gemma is the model this box answers with. Choose \u201cUse as fallback\u201d (or turn local-only mode off) first, then uninstall it.", code: "in_use" },
        { status: 409 },
      );
    }
  }
  const wired = await resolveConfiguredLlamaCppAlias().catch(() => null);
  if (wired !== null) {
    const res = await disableLocalAi(new Request("http://127.0.0.1/setup-api/local-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable" }),
    })).catch(() => null);
    if (!res || !res.ok) {
      const data = res ? await res.json().catch(() => ({})) : {};
      return NextResponse.json(
        { error: typeof data?.error === "string" ? data.error : "Local AI could not be turned off, so the model was left in place.", code: "disable_failed" },
        { status: 502 },
      );
    }
  } else {
    await stopLocalAiProvider("llamacpp").catch(() => {});
  }
  try {
    await fs.unlink(target);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not remove the local model.", code: "remove_failed" },
      { status: 500 },
    );
  }
  const files = await listLibrary(spec.modelDir, spec.hfFile);
  const disk = await checkInstallDisk(spec.modelDir, 0);
  return NextResponse.json({ ok: true, freedBytes, installed: false, files, freeBytes: disk.freeBytes, reserveBytes: disk.reserveBytes });
}

/**
 * `hf download <repo> <file> --local-dir <dir>`, watched.
 *
 * Every argument is one argv element and every one of them was rebuilt from a
 * validated alphabet; nothing here goes through a shell. Its own process group,
 * so the timeout ends a multi-gigabyte transfer rather than orphaning it.
 */
function runDownload(
  hfBin: string,
  repo: string,
  file: string,
  modelDir: string,
  onStatus: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(hfBin, ["download", repo, file, "--local-dir", modelDir], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "1" },
    });
    let settled = false;
    let stderr = "";
    const finish = (outcome: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(outcome);
    };
    const deadline = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      finish({ ok: false, error: "The model download took too long and was stopped." });
    }, DOWNLOAD_TIMEOUT_MS);

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) onStatus(trimmed);
      }
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on("error", () => finish({ ok: false, error: "Could not start the model download." }));
    child.on("close", (code) => {
      if (code === 0) return finish({ ok: true });
      const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      finish({ ok: false, error: lines.at(-1) || `The model download failed (exit ${code}).` });
    });
  });
}
