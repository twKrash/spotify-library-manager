import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { buildCleanupPlan } from "../domain/cleanup-plan.js";
import { createCleanupManifest, createManualRemovalManifest, restoreCandidates } from "../domain/manifest.js";
import type { CleanupGroupPlan, CleanupPlan, LibraryReport, OperationManifest, SongRecord, TrackSummary } from "../domain/types.js";
import type { ManifestStore } from "../ports/manifest-store.js";
import type { SnapshotStore } from "../ports/snapshot-store.js";
import type { SpotifyApiPort } from "../ports/spotify-api.js";
import { OperationGate } from "./operation-gate.js";
import type { CleanupPreview, MutationResult, OperationSummary, RestorePreview } from "./contracts.js";
export type { CleanupPreview, MutationResult, OperationSummary, RestorePreview } from "./contracts.js";

const MAX_URIS_PER_REQUEST = 40;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/;

type SelectedGroup = { id: string; plan: CleanupGroupPlan };

type PendingCleanup = {
  groups: SelectedGroup[];
  plan: CleanupPlan;
  snapshotFingerprint: string;
  confirmation: string;
  expiresAt: number;
};

type PendingRestore = {
  manifestId: string;
  tracks: TrackSummary[];
  alreadySavedIds: string[];
  snapshotFingerprint: string;
  confirmation: string;
  expiresAt: number;
};

export class RemovalService {
  private readonly cleanupPreviews = new Map<string, PendingCleanup>();
  private readonly restorePreviews = new Map<string, PendingRestore>();

  constructor(
    private readonly spotify: SpotifyApiPort,
    private readonly snapshots: SnapshotStore,
    private readonly manifests: ManifestStore,
    private readonly gate = new OperationGate(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async previewCleanup(groupIds?: string[]): Promise<CleanupPreview> {
    const report = await this.requireFreshSnapshot();
    const fullPlan = buildCleanupPlan(report);
    const allGroups = fullPlan.flatMap((band) => band.groups.map((plan) => ({ id: cleanupGroupId(plan), plan })));
    let selected: SelectedGroup[];
    if (groupIds === undefined) {
      selected = allGroups;
    } else {
      if (!Array.isArray(groupIds) || groupIds.length === 0 || groupIds.some((id) => typeof id !== "string")) {
        throw new Error("Select at least one valid duplicate group.");
      }
      if (new Set(groupIds).size !== groupIds.length) throw new Error("Duplicate group selection contains repeats.");
      const byId = new Map(allGroups.map((group) => [group.id, group]));
      selected = groupIds.map((id) => {
        const group = byId.get(id);
        if (!group) throw new Error("A selected duplicate group is not in the current snapshot.");
        return group;
      });
    }
    if (selected.length === 0) throw new Error("The current snapshot contains no duplicate tracks to remove.");
    return this.createCleanupPreview(report, fullPlan, selected);
  }

  async previewCleanupForSongs(songIds: string[]): Promise<CleanupPreview> {
    const report = await this.requireFreshSnapshot();
    if (!Array.isArray(songIds) || songIds.length === 0 || songIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error("Select one valid duplicate group.");
    }
    if (new Set(songIds).size !== songIds.length) throw new Error("Selected duplicate tracks contain repeats.");
    const fullPlan = buildCleanupPlan(report);
    const matches = fullPlan.flatMap((band) => band.groups.map((plan) => ({ id: cleanupGroupId(plan), plan })))
      .filter(({ plan }) => sameIds(plan.group.song_ids, songIds));
    if (matches.length !== 1) throw new Error("Selected duplicate group is not in the current snapshot.");
    return this.createCleanupPreview(report, fullPlan, matches);
  }

  private createCleanupPreview(report: LibraryReport, fullPlan: CleanupPlan, selected: SelectedGroup[]): CleanupPreview {
    const plan = selectCleanupPlan(fullPlan, new Set(selected.map((group) => group.id)));
    const removalCount = selected.reduce((total, group) => total + group.plan.remove.length, 0);
    const previewId = randomUUID();
    const confirmation = confirmationPhrase("DELETE", removalCount);
    this.cleanupPreviews.set(previewId, {
      groups: selected,
      plan,
      snapshotFingerprint: fingerprint(report),
      confirmation,
      expiresAt: this.now().getTime() + PREVIEW_TTL_MS,
    });
    return {
      preview_id: previewId,
      groups: selected.map(({ id, plan: groupPlan }) => ({ group_id: id, plan: groupPlan })),
      removal_count: removalCount,
      confirmation_text: confirmation,
    };
  }

  async applyCleanup(previewId: string, confirmation: string): Promise<MutationResult> {
    const pending = this.takePreview(this.cleanupPreviews, previewId, confirmation);
    return this.gate.run(async () => {
      const report = await this.requireFreshSnapshot();
      if (fingerprint(report) !== pending.snapshotFingerprint) throw new Error("The library changed after this preview; create a new preview.");
      const uris = pending.groups.flatMap(({ plan }) => plan.remove.map((track) => trackUri(track.id)));
      const manifest = createCleanupManifest(pending.plan, this.now());
      const path = await this.manifests.create(manifest);
      await this.snapshots.markStale();
      await this.removeBatches(path, uris);
      return { operation_id: basename(path), track_count: uris.length };
    });
  }

  async removeOne(trackId: string, confirmation: string): Promise<MutationResult> {
    return this.gate.run(async () => {
      const report = await this.requireFreshSnapshot();
      const song = findSong(report, trackId);
      if (!song) throw new Error("Track is not present in the current snapshot.");
      const summary = songSummary(song);
      if (confirmation !== manualConfirmation(summary)) throw new Error("Manual removal confirmation does not match the selected track.");
      const uri = trackUri(summary.id);
      const path = await this.manifests.create(createManualRemovalManifest(summary, this.now()));
      await this.snapshots.markStale();
      await this.spotify.removeSavedTrackUris([uri]);
      await this.manifests.recordBatch(path, "deleted_track_ids", [summary.id]);
      return { operation_id: basename(path), track_count: 1 };
    });
  }

  async listOperations(): Promise<OperationSummary[]> {
    return (await this.manifests.list()).map(({ id, manifest }) => operationSummary(id, manifest));
  }

  async previewRestore(operationId: string): Promise<RestorePreview> {
    if (typeof operationId !== "string" || operationId.length === 0) throw new Error("Operation ID is required.");
    const report = await this.requireFreshSnapshot();
    const manifest = await this.manifests.read(operationId);
    const savedTracks = await this.spotify.listSavedTracks();
    const savedIds = new Set(savedTracks.flatMap((track) => typeof track.id === "string" ? [track.id] : []));
    const candidates = restoreCandidates(manifest, savedIds);
    if (candidates.length === 0) throw new Error("This operation has no missing tracks to restore.");
    const allTracks = manifestTrackSummaries(manifest);
    const alreadySavedIds = allTracks.filter((track) => savedIds.has(track.id)).map((track) => track.id);
    const previewId = randomUUID();
    const confirmation = confirmationPhrase("RESTORE", candidates.length);
    this.restorePreviews.set(previewId, {
      manifestId: operationId,
      tracks: candidates,
      alreadySavedIds,
      snapshotFingerprint: fingerprint(report),
      confirmation,
      expiresAt: this.now().getTime() + PREVIEW_TTL_MS,
    });
    return {
      preview_id: previewId,
      operation_id: operationId,
      tracks: candidates,
      restore_count: candidates.length,
      confirmation_text: confirmation,
    };
  }

  async applyRestore(previewId: string, confirmation: string): Promise<MutationResult> {
    const pending = this.takePreview(this.restorePreviews, previewId, confirmation);
    return this.gate.run(async () => {
      const report = await this.requireFreshSnapshot();
      if (fingerprint(report) !== pending.snapshotFingerprint) throw new Error("The library changed after this preview; create a new preview.");
      const manifest = await this.manifests.read(pending.manifestId);
      const validIds = new Set(manifestTrackSummaries(manifest).map((track) => track.id));
      const tracks = pending.tracks.filter((track) => validIds.has(track.id));
      if (tracks.length !== pending.tracks.length) throw new Error("The restore manifest changed after this preview.");
      const uris = tracks.map((track) => trackUri(track.id));
      await this.snapshots.markStale();
      await this.manifests.recordBatch(pending.manifestId, "restored_track_ids", pending.alreadySavedIds);
      await this.addBatches(pending.manifestId, uris);
      return { operation_id: pending.manifestId, track_count: uris.length };
    });
  }

  private async requireFreshSnapshot(): Promise<LibraryReport> {
    if (await this.snapshots.isStale()) throw new Error("The library snapshot is stale; sync before making changes.");
    const report = await this.snapshots.load();
    if (!report) throw new Error("No library snapshot is available; sync first.");
    buildCleanupPlan(report);
    return report;
  }

  private takePreview<T extends { confirmation: string; expiresAt: number }>(
    previews: Map<string, T>,
    previewId: string,
    confirmation: string,
  ): T {
    if (typeof previewId !== "string" || typeof confirmation !== "string") throw new Error("A valid preview and confirmation are required.");
    const preview = previews.get(previewId);
    if (!preview || preview.expiresAt <= this.now().getTime()) {
      previews.delete(previewId);
      throw new Error("Preview is expired or already used; create a new preview.");
    }
    if (preview.confirmation !== confirmation) throw new Error("Confirmation text does not match the preview.");
    previews.delete(previewId);
    return preview;
  }

  private async removeBatches(path: string, uris: string[]): Promise<void> {
    for (const batch of chunks(uris, MAX_URIS_PER_REQUEST)) {
      await this.spotify.removeSavedTrackUris(batch);
      await this.manifests.recordBatch(path, "deleted_track_ids", batch.map(trackIdFromUri));
    }
  }

  private async addBatches(id: string, uris: string[]): Promise<void> {
    for (const batch of chunks(uris, MAX_URIS_PER_REQUEST)) {
      await this.spotify.addSavedTrackUris(batch);
      await this.manifests.recordBatch(id, "restored_track_ids", batch.map(trackIdFromUri));
    }
  }
}

function cleanupGroupId(plan: CleanupGroupPlan): string {
  const songIds = [...plan.group.song_ids].sort();
  return createHash("sha256").update(JSON.stringify(songIds)).digest("hex");
}

function sameIds(first: string[], second: string[]): boolean {
  const secondIds = new Set(second);
  return first.length === second.length && secondIds.size === second.length && first.every((id) => secondIds.has(id));
}

function selectCleanupPlan(plan: CleanupPlan, groupIds: Set<string>): CleanupPlan {
  return plan.map((band) => {
    const groups = band.groups.filter((group) => groupIds.has(cleanupGroupId(group)));
    return { artist: band.artist, groups, extra_copies: groups.reduce((total, group) => total + group.group.extra_copies, 0) };
  }).filter((band) => band.groups.length > 0);
}

function fingerprint(report: LibraryReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

function confirmationPhrase(action: "DELETE" | "RESTORE", count: number): string {
  return `${action} ${count} TRACK${count === 1 ? "" : "S"}`;
}

function findSong(report: LibraryReport, trackId: string): SongRecord | undefined {
  return report.artists.flatMap((artist) => artist.albums.flatMap((album) => album.songs))
    .find((song) => song.spotify_id === trackId);
}

function songSummary(song: SongRecord): TrackSummary {
  if (!song.spotify_id || !song.added_at) throw new Error("The selected track is missing required saved-library metadata.");
  return {
    id: song.spotify_id,
    added_at: song.added_at,
    title: song.title,
    artists: song.artists,
    album: song.album,
  };
}

function manualConfirmation(track: TrackSummary): string {
  return `REMOVE ${track.title} — ${track.artists.join(", ")}`;
}

function trackUri(id: string): string {
  if (!SPOTIFY_TRACK_ID.test(id)) throw new Error("A track in the snapshot has an invalid Spotify ID.");
  return `spotify:track:${id}`;
}

function trackIdFromUri(uri: string): string {
  return uri.slice("spotify:track:".length);
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

function manifestTrackSummaries(manifest: OperationManifest): TrackSummary[] {
  return manifest.schema_version === 1
    ? manifest.groups.flatMap((group) => group.remove)
    : manifest.tracks;
}

function operationSummary(id: string, manifest: OperationManifest): OperationSummary {
  const tracks = manifestTrackSummaries(manifest);
  return {
    id,
    operation: manifest.schema_version === 1 ? "duplicate_cleanup" : "manual_removal",
    created_at: manifest.created_at,
    track_count: tracks.length,
    deleted_track_count: manifest.deleted_track_ids.length,
    restored_track_count: manifest.restored_track_ids.length,
    status: manifest.schema_version === 1 ? manifest.cleanup_status : manifest.status,
    restore_status: manifest.restore_status,
  };
}
