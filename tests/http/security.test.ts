import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config.ts";
import { buildLibrary } from "../../src/domain/library.ts";
import { createServer } from "../../src/http/server.ts";

const config = loadConfig({
  SPOTIFY_CLIENT_ID: "client-id",
  SPOTIFY_CLIENT_SECRET: "private-secret",
  SPOTIFY_REDIRECT_URI: "http://127.0.0.1:3141/callback",
  PORT: "3141",
  RESULTS_DIR: "results",
});

async function setup(t: test.TestContext) {
  const calls: string[] = [];
  const report = buildLibrary([]);
  const app = createServer(config, {
    library: {
      async getSnapshot() { return report; },
      async isSnapshotStale() { return false; },
      async sync() { calls.push("sync"); return report; },
    },
    removal: {
      async previewCleanup() { calls.push("preview"); return { preview_id: "preview", groups: [], removal_count: 0, confirmation_text: "DELETE 0 TRACKS" }; },
      async previewCleanupForSongs() { calls.push("preview-group"); return { preview_id: "preview", groups: [], removal_count: 0, confirmation_text: "DELETE 0 TRACKS" }; },
      async applyCleanup() { calls.push("apply"); return { operation_id: "op", track_count: 0 }; },
      async removeOne() { calls.push("remove"); return { operation_id: "op", track_count: 1 }; },
      async previewRestore() { calls.push("restore-preview"); return { preview_id: "p", operation_id: "op", tracks: [], restore_count: 0, confirmation_text: "RESTORE 0 TRACKS" }; },
      async applyRestore() { calls.push("restore"); return { operation_id: "op", track_count: 0 }; },
      async listOperations() { return []; },
    },
    auth: {
      beginAuthorization() { return "https://accounts.spotify.com/authorize"; },
      async completeAuthorization() {},
      async getAccessToken() { return "private-access-token"; },
      async isConnected() { return true; },
    },
  });
  t.after(() => app.close());
  return { app, calls };
}

const validHeaders = { host: "127.0.0.1:3141", origin: "http://127.0.0.1:3141" };

test("mutation routes reject off-origin, missing-origin, and invalid-host requests", async (t) => {
  const { app, calls } = await setup(t);
  const offOrigin = await app.inject({ method: "POST", url: "/api/sync", headers: { ...validHeaders, origin: "http://attacker.example" }, payload: {} });
  const missingOrigin = await app.inject({ method: "POST", url: "/api/cleanup/preview", headers: { host: validHeaders.host }, payload: {} });
  const invalidHost = await app.inject({ method: "POST", url: "/api/sync", headers: { host: "attacker.example", origin: "http://attacker.example" }, payload: {} });
  const allowed = await app.inject({ method: "POST", url: "/api/sync", headers: validHeaders, payload: {} });

  assert.deepEqual([offOrigin.statusCode, missingOrigin.statusCode, invalidHost.statusCode, allowed.statusCode], [403, 403, 403, 200]);
  assert.deepEqual(calls, ["sync"]);
});

test("does not emit cross-origin access headers or expose arbitrary filesystem paths", async (t) => {
  const { app } = await setup(t);
  const response = await app.inject({ method: "GET", url: "/api/library", headers: { host: validHeaders.host, origin: "http://attacker.example" } });
  const traversal = await app.inject({ method: "GET", url: "/../../etc/passwd", headers: { host: validHeaders.host } });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(traversal.statusCode, 404);
  assert.doesNotMatch(traversal.body, /root:/);
});
