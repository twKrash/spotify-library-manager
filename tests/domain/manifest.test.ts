import assert from "node:assert/strict";
import test from "node:test";
import { buildCleanupPlan } from "../../src/domain/cleanup-plan.ts";
import { createCleanupManifest, createManualRemovalManifest, restoreCandidates, validateManifest } from "../../src/domain/manifest.ts";
import { library } from "../fixtures/cleanup.ts";

const now = new Date("2024-02-01T00:00:00.000Z");
const cleanupPlan = () => buildCleanupPlan(library());
const track = { id: "old", added_at: "2023-01-01T00:00:00Z", title: "Song", artists: ["Alpha"], album: "Album" };

test("createCleanupManifest preserves schema-v1 cleanup shape and initializes durable progress", () => {
  const manifest = createCleanupManifest(cleanupPlan(), now);
  assert.deepEqual(manifest, {
    schema_version: 1,
    created_at: "2024-02-01T00:00:00.000+00:00",
    cleanup_status: "in_progress",
    restore_status: "not_started",
    groups: [{
      keep: { id: "new", added_at: "2024-01-01T00:00:00Z", title: "Song", artists: ["Alpha"], album: "Album" },
      remove: [track],
    }],
    deleted_track_ids: [],
    restored_track_ids: [],
  });
  assert.deepEqual(validateManifest(manifest), manifest);
});

test("createManualRemovalManifest writes a distinct validated schema and is restorable", () => {
  const manifest = createManualRemovalManifest(track, now);
  assert.deepEqual(manifest, {
    schema_version: 2,
    operation: "manual_removal",
    created_at: "2024-02-01T00:00:00.000+00:00",
    status: "in_progress",
    restore_status: "not_started",
    tracks: [track],
    deleted_track_ids: [],
    restored_track_ids: [],
  });
  assert.deepEqual(validateManifest(manifest), manifest);
  assert.deepEqual(restoreCandidates(manifest, new Set()), [track]);
});

test("validateManifest accepts Python-compatible space-separated timezone-aware dates", () => {
  const valid = createCleanupManifest(cleanupPlan(), now);
  const compatible = {
    ...valid,
    created_at: "2024-02-01 00:00:00+00:00",
    groups: valid.groups.map((entry) => ({
      keep: { ...entry.keep, added_at: "2024-01-01 00:00:00+00:00" },
      remove: entry.remove.map((item) => ({ ...item, added_at: "2023-01-01 00:00:00+00:00" })),
    })),
  };
  assert.deepEqual(validateManifest(compatible), compatible);
});

test("validateManifest preserves unknown fields in retained v1 manifests and track records", () => {
  const valid = createCleanupManifest(cleanupPlan(), now);
  const extended = {
    ...valid,
    retained_field: { source: "older-version" },
    groups: valid.groups.map((entry) => ({
      keep: { ...entry.keep, retained_track_field: "keep-me" },
      remove: entry.remove.map((item) => ({ ...item, retained_track_field: "keep-me-too" })),
    })),
  };
  assert.deepEqual(validateManifest(extended), extended);
});

test("validateManifest rejects unsupported schemas, invalid statuses, and duplicate or overlapping IDs", () => {
  const valid = createCleanupManifest(cleanupPlan(), now);
  assert.throws(() => validateManifest({ ...valid, schema_version: 9 }), /Unsupported cleanup manifest version/);
  assert.throws(() => validateManifest({ ...valid, cleanup_status: "done" }), /cleanup status/);
  assert.throws(() => validateManifest({ ...valid, deleted_track_ids: ["not-removed"] }), /deleted_track_ids/);
  const overlap = { ...valid, groups: [{ keep: track, remove: [track] }] };
  assert.throws(() => validateManifest(overlap), /overlaps kept and removed/);
  const duplicate = { ...valid, groups: [{ keep: { ...track, id: "keep" }, remove: [track, track] }] };
  assert.throws(() => validateManifest(duplicate), /repeats a removal track ID/);
});

test("validateManifest fails closed for invalid track dates and malformed manual manifests", () => {
  const valid = createCleanupManifest(cleanupPlan(), now);
  const invalidTrack = { ...valid, groups: [{ keep: { ...track, added_at: "2024-01-01T00:00:00" }, remove: [track] }] };
  assert.throws(() => validateManifest(invalidTrack), /timezone/);
  assert.throws(() => validateManifest({ ...valid, created_at: "2024-01-01T00:00:00" }), /timezone/);
  assert.throws(() => validateManifest({
    ...createManualRemovalManifest(track, now),
    operation: "other",
  }), /manual removal/);
  assert.throws(() => validateManifest({
    ...createManualRemovalManifest(track, now),
    tracks: [],
  }), /no tracks/);
});

test("restoreCandidates reads v1 cleanup and v2 manual manifests and excludes tracks already saved", () => {
  const cleanup = createCleanupManifest(cleanupPlan(), now);
  const manual = createManualRemovalManifest(track, now);
  assert.deepEqual(restoreCandidates(cleanup, new Set(["old"])), []);
  assert.deepEqual(restoreCandidates(cleanup, new Set()), [track]);
  assert.deepEqual(restoreCandidates(manual, new Set(["old"])), []);
});

