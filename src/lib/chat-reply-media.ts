/**
 * Which files a member of staff may download from their chat (TASK-2516),
 * for the TypeScript side. The implementation is scripts/chat-reply-media.js,
 * which production-server.js's user-chat relay requires as well: one file, so
 * an OpenClaw member and a Hermes member are judged by one rule. SERVER ONLY.
 */

import path from "@/lib/runtime-path";
import { recordMediaOwnerReturning } from "@/lib/chat-media-owners";
import {
  claimReplyMedia,
  mediaDirectives,
  pathsInText,
  MEDIA_TREE_OWN_FOLDERS,
} from "../../scripts/chat-reply-media.js";

export { claimable, historyClaims, mediaDirectives, pathsInText, replyMediaPaths, stringsIn, MEDIA_TREE_OWN_FOLDERS } from "../../scripts/chat-reply-media.js";

type Claimed = { recorded: string[]; refused: Array<{ path: string; reason: string }> };

/**
 * Record the files a member's reply TEXT names on `MEDIA:` lines as theirs —
 * in their OWN assistant folder only (nobody else's assistant writes there),
 * written between `since` and now. A path in the shared media tree is never
 * made a member's by a reply: that takes a tool call's provenance
 * (`recordToolOutputFiles`). Never throws.
 */
export function recordMemberReplyMedia(input: { username: string; text: string; ownFolder: string | null; since: number | null }): Claimed {
  if (!input.ownFolder) return { recorded: [], refused: [] };
  const paths = mediaDirectives(input.text)
    .map((source: string) => (source.toLowerCase().startsWith("file://") ? source.slice("file://".length) : source))
    .filter((source: string) => path.isAbsolute(source));
  if (paths.length === 0) return { recorded: [], refused: [] };
  return claimReplyMedia({
    username: input.username,
    paths,
    since: input.since,
    until: Date.now(),
    roots: [{ dir: input.ownFolder }],
    record: recordMediaOwnerReturning,
  });
}

/**
 * PROVENANCE: the result of a tool call `username`'s assistant made through
 * the staff MCP relay with their own relay token named these files, and the
 * call began at `since`. A file it names in the chat media tree (not
 * ClawBox's own folders) or in the member's own folder, CREATED during the
 * call (its birth time), is theirs. Never throws.
 */
export function recordToolOutputFiles(input: { username: string; strings: readonly unknown[]; mediaRoot: string | null; ownFolder: string | null; since: number }): Claimed {
  const paths = pathsInText(input.strings);
  if (paths.length === 0) return { recorded: [], refused: [] };
  const roots: Array<{ dir: string; skip?: readonly string[] }> = [];
  if (input.mediaRoot) roots.push({ dir: input.mediaRoot, skip: MEDIA_TREE_OWN_FOLDERS });
  if (input.ownFolder) roots.push({ dir: input.ownFolder });
  // `created`: written by THIS call — born after it began — not merely named by it.
  return claimReplyMedia({ username: input.username, paths, since: input.since, until: Date.now(), roots, created: true, record: recordMediaOwnerReturning });
}
