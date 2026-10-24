# Contributing

## Development setup

Use Node.js 24 or newer. From the project directory:

```sh
npm ci
cp -n .env.example .env
```

Fill in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`, then run `npm run dev`. Keep `.env`, Spotify tokens, and generated library data private.

## Checks

Run these before opening a pull request:

```sh
npm run check
npm test
npm run build
npm run package:smoke
```

The package smoke check packs the app, installs it in a temporary prefix, and launches the command outside the source checkout. It uses test-only credentials and temporary data.

## Releases

Update the package version and add a matching `CHANGELOG.md` section before tagging a release. A `v<version>` tag runs `.github/workflows/release.yml`; it qualifies the package, publishes the verified public tarball to npm with provenance, and creates a GitHub release. The workflow uses npm trusted publishing over GitHub Actions OIDC; do not add a long-lived npm token.

After creating the GitHub repository, configure npm's trusted publisher for `@twkrash/spotify-library-manager` with the repository owner/name, workflow filename `release.yml`, and environment `npm-publish`. Configure the npm publisher to allow direct publishing. The repository identity is not yet set here, so this setup remains a release prerequisite.

## Recommended default-branch protection

After the remote repository exists, protect its default branch with an active branch rule or ruleset:

- Require pull requests for changes.
- Require the `CI / validate` status check.
- Block force pushes and branch deletion.
- Require an approving review only when another maintainer is available to provide one.

These are remote repository settings and are not applied by this local project setup.
