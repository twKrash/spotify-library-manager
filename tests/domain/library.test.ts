import assert from "node:assert/strict";
import test from "node:test";
import { buildLibrary, emptyApiStatistics, findDuplicateGroups, toonExportData } from "../../src/domain/library.ts";
import { trackIdentity } from "../../src/domain/track-identity.ts";

const track = (id: string, title: string, album: string, duration: number, isrc?: string) => ({
  id,
  name: title,
  artists: [{ name: "Ada" }],
  album: { name: album },
  duration_ms: duration,
  external_ids: isrc ? { isrc } : {},
  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  added_at: "2024-01-01T00:00:00Z",
});

test("findDuplicateGroups joins independent ISRC and normalized-metadata links transitively", () => {
  const songs = [
    { ...trackIdentity(track("a", "Alpha", "First", 10, "ISRC-A")), artists: ["Main", " Guest"] },
    { ...trackIdentity(track("b", "Beta", "Second", 10, "ISRC-A")), artists: ["Guest", "Main"] },
    { ...trackIdentity(track("c", " beta  ", " SECOND ", 10)), artists: ["main", "guest"] },
  ];

  assert.deepEqual(findDuplicateGroups(songs), [{
    song_ids: ["ISRC-A", "spotify:c"],
    isrcs: ["ISRC-A"],
    title: "Alpha",
    artists: ["Main", " Guest"],
    album: "First",
    copies: 3,
    extra_copies: 2,
  }]);
});

test("findDuplicateGroups excludes incomplete unknown metadata and sorts groups by extra copies", () => {
  const unknowns = [trackIdentity({ id: null }), trackIdentity({ id: "", name: "Unknown title", artists: [{ name: "Unknown artist" }], album: { name: "Unknown album" } })];
  const small = [trackIdentity(track("d", "Zebra", "Album", 10, "ISRC-D")), trackIdentity(track("e", "Zebra", "Album", 10, "ISRC-D"))];
  const large = [trackIdentity(track("f", "Apple", "Album", 10, "ISRC-F")), trackIdentity(track("g", "Apple", "Album", 10, "ISRC-F")), trackIdentity(track("h", "Apple", "Album", 10, "ISRC-F"))];

  assert.deepEqual(findDuplicateGroups([...unknowns, ...small, ...large]).map(({ title, copies, extra_copies }) => ({ title, copies, extra_copies })), [
    { title: "Apple", copies: 3, extra_copies: 2 },
    { title: "Zebra", copies: 2, extra_copies: 1 },
  ]);
});

test("findDuplicateGroups applies Unicode case folding without merging dotless i", () => {
  const sharpS = [
    trackIdentity({ id: "sharp", name: "Straße", artists: [{ name: "Band" }], album: { name: "Record" } }),
    trackIdentity({ id: "ascii", name: "STRASSE", artists: [{ name: "band" }], album: { name: "record" } }),
  ];
  const dotlessI = [
    trackIdentity({ id: "dotless", name: "ı", artists: [{ name: "Band" }], album: { name: "Record" } }),
    trackIdentity({ id: "latin", name: "i", artists: [{ name: "Band" }], album: { name: "Record" } }),
  ];

  assert.equal(findDuplicateGroups(sharpS)[0]?.copies, 2);
  assert.deepEqual(findDuplicateGroups(dotlessI), []);
});

test("buildLibrary preserves the full statistics and reports deterministic hierarchy and counts", () => {
  const tracks = [
    track("1", "Same", "Disc", 100, "US-X"),
    track("2", "Same", "Disc", 100, "US-X"),
    track("3", "Solo", "Disc 2", 200),
  ];
  const stats = {
    ...emptyApiStatistics(),
    top_rankings: {
      short_term: { label: "about 4 weeks", artists: [], tracks: [] },
      medium_term: { label: "about 6 months", artists: [], tracks: [] },
      long_term: { label: "about 1 year", artists: [], tracks: [] },
    },
    recent_play_count: 1,
    recently_played: [{ played_at: "2024-01-01T00:00:00Z", ...trackIdentity(tracks[2]!) }],
  };
  const report = buildLibrary(tracks, stats, new Date("2024-01-02T03:04:05.006Z"));

  assert.equal(report.generated_at, "2024-01-02T03:04:05.006+00:00");
  assert.equal(report.liked_track_count, 3);
  assert.equal(report.unique_song_count, 2);
  assert.equal(report.duplicate_song_count, 1);
  assert.equal(report.extra_duplicate_count, 1);
  assert.deepEqual(report.statistics.saved_library, {
    track_count: 3,
    unique_track_count: 2,
    duplicate_group_count: 1,
    artist_count: 1,
    artist_album_count: 2,
    top_artists: [{ name: "Ada", track_count: 3 }],
    top_albums: [
      { artist: "Ada", name: "Disc", track_count: 2 },
      { artist: "Ada", name: "Disc 2", track_count: 1 },
    ],
    collection_runtime_ms: 400,
  });
  assert.deepEqual(report.artists.map((artist) => artist.name), ["Ada"]);
  assert.deepEqual(report.artists[0]?.albums.map((album) => album.name), ["Disc", "Disc 2"]);
  assert.deepEqual(report.artists[0]?.albums[0]?.songs.map((song) => song.title), ["Same", "Same"]);
  assert.deepEqual(report.statistics.top_rankings, stats.top_rankings);
  assert.equal(report.statistics.recent_play_count, 1);
});

test("buildLibrary returns complete empty-statistics defaults for an empty collection", () => {
  const report = buildLibrary([], undefined, new Date("2024-01-02T00:00:00.000Z"));
  assert.deepEqual(report.statistics, { saved_library: {
    track_count: 0,
    unique_track_count: 0,
    duplicate_group_count: 0,
    artist_count: 0,
    artist_album_count: 0,
    top_artists: [],
    top_albums: [],
    collection_runtime_ms: 0,
  }, ...emptyApiStatistics() });
});

test("toonExportData emits the same compact top-level contract and ordered track rows", () => {
  const tracks = [track("1", "One", "Album", 100)];
  const report = buildLibrary(tracks, undefined, new Date("2024-01-02T00:00:00.000Z"));
  assert.deepEqual(toonExportData(report, tracks), {
    generated_at: "2024-01-02T00:00:00.000+00:00",
    liked_track_count: 1,
    unique_song_count: 1,
    duplicate_song_count: 0,
    extra_duplicate_count: 0,
    statistics: report.statistics,
    tracks: [trackIdentity(tracks[0]!)],
    duplicates: [],
  });
});
