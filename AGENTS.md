# AGENTS.md

## Project

- This is a local-first TypeScript app for analyzing and managing a Spotify saved library. Node.js 24+ is required.
- Application code is under `src/`; tests are under `tests/`. The server entry point is `src/http/server.ts`.
- Use the existing application/domain/adapter structure. Keep Spotify API, persistence, and presentation concerns separate.

## Commands

- `npm ci` installs locked dependencies.
- `npm run dev` builds the browser bundle and starts the local server.
- `npm run check` type-checks server, tests, and browser code.
- `npm test` runs the test suite.
- `npm run build` builds server and browser assets.
- `npm run package:smoke` validates the published CLI package from a temporary working directory.

## Safety and generated files

- Treat Spotify client secrets, refresh tokens, and library data as sensitive. Never print, commit, or include them in package artifacts.
- Keep `.env`, `results/`, and token storage local. Do not edit generated `dist/` or `public/dashboard.js` by hand; rebuild them from source.
- Preserve the existing token location `~/.config/liked-list/tokens.json` unless a backward-compatible migration is designed.
- Changes to removal, restore, confirmation, or persisted-manifest behavior require focused regression tests.
