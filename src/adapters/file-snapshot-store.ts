import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, resolve } from "node:path";
import { buildCleanupPlan } from "../domain/cleanup-plan.js";
import type { LibraryReport } from "../domain/types.js";
import type { SnapshotStore } from "../ports/snapshot-store.js";

export class FileSnapshotStore implements SnapshotStore {
  private readonly directory: string;
  private readonly snapshotPath: string;
  private readonly stalePath: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    this.snapshotPath = resolve(this.directory, "library.json");
    this.stalePath = resolve(this.directory, ".library-stale");
  }

  async load(): Promise<LibraryReport | null> {
    let contents: string;
    try {
      contents = await fs.readFile(this.snapshotPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new Error("Unable to read the saved library snapshot.", { cause: error });
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch (error) {
      throw new Error("The saved library snapshot is invalid.", { cause: error });
    }
    try {
      buildCleanupPlan(value);
      if (!isRecord(value) || !isRecord(value.statistics) || !isRecord(value.statistics.saved_library)) {
        throw new Error("Missing statistics");
      }
    } catch (error) {
      throw new Error("The saved library snapshot is invalid.", { cause: error });
    }
    // SAFETY: buildCleanupPlan validates the persisted track hierarchy; statistics and saved_library are checked above.
    return value as unknown as LibraryReport;
  }

  async save(report: LibraryReport): Promise<void> {
    try {
      buildCleanupPlan(report);
    } catch (error) {
      throw new Error("Refusing to save an invalid library snapshot.", { cause: error });
    }
    await atomicWrite(this.directory, this.snapshotPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  async isStale(): Promise<boolean> {
    try {
      await fs.lstat(this.stalePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new Error("Unable to read library snapshot status.", { cause: error });
    }
  }

  async markStale(): Promise<void> {
    await atomicWrite(this.directory, this.stalePath, "stale\n");
  }

  async markFresh(): Promise<void> {
    try {
      await fs.unlink(this.stalePath);
      await syncDirectory(this.directory);
    } catch (error) {
      if (isNotFound(error)) return;
      throw new Error("Unable to update library snapshot status.", { cause: error });
    }
  }
}

async function atomicWrite(directory: string, target: string, contents: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* Preserve the original snapshot error. */ }
    }
    try { await fs.unlink(temporary); } catch { /* Preserve the original snapshot error. */ }
    throw new Error("Unable to persist library snapshot data.", { cause: error });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
