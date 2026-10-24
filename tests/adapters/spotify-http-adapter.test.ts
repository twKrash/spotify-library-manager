import assert from "node:assert/strict";
import test from "node:test";
import { SpotifyHttpAdapter } from "../../src/adapters/spotify-http-adapter.ts";
import type { SpotifyTrack } from "../../src/domain/types.ts";

const token = { async getAccessToken() { return "access-secret"; } };

function track(id: string, name = `Track ${id}`): SpotifyTrack {
  return {
    id,
    name,
    artists: [{ name: "Artist" }],
    album: { name: "Album" },
    duration_ms: 180_000,
    external_ids: { isrc: "USAAA0000001" },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("saved tracks pagination uses 50-item pages and preserves each saved date", async () => {
  const requests: string[] = [];
  const adapter = new SpotifyHttpAdapter(token, async (url) => {
    requests.push(String(url));
    const offset = Number(new URL(String(url)).searchParams.get("offset"));
    return offset === 0
      ? json({ items: Array.from({ length: 50 }, (_, index) => ({ track: track(`id-${index}`), added_at: "2024-01-01T00:00:00Z" })), next: "https://api.spotify.com/v1/me/tracks?offset=50", total: 51 })
      : json({ items: [{ track: track("id-50"), added_at: "2024-02-03T04:05:06Z" }], next: null, total: 51 });
  });

  const saved = await adapter.listSavedTracks();
  assert.equal(saved.length, 51);
  assert.equal(saved[0]?.added_at, "2024-01-01T00:00:00Z");
  assert.equal(saved[50]?.id, "id-50");
  assert.equal(saved[50]?.added_at, "2024-02-03T04:05:06Z");
  assert.deepEqual(requests.map((url) => new URL(url).searchParams.get("offset")), ["0", "50"]);
  assert.ok(requests.every((url) => new URL(url).searchParams.get("limit") === "50"));
});

test("statistics include all ranking ranges and summarize the recent-play sample", async () => {
  const requests: string[] = [];
  const adapter = new SpotifyHttpAdapter(token, async (url) => {
    const parsed = new URL(String(url));
    requests.push(parsed.pathname + parsed.search);
    if (parsed.pathname.endsWith("/top/artists")) {
      return json({ items: [{ name: "Artist", genres: ["rock"], external_urls: { spotify: "https://open.spotify.com/artist/artist" } }] });
    }
    if (parsed.pathname.endsWith("/top/tracks")) {
      return json({ items: [track("track-id", "Repeated Track")] });
    }
    if (parsed.pathname.endsWith("/recently-played")) {
      return json({ items: [
        { track: track("track-id", "Repeated Track"), played_at: "2025-01-01T00:00:00Z" },
        { track: track("track-id", "Repeated Track"), played_at: "2025-01-02T00:00:00Z" },
      ] });
    }
    throw new Error(`Unexpected URL ${parsed.href}`);
  });

  const statistics = await adapter.getStatistics();
  assert.equal(requests.length, 7);
  assert.deepEqual(Object.keys(statistics.top_rankings), ["short_term", "medium_term", "long_term"]);
  assert.equal(statistics.top_rankings.short_term?.artists[0]?.rank, 1);
  assert.equal(statistics.top_rankings.short_term?.artists[0]?.name, "Artist");
  assert.equal(statistics.top_rankings.short_term?.tracks[0]?.title, "Repeated Track");
  assert.equal(statistics.recent_play_count, 2);
  assert.equal(statistics.most_played_recent_tracks[0]?.plays, 2);
  assert.equal(statistics.most_played_recent_artists[0]?.plays, 2);
});

test("library mutations use the current endpoint, bearer auth, and at most 40 track URIs", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const adapter = new SpotifyHttpAdapter(token, async (input, init) => {
    requests.push({ url: new URL(String(input)), init: init ?? {} });
    return json({ snapshot_id: "snapshot" });
  });
  const uris = ["spotify:track:0123456789012345678901", "spotify:track:1123456789012345678901"];

  await adapter.addSavedTrackUris(uris);
  await adapter.removeSavedTrackUris(uris);
  assert.deepEqual(requests.map(({ init }) => init.method), ["PUT", "DELETE"]);
  assert.ok(requests.every(({ url, init }) => url.pathname === "/v1/me/library" && url.searchParams.get("uris") === uris.join(",")));
  assert.ok(requests.every(({ init }) => (init.headers as Record<string, string>).authorization === "Bearer access-secret"));
  await assert.rejects(adapter.removeSavedTrackUris(Array.from({ length: 41 }, (_, index) => `spotify:track:${String(index).padStart(22, "0")}`)), /40/);
  assert.equal(requests.length, 2);
});

test("saved-track pagination rejects malformed pages and later-page failures", async () => {
  const malformed = new SpotifyHttpAdapter(token, async () => json({ items: "not-an-array", next: null }));
  await assert.rejects(malformed.listSavedTracks(), /invalid saved tracks items/);

  let requestCount = 0;
  const laterFailure = new SpotifyHttpAdapter(token, async () => {
    requestCount++;
    return requestCount === 1
      ? json({ items: Array.from({ length: 50 }, (_, index) => ({ track: track(`id-${index}`), added_at: "2024-01-01T00:00:00Z" })), next: "more", total: 51 })
      : new Response("private provider response", { status: 503 });
  });
  await assert.rejects(laterFailure.listSavedTracks(), /Spotify API request failed \(503\)/);
  assert.equal(requestCount, 2);
});

test("Spotify API errors do not leak response bodies or bearer tokens", async () => {
  const adapter = new SpotifyHttpAdapter(token, async () => new Response("access-secret-private error", { status: 500 }));

  await assert.rejects(adapter.listSavedTracks(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Spotify API request failed/);
    assert.doesNotMatch(error.message, /access-secret|private error/);
    return true;
  });
});
