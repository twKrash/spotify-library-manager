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
   Copy the **Client ID** and **Client Secret** from its settings.
2. Install and run the CLI:
   ```sh
   npm install @twkrash/spotify-library-manager
   npx spotify-library-manager
   ```
   On the first interactive run, the CLI prompts for missing credentials and
   stores them in `~/.config/liked-list/config.json`. The directory is created
   with mode `0700` and the file with mode `0600`. npm installation itself does
   not create files. The generated JSON uses `schemaVersion`, `clientId`,
   `clientSecret`, `redirectUri`, `port`, and `resultsDir`; edit it to change
   saved settings. The default redirect URI must exactly match the URI
   registered in the dashboard.
3. Open <http://127.0.0.1:3000>, connect Spotify, and sync the library.

The CLI also supports environment variables and a current-directory `.env` file.
Their precedence is process environment > `.env` > user config. If credentials
are missing in a non-interactive run, set `SPOTIFY_CLIENT_ID` and
`SPOTIFY_CLIENT_SECRET` (and `SPOTIFY_REDIRECT_URI` if using a non-default URI)
in the environment; the CLI exits with setup guidance instead of prompting.

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

When `RESULTS_DIR` is not set in the environment, `.env`, or user config, it
defaults to the absolute `~/.config/liked-list/` directory, independent of the
current working directory. It stores `library.json`, the compact `library.toon`
export, a self-contained read-only `index.html` snapshot, and recoverable
`operation-*.json` manifests alongside the app config and refresh token. Set
`RESULTS_DIR` to use a custom location; relative overrides remain relative to
the current working directory. Existing results directories are not moved or
deleted automatically. These files are local-only; do not commit Spotify data
or credentials.

The source code is licensed under the MIT License (see `LICENSE`). Spotify
and its marks belong to Spotify AB.
