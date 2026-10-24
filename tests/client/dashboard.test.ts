import assert from "node:assert/strict";
import test from "node:test";
import { isLibraryReport, manualRemovalConfirmation, safeSpotifyUrl, syncAndRefresh } from "../../src/client/dashboard.ts";
import { buildLibrary } from "../../src/domain/library.ts";

test("dashboard validates report shape and creates the exact manual-removal confirmation", () => {
  const report = buildLibrary([]);
  assert.equal(isLibraryReport(report), true);
  assert.equal(isLibraryReport({ ...report, artists: "invalid" }), false);
  assert.equal(isLibraryReport({ ...report, statistics: {} }), false);
  assert.equal(manualRemovalConfirmation("Song", ["Artist", "Guest"]), "REMOVE Song — Artist, Guest");
});

test("sync completion runs after refresh and not when either step fails", async () => {
  const calls: string[] = [];
  await syncAndRefresh(
    async () => { calls.push("sync"); },
    async () => { calls.push("refresh"); },
    () => { calls.push("complete"); },
  );
  assert.deepEqual(calls, ["sync", "refresh", "complete"]);

  await assert.rejects(syncAndRefresh(
    async () => { throw new Error("sync failed"); },
    async () => { calls.push("unexpected refresh"); },
    () => { calls.push("unexpected completion"); },
  ), /sync failed/);
  await assert.rejects(syncAndRefresh(
    async () => { calls.push("sync before refresh failure"); },
    async () => { throw new Error("refresh failed"); },
    () => { calls.push("unexpected completion"); },
  ), /refresh failed/);
  assert.deepEqual(calls, ["sync", "refresh", "complete", "sync before refresh failure"]);
});

test("dashboard only turns Spotify-owned HTTPS URLs into links", () => {
  assert.equal(safeSpotifyUrl("https://open.spotify.com/track/abc"), "https://open.spotify.com/track/abc");
  assert.equal(safeSpotifyUrl("javascript:alert(1)"), null);
  assert.equal(safeSpotifyUrl("https://attacker.example/"), null);
});
