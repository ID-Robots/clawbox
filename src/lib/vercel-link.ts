/**
 * The owner's Vercel link: which Vercel project a coding-agent project deploys
 * to, and which stored secret holds the token for it.
 *
 * WHY IT IS KEYED BY THE SECRET SCOPE. A run's secrets are resolved by
 * `projectScopeFor` in coding-agent.ts — a code project's id, or the first
 * folder under the owner's project folder for a run working anywhere inside
 * one. The link uses THAT identity and nothing else, so the token a run is
 * handed as `$VERCEL_TOKEN` and the token this box uses to ask how the build
 * went are the same entry, chosen by the same rule. Two identities here would
 * mean a project whose deploy worked for the agent and not for the card, which
 * is exactly the kind of split nobody would find.
 *
 * WHY THE LINKS ARE A CONFIG KEY AND THE TOKEN IS NOT. Everything here is
 * ordinary configuration — an id, a team, the NAME of a secret. It is readable,
 * it goes in a backup, and none of it is a credential. The token stays in
 * `data/secrets.json`, encrypted, and is read for the length of one call.
 */

import { get as configGet, set as configSet } from "@/lib/config-store";
import { BOX_SCOPE, isValidSecretScope, readSecretForProject, SECRET_NAME_RE } from "@/lib/project-secrets";
import { isVercelId, VercelLinkError, type VercelLink, type VercelLinkRefusal } from "@/lib/vercel-state";
import { readProject, verifyToken, type VercelAuth, type VercelErrorKind } from "@/lib/vercel";

/** Where the links live in `data/config.json`. */
export const VERCEL_LINKS_CONFIG_KEY = "coding_vercel_links";

/**
 * The most projects that may be linked.
 *
 * A bound rather than a policy: this is one config value read on every project
 * page, and an unbounded map written through an owner-only route is still a
 * map that grows for ever.
 */
export const MAX_VERCEL_LINKS = 50;

/** Every link, keyed by the project scope. */
export type VercelLinks = Record<string, VercelLink>;

function isLink(value: unknown): value is VercelLink {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isVercelId(v.projectId)
    && (v.teamId === null || isVercelId(v.teamId))
    && typeof v.tokenSecretName === "string" && SECRET_NAME_RE.test(v.tokenSecretName)
    && typeof v.createdAt === "number" && typeof v.updatedAt === "number";
}

/**
 * The scope a link is filed under, checked.
 *
 * `BOX_SCOPE` is refused here even though the secret store accepts it: a link
 * names ONE Vercel project, and a box-wide link would silently deploy every
 * project the agent works in to the same place.
 */
export function requireLinkScope(scope: unknown): string {
  if (typeof scope !== "string" || scope === BOX_SCOPE || !isValidSecretScope(scope)) {
    throw new VercelLinkError("invalid_scope", "A Vercel link belongs to one project, named by its id.");
  }
  return scope;
}

/**
 * Read the map.
 *
 * A value that is not the map it should be reads as EMPTY rather than throwing,
 * and that is the right direction here and the wrong one in the secret store:
 * the store's empty read would be written back over the owner's list, while
 * this map is only ever written key by key from a validated input — and a
 * project whose link cannot be read must show "not linked" rather than take the
 * project page down. A single malformed entry is dropped, not the rest with it.
 */
export async function readVercelLinks(): Promise<VercelLinks> {
  const raw = await configGet(VERCEL_LINKS_CONFIG_KEY);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyLinks();
  const links = emptyLinks();
  for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
    if (scope !== BOX_SCOPE && isValidSecretScope(scope) && isLink(value)) links[scope] = value;
  }
  return links;
}

/**
 * A map with NO PROTOTYPE.
 *
 * A project id is `[A-Za-z0-9_-]`, which spells `__proto__` perfectly well —
 * and `links["__proto__"] = value` on a plain object literal sets the
 * accumulator's PROTOTYPE instead of a key, after which `readVercelLink("…")`
 * can answer an inherited value that is not a link at all. Found in review;
 * `Object.create(null)` has no such key to set, and the own-key check below is
 * the second half of the same fix.
 */
function emptyLinks(): VercelLinks {
  return Object.create(null) as VercelLinks;
}

/** The link for one project, or null. */
export async function readVercelLink(scope: string | null | undefined): Promise<VercelLink | null> {
  if (typeof scope !== "string" || !scope) return null;
  const links = await readVercelLinks();
  // OWN keys only: see emptyLinks. Belt and braces, because a caller that built
  // a map some other way must not be able to reach `Object.prototype` through
  // this function either.
  return Object.prototype.hasOwnProperty.call(links, scope) ? links[scope] : null;
}

/** Attach a Vercel project, or change the attachment. Answers the stored link. */
export async function setVercelLink(input: {
  scope: unknown;
  projectId: unknown;
  teamId?: unknown;
  tokenSecretName: unknown;
}): Promise<VercelLink> {
  const scope = requireLinkScope(input.scope);
  if (!isVercelId(input.projectId)) {
    throw new VercelLinkError(
      "invalid_project",
      "A Vercel project is named by its id (prj_…) or its project name: letters, digits, hyphens and underscores.",
    );
  }
  // Absent, null and the empty string all mean a personal account — the field
  // is left off the form, so an empty box must not be a refusal.
  let teamId: string | null = null;
  if (input.teamId !== undefined && input.teamId !== null && input.teamId !== "") {
    if (!isVercelId(input.teamId)) {
      throw new VercelLinkError("invalid_team", "A Vercel team is named by its id (team_…): letters, digits, hyphens and underscores.");
    }
    teamId = input.teamId;
  }
  if (typeof input.tokenSecretName !== "string" || !SECRET_NAME_RE.test(input.tokenSecretName)) {
    throw new VercelLinkError(
      "invalid_secret_name",
      "The token is named by one of this ClawBox's stored secrets — an environment variable name, like VERCEL_TOKEN.",
    );
  }
  const tokenSecretName = input.tokenSecretName;

  const links = await readVercelLinks();
  const existing = Object.prototype.hasOwnProperty.call(links, scope) ? links[scope] : null;
  if (!existing && Object.keys(links).length >= MAX_VERCEL_LINKS) {
    // Refused rather than evicted, for the reason the secret store refuses a
    // full list: dropping the oldest would take a working deploy away from a
    // project nobody was looking at.
    throw new VercelLinkError("link_unwritable", `This ClawBox keeps at most ${MAX_VERCEL_LINKS} Vercel links. Remove one first.`);
  }
  const now = Date.now();
  const link: VercelLink = {
    projectId: input.projectId,
    teamId,
    tokenSecretName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await configSet(VERCEL_LINKS_CONFIG_KEY, { ...links, [scope]: link });
  return link;
}

/** Take the attachment back. Answers whether there was one. */
export async function deleteVercelLink(scope: unknown): Promise<boolean> {
  const key = requireLinkScope(scope);
  const links = await readVercelLinks();
  // `hasOwnProperty`, never `in`: see emptyLinks.
  if (!Object.prototype.hasOwnProperty.call(links, key)) return false;
  const next = { ...links };
  delete next[key];
  await configSet(VERCEL_LINKS_CONFIG_KEY, next);
  return true;
}

/**
 * The credential for a link, resolved at the moment of the call.
 *
 * Never cached and never put on a record: the owner can rotate the entry at any
 * time, and a token held from an earlier poll is a token that goes on failing
 * after they fixed it. The scope precedence is the store's own — the project's
 * entry over a box-wide one of the same name.
 *
 * Throws rather than returning null, because every caller has to say WHICH of
 * the two failures happened: an entry that is not there at all (the owner named
 * the wrong secret, or deleted it) and one this box cannot open (it was sealed
 * under a session secret a factory reset took) need different sentences.
 */
export async function resolveVercelAuth(link: VercelLink, scope: string): Promise<VercelAuth> {
  const found = await readSecretForProject({ name: link.tokenSecretName, project: scope });
  if (!found.found) {
    // THREE reasons, and each needs a different thing said. Folding any two of
    // them together gives advice that is wrong for the other: "save it under
    // that name" is useless about an entry already in the owner's list, and
    // worse than useless about a store this box cannot read — it would have
    // them type a credential into a file that will not keep it.
    if (found.reason === "unreadable") {
      throw new VercelLinkError(
        "token_unreadable",
        `This ClawBox has a secret called ${link.tokenSecretName} but can no longer open it — it was saved under a key this box has lost. Save the Vercel token again under the same name.`,
      );
    }
    if (found.reason === "unavailable") {
      throw new VercelLinkError(
        "token_store_unavailable",
        "This ClawBox could not read its own secret store, so it cannot tell whether the Vercel token is there. Nothing is wrong with your link — this is the box, and saving the token again will not help until the store can be read.",
      );
    }
    throw new VercelLinkError(
      "token_missing",
      `This ClawBox has no secret called ${link.tokenSecretName} for this project. Save the Vercel token under that name, or point the link at one that is there.`,
    );
  }
  return { token: found.value, teamId: link.teamId };
}

// ── readiness ───────────────────────────────────────────────────────────────

/**
 * Could this project deploy right now, and if not, what is missing?
 *
 * THREE questions, asked in order and each only when the one before it was
 * answered, because each is a prerequisite for the next: is there a link, does
 * the token open, and does Vercel accept it for that project. The list of
 * `problems` is what the card draws — one sentence per missing piece, the shape
 * `CodingHarnessReadiness` already uses — and `code` is the machine-readable
 * first cause, so a surface can word it in the owner's language.
 *
 * `tokenValid` and `projectResolves` are TRI-STATE. `null` is "could not ask"
 * — the box is offline, Vercel is rate-limiting, Vercel is having trouble — and
 * it is never read as false: a card that said "your token is wrong" because the
 * house internet was down would send an owner to rotate a credential that was
 * fine. The same distinction `harnessSwapUnitActive` makes, for the same reason.
 */
export interface VercelReadiness {
  linked: boolean;
  projectId: string | null;
  teamId: string | null;
  tokenSecretName: string | null;
  /**
   * Is the named secret there and openable?
   *
   * TRI-STATE like `tokenValid` below, and for the same reason: `null` is "this
   * box could not read its own secret store", which is neither "it is there"
   * nor "it is not". A card that read that as `false` would tell the owner to
   * save a token when the thing that is broken is the store (found in review).
   */
  tokenPresent: boolean | null;
  /** Did Vercel accept it? Null when this box could not ask. */
  tokenValid: boolean | null;
  /** Whose account it is, when Vercel said. */
  username: string | null;
  /** Does the project id resolve? Null when this box could not ask. */
  projectResolves: boolean | null;
  projectName: string | null;
  /** Ready = linked, token accepted, project resolves. Never true on a null. */
  ready: boolean;
  problems: string[];
  code: VercelLinkRefusal | VercelErrorKind | null;
}

function notLinked(): VercelReadiness {
  return {
    linked: false, projectId: null, teamId: null, tokenSecretName: null,
    tokenPresent: false, tokenValid: null, username: null,
    projectResolves: null, projectName: null, ready: false,
    problems: [], code: null,
  };
}

export async function checkVercelReadiness(scope: string | null | undefined): Promise<VercelReadiness> {
  const link = await readVercelLink(scope ?? null);
  if (!link || typeof scope !== "string") return notLinked();
  const base = {
    ...notLinked(),
    linked: true,
    projectId: link.projectId,
    teamId: link.teamId,
    tokenSecretName: link.tokenSecretName,
  };

  let auth: VercelAuth;
  try {
    auth = await resolveVercelAuth(link, scope);
  } catch (err) {
    const code = err instanceof VercelLinkError ? err.code : "token_missing";
    return {
      ...base,
      // An entry that is THERE and cannot be opened is PRESENT: the card must
      // not tell the owner to save a secret they can see in their own list. A
      // store this box could not read at all says nothing either way, so it is
      // null rather than false.
      tokenPresent: code === "token_unreadable" ? true : code === "token_store_unavailable" ? null : false,
      code,
      problems: [err instanceof Error ? err.message : "This ClawBox could not read the Vercel token."],
    };
  }

  const user = await verifyToken(auth);
  if (!user.ok) {
    return {
      ...base,
      tokenPresent: true,
      // Only an answer FROM Vercel decides the token; everything else leaves it
      // unknown. See the tri-state note above.
      tokenValid: user.kind === "auth" ? false : null,
      code: user.kind,
      problems: [user.detail],
    };
  }

  const project = await readProject(auth, link.projectId);
  if (!project.ok) {
    return {
      ...base,
      tokenPresent: true,
      tokenValid: true,
      username: user.username,
      projectResolves: project.kind === "not_found" || project.kind === "refused" ? false : null,
      code: project.kind,
      problems: [
        project.kind === "not_found"
          ? `Vercel has no project called ${link.projectId} on this account.`
          : project.detail,
      ],
    };
  }

  return {
    ...base,
    tokenPresent: true,
    tokenValid: true,
    username: user.username,
    projectResolves: true,
    projectName: project.name,
    ready: true,
    problems: [],
    code: null,
  };
}
