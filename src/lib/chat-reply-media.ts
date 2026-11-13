/**
 * The files an agent's reply in a member of staff's chat names, recorded as
 * that member's (TASK-2516), for the TypeScript side. The implementation is
 * scripts/chat-reply-media.js, which production-server.js's user-chat relay
 * requires as well: one file, so an OpenClaw reply and a Hermes reply are
 * judged by one rule. SERVER ONLY.
 */

import path from "@/lib/runtime-path";
import { recordMediaOwnerReturning } from "@/lib/chat-media-owners";
import {
  claimReplyMedia,
  mediaDirectives,
  MEDIA_TREE_OWN_FOLDERS,
} from "../../scripts/chat-reply-media.js";

export { claimable, historyClaims, mediaDirectives, replyMediaPaths, MEDIA_TREE_OWN_FOLDERS } from "../../scripts/chat-reply-media.js";

/**
 * Record the local files a member's reply TEXT names on `MEDIA:` lines as
 * theirs: in the chat media tree (`mediaRoot`, minus ClawBox's own folders) or
 * their own assistant folder, written between `since` and now. Never throws.
 * Answers how many were recorded and why the rest were not.
 */
export function recordMemberReplyMedia(input: {
  username: string;
  text: string;
  mediaRoot: string;
  ownFolder: string | null;
  since: number | null;
}): { recorded: string[]; refused: Array<{ path: string; reason: string }> } {
  const paths = mediaDirectives(input.text)
    .map((source: string) => (source.toLowerCase().startsWith("file://") ? source.slice("file://".length) : source))
    .filter((source: string) => path.isAbsolute(source));
  if (paths.length === 0) return { recorded: [], refused: [] };
  return claimReplyMedia({
    username: input.username,
    paths,
    since: input.since,
    until: Date.now(),
    roots: [
      { dir: input.mediaRoot, skip: MEDIA_TREE_OWN_FOLDERS },
      ...(input.ownFolder ? [{ dir: input.ownFolder }] : []),
    ],
    record: recordMediaOwnerReturning,
  });
}
