# Inventory API: spec

The test suite in test/ describes the finished API and fails today. Make every test pass
without editing the tests. Keep the code split into modules under src/ (routes, store,
middleware, csv); no new dependencies.

1. Items CRUD: GET /items/:id, POST /items, PATCH /items/:id, DELETE /items/:id.
   An item is { id, sku, name, price, stock }. sku unique (409 on clash), name non-empty,
   price >= 0 number, stock integer >= 0. Errors are JSON { error: "<message>" }.
2. Listing: GET /items?q=&page=&limit=&sort= returns { items, total, page, limit }.
   q matches name or sku case-insensitively; limit default 10, max 50; sort is a field,
   "-" prefix for descending; unknown sort field = 400.
3. Auth: every write (POST/PATCH/DELETE) needs header x-api-key equal to one of the
   comma-separated keys in createApp({ apiKeys }). 401 without, reads stay open.
4. Persistence: createApp({ dataFile }) loads items from that JSON file if it exists and
   writes the file after each change (atomic: write a temp file, then rename).
5. CSV: GET /items.csv returns text/csv, header "id,sku,name,price,stock", RFC 4180 quoting.
6. Stock: POST /items/:id/stock { delta, reason } changes stock (integer delta, result must
   stay >= 0 else 409); GET /items/:id/history lists movements, oldest first,
   each { delta, reason, stockAfter, at }.
