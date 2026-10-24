# Spotify Library Manager

A local-first Spotify saved-library analyzer and manager. It provides library statistics, Spotify top-track and top-artist rankings, recent listening activity, duplicate detection, safe cleanup and restore, and a compact TOON export for LLM workflows.

Spotify Library Manager runs locally on Node.js 24+ and uses Spotify's user-authorized Web API. It is an independent project and is not affiliated with, endorsed by, or sponsored by Spotify AB.

## Run the published app

Requirements: Node.js 24+ and a Spotify developer application with a client ID and client secret.

1. In the Spotify Developer Dashboard, set the redirect URI to `http://127.0.0.1:3000/callback`.
2. In the directory where you want local results stored, create a private `.env` file:
   ```dotenv
   SPOTIFY_CLIENT_ID=your-spotify-client-id
   SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
   SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/callback
   PORT=3000
   RESULTS_DIR=results
   ```
3. Run `npx @twkrash/spotify-library-manager` and open `http://127.0.0.1:3000`.
4. Connect Spotify and sync the library.

The app binds only to `127.0.0.1`. The client secret stays on the local server and is never sent to the browser. The Spotify permissions cover saved-library reads and changes, top tracks and artists, and recently played items.

## Manage and analyze the library

- Review library statistics, top tracks and artists, and recent listening activity in the dashboard.
- Inspect duplicate groups, choose which copies to remove, review the exact keep/remove list, and confirm with the generated phrase. Individual saved tracks can also be removed from the library browser.
- Removed tracks are recorded in local operation manifests. The restore panel previews tracks that are currently missing before confirming restoration. Spotify cannot restore their original saved dates.
- A successful library change marks the snapshot stale. Sync again before making another change.
- Export a compact `library.toon` file for LLM workflows.

## Run from source

Requirements are the same as above. From the project directory:

```sh
npm ci
cp -n .env.example .env
# Fill in the Spotify client ID and secret in .env.
npm run dev
```

For a production-style source run, use `npm run build` followed by `npm start`. Run `npm run check`, `npm test`, and `npm run build` before submitting changes.

## Local data and licensing

`RESULTS_DIR` defaults to `results/` and stores `library.json`, the compact `library.toon` export, a self-contained read-only `index.html` snapshot, and recoverable `operation-*.json` manifests. The Spotify refresh token remains at `~/.config/liked-list/tokens.json` for compatibility with existing installations. These files are local-only; do not commit Spotify data or credentials.

The source code is licensed under the MIT License (see `LICENSE`). Spotify and its marks belong to Spotify AB.
