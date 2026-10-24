# Public npm App Design

## Intent

Publish the local-first Spotify library analysis and management app as `@twkrash/spotify-library-manager`, runnable through `npx`, and prepare the source for a public GitHub repository. Rename the project directory from `spotify` to `spotify-library-manager`.

## Goals

- Keep the TypeScript Node.js 24+ implementation as the only supported app.
- Make the npm tarball installable and runnable from a user's working directory, with dashboard assets resolved from the installed package and user data/config resolved from the user's working directory as today.
- Exclude local credentials, test files, Python artifacts, and generated user data from the npm tarball.
- Add concise project instructions, contribution guidance, CI and tag-based trusted-publishing workflow.
- Recommend branch protections for setup when the remote repository exists.

## Non-goals

- Creating or changing a GitHub repository, applying remote branch protections, publishing to npm, or creating releases in this task.
- Deleting local `.env`, `.venv`, Python caches, results, tokens, or other ignored/user data.
- Changing Spotify API behavior, permission scope, persisted data formats, or token storage location.
- Making the app an importable JavaScript library.

## Approaches

1. **Keep Python fallback and support two implementations:** rejected; the user chose removal and the Python path is redundant with the supported TypeScript app.
2. **Publish only the source package:** rejected; it has no runnable npm entry point and the server currently resolves HTML/JS assets from `process.cwd()`.
3. **Publish a scoped runnable CLI:** selected. Add a `spotify-library-manager` executable pointing to the compiled server, build before packing, resolve packaged dashboard assets relative to the module, and keep `.env`/results relative to the user's working directory.

## Design decisions

- Package and folder name: `@twkrash/spotify-library-manager` and `spotify-library-manager`.
- Keep Node `>=24`, current version `0.1.0`, existing runtime dependencies, and existing `~/.config/liked-list/tokens.json` location for backward compatibility.
- Remove the Python sources/tests, `pyproject.toml`, `uv.lock`, `.python-version`, and Python-only `.gitignore` rules. Preserve local ignored caches and environments.
- Use a package `files` allowlist for compiled `dist`, dashboard HTML/JS assets, README, license, changelog, and `.env.example`; never include `.env`, `results/`, tests, source fixtures, or Python remnants.
- Add a Node CLI entry with a shebang; `npm pack` runs the existing build so `dist/` and `public/dashboard.js` are present. The server uses package-relative paths for dashboard assets and retains cwd-relative `.env` and results paths.
- Update README and package metadata for the TypeScript-only product; add `AGENTS.md`, `CONTRIBUTING.md`, and an initial changelog entry. Include an independent-project/non-affiliation notice for Spotify branding.
- CI runs on pushes and pull requests targeting `main`, using Node 24, `npm ci`, `npm run check`, `npm test`, `npm run build`, and package-content validation.
- Adapt `../pi-session-inspector/.github/workflows/release.yml`: version-matching `v*` tags, qualification/build/pack checks, inspected artifact, npm trusted publishing via OIDC with `id-token: write` and public access, and GitHub release assets. Do not configure `setup-node` with `registry-url` in the trusted-publish job. Use npm CLI 11.19.1, as the sibling workflow does.
- Document that npm trusted-publisher identity/environment and GitHub branch protection must be configured later against the actual remote repository. Recommend PRs and required CI on the default branch; block force pushes and deletion. Do not perform those remote changes here.
- Rename the local project directory only after implementation and verification, preserving its contents including local `.env` and caches.

## Constraints and risks

- A local `.env` currently exists. Its contents must not be read or copied; package allowlisting and tarball inspection must prove it is excluded.
- The repository identity is not yet available, so trusted-publisher configuration and branch protection cannot be completed locally.
- No local `git`, `gh`, or GitHub MCP operations; no commits, remote writes, npm publish, or release creation.
- User-facing validation must confirm the packed CLI starts outside the source checkout and serves the bundled dashboard without exposing secrets.
