import assert from "node:assert/strict";
import test from "node:test";
import { trackIdentity } from "../../src/domain/track-identity.ts";

const baseTrack = () => ({
  id: "track-1",
  name: "Night Drive",
  artists: [{ name: "Echo Group" }],
  album: { name: "After Hours" },
  duration_ms: 192000,
  external_ids: { isrc: " us-abC-12345 " },
  external_urls: { spotify: "https://open.spotify.com/track/track-1" },
  added_at: "2024-02-03T04:05:06Z",
});

test("trackIdentity normalizes ISRC and preserves the saved-track fields", () => {
  assert.deepEqual(trackIdentity(baseTrack()), {
    title: "Night Drive",
    artists: ["Echo Group"],
    album: "After Hours",
    spotify_id: "track-1",
    duration_ms: 192000,
    isrc: "US-ABC-12345",
    song_id: "US-ABC-12345",
    url: "https://open.spotify.com/track/track-1",
    added_at: "2024-02-03T04:05:06Z",
  });
});

test("trackIdentity falls back from ISRC to Spotify ID", () => {
  assert.equal(trackIdentity({ ...baseTrack(), external_ids: { isrc: " " } }).song_id, "spotify:track-1");
});

test("trackIdentity uses a stable metadata hash when both external identifiers are missing", () => {
  const track = { ...baseTrack(), id: null, external_ids: {}, name: "Track A", artists: [{ name: "Artist" }], album: { name: "Album" } };
  assert.equal(trackIdentity(track).song_id, "metadata:b66b868832f14d4d580ee675ba2319948966eb41530b7d2aa1fc4e0e9df40daf");
});

test("trackIdentity uses the current fallback labels and handles absent optional fields", () => {
  assert.deepEqual(trackIdentity({}), {
    title: "Unknown title",
    artists: [],
    album: "Unknown album",
    spotify_id: null,
    duration_ms: 0,
    isrc: null,
    song_id: "metadata:abb19f64e2988043ba056da3bbcaf278ab2a21ce23666f14a0d875d27ace7a88",
    url: null,
    added_at: null,
  });
});
