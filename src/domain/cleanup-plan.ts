import { parseIsoTimestamp } from "./date-time.js";
import { caseFoldText } from "./track-identity.js";
import type { CleanupBandPlan, CleanupDuplicateGroup, CleanupGroupPlan, CleanupPlan, TrackSummary } from "./types.js";

export class CleanupPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupPlanError";
  }
}

type ArtifactTrack = TrackSummary & { song_id: string };
type RecordValue = Record<string, unknown>;

export function buildCleanupPlan(input: unknown): CleanupPlan {
  const report = asRecord(input, "Library artifact is not an object.");
  parseTimestamp(report.generated_at, "Library artifact generated_at timestamp");
  if (!Array.isArray(report.duplicates)) {
    throw new CleanupPlanError("Library artifact has no valid duplicate list.");
  }

  const tracksBySongId = tracksGroupedBySongId(report);
  const bands = new Map<string, CleanupBandPlan>();

  for (const rawGroup of report.duplicates) {
    const group = validateDuplicateGroup(rawGroup);
    const candidates = group.song_ids.flatMap((songId) => tracksBySongId.get(songId) ?? []);
    if (candidates.length !== group.copies) {
      throw new CleanupPlanError(`Could not map all ${group.copies} copies of ${group.title} to saved tracks. No items were removed.`);
    }

    const trackIds = candidates.map((track) => track.id);
    if (trackIds.some((id) => !id.trim())) {
      throw new CleanupPlanError(`Duplicate group ${group.title} contains a track without a Spotify ID. No items were removed.`);
    }
    if (new Set(trackIds).size !== trackIds.length) {
      throw new CleanupPlanError(`Duplicate group ${group.title} repeats a Spotify ID. The API cannot remove one saved occurrence while preserving another.`);
    }

    const dated = candidates.map((track) => ({ track, timestamp: parseTimestamp(track.added_at, `Track ${track.id} saved date`) }));
    const firstDated = dated[0];
    if (!firstDated) {
      throw new CleanupPlanError(`Could not map all ${group.copies} copies of ${group.title} to saved tracks. No items were removed.`);
    }
    let newest = firstDated.timestamp;
    for (const entry of dated) {
      if (entry.timestamp > newest) newest = entry.timestamp;
    }
    const newestTracks = dated.filter(({ timestamp }) => timestamp === newest);
    const newestTrack = newestTracks.length === 1 ? newestTracks[0] : undefined;
    if (!newestTrack) {
      throw new CleanupPlanError(`Duplicate group ${group.title} has multiple tracks tied for newest saved date. No items were removed.`);
    }

    const keep = toTrackSummary(newestTrack.track);
    const remove = dated
      .filter(({ track }) => track !== newestTrack.track)
      .sort((first, second) => compareTimestamp(first.timestamp, second.timestamp) || compareText(first.track.id, second.track.id))
      .map(({ track }) => toTrackSummary(track));
    const artist = group.artists[0];
    if (!artist) throw new CleanupPlanError("Library artifact contains an invalid duplicate group.");
    const key = caseFoldText(artist);
    const band = bands.get(key) ?? { artist, extra_copies: 0, groups: [] };
    const plannedGroup: CleanupGroupPlan = { group, keep, remove };
    band.extra_copies += group.extra_copies;
    band.groups.push(plannedGroup);
    bands.set(key, band);
  }

  const plan = [...bands.values()];
  for (const band of plan) {
    band.groups.sort((first, second) =>
      second.group.extra_copies - first.group.extra_copies || compareFolded(first.group.title, second.group.title),
    );
  }
  return plan.sort((first, second) =>
    second.extra_copies - first.extra_copies || compareFolded(first.artist, second.artist),
  );
}

function tracksGroupedBySongId(report: RecordValue): Map<string, ArtifactTrack[]> {
  if (!Array.isArray(report.artists)) {
    throw new CleanupPlanError("Library artifact has no valid artist list.");
  }

  const byTrackId = new Map<string, ArtifactTrack>();
  const bySongId = new Map<string, ArtifactTrack[]>();
  for (const rawArtist of report.artists) {
    const artist = asRecord(rawArtist, "Library artifact contains an invalid artist entry.");
    if (!Array.isArray(artist.albums)) {
      throw new CleanupPlanError("Library artifact contains an invalid artist entry.");
    }
    for (const rawAlbum of artist.albums) {
      const album = asRecord(rawAlbum, "Library artifact contains an invalid album entry.");
      if (!Array.isArray(album.songs)) {
        throw new CleanupPlanError("Library artifact contains an invalid album entry.");
      }
      for (const rawSong of album.songs) {
        const song = asRecord(rawSong, "Library artifact contains an invalid song entry.");
        const track = artifactTrack(song);
        const previous = byTrackId.get(track.id);
        if (previous) {
          if (!sameTrack(previous, track) || previous.song_id !== track.song_id) {
            throw new CleanupPlanError(`Library artifact has conflicting records for Spotify track ${track.id}.`);
          }
          continue;
        }
        byTrackId.set(track.id, track);
        const tracks = bySongId.get(track.song_id) ?? [];
        tracks.push(track);
        bySongId.set(track.song_id, tracks);
      }
    }
  }

  if (!Number.isInteger(report.liked_track_count) || report.liked_track_count !== byTrackId.size) {
    throw new CleanupPlanError("Library artifact track count does not match its saved track records.");
  }
  return bySongId;
}

function artifactTrack(song: RecordValue): ArtifactTrack {
  if (!isStringArray(song.artists)) {
    throw new CleanupPlanError("Library artifact contains invalid track artists.");
  }
  if (typeof song.album !== "string") {
    throw new CleanupPlanError("Library artifact contains an invalid track album.");
  }
  if (typeof song.song_id !== "string" || !song.song_id) {
    throw new CleanupPlanError("Library artifact contains a track without a song_id.");
  }
  if (typeof song.spotify_id !== "string" || !song.spotify_id.trim()) {
    throw new CleanupPlanError("Library artifact contains a track without a Spotify ID.");
  }
  const addedAt = song.added_at;
  if (typeof addedAt !== "string") {
    throw new CleanupPlanError(`Track ${song.spotify_id} saved date is missing; refusing to guess which version is newest.`);
  }
  parseTimestamp(addedAt, `Track ${song.spotify_id} saved date`);
  return {
    id: song.spotify_id,
    added_at: addedAt,
    title: typeof song.title === "string" && song.title ? song.title : "Unknown title",
    artists: song.artists.map((artist) => artist || "Unknown artist"),
    album: song.album || "Unknown album",
    song_id: song.song_id,
  };
}

function validateDuplicateGroup(value: unknown): CleanupDuplicateGroup {
  const group = asRecord(value, "Library artifact contains an invalid duplicate group.");
  const songIds = group.song_ids;
  const artists = group.artists;
  const title = group.title;
  const copies = group.copies;
  const extraCopies = group.extra_copies;
  if (
    typeof title !== "string" || !isStringArray(songIds) || songIds.length === 0 ||
    songIds.some((songId) => songId.length === 0) || new Set(songIds).size !== songIds.length ||
    !isInteger(copies) || copies < 2 || !isInteger(extraCopies) || extraCopies !== copies - 1 ||
    !isStringArray(artists) || artists.length === 0 || artists.some((artist) => artist.length === 0)
  ) {
    throw new CleanupPlanError("Library artifact contains an invalid duplicate group.");
  }
  return { ...group, song_ids: songIds, title, copies, extra_copies: extraCopies, artists };
}

function toTrackSummary(track: ArtifactTrack): TrackSummary {
  const { id, added_at, title, artists, album } = track;
  return { id, added_at, title, artists, album };
}

function sameTrack(first: ArtifactTrack, second: ArtifactTrack): boolean {
  return first.id === second.id && first.added_at === second.added_at && first.title === second.title &&
    first.album === second.album && first.artists.length === second.artists.length &&
    first.artists.every((artist, index) => artist === second.artists[index]);
}

function parseTimestamp(value: unknown, context: string): bigint {
  const timestamp = parseIsoTimestamp(value);
  if (timestamp === null) {
    throw new CleanupPlanError(`${context} is invalid or has no timezone.`);
  }
  return timestamp;
}

function asRecord(value: unknown, message: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CleanupPlanError(message);
  }
  return value as RecordValue;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function compareFolded(first: string, second: string): number {
  const a = Array.from(caseFoldText(first), (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(caseFoldText(second), (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function compareTimestamp(first: bigint, second: bigint): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
