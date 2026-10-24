# Approved Duplicate Cleanup Implementation Plan

**Goal:** Add an explicit interactive cleanup mode to the single `main.py` entry point. Use `results/library.json` as the cleanup snapshot; do not ingest Spotify from cleanup mode.

**Architecture:** Normal `main.py` export preserves saved-track `added_at` in the JSON report. `cleanup_plan.py` maps the report's duplicate groups and artist hierarchy into bands sorted by extra-copy total. `cleanup_duplicates.py` handles band prompts and Spotify writes; `cleanup_manifest.py` persists recovery state. `main.py --restore MANIFEST` remains the single restore entry point.

**Tech Stack:** Python 3.11+, existing Spotipy, standard-library `unittest`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-approved-duplicate-cleanup.md`

## Constraints and Review Focus

- No Git/GitHub operations or live Spotify cleanup during implementation and tests.
- `y` approves every displayed removal for one artist; `n` skips that artist and continues; `s` stops later prompts but retains previous approvals.
- Cleanup reads the stored JSON only. Missing dates or inconsistent mappings abort before OAuth/deletion and instruct the user to refresh with normal `main.py`.
- Display the report timestamp because the artifact is a snapshot; do not silently re-fetch or compare the live library.
- Keep the newest-added copy; fail closed on tied dates or repeated/missing IDs.
- Write the manifest before removal and persist each successful batch (maximum 40 IDs).
- Restore still checks the current library, requires exact `RESTORE <count> TRACKS`, and records successful additions.

## Implementation Checklist

- [x] Test report dates and artifact-to-band planning, including largest-first order and invalid snapshots.
- [x] Add `main.py --cleanup` and `main.py --restore` as mutually exclusive modes; keep default export behavior.
- [x] Add per-artist `y/n/s` selection with exact previews; verify cleanup never calls the Spotify library-fetch helper.
- [x] Keep manifest creation/progress updates and restore behavior under the single entry point.
- [x] Update README with refresh, cleanup, snapshot, and restore instructions.
- [x] Run unit tests, Ruff, compilation, and LSP diagnostics; do not run cleanup against Spotify.
