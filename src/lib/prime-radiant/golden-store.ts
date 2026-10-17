/**
 * The golden questions in the vault: `golden.json` beside index.md (golden.ts
 * says what it holds). Read without creating anything; changed under the
 * vault's lock as ONE commit `golden: <what>`, authored by whoever asked (the
 * owner, or the assistant through the MCP bearer), so History shows it and
 * Undo takes it back like any page change. The file is no page: the lint and
 * the nightly gate never read it, memory-wiki never lists it.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { commitPaths, VAULT_AUTHOR, withVaultLock, type VaultAuthor } from "./git";
import { GOLDEN_FILE, GOLDEN_ID_RE, GOLDEN_LIMITS, parseGoldenFile, serializeGoldenFile, type GoldenInput, type GoldenQuestion } from "./golden";
import { vaultDir } from "./paths";
import { readSettings, type DomainSetting } from "./settings";
import { vaultInitialised } from "./vault";

/** Who a golden question gets when none is named and its domain has no owner in the settings. */
export const GOLDEN_DEFAULT_OWNER = "unassigned";

export class GoldenError extends Error {
  constructor(
    readonly code: "not_found" | "not_initialised" | "too_many",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoldenError";
  }
}

export function goldenFilePath(vault: string = vaultDir()): string {
  return path.join(vault, GOLDEN_FILE);
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** The questions the vault holds now (none, with no vault or no file). Never creates anything. */
export async function readGoldenQuestions(vault: string = vaultDir()): Promise<{ questions: GoldenQuestion[]; skipped: number }> {
  return parseGoldenFile(await readFileOrNull(goldenFilePath(vault)));
}

/** A caller's question id rebuilt, or null. */
export function safeGoldenId(input: unknown): string | null {
  return typeof input === "string" && GOLDEN_ID_RE.test(input) ? input : null;
}

function newGoldenId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `gq-${crypto.randomBytes(6).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

function ownerFor(domain: string, owner: string | null | undefined, domains: readonly DomainSetting[]): string {
  return owner ?? domains.find((d) => d.name === domain)?.owner ?? GOLDEN_DEFAULT_OWNER;
}

export interface GoldenChange {
  question: GoldenQuestion | null;
  commit: string | null;
}

export interface GoldenOptions {
  vault?: string;
  author?: VaultAuthor;
  now?: Date;
  domains?: readonly DomainSetting[];
}

/** Read, change and write `golden.json` under the vault's lock: one commit, or none when nothing differed. */
async function changeGolden(
  message: string,
  options: GoldenOptions,
  fn: (questions: GoldenQuestion[]) => { questions: GoldenQuestion[]; question: GoldenQuestion | null },
): Promise<GoldenChange> {
  const vault = options.vault ?? vaultDir();
  if (!(await vaultInitialised(vault).catch(() => false))) throw new GoldenError("not_initialised", "Prime Radiant has no vault yet.", 412);
  return withVaultLock(vault, async () => {
    const file = goldenFilePath(vault);
    const before = await readFileOrNull(file);
    const { questions, question } = fn(parseGoldenFile(before).questions);
    const text = serializeGoldenFile(questions);
    if (text === before) return { question, commit: null };
    const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tmp, text, { mode: 0o644, flag: "wx" });
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    try {
      const commit = await commitPaths(vault, message, [GOLDEN_FILE], options.author ?? VAULT_AUTHOR);
      return { question, commit };
    } catch (err) {
      // Put the file back as it was: an uncommitted golden.json would ride along in the next commit of someone else.
      if (before === null) await fs.rm(file, { force: true });
      else await fs.writeFile(file, before);
      throw err;
    }
  });
}

export async function addGoldenQuestion(input: GoldenInput, options: GoldenOptions = {}): Promise<GoldenChange> {
  const at = (options.now ?? new Date()).toISOString();
  const domains = options.domains ?? readSettings().domains;
  return changeGolden(`golden: add ${input.question.slice(0, 60)}`, options, (questions) => {
    if (questions.length >= GOLDEN_LIMITS.maxQuestions) {
      throw new GoldenError("too_many", `The wiki holds at most ${GOLDEN_LIMITS.maxQuestions} golden questions; delete one first.`, 409);
    }
    const question: GoldenQuestion = {
      id: newGoldenId(new Set(questions.map((q) => q.id))),
      question: input.question,
      expected: input.expected,
      owner: ownerFor(input.domain, input.owner, domains),
      domain: input.domain,
      claimId: input.claimId ?? null,
      page: input.page ?? null,
      createdAt: at,
      updatedAt: at,
    };
    return { questions: [...questions, question], question };
  });
}

export async function updateGoldenQuestion(id: string, patch: Partial<GoldenInput>, options: GoldenOptions = {}): Promise<GoldenChange> {
  const at = (options.now ?? new Date()).toISOString();
  const domains = options.domains ?? readSettings().domains;
  return changeGolden(`golden: edit ${id}`, options, (questions) => {
    const i = questions.findIndex((q) => q.id === id);
    if (i < 0) throw new GoldenError("not_found", "There is no golden question with that id.", 404);
    const prior = questions[i];
    const next: GoldenQuestion = {
      ...prior,
      ...(patch.question !== undefined ? { question: patch.question } : {}),
      ...(patch.expected !== undefined ? { expected: patch.expected } : {}),
      ...(patch.domain !== undefined ? { domain: patch.domain } : {}),
      ...(patch.claimId !== undefined ? { claimId: patch.claimId } : {}),
      ...(patch.page !== undefined ? { page: patch.page } : {}),
    };
    // A cleared owner goes back to the domain's; a moved question keeps the owner it was given.
    if (patch.owner !== undefined) next.owner = ownerFor(next.domain, patch.owner, domains);
    const same = JSON.stringify({ ...next, updatedAt: "" }) === JSON.stringify({ ...prior, updatedAt: "" });
    if (same) return { questions, question: prior };
    next.updatedAt = at;
    const out = [...questions];
    out[i] = next;
    return { questions: out, question: next };
  });
}

export async function deleteGoldenQuestion(id: string, options: GoldenOptions = {}): Promise<GoldenChange> {
  return changeGolden(`golden: delete ${id}`, options, (questions) => {
    const prior = questions.find((q) => q.id === id);
    if (!prior) throw new GoldenError("not_found", "There is no golden question with that id.", 404);
    return { questions: questions.filter((q) => q.id !== id), question: prior };
  });
}
