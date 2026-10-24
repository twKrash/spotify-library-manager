import { caseFoldText, trackIdentity } from "../domain/track-identity.js";
import { emptyApiStatistics } from "../domain/library.js";
import type {
  ApiStatistics,
  RankingArtist,
  RecentArtistSummary,
  RecentPlay,
  RecentTrackSummary,
  SpotifyTrack,
  TopRanking,
} from "../domain/types.js";
import type { SpotifyApiPort } from "../ports/spotify-api.js";
import type { SpotifyAuthService } from "./spotify-auth.js";

const API_BASE = "https://api.spotify.com/v1/";
const SAVED_TRACKS_PAGE_SIZE = 50;
const TOP_RANKING_LIMIT = 10;
const RECENT_PLAY_LIMIT = 50;
const TOP_TIME_RANGES = {
  short_term: "about 4 weeks",
  medium_term: "about 6 months",
  long_term: "about 1 year",
} as const;
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

export class SpotifyApiError extends Error {
  constructor(message: string, readonly statusCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpotifyApiError";
  }
}

export class SpotifyHttpAdapter implements SpotifyApiPort {
  constructor(
    private readonly auth: Pick<SpotifyAuthService, "getAccessToken">,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  async listSavedTracks(): Promise<SpotifyTrack[]> {
    const tracks: SpotifyTrack[] = [];
    let offset = 0;
    while (true) {
      const query = new URLSearchParams({ limit: String(SAVED_TRACKS_PAGE_SIZE), offset: String(offset) });
      const page = await this.requestJson(`/me/tracks?${query}`);
      const items = requiredArray(page.items, "saved tracks items");
      const next = page.next;
      if (next !== null && typeof next !== "string") {
        throw new SpotifyApiError("Spotify returned an invalid saved-tracks page.");
      }
      for (const value of items) {
        const item = asRecord(value, "saved track item");
        if (item.track === null) continue;
        const addedAt = item.added_at;
        if (addedAt !== null && addedAt !== undefined && typeof addedAt !== "string") {
          throw new SpotifyApiError("Spotify returned an invalid saved-track date.");
        }
        tracks.push({ ...parseTrack(item.track), added_at: addedAt ?? null });
      }
      if (next === null) return tracks;
      if (items.length === 0) throw new SpotifyApiError("Spotify returned an empty page with more results.");
      offset += items.length;
    }
  }

  async getStatistics(): Promise<ApiStatistics> {
    const statistics = emptyApiStatistics();
    for (const [period, label] of Object.entries(TOP_TIME_RANGES)) {
      const query = new URLSearchParams({ time_range: period, limit: String(TOP_RANKING_LIMIT) });
      const artistsResponse = await this.requestJson(`/me/top/artists?${query}`);
      const tracksResponse = await this.requestJson(`/me/top/tracks?${query}`);
      const artists = requiredArray(artistsResponse.items, "top artists items").map(parseRankingArtist);
      const tracks = requiredArray(tracksResponse.items, "top tracks items").map(parseTrack);
      const ranking: TopRanking = {
        label,
        artists: artists.map((artist, index) => ({ ...artist, rank: index + 1 })),
        tracks: tracks.map((track, index) => ({ ...trackIdentity(track), rank: index + 1 })),
      };
      statistics.top_rankings[period] = ranking;
    }

    const recentResponse = await this.requestJson(`/me/player/recently-played?limit=${RECENT_PLAY_LIMIT}`);
    const recentItems = requiredArray(recentResponse.items, "recently played items");
    const recentlyPlayed: RecentPlay[] = [];
    for (const value of recentItems) {
      const item = asRecord(value, "recent play item");
      if (item.track === null) continue;
      if (item.played_at !== null && item.played_at !== undefined && typeof item.played_at !== "string") {
        throw new SpotifyApiError("Spotify returned an invalid play timestamp.");
      }
      recentlyPlayed.push({ ...trackIdentity(parseTrack(item.track)), played_at: item.played_at ?? null });
    }

    statistics.recent_play_count = recentlyPlayed.length;
    statistics.recently_played = recentlyPlayed;
    statistics.most_played_recent_tracks = summarizeRecentTracks(recentlyPlayed);
    statistics.most_played_recent_artists = summarizeRecentArtists(recentlyPlayed);
    return statistics;
  }

  async removeSavedTrackUris(uris: string[]): Promise<void> {
    await this.mutateSavedTracks("DELETE", uris);
  }

  async addSavedTrackUris(uris: string[]): Promise<void> {
    await this.mutateSavedTracks("PUT", uris);
  }

  private async mutateSavedTracks(method: "PUT" | "DELETE", uris: string[]): Promise<void> {
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 40 || uris.some((uri) => !TRACK_URI.test(uri))) {
      throw new SpotifyApiError("Spotify library requests require 1 to 40 valid track URIs.");
    }
    const query = new URLSearchParams({ uris: uris.join(",") });
    await this.request(`/me/library?${query}`, method);
  }

  private async request(path: string, method: "GET" | "PUT" | "DELETE" = "GET"): Promise<Response> {
    const url = new URL(path.replace(/^\//, ""), API_BASE);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: { authorization: `Bearer ${await this.auth.getAccessToken()}`, accept: "application/json" },
        redirect: "error",
      });
    } catch (error) {
      throw new SpotifyApiError("Unable to reach the Spotify API.", undefined, { cause: error });
    }
    if (!response.ok) throw new SpotifyApiError(`Spotify API request failed (${response.status}).`, response.status);
    return response;
  }

  private async requestJson(path: string): Promise<Record<string, unknown>> {
    const response = await this.request(path);
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new SpotifyApiError("Spotify returned invalid JSON.", undefined, { cause: error });
    }
    return asRecord(value, "response");
  }
}

function parseTrack(value: unknown): SpotifyTrack {
  const track = asRecord(value, "track");
  const artists = track.artists === null || track.artists === undefined
    ? track.artists
    : requiredArray(track.artists, "track artists").map((artist) => {
      const record = asRecord(artist, "artist");
      const name = optionalString(record.name, "artist name");
      return name === undefined ? {} : { name };
    });
  const album = track.album === null || track.album === undefined
    ? track.album
    : parseOptionalObjectString(track.album, "album", "name", "album name");
  const externalIds = track.external_ids === null || track.external_ids === undefined
    ? track.external_ids
    : parseOptionalObjectString(track.external_ids, "external IDs", "isrc", "ISRC");
  const externalUrls = track.external_urls === null || track.external_urls === undefined
    ? track.external_urls
    : parseOptionalObjectString(track.external_urls, "external URLs", "spotify", "Spotify URL");
  if (track.duration_ms !== undefined && track.duration_ms !== null && typeof track.duration_ms !== "number") {
    throw new SpotifyApiError("Spotify returned an invalid track duration.");
  }
  const id = optionalString(track.id, "track ID");
  const name = optionalString(track.name, "track name");
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(track.duration_ms === undefined ? {} : { duration_ms: track.duration_ms as number | null }),
    ...(artists === undefined ? {} : { artists }),
    ...(album === undefined ? {} : { album }),
    ...(externalIds === undefined ? {} : { external_ids: externalIds }),
    ...(externalUrls === undefined ? {} : { external_urls: externalUrls }),
  };
}

function parseOptionalObjectString<const Key extends string>(
  value: unknown,
  context: string,
  key: Key,
  fieldName: string,
): { [Property in Key]?: string | null } {
  const record = asRecord(value, context);
  const field = optionalString(record[key], fieldName);
  return field === undefined ? {} : { [key]: field } as { [Property in Key]?: string | null };
}

function parseRankingArtist(value: unknown): RankingArtist {
  const artist = asRecord(value, "top artist");
  const genres = artist.genres === undefined || artist.genres === null ? [] : requiredArray(artist.genres, "artist genres");
  if (genres.some((genre) => typeof genre !== "string")) throw new SpotifyApiError("Spotify returned invalid artist genres.");
  const externalUrls = artist.external_urls === undefined || artist.external_urls === null
    ? {}
    : asRecord(artist.external_urls, "artist external URLs");
  return {
    rank: 0,
    name: optionalString(artist.name, "artist name") ?? null,
    url: optionalString(externalUrls.spotify, "artist Spotify URL") ?? null,
    genres: genres as string[],
  };
}

function summarizeRecentTracks(plays: RecentPlay[]): RecentTrackSummary[] {
  const summaries = new Map<string, RecentTrackSummary>();
  for (const play of plays) {
    const summary = summaries.get(play.song_id);
    if (summary) summary.plays++;
    else summaries.set(play.song_id, {
      song_id: play.song_id,
      title: play.title,
      artists: play.artists,
      album: play.album,
      plays: 1,
    });
  }
  return [...summaries.values()]
    .sort((first, second) => second.plays - first.plays || compareFolded(first.title, second.title))
    .slice(0, TOP_RANKING_LIMIT);
}

function summarizeRecentArtists(plays: RecentPlay[]): RecentArtistSummary[] {
  const counts = new Map<string, number>();
  for (const play of plays) {
    for (const artist of new Set(play.artists)) counts.set(artist, (counts.get(artist) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, plays]) => ({ name, plays }))
    .sort((first, second) => second.plays - first.plays || compareFolded(first.name, second.name))
    .slice(0, TOP_RANKING_LIMIT);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpotifyApiError(`Spotify returned an invalid ${context}.`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new SpotifyApiError(`Spotify returned invalid ${context}.`);
  return value;
}

function optionalString(value: unknown, context: string): string | null | undefined {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new SpotifyApiError(`Spotify returned an invalid ${context}.`);
  }
  return value as string | null | undefined;
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
