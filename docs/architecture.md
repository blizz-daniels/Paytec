# Paytec Backend Architecture (Refactor Stage 1)

## Migration Map

The previous monolithic `server.js` was reorganized as follows:

- `server.js`
  - Role now: compatibility bootstrap + exports for tests.
  - Starts server only when executed directly.
- `src/app.js`
  - Current application composition root.
  - Contains Express app wiring, middleware setup, DB helpers, schema init, and business logic.
- `src/server.js`
  - Startup-only entrypoint (`startServer()` call).
- `src/routes/messages.routes.js`
  - Message API route registration extracted from monolith.
  - Uses dependency injection from `src/app.js` to keep behavior stable.

## Current Module Boundaries

- `server.js`
  - Re-exports: `app`, `initDatabase`, `db`, `run`, `get`, `all`.
  - Keeps test/import contracts stable.
- `src/app.js`
  - Owns runtime configuration, DB initialization, middleware registration, and service orchestration.
- `src/routes/messages.routes.js`
  - Owns `/api/messages/*` route contracts and handlers.
- `src/server.js`
  - Contains no business logic.

## Dependency Rules

- External callers should import from root `server.js` for backward compatibility.
- Runtime startup should prefer `src/server.js` or `server.js` direct execution.
- `src/app.js` is the internal composition root and should be the source for further extraction into:
  - `src/config/*`
  - `src/db/*`
  - `src/middleware/*`
  - `src/routes/*`
  - `src/services/*`
  - `src/utils/*`

## Next Extraction Plan

1. Move DB helpers and `initDatabase` into `src/db/sqlite.js` and `src/db/initDatabase.js`.
2. Move auth/role/CSRF middleware into `src/middleware/auth.js` and `src/middleware/csrf.js`.
3. Continue moving routes into domain routers in `src/routes/*.routes.js` without changing contracts.
4. Move shared parsers/validators into `src/utils/*` and cross-domain logic into `src/services/*`.

## Compatibility Notes

- Existing route contracts and exported symbols are preserved.
- Existing startup command (`node server.js`) remains valid.
- Existing test import path (`require("../server")`) remains valid.
