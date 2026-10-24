import { createHash } from "node:crypto";
import { caseFold } from "unicode-case-folding";
import type { SongRecord, SpotifyTrack } from "./types.js";

export function caseFoldText(value: string): string {
  return caseFold(value);
}

export function normalizeText(value: string | null | undefined): string {
  return caseFoldText((value ?? "").replace(/\s+/gu, " ").trim());
}

export function trackIdentity(track: SpotifyTrack): SongRecord {
  const isrc = trackIsrc(track);
  return {
    title: track.name || "Unknown title",
    artists: (track.artists ?? []).map((artist) => artist.name || "Unknown artist"),
    album: track.album?.name || "Unknown album",
    spotify_id: track.id ?? null,
    duration_ms: track.duration_ms || 0,
    isrc,
    song_id: uniqueSongId(track, isrc),
    url: track.external_urls?.spotify ?? null,
    added_at: track.added_at ?? null,
  };
}

function trackIsrc(track: SpotifyTrack): string | null {
  const value = track.external_ids?.isrc;
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

function uniqueSongId(track: SpotifyTrack, isrc: string | null): string {
  if (isrc) return isrc;
  if (track.id) return `spotify:${track.id}`;

  const title = normalizeText(track.name);
  const artists = (track.artists ?? []).map((artist) => normalizeText(artist.name));
  const album = normalizeText(track.album?.name);
  const identityJson = `[${JSON.stringify(title)}, [${artists.map((artist) => JSON.stringify(artist)).join(", ")}], ${JSON.stringify(album)}]`;
  const digest = createHash("sha256").update(identityJson, "utf8").digest("hex");
  return `metadata:${digest}`;
}
