import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { validateManifest } from "../domain/manifest.js";
import type { ManifestProgressField, OperationManifest } from "../domain/types.js";
import type { ManifestStore } from "../ports/manifest-store.js";

export interface ManifestFileHandle {
  writeFile(data: string, options: { encoding: "utf8" }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ManifestFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<ManifestFileHandle>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const pendingUpdates = new Map<string, Promise<void>>();

const fileSystem: ManifestFileSystem = {
  mkdir: (path, options) => fsPromises.mkdir(path, options),
  open: (path, flags, mode) => fsPromises.open(path, flags, mode),
  readFile: (path, encoding) => fsPromises.readFile(path, encoding),
  rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
  unlink: (path) => fsPromises.unlink(path),
};

export class FileManifestStore implements ManifestStore {
  private readonly directory: string;
  private directorySynced = false;

  constructor(directory: string, private readonly fs: ManifestFileSystem = fileSystem) {
    this.directory = resolve(directory);
  }

  async create(manifest: OperationManifest): Promise<string> {
    const validManifest = validateManifest(manifest);
    await this.ensureDirectory();
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    const path = resolve(this.directory, `operation-${stamp}-${randomUUID()}.json`);
    await this.writeExclusive(path, serialize(validManifest));
    await this.syncDirectory(this.directory);
    return path;
  }

  async read(id: string): Promise<OperationManifest> {
    const target = this.resolveId(id);
    const metadata = await fsPromises.lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Operation manifest is not a regular file.");
    const contents = await this.fs.readFile(target, "utf8");
    return parseManifest(contents);
  }

  async list(): Promise<Array<{ id: string; manifest: OperationManifest }>> {
    let names: string[];
    try {
      names = await fsPromises.readdir(this.directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw new Error("Unable to list operation manifests.", { cause: error });
    }
    const results: Array<{ id: string; manifest: OperationManifest }> = [];
    for (const id of names.filter((name) => name.startsWith("operation-") && name.endsWith(".json")).sort()) {
      results.push({ id, manifest: await this.read(id) });
    }
    return results.sort((first, second) => second.manifest.created_at.localeCompare(first.manifest.created_at));
  }

  async recordBatch(path: string, field: ManifestProgressField, ids: string[]): Promise<void> {
    const target = path.includes("/") || path.includes("\\") ? this.resolveTarget(path) : this.resolveId(path);
    if (field !== "deleted_track_ids" && field !== "restored_track_ids") {
      throw new Error("Manifest progress field is invalid.");
    }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) {
      throw new Error("Manifest progress batch must contain non-empty track IDs.");
    }
    const batch = [...ids];
    const previous = pendingUpdates.get(target) ?? Promise.resolve();
    const update = previous
      .catch(() => undefined)
      .then(() => this.recordBatchNow(target, field, batch));
    pendingUpdates.set(target, update);
    try {
      await update;
    } finally {
      if (pendingUpdates.get(target) === update) pendingUpdates.delete(target);
    }
  }

  private async recordBatchNow(target: string, field: ManifestProgressField, ids: string[]): Promise<void> {
    const current = parseManifest(await this.fs.readFile(target, "utf8"));
    const updatedIds = [...new Set([...current[field], ...ids])];
    const allTrackIds = manifestTrackIds(current);
    let updated: OperationManifest;
    if (field === "deleted_track_ids") {
      const complete = allTrackIds.every((id) => updatedIds.includes(id));
      updated = current.schema_version === 1
        ? { ...current, deleted_track_ids: updatedIds, cleanup_status: complete ? "completed" : "in_progress" }
        : { ...current, deleted_track_ids: updatedIds, status: complete ? "completed" : "in_progress" };
    } else {
      const complete = allTrackIds.every((id) => updatedIds.includes(id));
      const restoreStatus = complete ? "completed" : updatedIds.length > 0 ? "in_progress" : "not_started";
      updated = { ...current, restored_track_ids: updatedIds, restore_status: restoreStatus };
    }
    await this.writeAtomic(target, serialize(validateManifest(updated)));
  }

  private async ensureDirectory(): Promise<void> {
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.directorySynced) return;

    const ancestors: string[] = [];
    let current = this.directory;
    while (true) {
      ancestors.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const path of ancestors.reverse()) await this.syncDirectory(path);
    this.directorySynced = true;
  }

  private async syncDirectory(path: string): Promise<void> {
    let handle: ManifestFileHandle | undefined;
    try {
      handle = await this.fs.open(path, "r");
      await handle.sync();
      await handle.close();
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* Preserve the durability failure. */ }
      }
      throw new Error("Could not sync the manifest directory; durability cannot be confirmed.", { cause: error });
    }
  }

  private resolveId(id: string): string {
    if (!/^operation-[0-9TZ]+-[0-9a-f-]+\.json$/.test(id)) {
      throw new Error("Operation manifest ID is invalid.");
    }
    return this.resolveTarget(resolve(this.directory, id));
  }

  private resolveTarget(path: string): string {
    const target = resolve(path);
    if (dirname(target) !== this.directory || basename(target) === "." || basename(target) === "..") {
      throw new Error("Manifest path is outside the configured directory.");
    }
    return target;
  }

  private async writeExclusive(path: string, contents: string): Promise<void> {
    const handle = await this.fs.open(path, "wx", 0o600);
    try {
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
    } catch (error) {
      try { await handle.close(); } catch { /* Preserve the original write error. */ }
      try { await this.fs.unlink(path); } catch { /* Best-effort cleanup of a partial file. */ }
      throw error;
    }
  }

  private async writeAtomic(target: string, contents: string): Promise<void> {
    await this.ensureDirectory();
    const temporary = resolve(this.directory, `.${basename(target)}.${randomUUID()}.tmp`);
    await this.writeExclusive(temporary, contents);
    try {
      await this.fs.rename(temporary, target);
      await this.syncDirectory(this.directory);
    } catch (error) {
      try { await this.fs.unlink(temporary); } catch { /* Preserve the original replacement error. */ }
      throw error;
    }
  }
}

function parseManifest(contents: string): OperationManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Operation manifest is not valid JSON.");
  }
  return validateManifest(parsed);
}

function manifestTrackIds(manifest: OperationManifest): string[] {
  return manifest.schema_version === 1
    ? manifest.groups.flatMap((group) => group.remove.map((track) => track.id))
    : manifest.tracks.map((track) => track.id);
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function serialize(manifest: OperationManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
