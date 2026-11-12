export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { readJsonObject } from "@/lib/bounded-json";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  credentialHeaderName,
  isServerName,
  isStaffUsername,
  maskCredential,
  normalizeCredential,
  readStaffMcpStore,
  staffServerVerdict,
  updateStaffMcpStore,
  type StaffMcpStore,
} from "@/lib/staff-mcp";

/**
 * /setup-api/settings/staff-mcp — which of the box's MCP servers members of
 * staff may use on an organisation box, and each member's own credential for
 * them (TASK-2377; src/lib/staff-mcp.ts holds the rules).
 *
 * OWNER ONLY, both ways: the owner's cookie (never another user's, never the
 * agent's MCP bearer — `personSession` is a person) and, for a write, our own
 * page. A credential is never answered — not to the owner either, who sees it
 * masked.
 *
 * GET  `{ orgMode, harness, servers: [{name, transport, usable, reason?, granted, header}],
 *         users: [{username, credentials: {[server]: "••••abcd"}}] }`
 * POST `{ servers: {[name]: {header?}} }`          — the granted list, whole;
 *      `{ username, server, credential: string|null }` — one member's credential.
 *
 * 403 `owner_only` for anyone else; 400 for a bad or unknown name.
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** The member a credential was for went away while the change waited for the store. */
class UserGoneError extends Error {}
const MAX_BODY_BYTES = 64 * 1024;
const MAX_GRANTED = 32;

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

async function ownerOnly(req: Request, write: boolean): Promise<NextResponse | null> {
  const who = await personSession(req);
  if (!who?.isOwner) return refuse(403, "owner_only", "Only the box owner can choose the tools members of staff may use.");
  if (write && !isSameOriginRequest(req)) return refuse(403, "cross_origin", "This can only be changed from this ClawBox's own pages.");
  return null;
}

/** The OpenClaw servers this box defines, as the staff page lists them. */
async function configuredServers() {
  const { readConfigStrict, isPlainObject } = await import("@/lib/openclaw-config");
  const { openclawServerEntries } = await import("@/lib/project-mcp-servers");
  const config = await readConfigStrict();
  const mcp = isPlainObject(config.mcp) ? config.mcp : {};
  return openclawServerEntries(mcp.servers);
}

async function view(store: StaffMcpStore) {
  const [{ readOrgMode }, { getActiveHarness }, { listUsers }] = await Promise.all([
    import("@/lib/org-mode-server"),
    import("@/lib/harness"),
    import("@/lib/clawbox-users"),
  ]);
  const harness = await getActiveHarness();
  let servers: Awaited<ReturnType<typeof configuredServers>> = [];
  let unreadable = false;
  if (harness === "openclaw") {
    try {
      servers = await configuredServers();
    } catch {
      unreadable = true;
    }
  }
  const listed: Array<{ name: string; transport: string | null; usable: boolean; reason?: string; granted: boolean; header: string }> = servers.map((server) => {
    const reason = staffServerVerdict(server);
    return {
      name: server.name,
      transport: server.transport,
      usable: reason === null,
      ...(reason ? { reason } : {}),
      granted: Boolean(store.servers[server.name]),
      header: store.servers[server.name]?.header ?? "Authorization",
    };
  });
  // A grant whose server is gone from openclaw.json is still shown, so the owner can take it away.
  for (const name of Object.keys(store.servers)) {
    if (!listed.some((s) => s.name === name)) {
      listed.push({ name, transport: null, usable: false, reason: "missing", granted: true, header: store.servers[name].header });
    }
  }
  const users = (await listUsers()).map((user) => {
    const credentials: Record<string, string> = {};
    for (const [server, value] of Object.entries(store.credentials[user.username] ?? {})) credentials[server] = maskCredential(value);
    return { username: user.username, credentials };
  });
  return {
    orgMode: await readOrgMode(),
    harness,
    // Hermes: a member of staff's profile gets no MCP server (multi-user.md).
    staffMcpSupported: harness === "openclaw",
    configUnreadable: unreadable,
    servers: listed.sort((a, b) => a.name.localeCompare(b.name)),
    users,
  };
}

async function readStoreOr500(): Promise<StaffMcpStore | NextResponse> {
  try {
    return await readStaffMcpStore();
  } catch {
    return refuse(500, "store_unreadable", "The staff tools settings could not be read. Nothing was changed.");
  }
}

export async function GET(req: Request) {
  const denied = await ownerOnly(req, false);
  if (denied) return denied;
  const store = await readStoreOr500();
  if (store instanceof NextResponse) return store;
  return NextResponse.json(await view(store), { headers: NO_STORE });
}

export async function POST(req: Request) {
  const denied = await ownerOnly(req, true);
  if (denied) return denied;
  const read = await readJsonObject(req, MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === "too_long" ? refuse(413, "body_too_large", "That request body is too large.") : refuse(400, "bad_body", "Invalid JSON.");
  }
  const body = read.body as Record<string, unknown>;

  const { getActiveHarness } = await import("@/lib/harness");
  if ((await getActiveHarness()) !== "openclaw") {
    return refuse(409, "unsupported_harness", "Members of staff get MCP tools on the OpenClaw assistant only.");
  }

  let change: (store: StaffMcpStore) => StaffMcpStore | Promise<StaffMcpStore>;
  if (body.servers !== undefined) {
    // The granted list, whole. Every name must be a server openclaw.json
    // defines that members of staff can use — or one already granted, so a
    // grant whose server went away can still be kept or taken away.
    if (body.servers === null || typeof body.servers !== "object" || Array.isArray(body.servers)) {
      return refuse(400, "bad_servers", "servers must be an object of server names.");
    }
    const requested = Object.entries(body.servers as Record<string, unknown>);
    if (requested.length > MAX_GRANTED) return refuse(400, "too_many", `At most ${MAX_GRANTED} servers can be granted.`);
    let known;
    try {
      known = await configuredServers();
    } catch {
      return refuse(503, "config_unreadable", "The assistant's configuration could not be read. Nothing was changed.");
    }
    const current = await readStoreOr500();
    if (current instanceof NextResponse) return current;
    const next: StaffMcpStore["servers"] = {};
    for (const [name, setting] of requested) {
      if (!isServerName(name)) return refuse(400, "bad_server", `"${String(name).slice(0, 64)}" is not a server name.`);
      const server = known.find((s) => s.name === name);
      if (!server && !current.servers[name]) return refuse(400, "unknown_server", `There is no MCP server named "${name}" on this box.`);
      if (server && staffServerVerdict(server) !== null && !current.servers[name]) {
        return refuse(400, "server_not_usable", `"${name}" cannot be offered to members of staff (only Streamable HTTP servers without a credential in the URL can).`);
      }
      const header = credentialHeaderName(setting && typeof setting === "object" ? (setting as { header?: unknown }).header : undefined);
      if (!header) return refuse(400, "bad_header", `The credential header for "${name}" is not a header that can be used.`);
      next[name] = { header };
    }
    change = (store) => ({ ...store, servers: next });
  } else if (body.username !== undefined || body.server !== undefined) {
    const { username, server } = body;
    if (!isStaffUsername(username)) return refuse(400, "bad_username", "That is not a username.");
    if (!isServerName(server)) return refuse(400, "bad_server", "That is not a server name.");
    const [{ listUsers }, { getSystemUsername }] = await Promise.all([import("@/lib/clawbox-users"), import("@/lib/auth")]);
    if (username === getSystemUsername() || !(await listUsers()).some((u) => u.username === username)) {
      return refuse(400, "unknown_user", `"${username}" is not a member of staff on this box.`);
    }
    const current = await readStoreOr500();
    if (current instanceof NextResponse) return current;
    if (!current.servers[server]) return refuse(400, "unknown_server", `"${server}" is not granted to members of staff.`);
    let credential: string | null = null;
    if (body.credential !== null) {
      credential = normalizeCredential(body.credential);
      if (!credential) return refuse(400, "bad_credential", "The credential must be 1–4096 characters with no line breaks or control characters.");
    }
    change = async (store) => {
      // Checked again UNDER the store's lock, which removal's and creation's
      // clean-ups take too: a credential is never written for an account that
      // was removed (or replaced by a new one of the same name) meanwhile.
      const { listUsers: usersNow } = await import("@/lib/clawbox-users");
      if (!(await usersNow()).some((u) => u.username === username)) throw new UserGoneError();
      const mine = { ...(store.credentials[username] ?? {}) };
      if (credential) mine[server] = credential;
      else delete mine[server];
      const credentials = { ...store.credentials };
      if (Object.keys(mine).length > 0) credentials[username] = mine;
      else delete credentials[username];
      return { ...store, credentials };
    };
  } else {
    return refuse(400, "bad_body", "Nothing to change.");
  }

  let store: StaffMcpStore;
  try {
    store = await updateStaffMcpStore(change);
  } catch (err) {
    if (err instanceof UserGoneError) return refuse(400, "unknown_user", "That user is not a member of staff on this box any more.");
    return refuse(500, "store_write_failed", "The staff tools settings could not be saved. Nothing was changed.");
  }
  console.log("[staff-mcp] the owner changed the staff MCP grants");
  // Each member's agent and relay entries follow at once (awaited, best effort).
  const { syncStaffAgents } = await import("@/lib/org-staff-agents");
  // `applied: false` — saved, but the assistant's configuration (or the
  // guard's record) could not be updated; the next sync (this page again, a
  // member opening their chat) retries it.
  const applied = await syncStaffAgents();
  if (!applied) console.error("[staff-mcp] the grants were saved but could not be applied to the assistant yet");
  return NextResponse.json({ ...(await view(store)), applied }, { headers: NO_STORE });
}
