---
name: lead-finder
description: "Find N leads / businesses / clinics / shops in <city>" — build a sourced lead list (name, phone, site, public email) and send it as a spreadsheet.
---

# Lead finder

1. Fix the brief: what kind of business, where, how many (default 10), which fields. Default fields: name, address,
   phone, website, public email, source URL. Ask nothing more unless the type or place is missing.
2. Search with `web_search` in the local language and in English (e.g. "пекарна Варна" and
   "bakery Varna"). Prefer the business's own site and public directories; open pages with `web_fetch`
   or `browser` to read contact details.
3. One row per business. Deduplicate by website domain and phone. Every row carries the URL where each detail
   was found. Leave a field empty rather than guess; never invent an email.
4. Only public business contact data. No bulk scraping of a site against its terms, no personal data of private
   persons.
5. Write `leads-<topic>-<date>.csv` (UTF-8, header row) in the workspace; also `.xlsx` if python `openpyxl` is
   available. Attach the file with `message` and reply with: count found, how many have email, one line on gaps.
6. Done = the file is attached and the row count in the reply matches the file.
