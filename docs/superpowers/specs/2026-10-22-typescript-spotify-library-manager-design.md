# TypeScript Spotify Library Manager Design

**Status:** Implementation authorized by the user's direct request to proceed with the discussed requirements and defaults.

## Intent

Build **LikedList**, a local TypeScript application that syncs one Spotify account, shows the existing library dashboard, plans duplicate cleanup, and supports a confirmed manual removal of a saved track without invoking Python. The name is a working local product/repository name inspired by the user's mix of playful and descriptive repository names; check name availability before any public hosting. Keep boundaries reusable so a future Family Assistant MCP adapter can call the same application services. Family Assistant integration and an MCP server are not part of this change.

## Goals

- Run the app with Node 24 or newer and npm; no Python process is required for sync or Spotify writes. Bun is not the default runtime to maximize compatibility with the npm ecosystem.
- Reuse `dashboard.html`'s layout and styling while replacing embedded-only data loading with a same-origin API.
- Preserve full report/output parity: the library JSON shape, saved-track `added_at`, all current statistics (top artists, top tracks, recently played), the TOON export, and the standalone offline HTML. The live dashboard reuses the current layout but calls the local API.
- Support explicit sync, exact duplicate previews, bulk removal of approved older copies, and a per-track removal action in the duplicate UI.
- Preserve recoverability: write operation manifests before Spotify mutation, record successful batches, and keep restore capability.
- Keep Spotify and filesystem details behind narrow TypeScript interfaces/adapters. HTTP routes and any future MCP adapter call the same library-management service.
- Bind to loopback only by default and test using mocked Spotify responses, never live writes.
- Add a standard MIT `LICENSE` and open-source setup documentation; do not create or publish a remote repository without separate explicit approval.

## Non-goals

- Implementing the Family Assistant integration or MCP protocol now.
- Multi-user hosting, LAN access, or cloud deployment.
- A frontend framework or redesign; preserve the current HTML/CSS and use TypeScript for its behavior.
- Removing the existing Python files until the TypeScript app has parity and the user separately approves removal.

## Current project facts

`main.py` owns Spotipy PKCE, paged saved-track reads, statistics, duplicate grouping, and the JSON/TOON/static-HTML exports. `cleanup_plan.py` contains deterministic artifact validation and newest-date planning. `cleanup_duplicates.py` and `cleanup_manifest.py` implement confirmed Spotify writes and recoverable progress. The dashboard is currently a static HTML template with embedded JSON; it cannot call Spotify. The CLI cleanup path also requires a TTY, so it cannot be invoked directly as a web handler.

Spotify's current user-library endpoints are `GET /me/tracks` (up to 50 items per page) and `PUT`/`DELETE /me/library` (up to 40 Spotify URIs per request, with `user-library-modify`). The installed Spotipy 2.26.0 maps its add/remove methods to `/me/library`; the inspected official Spotify TypeScript SDK and `spotify-web-api-node` removal methods still target deprecated `DELETE /me/tracks`. The TypeScript adapter will therefore use typed `fetch` calls for these current endpoints rather than depending on a stale high-level mutation wrapper.

Duplicate matching has two independent keys, joined transitively: a non-empty uppercase ISRC, or a metadata key consisting of casefolded/whitespace-collapsed title, casefolded/whitespace-collapsed album, and the sorted normalized artist names. Metadata matching is disabled for unknown title, album, or artist values. This matching key is distinct from the artifact's `song_id` fallback logic. Cleanup validation requires every occurrence in a duplicate group to map to a unique Spotify track ID; repeated IDs abort because Spotify cannot remove one saved occurrence while preserving another. The port must preserve those rules exactly.

## Approaches considered

1. **Keep Python + Spotipy and add Flask.** Lowest migration cost and reuses all tested Spotify behavior. Rejected for this app because the user wants to run it without invoking Python and wants a TypeScript core for future MCP reuse.
2. **Node 24 + TypeScript + Fastify (chosen).** Port the existing domain behavior once, retain the HTML, and expose a local API. Fastify provides schema-validated routes and TypeScript support; Node 24 also satisfies the current TOON CLI engine requirement. Bun remains a possible runtime later, but Node is the default for npm ecosystem compatibility.
3. **Node + official Spotify TypeScript SDK.** The SDK is typed and supports browser PKCE, but the inspected current-user removal method uses the deprecated endpoint and its default token cache is browser `localStorage`. It is not selected for the server-side mutation/auth boundary.

## Proposed architecture

- `LibraryManagementService`: syncs, builds the duplicate plan, and coordinates bulk/manual removal and restore. It has no Fastify or browser dependencies.
- `SpotifyApiPort` plus `SpotifyHttpAdapter`: typed paginated reads and library mutations using Node's built-in `fetch`; validate request/response shapes at the boundary. Use Spotify URIs for current library mutations and cap each batch at 40.
- `SpotifyAuthService` plus token-store adapter: use `oauth4webapi` for server-side Authorization Code and refresh-token exchanges. Store `SPOTIFY_CLIENT_SECRET` only in the server environment, never in HTML or API responses. Persist the one authorized account's refresh token in a private local config file with restrictive permissions; keep token data outside `results/`.
- `LibrarySnapshotStore` and `OperationManifestStore`: filesystem adapters for `results/library.json`, the existing TOON/offline dashboard outputs, and atomic operation-manifest updates. Preserve the old manifest reader; add a validated schema for manual removals and ensure restore can read both formats.
- `FastifyServer`: same-origin JSON API and static asset serving, explicitly bound to `127.0.0.1`. Validate Host/Origin for mutation routes; do not enable broad CORS.
- `dashboard.ts`: browser behavior compiled to a local static bundle and loaded by the existing HTML. It calls the API; it never receives the client secret or refresh token.
- Future `McpAdapter`: deliberately not implemented now. The service boundary is the intended future seam; no MCP package or speculative plugin registry is added.

## User and mutation flow

1. The user starts the server and clicks Connect. Spotify Authorization Code flow requests the existing dashboard's needed scopes (`user-library-read`, `user-library-modify`, `user-top-read`, `user-read-recently-played`). User consent remains required; Client Credentials is not suitable for `/me` data.
2. Sync fetches all saved-track pages and every existing dashboard statistic (top artists, top tracks, recently played), writes the compatible JSON and TOON artifacts plus a standalone read-only offline HTML report, and displays the report timestamp. This is full current-export parity, not a library-only subset.
3. Duplicate review uses the independent ISRC and normalized metadata keys defined above, including transitive grouping and unknown-value exclusions; keep the uniquely newest `added_at`; fail closed on invalid dates, IDs, mappings, repeated Spotify IDs, or ties. The UI shows exact kept/removed tracks and supports selecting groups/bands for bulk removal.
4. Bulk apply requires an explicit confirmation of the exact count. Manual remove has a separate confirmation naming the exact track. The service accepts only IDs present in the current synced snapshot; the browser cannot submit an arbitrary deletion list.
5. Before each operation's first Spotify write, persist its manifest. Use at most 40 URIs per request and persist each successful batch. After any mutation, mark the snapshot stale and disable further write actions until the user explicitly syncs again; do not silently fetch after approval.
6. Restore remains available through the TypeScript app, previews only items currently missing from the library, requires an exact confirmation, and records progress. Restore cannot reinstate original `added_at` values.

## Runtime and validation

Use Node 24, npm-local dependencies (never global installation), Fastify, `oauth4webapi`, TypeScript, a small TypeScript bundler for the browser script, and the TOON CLI as a local dependency. Unit tests use Node's built-in test runner and mock the Spotify adapter. Add regression fixtures matching the current Python duplicate and manifest behavior. No test or development command performs a live Spotify write.

## Authentication choice

The TypeScript server uses Authorization Code with a server-held client secret and does not include a PKCE fallback. The existing Python implementation remains untouched as a PKCE fallback during the migration. This keeps the TypeScript token refresh server-side and avoids exposing credentials to the browser.

## Risks and calls for review

- Porting duplicate identity, date ordering, reports, and partial-failure behavior risks drift; use parity fixtures from the current Python tests before switching daily use.
- A client secret does not authorize a user. The account owner must complete OAuth consent; tokens remain sensitive local state.
- Localhost is not a complete browser security boundary. Host/Origin checks, same-origin requests, and a non-public bind are required; LAN/remote use needs a separate security design.
- TOON generation now runs as a local npm dependency on Node 24, avoiding the failed global install. The old Python CLI remains untouched during this migration.
- The future Family Assistant repo was not inspected; its framework and secret store may require a different adapter later.
