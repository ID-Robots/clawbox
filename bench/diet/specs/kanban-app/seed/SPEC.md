# kanban-app: product and API specification

A multi-user kanban board. Users authenticate with an API key, own and share
boards, and move cards between columns. Everything below is the contract; where
it says "must", tests will check it exactly.

## 1. Runtime and layout

- Node.js >= 20, Express 4. **No runtime dependencies other than `express`**
  (dev dependencies for tests are fine).
- `src/app.js` must export `createApp(options)` which returns an Express app
  **without** calling `listen`. Options:
  - `dataFile` (string, optional): path of the JSON file holding all state. If
    omitted, state is in memory only.
- `npm start` runs `node src/server.js`, which listens on `process.env.PORT`
  (default `3000`) and uses `process.env.DATA_FILE` (default `./data/kanban.json`,
  creating the directory if missing).
- The browser UI is served at `/` (see section 9). Everything else is under `/api`.

## 2. Conventions

- Request and response bodies are JSON (`Content-Type: application/json`) except
  the CSV export. Unknown request fields are ignored.
- **IDs** are positive integers, assigned per entity type (users, boards, columns,
  cards, comments, activity entries) starting at 1, increasing, and **never
  reused**, also not after deletes or a restart.
- **Timestamps** (`createdAt`, `updatedAt`) are ISO-8601 strings in UTC as produced
  by `new Date().toISOString()`.
- **Dates** (`dueDate`, `dueBefore`) are `YYYY-MM-DD` strings that must be real
  calendar dates (`2026-02-30` is invalid).
- A path id that is not a positive integer, or that does not exist, is `404`.
- Strings that are said to be "trimmed" are stored with leading/trailing
  whitespace removed; length limits apply after trimming.

### 2.1 Errors

Every error response has this body, and nothing else at the top level:

```json
{ "error": { "code": "validation_error", "message": "title is required", "field": "title" } }
```

| status | code               | when                                                        |
|--------|--------------------|-------------------------------------------------------------|
| 400    | `invalid_json`     | the request body is not valid JSON                          |
| 400    | `validation_error` | a field or query parameter is invalid; `field` names it     |
| 401    | `unauthorized`     | missing or unknown API key                                  |
| 403    | `forbidden`        | authenticated, but not allowed (not a member / not owner)   |
| 404    | `not_found`        | unknown route under `/api`, unknown or malformed id         |
| 409    | `conflict`         | duplicate email, member already on board, non-empty column, removing the owner |

`field` is present (a string) only for `validation_error` and is the name of the
offending body field or query parameter exactly as spelled in this spec.
`message` is a human-readable string.

Checks happen in this order: authentication (401), then the target resource
exists (404), then permission (403), then validation (400), then conflicts (409).

### 2.2 Pagination

List endpoints marked *paginated* accept `page` (integer >= 1, default 1) and
`limit` (integer 1..100, default 20). Anything else (e.g. `page=0`, `limit=500`,
`limit=abc`) is `400 validation_error` with `field` `"page"` or `"limit"`.
They respond `200` with:

```json
{ "items": [ ... ], "page": 1, "limit": 20, "total": 57 }
```

`total` is the number of matching items across all pages. A page past the end
returns `items: []`.

## 3. Authentication and users

- Every `/api` endpoint requires the header `X-API-Key: <key>`, **except**
  `GET /api/health` and `POST /api/users`.
- API keys are random strings of at least 32 characters, returned once at
  sign-up. The data file must not contain the raw key; store a SHA-256 hash.
  Keys keep working after a restart.

User object: `{ "id", "name", "email", "createdAt" }` (never includes the key).

| # | method & path | body | success |
|---|---------------|------|---------|
| 1 | `GET /api/health` | - | `200 {"status":"ok"}` |
| 2 | `POST /api/users` | `{ name, email }` | `201 { "user": User, "apiKey": "<key>" }` |
| 3 | `GET /api/me` | - | `200 User` (the caller) |
| 4 | `GET /api/users` | - | `200` paginated list of all users, ordered by id |

Validation for `POST /api/users`: `name` string, trimmed, 1..100 chars; `email`
string, trimmed and lower-cased, must match `^[^@\s]+@[^@\s]+\.[^@\s]+$`.
An email that already exists (case-insensitive) is `409 conflict`.

## 4. Boards and members

Board object:
`{ "id", "name", "ownerId", "memberIds", "createdAt", "updatedAt" }` where
`memberIds` is sorted ascending and always includes the owner.

Only members can see or change anything on a board (including its columns,
cards, comments, activity and export); non-members get `403`. Owner-only
actions are marked; members who are not the owner get `403` for them.

| # | method & path | body | success |
|---|---------------|------|---------|
| 5 | `POST /api/boards` | `{ name }` | `201 Board`; caller is owner and only member; the board starts with three columns `To do`, `Doing`, `Done` (positions 0, 1, 2) |
| 6 | `GET /api/boards` | - | `200` paginated list of boards the caller is a member of, ordered by id |
| 7 | `GET /api/boards/:boardId` | - | `200 Board` plus `"columns": [Column + "cards": [Card...]]`, columns ordered by position, cards ordered by position |
| 8 | `PATCH /api/boards/:boardId` | `{ name }` | `200 Board` (owner only) |
| 9 | `DELETE /api/boards/:boardId` | - | `204` (owner only); deletes its columns, cards, comments and activity |
| 10 | `POST /api/boards/:boardId/members` | `{ userId }` | `200 Board` (owner only); `400` (`field` `userId`) if `userId` is not an integer, `404` if no such user, `409` if already a member |
| 11 | `DELETE /api/boards/:boardId/members/:userId` | - | `204` (owner only); `409` when removing the owner; `404` if that user is not a member. Cards on the board assigned to the removed user become unassigned (`assigneeId: null`) |

Board `name`: string, trimmed, 1..100 chars.

## 5. Columns

Column object: `{ "id", "boardId", "name", "position" }`.

Column positions on a board are always `0..n-1` with no gaps or duplicates.

| # | method & path | body | success |
|---|---------------|------|---------|
| 12 | `POST /api/boards/:boardId/columns` | `{ name, position? }` | `201 Column` |
| 13 | `PATCH /api/columns/:columnId` | `{ name?, position? }` | `200 Column` |
| 14 | `DELETE /api/columns/:columnId` | - | `204`; `409` if the column still has cards |

Column `name`: string, trimmed, 1..50 chars. `position`: integer >= 0; when
creating it defaults to the end; a value past the end means "at the end". Other
columns shift to keep positions contiguous (insert, move and delete alike).

## 6. Cards

Card object:

```json
{ "id": 7, "boardId": 1, "columnId": 2, "title": "Write docs", "description": "",
  "labels": ["docs"], "dueDate": "2026-11-01", "assigneeId": 3, "position": 0,
  "createdBy": 1, "createdAt": "...", "updatedAt": "..." }
```

Field rules (create and update):

- `title`: string, trimmed, 1..200 chars. Required on create.
- `description`: string, max 5000 chars, default `""`.
- `labels`: array of strings, default `[]`. Each label is trimmed and
  lower-cased, must be 1..30 chars; duplicates (after normalising) are dropped
  keeping the first occurrence; at most 10 labels after de-duplication.
- `dueDate`: `YYYY-MM-DD` calendar date or `null`, default `null`.
- `assigneeId`: id of a **member of the board**, or `null`, default `null`.
  Anything else is `400` with `field` `assigneeId`.

Card positions within a column are always `0..n-1`, contiguous.

| # | method & path | body | success |
|---|---------------|------|---------|
| 15 | `POST /api/columns/:columnId/cards` | `{ title, description?, labels?, dueDate?, assigneeId?, position? }` | `201 Card`; `position` as for columns (default end, past the end = end), later cards shift down |
| 16 | `GET /api/cards/:cardId` | - | `200 Card` |
| 17 | `PATCH /api/cards/:cardId` | any of `title, description, labels, dueDate, assigneeId` | `200 Card`; `updatedAt` changes. Sending `columnId` or `position` is `400` with that `field` (use the move endpoint) |
| 18 | `DELETE /api/cards/:cardId` | - | `204`; deletes its comments; later cards in the column shift up |
| 19 | `POST /api/cards/:cardId/move` | `{ columnId, position? }` | `200 Card` |

**Move** (`19`): `columnId` (required integer) must be a column of the **same
board**, otherwise `400` with `field` `columnId`. `position` is an integer >= 0
(else `400`, `field` `position`), default: end of the target column; past the
end means the end. The card is removed from its column (closing the gap) and
inserted into the target at that index (opening a gap). Moving within the same
column works the same way: in `[A, B, C]`, moving `A` to position 2 gives
`[B, C, A]`; moving `C` to position 0 gives `[C, A, B]`.

### 6.1 Search and filter

| # | method & path | success |
|---|---------------|---------|
| 20 | `GET /api/boards/:boardId/cards` | `200` paginated cards of the board |

Query parameters, all optional and combined with AND:

- `q`: case-insensitive substring of `title` or `description`.
- `label`: the card has this label (compared after trimming and lower-casing).
- `assigneeId`: an integer user id, or the literal `none` for unassigned cards;
  anything else is `400` (`field` `assigneeId`).
- `dueBefore`: `YYYY-MM-DD`; cards with a `dueDate` **on or before** this date
  (cards without a due date never match); invalid date is `400` (`field` `dueBefore`).
- `columnId`: only cards in that column (integer; otherwise `400`, `field` `columnId`).

Results are ordered by column position, then card position.

## 7. Comments

Comment object: `{ "id", "cardId", "authorId", "body", "createdAt" }`.
`body`: string, trimmed, 1..2000 chars.

| # | method & path | body | success |
|---|---------------|------|---------|
| 21 | `POST /api/cards/:cardId/comments` | `{ body }` | `201 Comment` |
| 22 | `GET /api/cards/:cardId/comments` | - | `200` paginated, oldest first |
| 23 | `DELETE /api/comments/:commentId` | - | `204`; only the comment's author (others: `403`) |

## 8. Activity log and export

Every successful change on a board appends an activity entry:
`{ "id", "boardId", "actorId", "type", "cardId", "data", "createdAt" }`.
`cardId` is the card's id for `card.*` and `comment.*` entries and `null`
otherwise. `type` and `data`:

| type | data |
|------|------|
| `board.created` | `{ "name" }` |
| `board.updated` | `{ "name" }` |
| `member.added` | `{ "userId" }` |
| `member.removed` | `{ "userId" }` |
| `column.created` | `{ "columnId", "name" }` |
| `column.updated` | `{ "columnId" }` |
| `column.deleted` | `{ "columnId" }` |
| `card.created` | `{ "title", "columnId" }` |
| `card.updated` | `{ "fields": [...] }`: names of the fields present in the request, sorted |
| `card.moved` | `{ "fromColumnId", "toColumnId", "fromPosition", "toPosition" }` (`toPosition` is the final position) |
| `card.deleted` | `{ "title" }` |
| `comment.created` | `{ "commentId" }` |
| `comment.deleted` | `{ "commentId" }` |

The three default columns of a new board do not produce `column.created` entries.

| # | method & path | success |
|---|---------------|---------|
| 24 | `GET /api/boards/:boardId/activity` | `200` paginated, newest first (by id descending) |
| 25 | `GET /api/boards/:boardId/export.csv` | `200`, `Content-Type: text/csv`, `Content-Disposition: attachment; filename="board-<id>.csv"` |

CSV export: RFC 4180 (fields containing `,` `"` CR or LF are quoted, quotes
doubled), lines end with `\r\n`. Header line exactly:

```
id,column,title,description,labels,dueDate,assignee,position
```

One row per card, ordered by column position then card position: `column` is
the column name, `labels` joined with `;`, `dueDate` empty when null, `assignee`
is the assignee's user **name** (empty when unassigned).

## 9. Persistence

With `dataFile` set, `createApp` loads state from the file if it exists, and
every successful change is written **before the response is sent**, atomically:
write a temporary file in the same directory and rename it over the data file.
No other files may be left in that directory. A new `createApp({ dataFile })`
on the same file sees all users (their API keys still work), boards, columns,
cards, comments, activity, and continues the id sequences.

## 10. Browser UI

`GET /` serves an HTML page (static files from `public/` are fine) that loads a
JavaScript file from the same server. No framework is required. With an API key
pasted into the page (kept in `localStorage`), it must:

- list the caller's boards and open one,
- show the board's columns with their cards in order,
- create a card in a column,
- move a card to another column (buttons, a select, or drag and drop).

Errors from the API are shown to the user, not swallowed.
