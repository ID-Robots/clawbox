# kanban-app

A small multi-user kanban board: a JSON API under `/api` and a plain HTML/JS
browser UI at `/`. No database: state lives in one JSON file.

- `npm install`, then `npm start` (serves on `$PORT`, default 3000)
- `npm test` runs the test suite (node:test + supertest)

The product and API contract is in [SPEC.md](SPEC.md). It is the source of truth.
