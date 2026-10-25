# First-run Spotify configuration for the npm CLI

**Status:** Approved by the user, including the stable library storage and sync diagnostics amendment.

## Intent and outcome

Make the published `spotify-library-manager` CLI usable without asking npm to write files during install. On first interactive run, guide the user through the Spotify credentials needed to start the local app, then store them privately in the existing user config directory.

## Current behavior

- `package.json` exposes the `spotify-library-manager` binary and requires Node.js 24+.
- `src/http/server.ts` loads `.env` from the current working directory before starting.
- `src/config.ts` requires `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REDIRECT_URI`; `PORT` defaults to `3000`, and `RESULTS_DIR` defaults to `results`.
- `FileTokenStore` already stores refresh tokens in `~/.config/liked-list/tokens.json` and enforces private permissions.
- The package includes `.env.example`; source users currently copy it to `.env`.

## Approaches considered

1. **Create a file from npm `postinstall`: rejected.** It writes into a user's home directory during dependency installation, including non-interactive/CI installs, and npm may suppress lifecycle scripts.
2. **Generate a template on first run:** avoids install side effects and is simple, but still makes users manually edit credentials.
3. **Prompt on first interactive run: selected by the user.** It avoids install side effects and guides users through setup; it needs safe secret input and persistence.

## Proposed behavior

- On normal CLI invocation, load values from the process environment, the existing current-directory `.env`, and `~/.config/liked-list/config.json`, with precedence: process environment > current-directory `.env` > user config.
- If required values are still missing and stdin is interactive, show Spotify Developer Dashboard instructions and prompt for missing values. Do not prompt if the effective configuration is already valid.
- Prompt for Client ID and Client Secret (secret input masked). Use defaults where meaningful: `PORT=3000`, `SPOTIFY_REDIRECT_URI=http://127.0.0.1:<PORT>/callback`, and, in the storage amendment below, the stable per-user application directory for `RESULTS_DIR`. Guide the user to register the exact redirect URI in the Spotify app settings.
- After all values validate, write JSON to `~/.config/liked-list/config.json`, creating the directory with mode `0700` and the file with mode `0600`; write atomically. Use the `AppConfig` field names (`clientId`, `clientSecret`, `redirectUri`, `port`, `resultsDir`) plus `schemaVersion: 1`. Because JSON has no comments, show setup guidance in the prompt and README. Do not print or log the secret. Then continue starting the server. On cancellation, do not write a partial file.
- If configuration is missing in a non-interactive run, exit with a concise message explaining how to run interactively or set environment variables; never hang waiting for input.
- Preserve source-run `.env` support, explicit `RESULTS_DIR` overrides, and the existing refresh-token location. Do not add an npm install lifecycle script or change token migration semantics.
- Update README with separate source-run and npm-install/run instructions, including Node 24+, generated config path and JSON fields, prompt behavior, and the Spotify dashboard links.

## Stable library storage and sync diagnostics (amendment draft)

**Intent:** Keep a successful library sync available when the CLI starts from a different working directory, and make Spotify API failures diagnosable without exposing credentials.

**Current behavior:** `RESULTS_DIR` defaults to `results`, resolved relative to the current working directory. `LibraryService.sync()` writes the analyzed `library.json` snapshot, `library.toon`, offline `index.html`, and operation manifests under that directory only after the Spotify requests and artifact generation succeed. This explains why changing directories can appear to lose the cache and why a failed initial sync leaves no snapshot.

**Approaches considered:**

1. **One stable app directory under `~/.config/liked-list/` (selected by the user).** Store `config.json`, `tokens.json`, `library.json`, `library.toon`, `index.html`, and operation manifests there by default. This follows the user's one-place preference and fixes cwd-dependent caching, though the directory contains both settings/secrets and local library data.
2. **Separate XDG settings and data directories:** keep config/tokens under `~/.config/liked-list/`, put library files under `~/.local/share/liked-list/`. This better separates settings from user data, but conflicts with the user's one-place preference.
3. **Persist only JSON and regenerate artifacts on demand:** reduces duplicate derived files, but adds lifecycle behavior beyond the cwd-independent cache fix. The selected design continues generating `.toon` and offline HTML after successful sync; regeneration from the saved report is a possible later feature.

**Selected behavior:**

- When there is no explicit `RESULTS_DIR` value, default it to the absolute `~/.config/liked-list/` directory, independent of `process.cwd()`. Use that same default in first-run prompts and generated config. Keep explicit environment or user-config `RESULTS_DIR` values honored.
- Do not automatically move, copy, or delete files from old `results/` directories. Preserve configured locations; new/default configuration uses the stable app directory. The app config/token files and library/artifact files share the existing private directory.
- Keep `library.json` as the persisted snapshot read by the dashboard; continue writing `library.toon`, offline `index.html`, and operation manifests in the same selected results directory on successful sync. Do not add automatic HTML regeneration on startup in this change.
- When a Spotify Web API request returns non-2xx or fails before receiving a response, log only the HTTP method, request path, and either status code or a no-response indicator to the server terminal. Never log request headers, tokens, response bodies, client credentials, or library contents. Keep the dashboard's generic error message.

## Spotify instructions

The first-run guide will link to the [Spotify Developer Dashboard app setup](https://developer.spotify.com/documentation/web-api/concepts/apps) for Client ID and Client Secret and [Redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri). The default callback is a loopback URI and must be registered in the app settings.

## Verification

Add focused tests for config-source precedence, prompt defaults and secret masking, secure file permissions, atomic/complete writes, cancellation, existing config, non-interactive missing-config behavior, cwd-independent default `RESULTS_DIR`, explicit override preservation, and non-sensitive Spotify failure logging. Run `npm run check`, `npm test`, `npm run build`, and `npm run package:smoke`.

## Open implementation choices

- This design assumes the first-run wizard starts the server automatically after saving config; users can rerun the app to change values by editing `config.json` manually. A separate `setup` subcommand is out of scope unless requested.
- Use existing dependencies and Node built-ins; do not add a prompt dependency unless implementation proves a safe hidden-secret prompt cannot be done cleanly with the platform APIs.
