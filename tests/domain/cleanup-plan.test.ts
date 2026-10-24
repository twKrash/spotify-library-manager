import assert from "node:assert/strict";
import test from "node:test";
import { buildCleanupPlan } from "../../src/domain/cleanup-plan.ts";
import { group, library, song } from "../fixtures/cleanup.ts";

test("buildCleanupPlan keeps the uniquely newest copy and orders the remaining removals", () => {
  const report = library([
    song("later-old", "key", "2023-02-01T00:00:00Z"),
    song("earlier-old", "key", "2023-01-01T00:00:00Z"),
    song("newest", "key", "2024-01-01T00:00:00Z"),
  ], [group(["key"], "Song", ["Alpha"], 3)]);

  assert.deepEqual(buildCleanupPlan(report), [{
    artist: "Alpha",
    extra_copies: 2,
    groups: [{
      group: group(["key"], "Song", ["Alpha"], 3),
      keep: { id: "newest", added_at: "2024-01-01T00:00:00Z", title: "Song", artists: ["Alpha"], album: "Album" },
      remove: [
        { id: "earlier-old", added_at: "2023-01-01T00:00:00Z", title: "Song", artists: ["Alpha"], album: "Album" },
        { id: "later-old", added_at: "2023-02-01T00:00:00Z", title: "Song", artists: ["Alpha"], album: "Album" },
      ],
    }],
  }]);
});

test("buildCleanupPlan accepts retained groups and preserves their extra fields", () => {
  const duplicateGroup = {
    song_ids: ["song-key"],
    title: "Song",
    artists: ["Alpha"],
    copies: 2,
    extra_copies: 1,
    retained_field: "legacy-value",
  };
  const report = { ...library(), duplicates: [duplicateGroup] };
  assert.deepEqual(buildCleanupPlan(report)[0]?.groups[0]?.group, duplicateGroup);
});

test("buildCleanupPlan accepts Python-compatible space-separated timezone-aware dates", () => {
  const report = library([
    song("older", "key", "2023-01-01 00:00:00+00:00"),
    song("newer", "key", "2024-01-01 00:00:00+00:00"),
  ], [group(["key"], "Song", ["Alpha"], 2)]);
  report.generated_at = "2024-01-02 00:00:00+00:00";
  assert.equal(buildCleanupPlan(report)[0]?.groups[0]?.keep.id, "newer");
});

test("buildCleanupPlan preserves microsecond order for far-future saved dates", () => {
  const report = library([
    song("older", "key", "9999-12-31T23:59:59.000000Z"),
    song("newer", "key", "9999-12-31T23:59:59.000001Z"),
  ], [group(["key"], "Song", ["Alpha"], 2)]);
  assert.equal(buildCleanupPlan(report)[0]?.groups[0]?.keep.id, "newer");
});

test("buildCleanupPlan deduplicates the same saved track repeated under multiple artists", () => {
  const songRows = [
    song("old", "shared", "2023-01-01T00:00:00Z", "Song", ["Alpha", "Beta"]),
    song("new", "shared", "2024-01-01T00:00:00Z", "Song", ["Alpha", "Beta"]),
  ];
  const report = {
    ...library(songRows, [group(["shared"], "Song", ["Alpha", "Beta"], 2)]),
    artists: [
      { name: "Alpha", albums: [{ name: "Album", songs: songRows }] },
      { name: "Beta", albums: [{ name: "Album", songs: songRows }] },
    ],
  };
  assert.equal(buildCleanupPlan(report)[0]?.groups[0]?.remove.length, 1);
});

test("buildCleanupPlan fails closed on invalid report timestamps and missing or malformed saved dates", () => {
  assert.throws(() => buildCleanupPlan({ ...library(), generated_at: "not-a-date" }), /generated_at/);
  assert.throws(() => buildCleanupPlan({ ...library(), generated_at: "2024-01-02T00:00:00" }), /timezone/);
  for (const addedAt of [undefined, "not-a-date", "2023-01-01T00:00:00"]) {
    assert.throws(() => buildCleanupPlan(library([
      song("old", "song-key", addedAt as string),
      song("new", "song-key", "2024-01-01T00:00:00Z"),
    ])));
  }
});

test("buildCleanupPlan rejects invalid hierarchy, count mismatch, and conflicting track records", () => {
  assert.throws(() => buildCleanupPlan({ ...library(), artists: null }), /artist list/);
  assert.throws(() => buildCleanupPlan({ ...library(), liked_track_count: 9 }), /track count/);
  const conflict = library();
  conflict.artists.push({ name: "Beta", albums: [{ name: "Other", songs: [song("old", "different-key", "2023-01-01T00:00:00Z")] }] });
  assert.throws(() => buildCleanupPlan(conflict), /conflicting records/);
});

test("buildCleanupPlan rejects mapping mismatches, repeated IDs, and newest-date ties", () => {
  assert.throws(() => buildCleanupPlan(library(undefined, [group(["missing"], "Song", ["Alpha"], 2)])), /map all/);
  const repeated = library([
    song("same", "first", "2023-01-01T00:00:00Z"),
    song("same", "second", "2024-01-01T00:00:00Z"),
  ], [group(["first", "second"], "Song", ["Alpha"], 2)]);
  assert.throws(() => buildCleanupPlan(repeated), /conflicting records|repeats a Spotify ID/);
  assert.throws(() => buildCleanupPlan(library([
    song("old", "key", "2024-01-01T00:00:00Z"),
    song("new", "key", "2024-01-01T00:00:00Z"),
  ], [group(["key"], "Song", ["Alpha"], 2)])), /tied for newest/);
});

test("buildCleanupPlan orders casefolded Unicode strings by code point", () => {
  const tracks = [
    song("fullwidth-old", "fullwidth", "2023-01-01T00:00:00Z", "Song", ["Ａlpha"]),
    song("fullwidth-new", "fullwidth", "2024-01-01T00:00:00Z", "Song", ["Ａlpha"]),
    song("emoji-old", "emoji", "2023-01-01T00:00:00Z", "Song", ["😀 Band"]),
    song("emoji-new", "emoji", "2024-01-01T00:00:00Z", "Song", ["😀 Band"]),
  ];
  const report = {
    ...library(tracks, [
      group(["fullwidth"], "Song", ["Ａlpha"], 2),
      group(["emoji"], "Song", ["😀 Band"], 2),
    ]),
    artists: [
      { name: "Ａlpha", albums: [{ name: "Album", songs: tracks.slice(0, 2) }] },
      { name: "😀 Band", albums: [{ name: "Album", songs: tracks.slice(2) }] },
    ],
  };
  assert.deepEqual(buildCleanupPlan(report).map((band) => band.artist), ["Ａlpha", "😀 Band"]);

  const titleTracks = [
    song("emoji-title-old", "emoji-title", "2023-01-01T00:00:00Z", "😀 Track", ["Band"]),
    song("emoji-title-new", "emoji-title", "2024-01-01T00:00:00Z", "😀 Track", ["Band"]),
    song("fullwidth-title-old", "fullwidth-title", "2023-01-01T00:00:00Z", "ＡTrack", ["Band"]),
    song("fullwidth-title-new", "fullwidth-title", "2024-01-01T00:00:00Z", "ＡTrack", ["Band"]),
  ];
  const titleReport = {
    ...library(titleTracks, [
      group(["emoji-title"], "😀 Track", ["Band"], 2),
      group(["fullwidth-title"], "ＡTrack", ["Band"], 2),
    ]),
    artists: [{ name: "Band", albums: [{ name: "Album", songs: titleTracks }] }],
  };
  assert.deepEqual(buildCleanupPlan(titleReport)[0]?.groups.map(({ group: duplicate }) => duplicate.title), ["ＡTrack", "😀 Track"]);
});

test("buildCleanupPlan sorts bands by extra copies and groups by duplicate size", () => {
  const tracks = [
    song("a1", "a", "2023-01-01T00:00:00Z", "Zebra", ["Alpha"]),
    song("a2", "a", "2024-01-01T00:00:00Z", "Zebra", ["Alpha"]),
    song("b1", "b", "2023-01-01T00:00:00Z", "Beta", ["Beta"]),
    song("b2", "b", "2023-02-01T00:00:00Z", "Beta", ["Beta"]),
    song("b3", "b", "2024-01-01T00:00:00Z", "Beta", ["Beta"]),
  ];
  const report = {
    ...library(tracks, [group(["a"], "Zebra", ["Alpha"], 2), group(["b"], "Beta", ["Beta"], 3)]),
    artists: [
      { name: "Alpha", albums: [{ name: "Album", songs: tracks.slice(0, 2) }] },
      { name: "Beta", albums: [{ name: "Album", songs: tracks.slice(2) }] },
    ],
  };
  assert.deepEqual(buildCleanupPlan(report).map(({ artist, extra_copies }) => ({ artist, extra_copies })), [
    { artist: "Beta", extra_copies: 2 },
    { artist: "Alpha", extra_copies: 1 },
  ]);
});
