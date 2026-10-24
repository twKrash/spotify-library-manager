import assert from "node:assert/strict";
import test from "node:test";
import { LibraryService } from "../../src/application/library-service.ts";
import type { ApiStatistics, LibraryReport, SpotifyTrack } from "../../src/domain/types.ts";
import type { SpotifyApiPort } from "../../src/ports/spotify-api.ts";
import type { SnapshotStore } from "../../src/ports/snapshot-store.ts";
import type { LibraryArtifactStore } from "../../src/ports/library-artifacts.ts";
import type { ToonEncoder } from "../../src/ports/toon-encoder.ts";
import type { OfflineHtmlRenderer } from "../../src/ports/offline-html.ts";
import { emptyApiStatistics } from "../../src/domain/library.ts";

const tracks: SpotifyTrack[] = [{
  id: "0123456789012345678901",
  name: "Song",
  artists: [{ name: "Artist" }],
  album: { name: "Album" },
  duration_ms: 180_000,
  external_ids: { isrc: "USAAA0000001" },
  external_urls: { spotify: "https://open.spotify.com/track/0123456789012345678901" },
  added_at: "2024-01-01T00:00:00Z",
}];

class MemorySnapshotStore implements SnapshotStore {
  report: LibraryReport | null = null;
  stale = true;
  async load() { return this.report; }
  async save(report: LibraryReport) { this.report = report; }
  async isStale() { return this.stale; }
  async markStale() { this.stale = true; }
  async markFresh() { this.stale = false; }
}

const stats: ApiStatistics = emptyApiStatistics();

test("LibraryService builds and persists all output representations after fetching Spotify data", async () => {
  const events: string[] = [];
  const snapshot = new MemorySnapshotStore();
  const api: SpotifyApiPort = {
    async listSavedTracks() { events.push("tracks"); return tracks; },
    async getStatistics() { events.push("statistics"); return stats; },
    async removeSavedTrackUris() { throw new Error("unexpected mutation"); },
    async addSavedTrackUris() { throw new Error("unexpected mutation"); },
  };
  let encoded: unknown;
  let rendered: LibraryReport | undefined;
  const artifacts: LibraryArtifactStore = { async writeArtifacts(toon, html) { events.push(`artifacts:${toon}:${html}`); } };
  const encoder: ToonEncoder = { async encode(data) { encoded = data; return "encoded-toon"; } };
  const offlineHtml: OfflineHtmlRenderer = { async render(report) { rendered = report; return "offline-html"; } };
  const service = new LibraryService(api, snapshot, artifacts, encoder, offlineHtml, undefined, () => new Date("2025-02-03T04:05:06Z"));

  const report = await service.sync();
  assert.deepEqual(events, ["tracks", "statistics", "artifacts:encoded-toon:offline-html"]);
  assert.equal(report.generated_at, "2025-02-03T04:05:06.000+00:00");
  assert.equal(report.liked_track_count, 1);
  assert.equal(snapshot.report, report);
  assert.equal(snapshot.stale, false);
  assert.equal(rendered, report);
  assert.ok(encoded && typeof encoded === "object" && "tracks" in encoded);
});

test("LibraryService leaves the previous snapshot untouched when an encoder fails", async () => {
  const old = {} as LibraryReport;
  const snapshot = new MemorySnapshotStore();
  snapshot.report = old;
  snapshot.stale = false;
  const api: SpotifyApiPort = {
    async listSavedTracks() { return tracks; },
    async getStatistics() { return stats; },
    async removeSavedTrackUris() { throw new Error("unexpected mutation"); },
    async addSavedTrackUris() { throw new Error("unexpected mutation"); },
  };
  const artifacts: LibraryArtifactStore = { async writeArtifacts() { throw new Error("must not write artifacts"); } };
  const encoder: ToonEncoder = { async encode() { throw new Error("injected encoder failure"); } };
  const offlineHtml: OfflineHtmlRenderer = { async render() { return "unused"; } };
  const service = new LibraryService(api, snapshot, artifacts, encoder, offlineHtml);

  await assert.rejects(service.sync(), /injected encoder failure/);
  assert.equal(snapshot.report, old);
  assert.equal(snapshot.stale, false);
});
