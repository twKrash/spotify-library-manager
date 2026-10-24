# LikedList Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Node 24+ TypeScript app that replaces Python as the daily Spotify library sync/cleanup UI while preserving exports and preparing a reusable service boundary for a future MCP adapter.

**Architecture:** Fastify serves the existing dashboard and same-origin API. A framework-independent application service depends on narrow Spotify, snapshot, manifest, token, and TOON ports; concrete adapters use `oauth4webapi`, built-in `fetch`, and filesystem/local CLI facilities. TypeScript domain logic ports the existing Python behavior exactly.

**Tech Stack:** Node >=24, npm, TypeScript, Fastify, `oauth4webapi`, `dotenv`, `unicode-case-folding`, `@toon-format/cli`, `esbuild`, `tsx`, and Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-22-typescript-spotify-library-manager-design.md`

## Global Constraints

- Project/app name: `LikedList`; npm package slug: `liked-list`.
- Node >=24 is the supported runtime; use npm-local dependencies, never global installs.
- Full parity includes saved-library JSON, all current statistics, TOON, and the standalone offline HTML report.
- OAuth is user Authorization Code with the secret held only by the server; Client Credentials is not valid for `/me` routes.
- Mutations use `DELETE`/`PUT /v1/me/library`, maximum 40 Spotify URIs per request; reads use paged `GET /v1/me/tracks` with a maximum page size of 50.
- Cleanup must preserve separate ISRC and normalized-metadata matching keys, transitive grouping, newest `added_at` selection, and fail-closed validation for invalid dates/IDs/mappings/ties/repeated Spotify IDs.
- Persist a validated manifest before any Spotify mutation; persist progress after each successful batch; never report an incomplete operation as complete.
- Bind to `127.0.0.1`; no broad CORS; validate request origin/host for mutation routes.
- Tests use synthetic data and mocked Spotify responses; no live Spotify writes.
- Keep existing Python sources and dependencies untouched as a migration fallback; the TypeScript app must not invoke Python.
- Do not run `git`, `gh`, GitHub MCP, create/publish a remote repository, or push. The user authorized local MIT/open-source preparation only.
- Do not read, print, or copy values from `.env`; add only a placeholder `.env.example` and retain `.env`/`results/` ignores.

## Review Focus

- Missing or malformed OAuth configuration, bad callback state, expired access token, and token refresh failures must fail without logging secrets or issuing Spotify writes.
- Pagination must retrieve every saved-track page while rejecting malformed page shapes and preserving `added_at`.
- Duplicate chains must join on either independent key, sort artists for metadata identity, exclude unknown metadata, and reject an ambiguous newest date or repeated Spotify IDs.
- A partial delete/restore failure must leave a readable manifest showing only successful batches; atomic manifest-write failure must stop later Spotify calls.
- Offline HTML must remain a standalone read-only artifact and must safely embed track strings containing `</script>` or other HTML-significant characters.

---

### Task 1: Scaffold the Node package and open-source metadata

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.test.json`, `tsconfig.client.json`
- Create: `src/config.ts`, `tests/config.test.ts`
- Create: `.env.example`, `LICENSE`
- Modify: `.gitignore`, `README.md`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig` validates `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `PORT`, and `RESULTS_DIR`, returns validated non-secret runtime settings, and never includes the client secret in error messages.
- Package scripts: `dev`, `build`, `start`, `test`, `check`.

- [ ] **Step 1: Write config tests** for missing client ID/secret, malformed redirect URI, valid local callback, and secret-safe errors.
- [ ] **Step 2: Run the config tests under Node 24 and verify they fail** because config code does not exist.
- [ ] **Step 3: Add the npm package, Node engine floor, TS configs, local dependencies, `.env.example`, MIT license, and ignore rules; implement `loadConfig` minimally.** Set `private: true` to prevent accidental npm publishing while allowing source licensing.
- [ ] **Step 4: Run `npm test` and `npm run check`; verify the Node engine check and no secret value appears in test output.**

### Task 2: Port the library model, statistics, and duplicate detection

**Files:**
- Create: `src/domain/types.ts`, `src/domain/track-identity.ts`, `src/domain/library.ts`
- Create: `tests/domain/track-identity.test.ts`, `tests/domain/library.test.ts`, synthetic fixtures under `tests/fixtures/`
- Reference without modifying: `main.py` functions `song_record`, `find_duplicate_groups`, `fetch_statistics`, and `build_library`.

**Interfaces:**
- `trackIdentity(track: SpotifyTrack): SongRecord`
- `findDuplicateGroups(songs: SongRecord[]): DuplicateGroup[]`
- `buildLibrary(tracks: SpotifyTrack[], statistics: ApiStatistics, now?: Date): LibraryReport`
- `toonExportData(report: LibraryReport, tracks: SpotifyTrack[]): ToonExport`

- [ ] **Step 1: Write failing tests** for ISRC normalization; Spotify-ID then metadata `song_id` fallbacks; independent ISRC/metadata matching; transitive union; casefolded/collapsed text; sorted artist names; unknown metadata exclusion; all library counts/sorting/runtime; all three ranking periods and recent-play summaries.
- [ ] **Step 2: Run only domain tests and verify failures** correspond to missing TypeScript modules.
- [ ] **Step 3: Implement domain types, identity, duplicate grouping, library aggregation/statistics, and TOON export payload** using deterministic injected time and no I/O.
- [ ] **Step 4: Run domain tests and compare fixture JSON/TOON payloads against synthetic Python-output expectations.**

### Task 3: Port cleanup planning and recoverable manifests

**Files:**
- Create: `src/domain/cleanup-plan.ts`, `src/domain/manifest.ts`
- Create: `src/ports/manifest-store.ts`, `src/adapters/file-manifest-store.ts`
- Create: `tests/domain/cleanup-plan.test.ts`, `tests/domain/manifest.test.ts`, `tests/adapters/file-manifest-store.test.ts`
- Reference without modifying: `cleanup_plan.py`, `cleanup_manifest.py`, `cleanup_duplicates.py`.

**Interfaces:**
- `buildCleanupPlan(report: LibraryReport): CleanupPlan`
- `createCleanupManifest(plan: CleanupPlan, now?: Date): CleanupManifestV1`
- `validateManifest(value: unknown): CleanupManifest`
- `ManifestStore.create(manifest): Promise<string>` and `ManifestStore.recordBatch(path, field, ids): Promise<void>`
- `restoreCandidates(manifest: CleanupManifest, savedIds: Set<string>): TrackSummary[]`

- [ ] **Step 1: Write failing tests** for invalid report timestamps, invalid/missing track dates, invalid library/group hierarchy, count mismatch, conflicting records, missing IDs, duplicate group mapping mismatch, repeated Spotify IDs, tied newest dates, largest-first artist ordering, schema-version rejection, overlapping keep/remove IDs, and restore candidate filtering.
- [ ] **Step 2: Run cleanup/manifest tests and verify they fail** before implementation.
- [ ] **Step 3: Implement the planner and strict manifest validator** preserving schema-v1 compatibility and the exact current Python semantics.
- [ ] **Step 4: Implement exclusive manifest creation and atomic replace updates**; use a same-directory temporary file, restrictive permissions, and no-clobber creation.
- [ ] **Step 5: Run the tests, including injected write/rename failures** proving no Spotify mutation can proceed without a durable manifest and only completed batches are recorded.

### Task 4: Add OAuth and Spotify HTTP adapters

**Files:**
- Create: `src/ports/spotify-api.ts`, `src/ports/token-store.ts`
- Create: `src/adapters/spotify-auth.ts`, `src/adapters/file-token-store.ts`, `src/adapters/spotify-http-adapter.ts`
- Create: `tests/adapters/spotify-auth.test.ts`, `tests/adapters/file-token-store.test.ts`, `tests/adapters/spotify-http-adapter.test.ts`

**Interfaces:**
- `SpotifyApiPort.listSavedTracks(): Promise<SpotifyTrack[]>`
- `SpotifyApiPort.getStatistics(): Promise<ApiStatistics>`
- `SpotifyApiPort.removeSavedTrackUris(uris: string[]): Promise<void>`
- `SpotifyApiPort.addSavedTrackUris(uris: string[]): Promise<void>`
- `TokenStore.load()/save()/clear()` stores only validated refresh-token state outside `results/`.

- [ ] **Step 1: Write failing adapter tests** with injected `fetch` for OAuth state mismatch, callback errors, refresh success/failure, token secret redaction, paginated reads, 50-item page limit, current top/recent endpoints, current `PUT`/`DELETE /v1/me/library`, and 40-URI batching.
- [ ] **Step 2: Run adapter tests and verify they fail** before implementation.
- [ ] **Step 3: Implement Authorization Code and refresh flows through `oauth4webapi`**, with random one-time state, exact redirect validation, local token persistence, and no credential output.
- [ ] **Step 4: Implement typed Spotify HTTP calls** using Node `fetch`, validate response shapes, preserve `added_at`, and reject HTTP errors before changing local state.
- [ ] **Step 5: Run adapter tests, including malformed JSON/pages and failed later pagination pages.**

### Task 5: Implement application services and output adapters

**Files:**
- Create: `src/application/library-service.ts`, `src/application/removal-service.ts`
- Create: `src/ports/snapshot-store.ts`, `src/ports/toon-encoder.ts`
- Create: `src/adapters/file-snapshot-store.ts`, `src/adapters/toon-cli.ts`, `src/adapters/offline-html.ts`
- Create: `tests/application/library-service.test.ts`, `tests/application/removal-service.test.ts`, `tests/adapters/outputs.test.ts`

**Interfaces:**
- `LibraryService.sync(): Promise<LibraryReport>` fetches tracks/statistics and writes compatible outputs.
- `RemovalService.previewCleanup(selection): Promise<CleanupPreview>` returns exact keep/remove summaries from the current snapshot.
- `RemovalService.applyCleanup(previewId, confirmation): Promise<OperationResult>` persists the manifest before using the Spotify port.
- `RemovalService.removeOne(trackId, confirmation): Promise<OperationResult>` only accepts an ID in the current snapshot.
- `SnapshotStore.load()/save()` is the single JSON snapshot authority; `ToonEncoder.encode()` uses the local TOON CLI adapter.

- [ ] **Step 1: Write failing service/output tests** for full sync output, stale preview rejection, exact-count confirmation, snapshot ID allow-listing, manual removal, cleanup/restore manifest ordering, partial batch failures, JSON format parity, TOON export payload, and standalone HTML injection safety.
- [ ] **Step 2: Run tests and confirm they fail** because service/adapters do not exist.
- [ ] **Step 3: Implement sync orchestration and file outputs** while preserving JSON hierarchy/statistics, `library.toon`, and standalone offline `results/index.html`.
- [ ] **Step 4: Implement explicit preview/apply/manual-delete/restore orchestration** with typed errors, exact confirmation, 40-ID batches, and durable per-batch progress.
- [ ] **Step 5: Run application/output tests with fake Spotify, filesystem temp directories, and a fake TOON encoder; verify no test can reach live Spotify.**

### Task 6: Serve the interactive dashboard over Fastify

**Files:**
- Create: `src/http/server.ts`, `src/http/routes.ts`, `src/client/dashboard.ts`
- Modify: `dashboard.html`
- Create: `tests/http/routes.test.ts`, `tests/http/security.test.ts`

**Interfaces:**
- Routes: `GET /`, `GET /api/library`, `POST /api/sync`, `POST /api/cleanup/preview`, `POST /api/cleanup/apply`, `POST /api/tracks/:id/remove`, `POST /api/restore/preview`, `POST /api/restore/apply`, `GET /auth/login`, `GET /auth/callback`.
- Fastify routes depend on application services only; browser code receives typed JSON reports/plans and never receives client credentials or refresh tokens.

- [ ] **Step 1: Write route tests** for successful sync, preview, manual delete, bulk apply, restore, malformed bodies, unknown IDs, unapproved/stale plan IDs, unauthenticated writes, and off-origin/invalid-host mutation requests.
- [ ] **Step 2: Run route tests and verify they fail** before adding Fastify handlers.
- [ ] **Step 3: Implement schemas and Fastify routes**, explicitly binding `127.0.0.1`, enforcing same-origin/Host checks, and serving only fixed local assets through explicit routes without broad CORS.
- [ ] **Step 4: Move dashboard behavior into TypeScript**, retain the existing layout/search/expand controls, add explicit Sync/duplicate review/per-track removal/restore confirmation controls, and let the exported offline page render embedded data without mutation controls.
- [ ] **Step 5: Bundle the client TypeScript and run route/security tests plus a local smoke test** with fake ports only.

### Task 7: Finish public-facing docs and verify the migration

**Files:**
- Modify: `README.md`, `.gitignore`, `docs/superpowers/specs/2026-10-22-typescript-spotify-library-manager-design.md`
- Verify: all created TypeScript and test files; do not modify Python files, `pyproject.toml`, `.env`, or generated `results/`.

- [ ] **Step 1: Update README** with the `LikedList` name, Node 24 setup, `.env.example`, callback setup, local-only security, sync/cleanup/manual/restore flows, TOON-for-LLM output, MIT license, and migration note for the retained Python fallback.
- [ ] **Step 2: Run `npm ci`, `npm run check`, and `npm test` under Node 24.**
- [ ] **Step 3: Run a local UI smoke test with fake Spotify responses**, verify JSON/TOON/offline HTML artifacts, and confirm `.env` and `results/` are ignored by project rules without using Git commands.
- [ ] **Step 4: Run LSP diagnostics on changed TypeScript files and obtain an independent read-only code review.** Fix findings, rerun affected tests, and report any remaining risk.

---

## Execution Notes

- Use one writer at a time in the existing workspace; the parent integrates and verifies all work.
- User explicitly prohibited Git/GitHub commands; the plan intentionally contains no commit, push, remote creation, or publish step.
- No public repository creation is authorized by local MIT licensing; a remote owner/name and exact payload require separate approval.
- Ruling: omit `@fastify/static` and serve the fixed dashboard/asset routes directly — npm audit reported high-severity path traversal and authorization-bypass advisories for the compatible package range, while these two fixed assets do not justify retaining a vulnerable dependency; cost if wrong: future static assets will need an explicit safe route or a re-evaluated patched plugin.
- Ruling: use `unicode-case-folding` for metadata normalization — JavaScript lowercasing alone does not match Python's Unicode `casefold()` semantics, and the duplicate matcher must retain that behavior; cost if wrong: the additional runtime dependency is unnecessary if the Unicode implementation differs from the Python reference.
