# Email draft send approval

The assistant can prepare an email as a **draft** in a mailbox, through a mail
MCP server the owner granted it (for example a Microsoft 365 server whose
tools can create and update drafts but not send). ClawBox then shows the draft
in the chat as a card:

- **Send**: the ClawBox web server sends the draft through the mail send
  backend.
- **Keep as draft**: nothing is sent. The draft stays in the Drafts folder.
- **Tell me what to change**: the text becomes the person's next chat message.
  The assistant revises the draft and shows a new card.

The assistant never holds the right to send. Only a signed-in person pressing
**Send** on their own card sends the draft.

## How a draft reaches the chat

1. The assistant creates or updates the draft with its mail tool.
2. It calls ClawBox's `email_draft_card` MCP tool with the draft id. The tool
   checks that cards are switched on and that the mailbox has the draft. It
   answers with one line, `EMAIL_DRAFT:<id>`, for the end of the reply.
3. The chat (`src/lib/chat-email-draft-refs.ts`) lifts that line out of the
   reply. In its place it shows the card (`src/lib/chat-email-draft.tsx`).
4. The card asks `POST /setup-api/email/draft-approval/card`. The server reads
   the draft from the mail send backend, so the card never uses the
   assistant's words. It answers with the recipients, subject and body, plus a
   one-time approval token.

The line carries an id and nothing else. On Telegram, WhatsApp, Discord and
Slack, which have no cards, both runtimes' reply plugins strip the line
(`scripts/openclaw-plugins/clawbox-email-directives/`,
`scripts/hermes-plugins/clawbox_email_directives/`). A reply that names a draft the person
cannot see gets a card saying the draft is not in their mailbox.

## The approval token

`src/lib/mail-draft-approval.ts` issues the token. It is bound to:

- the signed-in user the card was made for (the owner or a member of staff);
- the draft id;
- a SHA-256 hash of the backend's **whole answer** for the draft:
  `sha256("clawbox-mail-draft/v2\n" + canonical JSON)`, where canonical JSON
  is the answer re-serialised byte for byte as set out in
  [Canonical JSON](#canonical-json) below. The hash is not
  limited to the fields the card shows. A Reply-To, a From, a header or an
  attachment's bytes or digest, when the backend includes them, are bound as
  firmly as the recipients and the body. An answer nested more than 64 levels
  deep is refused as an answer ClawBox could not read, rather than hashed down
  to that depth: a hash that cannot tell two answers apart would not bind
  either of them;
- an expiry: 30 minutes, or `CLAWBOX_MAIL_DRAFT_TOKEN_TTL_S` seconds (10 s to
  24 h).

The token is HMAC-SHA256 signed. The key is derived from the session-signing
secret under a label of its own, so a token is never a valid session cookie and
a cookie is never a valid token. Every card is recorded in
`data/mail-draft-approvals.json` (mode 0600, written by atomic rename), which is
what makes a token one-time. The file is read **fail-closed**: a missing file is
an empty ledger (a box's first use), and a file whose JSON, or any single entry
in it, cannot be read refuses the whole ledger — every decision is then refused
with 503 rather than taken against records that may be missing the one that
should block a Send.

`POST /setup-api/email/draft-approval/decide` with `{token, action}` checks the
following, in order, and refuses if any check fails:

| Check | Refusal |
|---|---|
| A person's session cookie (the MCP bearer is refused) | 403 `owner_only` |
| The request comes from this ClawBox's own pages | 403 `cross_origin` |
| Cards are switched on | 409 `disabled` |
| A token was sent at all | 403 `no_approval` |
| ClawBox signed this token | 403 `forged` |
| The token was made for the person pressing | 403 `other_user` |
| The card is still open (not sent, kept, revised or claimed by a parallel press) | 409 `reused` |
| Send only: no other card of this person has sent this draft, is sending it, or lost the answer to sending it after this card was made | 409 `reused`, with `state` `sent`, `sending` or `uncertain` |
| The token has not expired | 410 `expired` |
| Keep or Revise only: no other card of this person has sent this draft (any version), and no other card for the same draft version is sending it right now | 409 `reused`, with `state` `sent` or `sending` (nothing is changed) |
| Send only: the draft re-read from the backend still has the approved hash | 409 `changed` |
| Send only: the preview of that draft was shown whole (see below) | 409 `too_long`, the card stays open |

Only then does the server call the backend's send endpoint. A Send claims the
card **before** the re-read, so two presses or two tabs cannot both send it.
The claim is **per draft**, not per card: in the same synchronous
read-modify-write it checks every card of that person for that draft. Two open
cards for one draft exist when the first was close to its expiry as the second
was made. While one card's Send runs, or after it went, a Send from any other
card for the draft is refused. Every ledger write happens synchronously after
the last network call, from a fresh read, so a card minted while a Send is
running cannot undo the Send. Each ledger event (a card made, claimed or
settled) is stamped after every earlier one, so "made before that Send was
lost" is a strict order even within one millisecond.

If the backend could not be reached before sending, the card is reopened. If
the backend's answer to the send was lost (a timeout or a 5xx), the card is
closed as `uncertain`. The same applies to a server that stopped mid-send. An
`uncertain` card never reports "not sent". A plain reload does not offer that
draft's Send again, and no card made before the loss can send it. Only the
person's explicit **Review again** does, with a card made after the card has
told them to check their Sent folder.

That **Review again** is bound to the warning the card showed. An answer that
says `uncertain` (from the card route, and the decide route's `send_uncertain`
and `reused` refusals) carries `uncertainty` whenever the ledger holds a lost
Send that no card has been made since: the moment of the newest such loss. The
card route's `uncertain` always carries it. A decide refusal can lack it: when
the loss could not be written to the ledger (the card still says `sending`
until it is settled as lost), or when every loss already has a card made since
it. The card's **Review again** sends `uncertainty` back as `acknowledged`
(`{draftId, reopen: true, acknowledged}`), or sends a plain reopen when it has
none. The card route hands out a card that can send only when no lost Send is
outstanding, or when `acknowledged` names the newest one. Otherwise it answers
`uncertain` with the current `uncertainty` and no token, and the card shows
that warning first. This
covers a card that still says **Kept** or **Revised** when a Send from another
tab loses its answer: its **Review again** names no loss, so it is answered
with the warning, never with a sendable card. It also covers a **Review again**
that was already loading when a Send of the same draft lost its answer: that
loss is newer than the one it acknowledged, so the card says `uncertain` and
waits for another **Review again**. That holds even when another tab has
already shown that warning and opened a card past it while this one was
loading. A card load compares the newest loss before and after its own read
of the draft, whoever has been warned. A loss that appeared in between is
answered with its warning, never with the other tab's sendable card. A
plain look that was loading is answered the same way. A **Review again** with no loss outstanding
(every loss has had a card made since) opens a card as before. So a crashed
Send blocks the older cards, never the draft for good.

A Send the backend **confirmed** is recorded in the ledger with retries, and the
retries repeat the ledger write alone — the backend is never asked to send
twice. If no write succeeds — or if the ledger no longer holds the card at all —
the answer is still `sent`, with `recorded: false` and a sentence saying the
mail went and the record of it did not; the card shows that rather than only
"Sent."

The ledger keeps at most 2000 cards, but a `sent`, `sending` or `uncertain` card
is never dropped to make room. Those leave only by age (30 days). When they fill
the ledger there is no room for a new open card, and the card route refuses with
503 `no_room` instead of handing out an approval the ledger does not hold (which
every press would refuse as `reused`, saying the wrong thing about why). The
refused request writes nothing, so it costs the person none of their open or
answered records; nothing can be sent without an approval, so the refusal is
fail-closed as well. The card offers **Try again**, since the state clears as
the settled records age out.

A reload after **Review again** shows the new open card, not the earlier
**Keep as draft** or **Tell me what to change** answer for the same version.

**Keep as draft** and **Tell me what to change** close every approval
outstanding for the draft version they decline — that person, that draft, that
hash — not only the card they were pressed on. Two cards for one version exist
in two tabs, or across an expiry, and the second must not be able to send the
version the person has just asked to change. Approvals for other versions are
untouched, and an explicit **Review again** opens a card that can send. While a
Send of that version is running from another card, neither answer is confirmed:
that Send may still go out, or, if its read of the draft fails, put its card back
to open. The server answers `reused` with `state: "sending"` and changes nothing;
the person can answer again once the Send has finished. Once a Send of the
draft from another card has gone (whatever version it sent), neither answer is
confirmed either: a Send closes only the card it was pressed on, so the other
card is still open, and "kept" or a change request to the assistant would be
confirmed over mail that has already left. The server answers `reused` with
`state: "sent"`, changes nothing, and the card says the draft was already sent.

In the chat, a Send whose answer never reaches the browser (the connection
dropped, or something other than ClawBox answered, such as a proxy's error
page) is never shown as "nothing was sent". The card says the outcome is
unknown and asks ClawBox, by a plain look, what it recorded. That can be sent,
still sending, uncertain, or no longer in the mailbox. If ClawBox has no record
of the Send claim and the card is still open, the card is offered again and
says so. A second Send is safe there because of the per-draft claim above. If
ClawBox cannot be asked, the card stays unknown, points to the Sent folder, and
offers **Check again**.

### What the card shows

- From (when the backend names one), To, Cc, Bcc (always, when present),
  Reply-To (when present), the subject, the body and the attachments.
- An HTML body is shown as its words, through the mail viewer's sanitiser.
  Each link is shown with its target (`Open invoice <https://…>`).
- Characters that would make the card read differently from the mail, or
  carry text nobody sees, are shown as `[U+202E]`-style marks, never dropped
  silently, and the card warns about them. These are the C0 and C1 controls,
  every Unicode format character (bidi marks, embeddings, overrides and
  isolates, zero-width space, non-joiner and joiner, word joiner, invisible
  operators, the BOM, the tag block U+E0000-U+E007F) and every other
  default-ignorable code point (soft hyphen, Hangul fillers, variation
  selectors). A standard emoji is left alone: the joiner in a family or
  profession emoji, the U+FE0F of a red heart or a keycap, and the tags of the
  England, Scotland and Wales flags. A joiner or selector outside such an emoji,
  and any other tag run, is marked.
- The whole body is shown, up to the backend's 1 MiB answer limit. A preview
  that ever had to be cut offers no Send — including a cut the HTML sanitiser
  made rather than the preview limit: a body with more nodes than it keeps
  (12 000) or one run of text longer than it keeps (40 000 characters) is
  reported as truncated, however short the words that came out of it are, and
  so is an image description over 300 characters. The same applies to a subject
  (over 1000 characters) or an attachment name (over 200) that had to be cut. A
  recipient is never cut: one over 400 characters makes the draft unreadable,
  and ClawBox refuses it as the backend giving an answer it could not read. The
  server enforces this as well as the card: a Send for a draft whose preview was
  cut is refused with 409 `too_long` after the re-read, and nothing is sent.
  **Keep as draft** and **Tell me what to change** stay available for it.
- **Tell me what to change** goes to the assistant only after the server has
  closed the card as `revised`. If the close fails, the request stays in the
  box, read-only, and nothing is sent to the assistant. When a look reopens
  the card, the box can be edited and sent again. If the answer to the close was
  lost and a later look finds the card closed as `revised`, the words go to the
  assistant then, once.

## The mail send backend

The backend is a small HTTP service **on the box**. It holds the mailbox's send
credential (for Microsoft 365, the `Mail.Send` permission). The owner sets it up
in **Settings → Email → Send approved drafts**:

- **Send service address**: an `http://` or `https://` URL on a loopback host
  (`127.0.0.0/8`, `::1` or `localhost`). It may carry a path. It may not carry
  credentials, a query or a fragment.
- **Auth header name** (default `Authorization`) and **value**. ClawBox sends
  this header on every call. The value is stored in `data/config.json` and is
  never returned to any caller once saved.
- **Show send approval cards in the chat**: off by default.

Only the owner's signed-in browser can read or change this setting
(`/setup-api/email/draft-approval`). A browser the route refuses (401, 403, or
404 on a box without it) is shown no panel at all; any other failed read — a
503, a dropped connection, an answer that is not the setting — is shown as a
failed read with a **Try again** that reads it once more, so the setting is
never silently absent. The **Test connection** button reads a
draft id nobody has, so a healthy backend answers 404 and nothing is touched.
A 200 passes only when it reads as a draft; any other page on that port is
reported as an answer ClawBox could not read.

### Contract

Every request carries the configured auth header. ClawBox does not follow
redirects, waits 10 s at most, and reads at most 1 MiB of each answer. It reads
a body only from a `200` answer to a draft read. Every other status, and every
answer to a send, is decided by the status alone, and the body is discarded
unread. So a 404 with a large or broken body still means "no such draft".

```
GET {endpoint}/drafts/{id}?user={clawbox username}
```

Returns the draft as it is now.

| Status | Meaning |
|---|---|
| 200 | The draft as JSON (shape below) |
| 404 or 410 | No such draft: it was sent or deleted |
| 401 or 403 | The credential was refused |

The draft JSON can take either of two shapes:

```json
{
  "id": "AAMk…",
  "to": ["Ivan Ivanov <ivan@example.com>"],
  "cc": ["ops@example.com"],
  "bcc": [],
  "subject": "Offer for Acme",
  "body": "Hello Ivan, …",
  "bodyType": "text",
  "attachments": [{ "name": "offer.pdf", "size": 20480 }]
}
```

The second shape is a Microsoft Graph `message` passed straight through:
`toRecipients`, `ccRecipients`, `bccRecipients` (each an array of
`{emailAddress: {name, address}}`), `subject`, and
`body: {contentType, content}`. Recipients may also be plain strings or
`{address, name}`. If `id` is present it must equal the id asked for. Any
answer ClawBox cannot read whole — including one nested more than 64 levels
deep, which it cannot hash whole — is refused rather than shown in part. An
HTML body is shown as text, through the same sanitiser the mail viewer uses.

Draft ids are one word of letters, digits and `. _ ~ + / = : @ -`, never only
dots, and are percent-encoded into the path.

`user` is the ClawBox user the card belongs to. A backend must serve each
person's own mailbox: it maps `user` to that person's mailbox and answers 404
for a draft that is not theirs. ClawBox does not check who owns a draft; `user`
is the only thing that keeps one person's drafts from another's. On a box with
one person (the owner) a backend for a single mailbox can ignore `user`. **A
backend for a single shared mailbox is not supported on an organisation box**:
there any member who knows a draft id would read that draft and send it from
the shared mailbox.

```
POST {endpoint}/drafts/{id}/send
Content-Type: application/json

{"user": "<clawbox username>", "draftId": "<id>", "contentHash": "<sha256 hex>"}
```

Sends that draft.

| Status | Meaning |
|---|---|
| 2xx | Sent |
| 404 or 410 | No such draft |
| 409 or 412 | The draft changed and was not sent |
| 401 or 403 | The credential was refused |
| Other 4xx | Refused, not sent |
| 5xx, or no answer | The outcome is unknown |

Between ClawBox's re-read and the backend's send there is a short window in
which the draft can still be edited, and only the backend can close it. **A
conforming backend must never send anything other than the content whose hash
is `contentHash`. If the draft no longer matches, it sends nothing and answers
409 (or 412).** Comparing the hash and then asking the provider to send the
draft by its id is NOT enough. The draft can be edited between that check and
the provider's send, and the provider then sends the edited mail. The check and
the send must be one step. A backend can do that in either of two ways:

- **Send the content it checked.** Read the draft once, recompute
  `contentHash` over that read (see [Canonical JSON](#canonical-json)), refuse
  on a mismatch, and send a message built from that same read: recipients,
  subject, body and attachments. Then delete the draft. An edit after the read
  reaches only the draft, never the mail that leaves. Do not use an operation
  that sends a stored draft by its id: it sends whatever the draft holds at
  that moment.
- **Hold the draft still.** If every change to the draft goes through the
  backend, take a lock per draft that edits also take. Hold it from the read
  through the provider's answer to the send.

Neither way relies on the provider refusing a changed draft. Use a provider's
conditional send only where the provider documents one for that exact send
operation. Microsoft Graph's `message: send` documents none: it takes no
request body and no precondition header. A backend that does neither of the
above does not meet this contract: the approval then covers the draft only up
to ClawBox's re-read.

Include attachment contents or a digest in the draft JSON if attachment swaps
should be caught. A Graph backend can use `$expand=attachments`.

### Canonical JSON

A backend that recomputes `contentHash` must produce the same bytes as
ClawBox, or a valid Send is refused as changed. ClawBox computes:

```
contentHash = lowercase hex of SHA-256( UTF-8 bytes of
                "clawbox-mail-draft/v2" + "\n" + canonical(answer) )
```

`answer` is the JSON value parsed from the body of the backend's `200` answer
to `GET {endpoint}/drafts/{id}`, decoded as UTF-8. It is the whole answer, not
the fields ClawBox shows. `canonical` writes it as follows:

- **No whitespace** anywhere outside strings.
- **Objects**: `{`, the members joined by `,`, then `}`. Each member is the key
  written as a string, then `:`, then the value. Members are ordered by key,
  comparing the keys as sequences of **UTF-16 code units**, not code points or
  UTF-8 bytes. So `"😀"` (U+D83D U+DE00) sorts before `"ｚ"` (U+FF5A). A key that
  appears twice in the answer keeps its last value.
- **Arrays**: `[`, the elements in their original order joined by `,`, then `]`.
- **`true`, `false`, `null`** as those literals.
- **Strings**: in double quotes. `"` is written `\"` and `\` is written `\\`.
  Backspace, form feed, newline, carriage return and tab are written `\b`, `\f`,
  `\n`, `\r`, `\t`. Any other character below U+0020, and a lone surrogate
  (U+D800–U+DFFF not part of a pair), is written `\u` plus four **lowercase**
  hex digits. Every other character is written as itself, in UTF-8. That
  includes `/`, U+007F, U+2028, U+2029 and everything beyond ASCII. No other
  escapes are used.
- **Numbers**: parsed as IEEE 754 doubles, then written the way ECMAScript's
  `Number.prototype.toString()` writes them. That means the shortest digits
  that read back as the same double, and `-0` written `0`. An exponent is used
  only when the absolute value is below 1e-6 or at least 1e21: `1e+21`,
  `-1e+21`, `5e-7`. So `1.0` → `1`, `1E2` → `100`, and
  `123456789012345678901` → `123456789012345680000`: the shortest digits
  padded with zeros, not the double's exact integer value.
- A number outside the double range (such as `1e400`, which would parse to
  infinity) has no canonical form. ClawBox refuses an answer that contains one
  as an answer it could not read, so there is never a hash for it.
- Nesting deeper than 64 levels is refused, never hashed.

For an answer with no duplicate keys and no lone surrogates, this is the JSON
Canonicalization Scheme of [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785),
so a JCS library gives the same text. ClawBox's own code is `canonicalJson` and
`draftContentHash` in `src/lib/mail-draft-backend.ts`.

Test vectors. The input is the answer's body as sent. The canonical text and
the hash must match exactly:

| Input | Canonical text | `contentHash` |
|---|---|---|
| `{"to":["ivan@example.com"],"subject":"Hello","id":"d1","cc":[],"bcc":[],"body":"Body","bodyType":"text","attachments":[]}` | `{"attachments":[],"bcc":[],"body":"Body","bodyType":"text","cc":[],"id":"d1","subject":"Hello","to":["ivan@example.com"]}` | `486400710f35e162a632768352574713f1ddde9f9872280dc83c946b76c8d7d5` |
| `{"subject":"Re: \"Q3\" \\ plan / café 😀","body":"line 1\nline 2\ttab\u0001","to":["ivan@example.com"]}` | `{"body":"line 1\nline 2\ttab\u0001","subject":"Re: \"Q3\" \\ plan / café 😀","to":["ivan@example.com"]}` | `61f59bb40ebbfbf4f9d5f61f7c130e92a6534f027db18e8bf33076e9ea335d57` |
| `{"z":1.0,"size":1E2,"n":-0,"big":1e21,"small":5e-7,"f":0.1,"long":123456789012345678901,"ｚ":true,"😀":null,"a":[],"o":{}}` | `{"a":[],"big":1e+21,"f":0.1,"long":123456789012345680000,"n":0,"o":{},"size":100,"small":5e-7,"z":1,"😀":null,"ｚ":true}` | `c219ce8bf52c06209d18b41d139ef8ae426dc0f2b19bd42c0727ad0d192f813c` |

In the table, `\"`, `\\`, `\n`, `\t` and `\u0001` are the JSON escapes
themselves, exactly as they appear in the bytes. They do not stand for the
characters. `src/tests/unit/mail-draft-backend.test.ts` checks these vectors
against ClawBox's code.

## Who can do what

| Caller | Settings route | `status` | `card` | `decide` |
|---|---|---|---|---|
| The owner's browser | ✓ | ✓ | ✓ (own cards) | ✓ (own cards) |
| A member of staff's browser (org mode) | ✗ | ✗ | ✓ (own cards) | ✓ (own cards) |
| The assistant (MCP bearer) | ✗ | ✓ (on/off and draft found/missing only) | ✗ | ✗ |
| Another site's page, with the person's cookie | ✗ (writes) | n/a | ✗ | ✗ |

No MCP tool names the `card` or `decide` routes.
`src/tests/unit/mcp-email-draft-card-tool.test.ts` fails if one ever does.

## Members of staff

On an organisation box each card is bound to the member who opened it. The
backend is asked about, and sends from, that member's mailbox
(`user=<their username>`). The owner cannot send a member's card, and a member
cannot send the owner's. This relies on a backend that keeps one mailbox per
person, so a backend for a single shared mailbox is not supported here (see
`user` in the contract).

Two limits apply to members of staff today:

- Their assistants have no ClawBox MCP tools (`config/org-staff-policy.json`
  denies `clawbox__*`), so they cannot call `email_draft_card`.
- The staff MCP relay (`staffToolAllowed` in `src/lib/staff-mcp.ts`) offers no
  tool whose name contains a write verb (`create`, `update`, `send`, …), so a
  granted mail server's draft tools are not offered to them — unless the owner
  ticks "tools that create or edit" (`writeTools`) for that server. With the
  tick, tools whose names carry only a create or edit verb (`create`, `update`,
  `edit`, `compose`, …) are offered, so a draft-writing tool such as
  `create_draft` can be. Names with `send`, `delete` or any other write verb
  stay refused, as do names with a who-may-do-what noun (`member`,
  `permission`, …) and tools the server marks `destructiveHint: true`. The
  relay judges a tool by its name and annotations; it does not know what a tool
  does beyond them.

Letting a member's assistant prepare drafts and show their cards needs the
first limit widened, and the tick for the second. That is an owner policy
decision, and this change does not make it.

## What this does not cover

An assistant that may run shell commands as the box's user can read
`data/config.json` and the session secret, like any other process of that user.
This is the same boundary every other approval on the box has. Run the send
backend under an OS user of its own, and keep the assistant's shell behind the
operator approvals, and the boundary holds.
