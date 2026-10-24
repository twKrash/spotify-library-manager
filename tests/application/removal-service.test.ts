import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RemovalService } from "../../src/application/removal-service.ts";
import { FileManifestStore } from "../../src/adapters/file-manifest-store.ts";
import { FileSnapshotStore } from "../../src/adapters/file-snapshot-store.ts";
import { emptyApiStatistics, buildLibrary } from "../../src/domain/library.ts";
import type { ApiStatistics, SpotifyTrack } from "../../src/domain/types.ts";
import type { SpotifyApiPort } from "../../src/ports/spotify-api.ts";
import { OperationGate } from "../../src/application/operation-gate.ts";

const stats: ApiStatistics = emptyApiStatistics();
const trackId = (index: number): string => index.toString(36).toUpperCase().padStart(22, "0");

function track(index: number, addedAt: string, isrc = "USAAA0000001", title = "Song"): SpotifyTrack {
  const id = trackId(index);
  return {
    id,
    name: title,
    artists: [{ name: "Artist" }],
    album: { name: "Album" },
    duration_ms: 180_000,
    external_ids: { isrc },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    added_at: addedAt,
  };
}

async function setup(t: test.TestContext, tracks: SpotifyTrack[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "liked-list-removal-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshots = new FileSnapshotStore(path.join(directory, "results"));
  const manifests = new FileManifestStore(path.join(directory, "results"));
  await snapshots.save(buildLibrary(tracks, stats, new Date("2025-01-01T00:00:00Z")));
  await snapshots.markFresh();
  const saved = [...tracks];
  const removedBatches: string[][] = [];
  const addedBatches: string[][] = [];
  let beforeMutation: (() => Promise<void>) | undefined;
  const api: SpotifyApiPort = {
    async listSavedTracks() { return [...saved]; },
    async getStatistics() { return stats; },
    async removeSavedTrackUris(uris) {
      if (beforeMutation) await beforeMutation();
      removedBatches.push(uris);
      const ids = new Set(uris.map((uri) => uri.slice("spotify:track:".length)));
      for (let index = saved.length - 1; index >= 0; index--) if (ids.has(saved[index]?.id ?? "")) saved.splice(index, 1);
    },
    async addSavedTrackUris(uris) {
      if (beforeMutation) await beforeMutation();
      addedBatches.push(uris);
      const existing = new Set(saved.map((item) => item.id));
      for (const id of uris.map((uri) => uri.slice("spotify:track:".length))) {
        if (!existing.has(id)) {
          const original = tracks.find((item) => item.id === id);
          if (original) saved.push(original);
        }
      }
    },
  };
  const service = new RemovalService(api, snapshots, manifests, new OperationGate(), () => new Date("2025-02-01T00:00:00Z"));
  return { service, snapshots, manifests, api, saved, removedBatches, addedBatches, setBeforeMutation: (callback: () => Promise<void>) => { beforeMutation = callback; } };
}

test("cleanup previews are exact, one-use approvals and persist a manifest before Spotify deletion", async (t) => {
  const oldTrack = track(1, "2023-01-01T00:00:00Z");
  const keepTrack = track(2, "2024-01-01T00:00:00Z");
  const context = await setup(t, [oldTrack, keepTrack]);
  const preview = await context.service.previewCleanup();
  assert.equal(preview.removal_count, 1);
  assert.equal(preview.confirmation_text, "DELETE 1 TRACK");
  assert.equal(context.removedBatches.length, 0);
  await assert.rejects(context.service.applyCleanup(preview.preview_id, "DELETE ALL"), /confirmation/i);
  assert.equal((await context.manifests.list()).length, 0);

  let manifestExistedBeforeWrite = false;
  context.setBeforeMutation(async () => { manifestExistedBeforeWrite = (await context.manifests.list()).length === 1; });
  const result = await context.service.applyCleanup(preview.preview_id, preview.confirmation_text);
  assert.equal(manifestExistedBeforeWrite, true);
  assert.equal(result.track_count, 1);
  assert.equal(context.removedBatches[0]?.[0], `spotify:track:${oldTrack.id}`);
  assert.equal(await context.snapshots.isStale(), true);
  const operation = (await context.manifests.list())[0];
  assert.equal(operation?.manifest.schema_version === 1 ? operation.manifest.cleanup_status : "", "completed");
  await assert.rejects(context.service.applyCleanup(preview.preview_id, preview.confirmation_text), /expired or already used/);
  await assert.rejects(context.service.previewCleanup(), /stale/);
});

test("cleanup can preview one duplicate group by its song IDs", async (t) => {
  const context = await setup(t, [track(6, "2023-01-01T00:00:00Z"), track(7, "2024-01-01T00:00:00Z")]);
  const report = await context.snapshots.load();
  const group = report?.duplicates[0];
  assert.ok(group);

  const preview = await context.service.previewCleanupForSongs(group.song_ids);

  assert.equal(preview.groups.length, 1);
  assert.deepEqual(preview.groups[0]?.plan.group.song_ids, group.song_ids);
  assert.equal(preview.removal_count, 1);
  await assert.rejects(context.service.previewCleanupForSongs([]), /valid duplicate group/i);
  await assert.rejects(context.service.previewCleanupForSongs(["unknown-song-id"]), /not in the current snapshot/i);
});

test("manual removal requires the exact snapshot track and its confirmation phrase", async (t) => {
  const solo = track(3, "2024-01-01T00:00:00Z", "USBBB0000002", "Manual Song");
  const context = await setup(t, [solo]);
  await assert.rejects(context.service.removeOne(solo.id ?? "", "REMOVE Song"), /confirmation/);
  assert.equal(context.removedBatches.length, 0);
  assert.equal((await context.manifests.list()).length, 0);

  await assert.rejects(context.service.removeOne("unknown-track-id", "REMOVE Manual Song — Artist"), /not present/);
  const result = await context.service.removeOne(solo.id ?? "", "REMOVE Manual Song — Artist");
  assert.equal(result.track_count, 1);
  assert.equal(context.removedBatches[0]?.[0], `spotify:track:${solo.id}`);
});

test("restore previews only missing tracks and records resumable progress", async (t) => {
  const oldTrack = track(4, "2023-01-01T00:00:00Z");
  const keepTrack = track(5, "2024-01-01T00:00:00Z");
  const context = await setup(t, [oldTrack, keepTrack]);
  const cleanup = await context.service.previewCleanup();
  const deleted = await context.service.applyCleanup(cleanup.preview_id, cleanup.confirmation_text);
  const latest = buildLibrary(context.saved, stats, new Date("2025-02-02T00:00:00Z"));
  await context.snapshots.save(latest);
  await context.snapshots.markFresh();

  const operations = await context.service.listOperations();
  assert.equal(operations[0]?.id, deleted.operation_id);
  const preview = await context.service.previewRestore(deleted.operation_id);
  assert.deepEqual(preview.tracks.map((item) => item.id), [oldTrack.id]);
  assert.equal(preview.confirmation_text, "RESTORE 1 TRACK");
  const result = await context.service.applyRestore(preview.preview_id, preview.confirmation_text);
  assert.equal(context.addedBatches[0]?.[0], `spotify:track:${oldTrack.id}`);
  assert.equal(result.track_count, 1);
  const manifest = await context.manifests.read(deleted.operation_id);
  assert.deepEqual(manifest.restored_track_ids, [oldTrack.id]);
  assert.equal(manifest.restore_status, "completed");
  assert.equal(await context.snapshots.isStale(), true);
});

test("cleanup batches removals at 40 and retains completed progress after a later failure", async (t) => {
  const duplicates = Array.from({ length: 42 }, (_, index) => track(index + 100, new Date(Date.UTC(2020 + index, 0, 1)).toISOString()));
  const context = await setup(t, duplicates);
  const preview = await context.service.previewCleanup();
  assert.equal(preview.removal_count, 41);
  let calls = 0;
  context.setBeforeMutation(async () => {
    calls++;
    if (calls === 2) throw new Error("injected Spotify failure");
  });
  await assert.rejects(context.service.applyCleanup(preview.preview_id, preview.confirmation_text), /injected Spotify failure/);
  assert.deepEqual(context.removedBatches.map((batch) => batch.length), [40]);
  const operation = (await context.manifests.list())[0];
  assert.ok(operation);
  assert.equal(operation.manifest.deleted_track_ids.length, 40);
  assert.equal(await context.snapshots.isStale(), true);
});
