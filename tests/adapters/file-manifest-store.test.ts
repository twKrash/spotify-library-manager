import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildCleanupPlan } from "../../src/domain/cleanup-plan.ts";
import { createCleanupManifest, validateManifest } from "../../src/domain/manifest.ts";
import { FileManifestStore, type ManifestFileHandle, type ManifestFileSystem } from "../../src/adapters/file-manifest-store.ts";
import { library } from "../fixtures/cleanup.ts";

function cleanupManifest() {
  return createCleanupManifest(buildCleanupPlan(library()));
}

function realFileSystem(): ManifestFileSystem {
  return {
    mkdir: (path, options) => fsPromises.mkdir(path, options),
    open: (path, flags, mode) => fsPromises.open(path, flags, mode),
    readFile: (path, encoding) => fsPromises.readFile(path, encoding),
    rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
    unlink: (path) => fsPromises.unlink(path),
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "liked-list-manifest-test-"));
}

test("FileManifestStore creates exclusive private manifests in its directory", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileManifestStore(directory);
  const path = await store.create(cleanupManifest());
  const parsed = validateManifest(JSON.parse(await readFile(path, "utf8")));

  assert.equal(parsed.schema_version, 1);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readdir(directory)).length, 1);
});

test("FileManifestStore lists and reads manifests by opaque ID and rejects symlinks", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileManifestStore(directory);
  const path = await store.create(cleanupManifest());
  const id = basename(path);

  assert.equal((await store.read(id)).schema_version, 1);
  assert.deepEqual((await store.list()).map((entry) => entry.id), [id]);
  await assert.rejects(store.read(`../${id}`), /ID is invalid/);

  const alias = await store.create(cleanupManifest());
  await rm(alias);
  await symlink(path, alias);
  await assert.rejects(store.read(basename(alias)), /regular file/);
});

test("create syncs newly created directories before and after creating the manifest", async (t) => {
  const root = await temporaryDirectory();
  const directory = join(root, "nested", "manifests");
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = realFileSystem();
  const events: string[] = [];
  const recording: ManifestFileSystem = {
    ...base,
    open: async (file, flags, mode) => {
      const handle = await base.open(file, flags, mode);
      return {
        writeFile: (data, options) => handle.writeFile(data, options),
        sync: async () => {
          events.push(flags === "r" ? "directory-sync" : "file-sync");
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };

  await new FileManifestStore(directory, recording).create(cleanupManifest());
  const fileSync = events.indexOf("file-sync");
  assert.ok(events.slice(0, fileSync).includes("directory-sync"));
  assert.deepEqual(events.slice(-2), ["file-sync", "directory-sync"]);
});

test("FileManifestStore never opens a manifest path without exclusive create", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = realFileSystem();
  let requestedFlags = "";
  const collision: ManifestFileSystem = {
    ...base,
    open: async (path, flags, mode) => {
      if (flags === "r") return base.open(path, flags, mode);
      requestedFlags = flags;
      assert.equal(mode, 0o600);
      throw new Error("simulated path collision");
    },
  };

  await assert.rejects(new FileManifestStore(directory, collision).create(cleanupManifest()), /simulated path collision/);
  assert.equal(requestedFlags, "wx");
  assert.deepEqual(await readdir(directory), []);
});

test("create fails closed when its manifest directory cannot be synced", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = realFileSystem();
  const failing: ManifestFileSystem = {
    ...base,
    open: async (path, flags, mode) => {
      const handle = await base.open(path, flags, mode);
      if (flags !== "r") return handle;
      return {
        writeFile: (data, options) => handle.writeFile(data, options),
        sync: async () => { throw new Error("injected directory sync failure"); },
        close: () => handle.close(),
      };
    },
  };

  await assert.rejects(new FileManifestStore(directory, failing).create(cleanupManifest()), /durability cannot be confirmed/);
  assert.deepEqual(await readdir(directory), []);
});

test("recordBatch syncs its directory after the atomic replacement", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = await new FileManifestStore(directory).create(cleanupManifest());
  const base = realFileSystem();
  const events: string[] = [];
  const recording: ManifestFileSystem = {
    ...base,
    open: async (file, flags, mode) => {
      const handle = await base.open(file, flags, mode);
      return {
        writeFile: (data, options) => handle.writeFile(data, options),
        sync: async () => {
          events.push(flags === "r" ? "directory-sync" : "file-sync");
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
    rename: async (temporary, target) => {
      await base.rename(temporary, target);
      events.push("rename");
    },
  };

  await new FileManifestStore(directory, recording).recordBatch(path, "deleted_track_ids", ["old"]);
  assert.deepEqual(events.slice(-3), ["file-sync", "rename", "directory-sync"]);
});

test("recordBatch atomically records only validated, idempotent progress", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileManifestStore(directory);
  const path = await store.create(cleanupManifest());

  await store.recordBatch(path, "deleted_track_ids", ["old"]);
  await store.recordBatch(path, "deleted_track_ids", ["old"]);
  const parsed = validateManifest(JSON.parse(await readFile(path, "utf8")));

  assert.deepEqual(parsed.deleted_track_ids, ["old"]);
  assert.equal((await readdir(directory)).length, 1);
});

test("concurrent recordBatch calls do not lose completed progress", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = cleanupManifest();
  const firstGroup = initial.groups[0];
  assert.ok(firstGroup);
  const firstRemoved = firstGroup.remove[0];
  assert.ok(firstRemoved);
  const manifest = {
    ...initial,
    groups: [{ ...firstGroup, remove: [firstRemoved, { ...firstRemoved, id: "old-2" }] }],
  };
  const path = await new FileManifestStore(directory).create(manifest);
  const base = realFileSystem();
  let readCount = 0;
  const delayedReads: ManifestFileSystem = {
    ...base,
    readFile: async (file, encoding) => {
      const contents = await base.readFile(file, encoding);
      if (readCount++ === 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      return contents;
    },
  };
  const firstStore = new FileManifestStore(directory, delayedReads);
  const secondStore = new FileManifestStore(directory, delayedReads);

  await Promise.all([
    firstStore.recordBatch(path, "deleted_track_ids", ["old"]),
    secondStore.recordBatch(path, "deleted_track_ids", ["old-2"]),
  ]);
  const parsed = validateManifest(JSON.parse(await readFile(path, "utf8")));

  assert.deepEqual(new Set(parsed.deleted_track_ids), new Set(["old", "old-2"]));
});

test("recordBatch reports malformed stored JSON without replacing the manifest", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileManifestStore(directory);
  const path = await store.create(cleanupManifest());
  const malformed = "{not json";
  await writeFile(path, malformed);

  await assert.rejects(store.recordBatch(path, "deleted_track_ids", ["old"]), /valid JSON/);
  assert.equal(await readFile(path, "utf8"), malformed);
  assert.equal((await readdir(directory)).length, 1);
});

test("recordBatch rejects IDs outside the manifest and paths outside its directory", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileManifestStore(directory);
  const path = await store.create(cleanupManifest());
  const before = await readFile(path, "utf8");

  await assert.rejects(store.recordBatch(path, "deleted_track_ids", ["not-removed"]));
  await assert.rejects(store.recordBatch(join(directory, "..", "outside.json"), "deleted_track_ids", []), /outside/);
  assert.equal(await readFile(path, "utf8"), before);
});

test("failed manifest replacement preserves the last durable file and cleans its temp file", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = await new FileManifestStore(directory).create(cleanupManifest());
  const before = await readFile(path, "utf8");
  const base = realFileSystem();
  const failing: ManifestFileSystem = {
    ...base,
    rename: async () => { throw new Error("injected rename failure"); },
  };

  await assert.rejects(new FileManifestStore(directory, failing).recordBatch(path, "deleted_track_ids", ["old"]), /injected rename failure/);
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await readdir(directory), [path.split("/").at(-1)]);
});

test("failed temp write leaves the durable manifest untouched", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = await new FileManifestStore(directory).create(cleanupManifest());
  const before = await readFile(path, "utf8");
  const base = realFileSystem();
  const failing: ManifestFileSystem = {
    ...base,
    open: async (filename, flags, mode) => {
      const handle = await base.open(filename, flags, mode);
      if (!filename.endsWith(".tmp")) return handle;
      const broken: ManifestFileHandle = {
        writeFile: async () => { throw new Error("injected write failure"); },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
      return broken;
    },
  };

  await assert.rejects(new FileManifestStore(directory, failing).recordBatch(path, "deleted_track_ids", ["old"]), /injected write failure/);
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await readdir(directory), [path.split("/").at(-1)]);
});
