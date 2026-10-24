# Public npm App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Implement tasks in order; keep the working directory and package slug aligned with the approved spec.

**Goal:** Publish `@twkrash/spotify-library-manager` as an `npx`-runnable local Spotify library manager and prepare the source repository for public collaboration.

**Architecture:** Keep the existing TypeScript/Fastify application. Expose the compiled server as the npm executable, resolve static dashboard assets from the installed package, and leave `.env`, results, and token storage in their existing user locations. Build a package allowlist and verify the tarball before publishing through a tag-triggered OIDC workflow.

**Tech Stack:** Node.js 24+, TypeScript, npm, Fastify, GitHub Actions, npm trusted publishing (OIDC).

**Spec:** `docs/superpowers/specs/2026-10-24-public-npm-app-design.md`

## Global Constraints

- Package and directory slug: `spotify-library-manager`; npm name: `@twkrash/spotify-library-manager`.
- Preserve Node `>=24`, package version `0.1.0`, existing dependencies, and `~/.config/liked-list/tokens.json` for compatibility.
- Never read, copy, publish, or delete the existing local `.env`; allowlist package contents and inspect the packed artifact to prove it is excluded.
- Preserve local caches, virtual environments, results, and tokens; remove only Python project sources/tests/manifests.
- Do not run local `git`, `gh`, or GitHub MCP; do not commit, publish, create a release, or change remote repository settings.
- Configure npm trusted publishing with npm CLI `11.19.1`, least-privilege `id-token: write`, public access, and no long-lived npm token.
- Branch protection is documented for later setup only; target the actual default branch after a remote repository exists.

## Review Focus

- `.env`, token files, and results must never enter the npm tarball: release validation checks packed file paths.
- CLI must work when launched from a working directory outside the source tree: package smoke test launches it there and requests `/` and `/dashboard.js`.
- Dashboard static files must resolve from the installed package; `.env` and results must still resolve from the caller's working directory.
- Changing project/package name must not move or invalidate existing token storage: preserve `~/.config/liked-list/tokens.json`.
- Release workflow must not use token-based npm authentication: inspect permissions, environment, trusted publishing, and publish command.

---

### Task 1: Remove the Python fallback

**Files:**
- Delete: `main.py`, `cleanup_duplicates.py`, `cleanup_manifest.py`, `cleanup_plan.py`
- Delete: `pyproject.toml`, `uv.lock`, `.python-version`
- Delete: `tests/test_main.py`, `tests/test_cleanup_duplicates.py`
- Modify: `.gitignore` only to remove stale Python project configuration ignores; retain rules protecting local Python caches/environments

**Interfaces:** No production interfaces change.

- [ ] Remove only the listed Python implementation, tests, and environment manifests. Do not remove `__pycache__`, `.ruff_cache`, `.venv`, or other ignored local data.
- [ ] Verify no active Python implementation, dependency manifest, or Python-specific test remains with a bounded file search; do not inspect local Python cache contents.
- [ ] Run `npm run check` and `npm test`.

### Task 2: Update project and contributor documentation

**Files:**
- Modify: `README.md`
- Add: `AGENTS.md`, `CONTRIBUTING.md`, `CHANGELOG.md`

**Interfaces:** No runtime interfaces change.

- [ ] Rewrite README for the TypeScript-only app and `npx @twkrash/spotify-library-manager`, including local `.env` setup, Node 24 requirement, analytics/duplicate management, safe removal/restore, and independent-project disclaimer.
- [ ] Add concise `AGENTS.md` with project commands, source/test locations, generated assets, Node version, and secret/data handling rules.
- [ ] Add `CONTRIBUTING.md` with setup, checks, package/release process, npm trusted-publisher setup prerequisites, and recommended default-branch protection (PR required, CI status required, force-push/deletion blocked).
- [ ] Add a `0.1.0` changelog entry because the tag-based release workflow validates release notes.

### Task 3: Make the package runnable outside the source checkout

**Files:**
- Modify: `src/http/server.ts`
- Modify: `package.json`, regenerate root metadata in `package-lock.json`
- Add: `scripts/package-smoke.mjs`

**Interfaces:**
- Keep exported `startServer(): Promise<FastifyInstance>` and existing `npm start` behavior.
- Add npm binary `spotify-library-manager` targeting `dist/http/server.js`.

- [ ] Add a Node shebang to the server entrypoint and preserve its existing direct-run error handling.
- [ ] Resolve `dashboard.html` and `public/dashboard.js` relative to the server module URL; pass those explicit package paths to HTTP routes and `FileOfflineHtmlRenderer`. Keep `.env` and `RESULTS_DIR` cwd-relative.
- [ ] Set package name to `@twkrash/spotify-library-manager`; remove `private`; set public publish access, MIT license, accurate description/keywords, `bin`, `files` allowlist, and `prepack` build. Include `dist`, dashboard assets, `.env.example`, README, LICENSE, and CHANGELOG only.
- [ ] Update package-lock root metadata using `npm install --package-lock-only --ignore-scripts`; do not upgrade/add dependencies.
- [ ] Add `scripts/package-smoke.mjs` and `npm run package:smoke`: pack the app, verify tarball paths against the allowlist (including absence of `.env`, results, tests, and Python files), install it into a temporary prefix, launch its binary from a separate temporary working directory with fake OAuth values and an isolated temporary home, request `/` and `/dashboard.js`, then clean only its own temporary files.
- [ ] Run `npm run package:smoke` and verify it fails if package assets or the executable are missing.

### Task 4: Add continuous integration and release publishing

**Files:**
- Add: `.github/workflows/ci.yml`
- Add: `.github/workflows/release.yml`

**Interfaces:** Release tags must exactly match `v${package.json.version}`.

- [ ] Add workflow `CI` with a `validate` job on push and pull request targeting `main`, using Node 24 and npm cache; run `npm ci`, `npm run check`, `npm test`, `npm run build`, and `npm run package:smoke`. The required branch-protection check is `CI / validate`.
- [ ] Adapt the sibling release workflow to tag-qualified package build, exact-version check, changelog extraction, packed-artifact inspection, and versioned GitHub release assets. A `v*` tag will trigger npm publication and GitHub release creation in CI; do not trigger it locally.
- [ ] Publish the qualified tarball from a separate `npm-publish` environment with `contents: read` and `id-token: write`; install npm `11.19.1`, omit `setup-node` `registry-url`, use OIDC trusted publishing, `--access public`, and provenance. Do not add `NPM_TOKEN` or other registry secret.
- [ ] Validate workflow YAML and confirm pull-request CI has no publish permissions while the publish job alone can mint OIDC tokens.

### Task 5: Rename the project folder and verify

**Files:**
- Rename directory: `/home/dvory/code/spotify` → `/home/dvory/code/spotify-library-manager`

- [ ] Confirm destination remains absent, then rename the directory without deleting or altering its contents.
- [ ] From the renamed directory, run `npm run check`, `npm test`, `npm run build`, and the package smoke/content validation.
- [ ] Search source and public docs for stale package/project references; keep the existing token directory name intentionally.
- [ ] Report that external npm trusted-publisher configuration and actual branch protection still require the future repository identity.
