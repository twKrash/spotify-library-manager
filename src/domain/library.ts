import { caseFoldText, normalizeText, trackIdentity } from "./track-identity.js";
import type {
  ApiStatistics,
  DuplicateGroup,
  LibraryAlbum,
  LibraryArtist,
  LibraryReport,
  SavedLibraryStatistics,
  SongRecord,
  SpotifyTrack,
  ToonExport,
} from "./types.js";

const TOP_RANKING_LIMIT = 10;
const RECENT_PLAY_LIMIT = 50;

export function emptyApiStatistics(): ApiStatistics {
  return {
    top_rankings: {},
    recent_play_count: 0,
    recent_play_limit: RECENT_PLAY_LIMIT,
    recently_played: [],
    most_played_recent_tracks: [],
    most_played_recent_artists: [],
  };
}

export function findDuplicateGroups(songs: SongRecord[]): DuplicateGroup[] {
  const parents = songs.map((_song, index) => index);
  const matchingKeys = new Map<string, number>();

  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const parent = parents[index]!;
      parents[index] = root;
      index = parent;
    }
    return root;
  };

  const union = (first: number, second: number): void => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot;
  };

  for (const [index, song] of songs.entries()) {
    const keys: string[] = [];
    if (song.isrc) keys.push(JSON.stringify(["isrc", song.isrc]));

    const artists = song.artists.map(normalizeText).sort();
    const title = normalizeText(song.title);
    const album = normalizeText(song.album);
    if (
      title && title !== "unknown title" &&
      album && album !== "unknown album" &&
      artists.length > 0 && !artists.includes("unknown artist")
    ) {
      keys.push(JSON.stringify(["metadata", title, artists, album]));
    }

    for (const key of keys) {
      const previous = matchingKeys.get(key);
      if (previous === undefined) matchingKeys.set(key, index);
      else union(index, previous);
    }
  }

  const clusters = new Map<number, SongRecord[]>();
  for (const [index, song] of songs.entries()) {
    const root = find(index);
    const cluster = clusters.get(root) ?? [];
    cluster.push(song);
    clusters.set(root, cluster);
  }

  const groups: DuplicateGroup[] = [];
  for (const copies of clusters.values()) {
    if (copies.length < 2) continue;
    const representative = copies[0]!;
    groups.push({
      song_ids: [...new Set(copies.map((song) => song.song_id))].sort(),
      isrcs: [...new Set(copies.flatMap((song) => song.isrc ? [song.isrc] : []))].sort(),
      title: representative.title,
      artists: representative.artists,
      album: representative.album,
      copies: copies.length,
      extra_copies: copies.length - 1,
    });
  }

  return groups.sort((first, second) =>
    second.extra_copies - first.extra_copies || compareFolded(first.title, second.title),
  );
}

export function buildLibrary(
  tracks: SpotifyTrack[],
  apiStatistics: ApiStatistics = emptyApiStatistics(),
  now = new Date(),
): LibraryReport {
  const songs: SongRecord[] = [];
  const artistsByName = new Map<string, Map<string, SongRecord[]>>();

  for (const track of tracks) {
    const song = trackIdentity(track);
    songs.push(song);
    const artistNames = song.artists.length > 0 ? song.artists : ["Unknown artist"];

    for (const artistName of artistNames) {
      const albums = artistsByName.get(artistName) ?? new Map<string, SongRecord[]>();
      const albumSongs = albums.get(song.album) ?? [];
      albumSongs.push(song);
      albums.set(song.album, albumSongs);
      artistsByName.set(artistName, albums);
    }
  }

  const duplicates = findDuplicateGroups(songs);
  const extraDuplicateCount = duplicates.reduce((total, group) => total + group.extra_copies, 0);
  const topArtists = [...artistsByName.entries()]
    .map(([name, albums]) => ({
      name,
      track_count: [...albums.values()].reduce((count, rows) => count + rows.length, 0),
    }))
    .sort((first, second) => second.track_count - first.track_count || compareFolded(first.name, second.name))
    .slice(0, TOP_RANKING_LIMIT);
  const topAlbums = [...artistsByName.entries()].flatMap(([artist, albums]) =>
    [...albums.entries()].map(([name, rows]) => ({ artist, name, track_count: rows.length })),
  )
    .sort((first, second) =>
      second.track_count - first.track_count ||
      compareFolded(first.artist, second.artist) ||
      compareFolded(first.name, second.name),
    )
    .slice(0, TOP_RANKING_LIMIT);

  const library: LibraryArtist[] = [...artistsByName.entries()]
    .sort(([first], [second]) => compareFolded(first, second))
    .map(([name, albums]) => ({
      name,
      albums: [...albums.entries()]
        .sort(([first], [second]) => compareFolded(first, second))
        .map(([albumName, albumSongs]): LibraryAlbum => ({
          name: albumName,
          songs: [...albumSongs].sort((first, second) => compareFolded(first.title, second.title)),
        })),
    }));

  const savedLibrary: SavedLibraryStatistics = {
    track_count: songs.length,
    unique_track_count: songs.length - extraDuplicateCount,
    duplicate_group_count: duplicates.length,
    artist_count: artistsByName.size,
    artist_album_count: [...artistsByName.values()].reduce((count, albums) => count + albums.size, 0),
    top_artists: topArtists,
    top_albums: topAlbums,
    collection_runtime_ms: songs.reduce((total, song) => total + (song.duration_ms || 0), 0),
  };

  return {
    generated_at: now.toISOString().replace(/Z$/, "+00:00"),
    liked_track_count: songs.length,
    unique_song_count: songs.length - extraDuplicateCount,
    duplicate_song_count: duplicates.length,
    extra_duplicate_count: extraDuplicateCount,
    duplicates,
    artists: library,
    statistics: { saved_library: savedLibrary, ...apiStatistics },
  };
}

export function toonExportData(report: LibraryReport, tracks: SpotifyTrack[]): ToonExport {
  return {
    generated_at: report.generated_at,
    liked_track_count: report.liked_track_count,
    unique_song_count: report.unique_song_count,
    duplicate_song_count: report.duplicate_song_count,
    extra_duplicate_count: report.extra_duplicate_count,
    statistics: report.statistics,
    tracks: tracks.map(trackIdentity),
    duplicates: report.duplicates,
  };
}

function compareFolded(first: string, second: string): number {
  const firstFolded = caseFoldText(first);
  const secondFolded = caseFoldText(second);
  return firstFolded < secondFolded ? -1 : firstFolded > secondFolded ? 1 : 0;
}
