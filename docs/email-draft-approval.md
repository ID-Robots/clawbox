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

The line carries an id and nothing else. A reply that names a draft the person
cannot see gets a card saying the draft is not in their mailbox.

## The approval token

`src/lib/mail-draft-approval.ts` issues the token. It is bound to:

- the signed-in user the card was made for (the owner or a member of staff);
- the draft id;
- a SHA-256 hash of the draft's content as the backend returned it. The hash
  covers the recipients (To, Cc, Bcc), the subject, the body and its type, and
  the attachment names and sizes;
- an expiry: 30 minutes, or `CLAWBOX_MAIL_DRAFT_TOKEN_TTL_S` seconds (10 s to
  24 h).

The token is HMAC-SHA256 signed. The key is derived from the session-signing
secret under a label of its own, so a token is never a valid session cookie and
a cookie is never a valid token. Every card is recorded in
`data/mail-draft-approvals.json` (mode 0600, written by atomic rename), which is
what makes a token one-time.

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
| The token has not expired | 410 `expired` |
| Send only: the draft re-read from the backend still has the approved hash | 409 `changed` |

Only then does the server call the backend's send endpoint. A Send claims the
card **before** the re-read, so two presses or two tabs cannot both send it. If
the backend could not be reached before sending, the card is reopened. If the
backend's answer to the send was lost (a timeout or a 5xx), the card is closed
as failed and the person is told to check the Sent folder. ClawBox never
reports that outcome as "not sent".

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
(`/setup-api/email/draft-approval`). The **Test connection** button reads a
draft id nobody has, so a healthy backend answers 404 and nothing is touched.

### Contract

Every request carries the configured auth header. ClawBox does not follow
redirects, waits 10 s at most, and reads at most 1 MiB of each answer.

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
answer ClawBox cannot read whole is refused rather than shown in part. An HTML
body is shown as text, through the same sanitiser the mail viewer uses.

`user` is the ClawBox user the card belongs to. A backend that serves one
mailbox per person maps it to that person's mailbox. A backend for a single
mailbox can ignore it.

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

Between ClawBox's re-read and the backend's send there is a short window. A
backend that can should close it: re-read the draft right before sending, or
send with the mail provider's own concurrency check (for Graph, the message's
`changeKey`). It answers 409 if the draft no longer matches.

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
cannot send the owner's.

Two limits apply to members of staff today:

- Their assistants have no ClawBox MCP tools (`config/org-staff-policy.json`
  denies `clawbox__*`), so they cannot call `email_draft_card`.
- The staff MCP relay offers no tool whose name contains a write verb (`create`,
  `update`, `send`, …; `src/lib/staff-mcp.ts`), so a granted mail server's
  draft tools are not offered to them.

Letting a member's assistant prepare drafts needs both widened. That is an owner
policy decision, and this change does not make it.

## What this does not cover

An assistant that may run shell commands as the box's user can read
`data/config.json` and the session secret, like any other process of that user.
This is the same boundary every other approval on the box has. Run the send
backend under an OS user of its own, and keep the assistant's shell behind the
operator approvals, and the boundary holds.
