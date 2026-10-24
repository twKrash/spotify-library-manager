import { parseIsoTimestamp } from "./date-time.js";
import type {
  CleanupManifestV1,
  CleanupPlan,
  ManualRemovalManifestV2,
  OperationManifest,
  TrackSummary,
} from "./types.js";

type RecordValue = Record<string, unknown>;

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

export function createCleanupManifest(plan: CleanupPlan, now = new Date()): CleanupManifestV1 {
  if (plan.length === 0) throw new ManifestValidationError("Cleanup manifest contains no duplicate groups.");
  return {
    schema_version: 1,
    created_at: formatTimestamp(now),
    cleanup_status: "in_progress",
    restore_status: "not_started",
    groups: plan.flatMap((band) => band.groups.map(({ keep, remove }) => ({ keep, remove }))),
    deleted_track_ids: [],
    restored_track_ids: [],
  };
}

export function createManualRemovalManifest(track: TrackSummary, now = new Date()): ManualRemovalManifestV2 {
  const validTrack = validateTrackSummary(track);
  return {
    schema_version: 2,
    operation: "manual_removal",
    created_at: formatTimestamp(now),
    status: "in_progress",
    restore_status: "not_started",
    tracks: [validTrack],
    deleted_track_ids: [],
    restored_track_ids: [],
  };
}

export function validateManifest(value: unknown): OperationManifest {
  const manifest = asRecord(value);
  if (!isInteger(manifest.schema_version)) {
    throw new ManifestValidationError("Unsupported or malformed cleanup manifest.");
  }
  if (manifest.schema_version === 1) return validateCleanupManifest(manifest);
  if (manifest.schema_version === 2) return validateManualRemovalManifest(manifest);
  throw new ManifestValidationError(`Unsupported cleanup manifest version ${manifest.schema_version}.`);
}

export function restoreCandidates(value: unknown, savedIds: Set<string>): TrackSummary[] {
  const manifest = validateManifest(value);
  const tracks = manifest.schema_version === 1
    ? manifest.groups.flatMap((group) => group.remove)
    : manifest.tracks;
  return tracks.filter((track) => !savedIds.has(track.id));
}

export function validateTrackSummary(value: unknown): TrackSummary {
  const track = asRecord(value);
  if (typeof track.id !== "string" || !track.id || track.id !== track.id.trim()) {
    throw new ManifestValidationError("Cleanup manifest contains an invalid Spotify track ID.");
  }
  if (typeof track.added_at !== "string" || parseIsoTimestamp(track.added_at) === null) {
    throw new ManifestValidationError("Cleanup manifest track has an invalid saved date or no timezone.");
  }
  if (typeof track.title !== "string" || typeof track.album !== "string") {
    throw new ManifestValidationError("Cleanup manifest contains invalid track metadata.");
  }
  if (!isStringArray(track.artists)) {
    throw new ManifestValidationError("Cleanup manifest contains invalid artist metadata.");
  }
  return {
    ...track,
    id: track.id,
    added_at: track.added_at,
    title: track.title,
    artists: track.artists,
    album: track.album,
  };
}

function validateCleanupManifest(manifest: RecordValue): CleanupManifestV1 {
  const createdAt = validateCreatedAt(manifest.created_at);
  if (manifest.cleanup_status !== "in_progress" && manifest.cleanup_status !== "completed") {
    throw new ManifestValidationError("Cleanup manifest has an invalid cleanup status.");
  }
  const restoreStatus = validateRestoreStatus(manifest.restore_status);
  if (!Array.isArray(manifest.groups) || manifest.groups.length === 0) {
    throw new ManifestValidationError("Cleanup manifest contains no duplicate groups.");
  }

  const groups = manifest.groups.map((value) => {
    const group = asRecord(value);
    if (!Array.isArray(group.remove) || group.remove.length === 0) {
      throw new ManifestValidationError("Cleanup manifest contains an invalid or empty removal group.");
    }
    return {
      ...group,
      keep: validateTrackSummary(group.keep),
      remove: group.remove.map(validateTrackSummary),
    };
  });
  const keptIds = groups.map((group) => group.keep.id);
  const removedIds = groups.flatMap((group) => group.remove.map((track) => track.id));
  if (new Set(removedIds).size !== removedIds.length) {
    throw new ManifestValidationError("Cleanup manifest repeats a removal track ID.");
  }
  if (new Set(keptIds).size !== keptIds.length || keptIds.some((id) => removedIds.includes(id))) {
    throw new ManifestValidationError("Cleanup manifest overlaps kept and removed track IDs.");
  }

  return {
    ...manifest,
    schema_version: 1,
    created_at: createdAt,
    cleanup_status: manifest.cleanup_status,
    restore_status: restoreStatus,
    groups,
    deleted_track_ids: validateProgressIds(manifest.deleted_track_ids, new Set(removedIds), "deleted_track_ids"),
    restored_track_ids: validateProgressIds(manifest.restored_track_ids, new Set(removedIds), "restored_track_ids"),
  };
}

function validateManualRemovalManifest(manifest: RecordValue): ManualRemovalManifestV2 {
  if (manifest.operation !== "manual_removal") {
    throw new ManifestValidationError("Invalid manual removal manifest operation.");
  }
  const createdAt = validateCreatedAt(manifest.created_at);
  if (manifest.status !== "in_progress" && manifest.status !== "completed") {
    throw new ManifestValidationError("Manual removal manifest has an invalid status.");
  }
  const restoreStatus = validateRestoreStatus(manifest.restore_status);
  if (!Array.isArray(manifest.tracks) || manifest.tracks.length === 0) {
    throw new ManifestValidationError("Manual removal manifest contains no tracks.");
  }
  const tracks = manifest.tracks.map(validateTrackSummary);
  const ids = tracks.map((track) => track.id);
  if (new Set(ids).size !== ids.length) {
    throw new ManifestValidationError("Manual removal manifest repeats a Spotify track ID.");
  }
  return {
    ...manifest,
    schema_version: 2,
    operation: "manual_removal",
    created_at: createdAt,
    status: manifest.status,
    restore_status: restoreStatus,
    tracks,
    deleted_track_ids: validateProgressIds(manifest.deleted_track_ids, new Set(ids), "deleted_track_ids"),
    restored_track_ids: validateProgressIds(manifest.restored_track_ids, new Set(ids), "restored_track_ids"),
  };
}

function validateCreatedAt(value: unknown): string {
  if (typeof value !== "string" || parseIsoTimestamp(value) === null) {
    throw new ManifestValidationError("Cleanup manifest creation time is invalid or has no timezone.");
  }
  return value;
}

function validateRestoreStatus(value: unknown): "not_started" | "in_progress" | "completed" {
  if (value !== "not_started" && value !== "in_progress" && value !== "completed") {
    throw new ManifestValidationError("Cleanup manifest has an invalid restore status.");
  }
  return value;
}

function validateProgressIds(value: unknown, allowedIds: Set<string>, field: string): string[] {
  if (!isStringArray(value) || new Set(value).size !== value.length || value.some((id) => !allowedIds.has(id))) {
    throw new ManifestValidationError(`Cleanup manifest has invalid ${field}.`);
  }
  return value;
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/Z$/, "+00:00");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function asRecord(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestValidationError("Cleanup manifest contains an invalid record.");
  }
  return value as RecordValue;
}
