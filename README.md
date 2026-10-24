<div align="center">

# Spotify Library Manager

**Analyze and safely manage your Spotify saved library, locally.**

A local-first Spotify Web API app for library statistics, listening activity,
duplicate cleanup, restore, and compact TOON exports.

[![npm version](https://img.shields.io/npm/v/@twkrash/spotify-library-manager)](https://www.npmjs.com/package/@twkrash/spotify-library-manager)
[![CI](https://github.com/twKrash/spotify-library-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/twKrash/spotify-library-manager/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/twKrash/spotify-library-manager)](https://github.com/twKrash/spotify-library-manager/releases/latest)
[![license: MIT](https://img.shields.io/github/license/twKrash/spotify-library-manager)](https://github.com/twKrash/spotify-library-manager/blob/main/LICENSE)
[![node: >=24](https://img.shields.io/node/v/@twkrash/spotify-library-manager)](https://www.npmjs.com/package/@twkrash/spotify-library-manager)

</div>

## What is Spotify Library Manager?

Spotify Library Manager runs locally on Node.js 24+ and uses Spotify's
user-authorized Web API. It is independent of Spotify AB and is not affiliated
with, endorsed by, or sponsored by Spotify.

The app binds only to `127.0.0.1`; its client secret stays on the local server
and is never sent to the browser. Library data and operation manifests stay
local.

## Install and connect

Requirements: Node.js 24+ and a Spotify developer application. Spotify requires
the owner of a Development Mode app to have an active Premium subscription
([Development Mode requirements](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)).

1. Sign in to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   with the Spotify account that will own the app. Create an app, select **Web
   API**, register `http://127.0.0.1:3000/callback` as a Redirect URI, accept the
   Developer Terms, and create the app ([Spotify's getting started
   guide](https://developer.spotify.com/documentation/web-api/tutorials/getting-started)).
2. In the app settings, copy the **Client ID** and **Client Secret**. In the
   directory where you want local results stored, create a private `.env` file:
   ```dotenv
   SPOTIFY_CLIENT_ID=your-spotify-client-id
   SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
   SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/callback
   PORT=3000
   RESULTS_DIR=results
   ```
   `SPOTIFY_REDIRECT_URI` must exactly match the URI registered in the dashboard.
3. After the package is published, run `npx @twkrash/spotify-library-manager`
   and open <http://127.0.0.1:3000>.
4. Connect Spotify and sync the library.

The app requests Spotify permissions for saved-library reads and changes, top
tracks and artists, and recently played items.

## Manage and analyze the library

- Review library statistics, top tracks and artists, and recent listening
  activity in the dashboard.
- Inspect duplicate groups, choose which copies to remove, review the exact
  keep/remove list, and confirm with the generated phrase. Individual saved
  tracks can also be removed from the library browser.
- Removed tracks are recorded in local operation manifests. The restore panel
  previews tracks that are currently missing before confirming restoration.
  Spotify cannot restore their original saved dates.
- A successful library change marks the snapshot stale. Sync again before
  making another change.
- Export a compact `library.toon` file for LLM workflows.

## Run from source

From the project directory:

```sh
npm ci
cp -n .env.example .env
# Fill in the Spotify client ID and secret in .env.
npm run dev
```

For a production-style source run, use `npm run build` followed by
`npm start`. Run `npm run check`, `npm test`, and `npm run build` before
submitting changes.

## Local data and licensing

`RESULTS_DIR` defaults to `results/` and stores `library.json`, the compact
`library.toon` export, a self-contained read-only `index.html` snapshot, and
recoverable `operation-*.json` manifests. The Spotify refresh token remains at
`~/.config/liked-list/tokens.json` for compatibility with existing
installations. These files are local-only; do not commit Spotify data or
credentials.

The source code is licensed under the MIT License (see `LICENSE`). Spotify
and its marks belong to Spotify AB.
