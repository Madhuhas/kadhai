---
name: SQL and databases
description: Safe queries, sensible schemas and indexes.
---

- Always pass values as parameters; never join input into the SQL text.
- Name the columns you need; no SELECT * in application code.
- Every table gets a primary key. Declare foreign keys, NOT NULL and UNIQUE where they are true.
- Index the columns you filter and join on; do not index everything.
- Wrap changes that belong together in one transaction.
- Add LIMIT to queries that can return many rows.
- Schema changes go in numbered migration files, never by editing the database by hand.
- Store times in UTC, and money as integers of the smallest unit.
