import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.ts";
import { SpotifyAuthError } from "../../src/adapters/spotify-auth.ts";
import { createServer } from "../../src/http/server.ts";
import type { CleanupPreview, MutationResult, OperationSummary, RestorePreview } from "../../src/application/removal-service.ts";
import { buildLibrary } from "../../src/domain/library.ts";

const config = loadConfig({
  SPOTIFY_CLIENT_ID: "client-id",
  SPOTIFY_CLIENT_SECRET: "never-return-this-secret",
  SPOTIFY_REDIRECT_URI: "http://127.0.0.1:3141/callback",
  PORT: "3141",
  RESULTS_DIR: "results",
});
const report = buildLibrary([], undefined, new Date("2025-01-01T00:00:00Z"));
const operationId = "operation-20250101T000000000Z-12345678-1234-1234-1234-123456789abc.json";
const cleanupPreview: CleanupPreview = { preview_id: "preview-id", groups: [], removal_count: 1, confirmation_text: "DELETE 1 TRACK" };
const restorePreview: RestorePreview = { preview_id: "restore-id", operation_id: operationId, tracks: [], restore_count: 1, confirmation_text: "RESTORE 1 TRACK" };
const mutation: MutationResult = { operation_id: operationId, track_count: 1 };
const operations: OperationSummary[] = [];

async function createTestServer(t: test.TestContext, connected = true): Promise<{ app: FastifyInstance; calls: unknown[] }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "liked-list-routes-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const template = path.join(directory, "dashboard.html");
  const bundle = path.join(directory, "dashboard.js");
  await writeFile(template, '<body data-offline="__OFFLINE_MODE__"><script id="library-data">__LIBRARY_JSON__</script><script defer src="/dashboard.js"></script></body>');
  await writeFile(bundle, "console.log('local bundle')");
  const calls: unknown[] = [];
  const library = {
    async getSnapshot() { return report; },
    async isSnapshotStale() { return false; },
    async sync() { calls.push("sync"); return report; },
  };
  const removal = {
    async previewCleanup(groupIds?: string[]) { calls.push(["previewCleanup", groupIds]); return cleanupPreview; },
    async previewCleanupForSongs(songIds: string[]) { calls.push(["previewCleanupForSongs", songIds]); return cleanupPreview; },
    async applyCleanup(id: string, confirmation: string) {
      calls.push(["applyCleanup", id, confirmation]);
      if (id === "missing") throw new Error("Cleanup preview is stale or already used.");
      return mutation;
    },
    async removeOne(id: string, confirmation: string) { calls.push(["removeOne", id, confirmation]); return mutation; },
    async previewRestore(id: string) { calls.push(["previewRestore", id]); return restorePreview; },
    async applyRestore(id: string, confirmation: string) { calls.push(["applyRestore", id, confirmation]); return mutation; },
    async listOperations() { return operations; },
  };
  const auth = {
    beginAuthorization() { return "https://accounts.spotify.com/authorize?state=generated"; },
    async completeAuthorization(parameters: URLSearchParams) { calls.push(["callback", parameters.get("code"), parameters.get("state")]); },
    async getAccessToken() { if (!connected) throw new SpotifyAuthError("Spotify is not connected."); return "access-token"; },
    async isConnected() { return connected; },
  };
  const app = createServer(config, { library, removal, auth }, { dashboardHtmlPath: template, dashboardBundlePath: bundle });
  t.after(() => app.close());
  return { app, calls };
}

function localHeaders(origin = "http://127.0.0.1:3141") {
  return { host: "127.0.0.1:3141", origin };
}

test("serves the dashboard and library status without exposing auth secrets", async (t) => {
  const { app } = await createTestServer(t);
  const page = await app.inject({ method: "GET", url: "/", headers: { host: "127.0.0.1:3141" } });
  const state = await app.inject({ method: "GET", url: "/api/library", headers: { host: "127.0.0.1:3141" } });
  const script = await app.inject({ method: "GET", url: "/dashboard.js", headers: { host: "127.0.0.1:3141" } });

  assert.equal(page.statusCode, 200);
  assert.match(page.body, /data-offline="false"/);
  assert.doesNotMatch(page.body, /never-return-this-secret|access-token/);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json(), { library: report, stale: false, connected: true });
  assert.equal(script.body, "console.log('local bundle')");
});

test("sync, duplicate, manual removal, and restore routes pass only approved service inputs", async (t) => {
  const { app, calls } = await createTestServer(t);
  const headers = localHeaders();
  const sync = await app.inject({ method: "POST", url: "/api/sync", headers, payload: {} });
  const groupId = "a".repeat(64);
  const preview = await app.inject({ method: "POST", url: "/api/cleanup/preview", headers, payload: { group_ids: [groupId] } });
  const groupReview = await app.inject({ method: "POST", url: "/api/cleanup/preview-group", headers, payload: { song_ids: ["USRC17607839"] } });
  const apply = await app.inject({ method: "POST", url: "/api/cleanup/apply", headers, payload: { preview_id: "preview-id", confirmation_text: "DELETE 1 TRACK" } });
  const manual = await app.inject({ method: "POST", url: "/api/tracks/0123456789012345678901/remove", headers, payload: { confirmation_text: "REMOVE Song — Artist" } });
  const restorePreviewResponse = await app.inject({ method: "POST", url: "/api/restore/preview", headers, payload: { operation_id: operationId } });
  const restore = await app.inject({ method: "POST", url: "/api/restore/apply", headers, payload: { preview_id: "restore-id", confirmation_text: "RESTORE 1 TRACK" } });
  const listed = await app.inject({ method: "GET", url: "/api/operations", headers: { host: "127.0.0.1:3141" } });

  assert.deepEqual([sync.statusCode, preview.statusCode, groupReview.statusCode, apply.statusCode, manual.statusCode, restorePreviewResponse.statusCode, restore.statusCode, listed.statusCode], [200, 200, 200, 200, 200, 200, 200, 200]);
  assert.deepEqual(calls, [
    "sync",
    ["previewCleanup", [groupId]],
    ["previewCleanupForSongs", ["USRC17607839"]],
    ["applyCleanup", "preview-id", "DELETE 1 TRACK"],
    ["removeOne", "0123456789012345678901", "REMOVE Song — Artist"],
    ["previewRestore", operationId],
    ["applyRestore", "restore-id", "RESTORE 1 TRACK"],
  ]);
  for (const response of [sync, preview, apply, manual, restorePreviewResponse, restore]) {
    assert.doesNotMatch(response.body, /never-return-this-secret|access-token/);
  }
});

test("rejects malformed bodies and service-rejected unknown or stale identifiers", async (t) => {
  const { app, calls } = await createTestServer(t);
  const headers = localHeaders();
  const badPreview = await app.inject({ method: "POST", url: "/api/cleanup/preview", headers, payload: { group_ids: "not-an-array" } });
  const badGroupPreview = await app.inject({ method: "POST", url: "/api/cleanup/preview-group", headers, payload: { song_ids: [] } });
  const badManual = await app.inject({ method: "POST", url: "/api/tracks/not-a-spotify-id/remove", headers, payload: { confirmation_text: "REMOVE" } });
  const staleApply = await app.inject({ method: "POST", url: "/api/cleanup/apply", headers, payload: { preview_id: "missing", confirmation_text: "DELETE 1 TRACK" } });

  assert.deepEqual([badPreview.statusCode, badGroupPreview.statusCode, badManual.statusCode], [400, 400, 400]);
  assert.equal(staleApply.statusCode, 409);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "applyCleanup"), true);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "previewCleanupForSongs"), false);
});

test("blocks sync and all Spotify writes when no authorization token is available", async (t) => {
  const { app, calls } = await createTestServer(t, false);
  const headers = localHeaders();
  const sync = await app.inject({ method: "POST", url: "/api/sync", headers, payload: {} });
  const apply = await app.inject({ method: "POST", url: "/api/cleanup/apply", headers, payload: { preview_id: "preview-id", confirmation_text: "DELETE 1 TRACK" } });
  const manual = await app.inject({ method: "POST", url: "/api/tracks/0123456789012345678901/remove", headers, payload: { confirmation_text: "REMOVE Song — Artist" } });
  const restore = await app.inject({ method: "POST", url: "/api/restore/apply", headers, payload: { preview_id: "restore-id", confirmation_text: "RESTORE 1 TRACK" } });

  assert.deepEqual([sync.statusCode, apply.statusCode, manual.statusCode, restore.statusCode], [401, 401, 401, 401]);
  assert.deepEqual(calls, []);
});

test("OAuth login redirects to Spotify and callback completes with parsed query parameters", async (t) => {
  const { app, calls } = await createTestServer(t);
  const login = await app.inject({ method: "GET", url: "/auth/login", headers: { host: "127.0.0.1:3141" } });
  const callback = await app.inject({ method: "GET", url: "/callback?code=auth-code&state=auth-state", headers: { host: "127.0.0.1:3141" } });

  assert.equal(login.statusCode, 302);
  assert.match(login.headers.location ?? "", /^https:\/\/accounts\.spotify\.com\/authorize/);
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, "/");
  assert.deepEqual(calls, [["callback", "auth-code", "auth-state"]]);
});
