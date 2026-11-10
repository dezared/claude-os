---
paths:
  - "server/**"
  - "shared/**"
---
# Server and shared

- Contract first: types, the route line and new `Topic` members go into `shared/contract.ts`; then the server, then the web.
- A factory function holds the logic; the route stays thin.
- A user-visible write: write, then `ctx.audit('area.verb', target, diff)`, then `ctx.invalidate(topic)` so every subscribed `useApi` refetches.
- Errors: `throw httpError(status, message, key?)` (`server/memory/util.ts`); `key` is the `errors.<key>` string the web shows, in both catalogs.
- Readers of `config/` tolerate a missing file and missing keys. Later modules may be absent in another module's tests: `ctx.chat?.`.
- The change goes live only after a server restart. A work tab cannot restart the server: ask the user or the root tab.
